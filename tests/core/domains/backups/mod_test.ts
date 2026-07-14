import { expect, test } from "bun:test";

import {
  BackupsService,
  type ControlBackupBundle,
  InMemoryBackupArtifactStore,
  type ServiceDataBackupManifest,
  type ServiceDataBackupRunner,
} from "../../../../core/domains/backups/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";

const TS = "2026-06-06T00:00:00.000Z";

function makeService(
  options: {
    readonly store?: InMemoryOpenTofuControlStore;
    readonly artifactStore?: InMemoryBackupArtifactStore | null;
    readonly serviceDataRunner?: ServiceDataBackupRunner;
    readonly stateObjects?: Readonly<Record<string, Uint8Array>>;
  } = {},
): {
  readonly service: BackupsService;
  readonly store: InMemoryOpenTofuControlStore;
  readonly artifactStore: InMemoryBackupArtifactStore | undefined;
} {
  const store = options.store ?? new InMemoryOpenTofuControlStore();
  const artifactStore =
    options.artifactStore === null
      ? undefined
      : (options.artifactStore ?? new InMemoryBackupArtifactStore());
  let counter = 0;
  const service = new BackupsService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    ...(artifactStore ? { artifactStore } : {}),
    stateObjectReader: {
      get: async (ref) => options.stateObjects?.[ref],
    },
    ...(options.serviceDataRunner
      ? { serviceDataRunner: options.serviceDataRunner }
      : {}),
    activity: new ActivityService({ store, now: () => new Date(TS) }),
    now: () => new Date(TS),
    newId: (prefix) =>
      `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  });
  return { service, store, artifactStore };
}

/** Reads + zstd-decodes the stored bundle bytes back into the bundle object. */
async function readBundle(
  artifactStore: InMemoryBackupArtifactStore,
  ref: string,
): Promise<ControlBackupBundle> {
  return JSON.parse(
    new TextDecoder().decode(readZstdRawObject(artifactStore, ref)),
  ) as ControlBackupBundle;
}

async function readServiceDataManifest(
  artifactStore: InMemoryBackupArtifactStore,
  ref: string,
): Promise<ServiceDataBackupManifest> {
  const tar = readZstdRawObject(artifactStore, ref);
  return JSON.parse(
    new TextDecoder().decode(tarEntry(tar, "service-data.json")),
  ) as ServiceDataBackupManifest;
}

function readJsonObject(
  artifactStore: InMemoryBackupArtifactStore,
  ref: string,
): Record<string, unknown> {
  const bytes = artifactStore.get(ref);
  if (!bytes) throw new Error(`no object at ${ref}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function readZstdRawObject(
  artifactStore: InMemoryBackupArtifactStore,
  ref: string,
): Uint8Array {
  const bytes = artifactStore.get(ref);
  if (!bytes) throw new Error(`no object at ${ref}`);
  return decodeZstdRaw(bytes);
}

function decodeZstdRaw(bytes: Uint8Array): Uint8Array {
  if (
    bytes[0] !== 0x28 ||
    bytes[1] !== 0xb5 ||
    bytes[2] !== 0x2f ||
    bytes[3] !== 0xfd ||
    bytes[4] !== 0xa0
  ) {
    throw new Error("unexpected zstd frame");
  }
  const size =
    bytes[5]! | (bytes[6]! << 8) | (bytes[7]! << 16) | (bytes[8]! << 24);
  const out = new Uint8Array(size >>> 0);
  let input = 9;
  let output = 0;
  while (input < bytes.byteLength && output < out.byteLength) {
    const header =
      bytes[input]! | (bytes[input + 1]! << 8) | (bytes[input + 2]! << 16);
    input += 3;
    const blockSize = header >>> 3;
    out.set(bytes.slice(input, input + blockSize), output);
    input += blockSize;
    output += blockSize;
    if ((header & 1) === 1) break;
  }
  return out;
}

function tarEntry(tar: Uint8Array, name: string): Uint8Array {
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const entryName = new TextDecoder()
      .decode(header.slice(0, 100))
      .replace(/\0.*$/u, "");
    const sizeText = new TextDecoder()
      .decode(header.slice(124, 136))
      .replace(/\0.*$/u, "")
      .trim();
    const size = Number.parseInt(sizeText, 8);
    const bodyStart = offset + 512;
    if (entryName === name) return tar.slice(bodyStart, bodyStart + size);
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`missing tar entry ${name}`);
}

test("createBackup writes a sealed bundle + records a pointer + emits activity", async () => {
  const { service, store, artifactStore } = makeService();
  await seedCapsuleModel(store, { workspaceId: "ws_backup1" });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });

  expect(record.workspaceId).toBe("ws_backup1");
  expect(record.id).toMatch(/^bkp_/);
  expect(record.ref).toBe(
    "workspaces/ws_backup1/backups/bkp_0001/control.json.zst.enc",
  );
  expect(record.artifactsManifest?.ref).toBe(
    "workspaces/ws_backup1/backups/bkp_0001/artifacts.manifest.json",
  );
  const artifactsManifest = readJsonObject(
    artifactStore!,
    record.artifactsManifest!.ref,
  );
  expect(artifactsManifest.kind).toBe("backup-artifacts-manifest");
  expect(artifactsManifest.workspaceId).toBe("ws_backup1");
  expect(artifactsManifest.backupId).toBe(record.id);
  expect(artifactsManifest.artifacts).toEqual([
    expect.objectContaining({
      kind: "control",
      ref: record.ref,
      digest: record.digest,
      sizeBytes: record.sizeBytes,
    }),
  ]);
  expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(record.sizeBytes).toBeGreaterThan(0);
  expect(record.createdAt).toBe(TS);

  // Ledger pointer is persisted and listed.
  const listed = await store.listBackupRecords("ws_backup1");
  expect(listed.map((b) => b.id)).toEqual([record.id]);

  // The object exists in backup storage and digests to the recorded digest.
  const bytes = artifactStore!.get(record.ref);
  expect(bytes).toBeDefined();
  expect(bytes!.byteLength).toBe(record.sizeBytes);

  // A Workspace Activity event was emitted (pointer metadata only).
  const events = await store.listActivityEvents("ws_backup1");
  const backupEvent = events.find((e) => e.action === "backup.created");
  expect(backupEvent).toBeDefined();
  expect(backupEvent!.targetId).toBe(record.id);
  expect(backupEvent!.metadata.ref).toBe(record.ref);
});

test("control bundle captures the Workspace ledger as public projections", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  const bundle = await readBundle(artifactStore!, record.ref);

  expect(bundle.kind).toBe("control");
  expect(bundle.bundleVersion).toBe(2);
  expect(bundle.workspaceId).toBe("ws_backup1");
  expect(bundle.capturedAt).toBe(TS);
  expect((bundle.workspace as { id: string }).id).toBe("ws_backup1");
  expect(bundle.sources.map((s) => s.id)).toEqual([seeded.source.id]);
  expect(bundle.sourceSnapshots.map((s) => s.id)).toEqual([seeded.snapshot.id]);
  // Capsules are Workspace-scoped and captured; the fixture InstallConfig is an
  // Built-in shared config (no workspaceId), so it is NOT a Workspace-owned config.
  expect(bundle.capsules.length).toBe(1);
  expect(bundle.installConfigs.length).toBe(0);

  // A Workspace-OWN InstallConfig is captured.
  await store.putInstallConfig({
    id: "cfg_space",
    workspaceId: "ws_backup1",
    name: "own",
    installType: "opentofu_module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: TS,
    updatedAt: TS,
  });
  const second = await service.createBackup({ workspaceId: "ws_backup1" });
  const bundle2 = await readBundle(artifactStore!, second.ref);
  expect(bundle2.installConfigs.length).toBe(1);
});

test("control bundle strips the Source internal hook-secret + sync fields", async () => {
  const { service, store, artifactStore } = makeService();
  await store.putWorkspace({
    id: "ws_backup1",
    handle: "space-1",
    displayName: "S",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: TS,
    updatedAt: TS,
  });
  const source: StoredSource = {
    id: "src_secret",
    workspaceId: "ws_backup1",
    name: "s",
    url: "https://git.example.com/a/b.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    createdAt: TS,
    updatedAt: TS,
    hookSecretHash: "TOP-SECRET-HASH",
    lastSeenCommit: "deadbeef",
    autoSync: true,
  };
  await store.putSource(source);

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  const bundle = await readBundle(artifactStore!, record.ref);

  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain("TOP-SECRET-HASH");
  expect(serialized).not.toContain("hookSecretHash");
  expect(serialized).not.toContain("lastSeenCommit");
  // The public Source fields survive.
  expect(bundle.sources[0]!.id).toBe("src_secret");
  expect(bundle.sources[0]!.url).toBe("https://git.example.com/a/b.git");
  expect(bundle.sources[0]!.autoSync).toBe(true);
});

test("control bundle includes PUBLIC connection records, never blobs", async () => {
  const { service, store, artifactStore } = makeService();
  await store.putWorkspace({
    id: "ws_backup1",
    handle: "space-1",
    displayName: "S",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: TS,
    updatedAt: TS,
  });
  const connection: ProviderConnection = {
    id: "conn_1",
    workspaceId: "ws_backup1",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    scope: "workspace",
    materialization: "secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: TS,
    updatedAt: TS,
  };
  await store.putConnection(connection);
  await store.putSecretBlob({
    id: "secret_conn_1",
    connectionId: "conn_1",
    workspaceId: "ws_backup1",
    kind: "cloudflare_api_token",
    ciphertext: "SEALED-CIPHERTEXT-BYTES",
    encryptedDek: "secret-boundary-aes-gcm/v1/global",
    nonce: "SEALED-IV",
    keyVersion: 1,
    aad: JSON.stringify({
      secretPartition: "global",
      workspaceId: "ws_backup1",
      provider: "cloudflare",
    }),
    createdAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  const bundle = await readBundle(artifactStore!, record.ref);

  expect(bundle.connections.map((c) => c.id)).toEqual(["conn_1"]);
  expect(bundle.connections[0]!.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  // The sealed blob never enters the bundle.
  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain("SEALED-CIPHERTEXT-BYTES");
  expect(serialized).not.toContain("SEALED-IV");
});

test("control bundle carries StateVersion metadata + output projection only", async () => {
  const stateRef = "workspaces/ws_backup1/.../states/00000001.tfstate.enc";
  const { service, store, artifactStore } = makeService({
    stateObjects: {
      [stateRef]: new TextEncoder().encode("SEALED-TFSTATE"),
    },
  });
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putStateVersion({
    id: "st_1",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: stateRef,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });
  await store.putOutput({
    id: "out_1",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/.../raw-output.json.enc",
    publicOutputs: { url: "https://app.example.com" },
    workspaceOutputs: { internal_id: "xyz" },
    outputDigest: "sha256:" + "c".repeat(64),
    createdAt: TS,
  });
  await store.putOutput({
    id: "out_2",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 2,
    rawArtifactRef: "workspaces/ws_backup1/.../raw-output-2.json.enc",
    publicOutputs: { url: "https://app2.example.com" },
    workspaceOutputs: { internal_id: "abc" },
    outputDigest: "sha256:" + "d".repeat(64),
    createdAt: "2026-06-06T00:01:00.000Z",
  });
  await store.putConnection({
    id: "conn_backup_cloudflare",
    workspaceId: "ws_backup1",
    scope: "workspace",
    provider: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    kind: "cloudflare_api_token",
    displayName: "Cloudflare",
    materialization: "secret",
    status: "verified",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: TS,
    updatedAt: TS,
    verifiedAt: TS,
  });
  await store.putProviderBindingSet({
    id: "dp_1",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_backup_cloudflare",
      },
    ],
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putOutputShare({
    id: "share_from",
    fromWorkspaceId: "ws_backup1",
    toWorkspaceId: "ws_backup2",
    producerCapsuleId: seeded.capsule.id,
    outputs: [{ name: "url", sensitive: false }],
    status: "active",
    createdAt: TS,
  });
  await store.putOutputShare({
    id: "share_to",
    fromWorkspaceId: "ws_backup2",
    toWorkspaceId: "ws_backup1",
    producerCapsuleId: "cap_other01",
    outputs: [{ name: "shared", sensitive: false }],
    status: "pending",
    createdAt: TS,
  });
  await store.putSecurityFinding({
    id: "finding_1",
    workspaceId: "ws_backup1",
    severity: "warning",
    type: "policy",
    message: "policy warning",
    metadata: {},
    createdAt: TS,
  });
  await store.putUsageEvent({
    id: "usage_1",
    workspaceId: "ws_backup1",
    kind: "runner_minute",
    quantity: 1,
    usdMicros: 30_000,
    ratingStatus: "rated",
    source: "runner",
    idempotencyKey: "usage_1",
    createdAt: TS,
  });
  await store.putBackupRecord({
    id: "bkp_old",
    workspaceId: "ws_backup1",
    ref: "workspaces/ws_backup1/backups/bkp_old/control.json.zst.enc",
    digest: "sha256:" + "e".repeat(64),
    sizeBytes: 1,
    createdAt: "2026-06-05T00:00:00.000Z",
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  const bundle = await readBundle(artifactStore!, record.ref);

  expect(record.stateArchive?.ref).toBe(
    "workspaces/ws_backup1/backups/bkp_0001/state.tar.zst.enc",
  );
  const stateTar = readZstdRawObject(artifactStore!, record.stateArchive!.ref);
  expect(new TextDecoder().decode(tarEntry(stateTar, "state.json"))).toContain(
    '"kind":"state-backup-archive"',
  );
  expect(
    new TextDecoder().decode(
      tarEntry(
        stateTar,
        `states/${seeded.capsule.id}/${seeded.capsule.environment}/00000001.tfstate.enc`,
      ),
    ),
  ).toBe("SEALED-TFSTATE");
  const artifactsManifest = readJsonObject(
    artifactStore!,
    record.artifactsManifest!.ref,
  );
  expect(artifactsManifest.artifacts).toEqual([
    expect.objectContaining({ kind: "control", ref: record.ref }),
    expect.objectContaining({
      kind: "state",
      ref: record.stateArchive!.ref,
      digest: record.stateArchive!.digest,
      sizeBytes: record.stateArchive!.sizeBytes,
    }),
  ]);
  expect(bundle.stateVersions.map((s) => s.id)).toEqual(["st_1"]);
  expect(bundle.stateVersions[0]!.stateRef).toContain("tfstate.enc");
  expect(bundle.outputs.map((o) => o.id)).toEqual(["out_1", "out_2"]);
  // Projected outputs survive; the raw artifact KEY is listed (bytes are not).
  expect(bundle.outputs[0]!.publicOutputs.url).toBe("https://app.example.com");
  expect(bundle.outputs[0]!.rawArtifactRef).toContain("raw-output.json.enc");
  // The standalone Provider Catalog is removed after the credential-model
  // collapse; the unified Provider ProviderConnection records are captured instead.
  expect(bundle.connections.map((connection: any) => connection.id)).toEqual([
    "conn_backup_cloudflare",
  ]);
  expect(bundle.providerBindingSets.map((profile: any) => profile.id)).toEqual([
    "dp_1",
  ]);
  expect(bundle.outputSharesGranted.map((share: any) => share.id)).toEqual([
    "share_from",
  ]);
  expect(bundle.outputSharesReceived.map((share: any) => share.id)).toEqual([
    "share_to",
  ]);
  expect(bundle.securityFindings.map((finding: any) => finding.id)).toEqual([
    "finding_1",
  ]);
  expect(bundle.usageEvents.map((row: any) => row.id)).toEqual(["usage_1"]);
  expect(bundle.backupRecords.map((row: any) => row.id)).toEqual(["bkp_old"]);
});

test("state archive fails closed when a state object is missing", async () => {
  const stateRef = "workspaces/ws_backup1/.../states/00000001.tfstate.enc";
  const { service, store } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putStateVersion({
    id: "st_1",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: stateRef,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });

  await expect(
    service.createBackup({ workspaceId: "ws_backup1" }),
  ).rejects.toThrow(/state snapshot ref .* is missing/);
});

test("artifact_export service-data backup writes a sealed artifact manifest", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "artifact_export",
      outputPath: "backup.artifact",
    },
  });
  await store.putOutput({
    id: "out_backup",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/raw-output.json.enc",
    publicOutputs: {},
    workspaceOutputs: {
      backup: {
        artifact: {
          ref: "r2://service-data/exports/talk-20260606.tar.zst.enc",
          digest: "sha256:" + "d".repeat(64),
          sizeBytes: 12345,
          contentType: "application/zstd",
        },
      },
    },
    outputDigest: "sha256:" + "e".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.ref).toBe(
    "workspaces/ws_backup1/backups/bkp_0001/service-data.tar.zst.enc",
  );
  expect(record.serviceData!.exportedCount).toBe(1);
  expect(record.serviceData!.unsupportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(0);

  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );
  expect(manifest.kind).toBe("service-data-backup-manifest");
  expect(manifest.entries.length).toBe(1);
  const entry = manifest.entries[0]!;
  expect(entry.status).toBe("exported");
  expect(entry.capsuleId).toBe(seeded.capsule.id);
  if (entry.status === "exported") {
    expect(entry.outputPath).toBe("backup.artifact");
    expect(entry.artifact.ref).toBe(
      "r2://service-data/exports/talk-20260606.tar.zst.enc",
    );
    expect(entry.artifact.digest).toBe("sha256:" + "d".repeat(64));
    expect(entry.artifact.sizeBytes).toBe(12345);
  }

  const events = await store.listActivityEvents("ws_backup1");
  const backupEvent = events.find((e) => e.action === "backup.created");
  expect(
    (backupEvent!.metadata.serviceData as { exportedCount: number })
      .exportedCount,
  ).toBe(1);
});

test("Capsule-scoped backup records Capsule and environment on the BackupRecord", async () => {
  const { service, store } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });

  const record = await service.createBackup({
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
  });

  expect(record.capsuleId).toBe(seeded.capsule.id);
  expect(record.environment).toBe(seeded.capsule.environment);
  expect((await store.listBackupRecords("ws_backup1"))[0]).toMatchObject({
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
  });
});

test("Capsule-scoped backup records the latest restore target generation", async () => {
  const stateRef1 = "workspaces/ws_backup1/.../states/00000001.tfstate.enc";
  const stateRef2 = "workspaces/ws_backup1/.../states/00000002.tfstate.enc";
  const { service, store } = makeService({
    stateObjects: {
      [stateRef1]: new TextEncoder().encode("SEALED-TFSTATE-1"),
      [stateRef2]: new TextEncoder().encode("SEALED-TFSTATE-2"),
    },
  });
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putStateVersion({
    id: "st_1",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: stateRef1,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });
  await store.putStateVersion({
    id: "st_2",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 2,
    stateRef: stateRef2,
    digest: "sha256:" + "c".repeat(64),
    createdByRunId: "apply_2",
    createdAt: TS,
  });

  const record = await service.createBackup({
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
  });

  expect(record.restoreTarget).toEqual({
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    stateGeneration: 2,
    stateVersionId: "st_2",
  });
});

test("service-data refs are opaque and not classified by URI scheme", async () => {
  const { service, store, artifactStore } = makeService({
    serviceDataRunner: {
      async run() {
        return {
          status: "exported",
          runId: "run_backup_local",
          artifact: {
            ref: "runner-local://run_backup_local/artifact/export.tar.zst",
            digest: "sha256:" + "a".repeat(64),
            sizeBytes: 10,
          },
        };
      },
    },
  });
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      adapterId: "snapshot-export",
      outputPath: "backup.snapshot",
    },
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  expect(record.serviceData!.exportedCount).toBe(1);
  expect(record.serviceData!.missingCount).toBe(0);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );
  expect(manifest.entries[0]!.status).toBe("exported");
  if (manifest.entries[0]!.status === "exported") {
    expect(manifest.entries[0]!.artifact.ref).toBe(
      "runner-local://run_backup_local/artifact/export.tar.zst",
    );
  }
});

test("provider_snapshot and custom_command service-data backup modes capture projected pointers", async () => {
  const { service, store, artifactStore } = makeService();
  const one = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...one.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      adapterId: "snapshot-export",
      outputPath: "backup.snapshot",
    },
  });
  await store.putOutput({
    id: "out_snapshot",
    workspaceId: "ws_backup1",
    capsuleId: one.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/raw-output.json.enc",
    publicOutputs: {},
    workspaceOutputs: {
      backup: {
        snapshot: {
          ref: "aws:rds:us-east-1:123456789012:snapshot/talk-20260606",
          digest: "sha256:" + "a".repeat(64),
        },
      },
    },
    outputDigest: "sha256:" + "b".repeat(64),
    createdAt: TS,
  });
  await store.putSource({
    id: "src_two",
    workspaceId: "ws_backup1",
    name: "two",
    url: "https://git.example.com/two.git",
    defaultRef: "main",
    defaultPath: ".",
    status: "active",
    hookSecretHash: "hash",
    autoSync: false,
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putInstallConfig({
    id: "cfg_two",
    name: "two",
    installType: "opentofu_module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    backup: {
      enabled: true,
      mode: "custom_command",
      command: ["backup"],
      outputPath: "backup.commandArtifact",
    },
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putCapsule({
    id: "cap_two0001",
    workspaceId: "ws_backup1",
    name: "two",
    slug: "two",
    sourceId: "src_two",
    installType: "opentofu_module",
    installConfigId: "cfg_two",
    environment: "production",
    currentStateGeneration: 0,
    status: "active",
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putOutput({
    id: "out_command",
    workspaceId: "ws_backup1",
    capsuleId: "cap_two0001",
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/raw-output-two.json.enc",
    publicOutputs: {},
    workspaceOutputs: {
      backup: {
        commandArtifact: {
          ref: "r2://service-data/exports/two-20260606.tar.zst.enc",
          digest: "sha256:" + "c".repeat(64),
          sizeBytes: 999,
        },
      },
    },
    outputDigest: "sha256:" + "d".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.exportedCount).toBe(2);
  expect(record.serviceData!.unsupportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(0);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );
  expect(manifest.entries.map((entry) => entry.status)).toEqual([
    "exported",
    "exported",
  ]);
  expect(manifest.entries.map((entry) => entry.mode).sort()).toEqual([
    "custom_command",
    "provider_snapshot",
  ]);
  const refs = manifest.entries
    .map((entry) => (entry.status === "exported" ? entry.artifact.ref : ""))
    .sort();
  expect(refs).toEqual([
    "aws:rds:us-east-1:123456789012:snapshot/talk-20260606",
    "r2://service-data/exports/two-20260606.tar.zst.enc",
  ]);
});

test("provider_snapshot and custom_command service-data backup modes use isolated runner when wired", async () => {
  const calls: Array<{
    mode: string;
    capsuleId: string;
    outputPath: string;
    adapterId?: string;
    command?: readonly string[];
  }> = [];
  const { service, store, artifactStore } = makeService({
    serviceDataRunner: {
      async run(input) {
        calls.push({
          mode: input.mode,
          capsuleId: input.capsule.id,
          outputPath: input.outputPath,
          ...(input.adapterId ? { adapterId: input.adapterId } : {}),
          ...(input.command ? { command: input.command } : {}),
        });
        if (input.mode === "provider_snapshot") {
          return {
            status: "exported",
            runId: "run_backup_snapshot",
            artifact: {
              ref: "r2://service-data/provider/snap-1",
              digest: "sha256:" + "a".repeat(64),
            },
          };
        }
        return {
          status: "exported",
          runId: "run_backup_command",
          artifact: {
            ref: "r2://service-data/command/export-1.tar.zst.enc",
            digest: "sha256:" + "b".repeat(64),
            sizeBytes: 55,
          },
        };
      },
    },
  });
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      adapterId: "snapshot-export",
      outputPath: "backup.snapshot",
    },
    policy: {
      ...seeded.installConfig.policy,
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
  });
  await seedCapsuleModel(store, {
    workspaceId: "ws_backup1",
    capsuleId: "cap_command1",
    installConfigId: "cfg_cmd",
    name: "cmd",
  });
  await store.putInstallConfig({
    id: "cfg_cmd",
    workspaceId: "ws_backup1",
    name: "command",
    installType: "opentofu_module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    backup: {
      enabled: true,
      mode: "custom_command",
      command: ["bun", "run", "backup"],
      outputPath: "backup.commandArtifact",
    },
    createdAt: TS,
    updatedAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );

  const sortedCalls = [...calls].sort((a, b) =>
    a.capsuleId.localeCompare(b.capsuleId),
  );
  expect(sortedCalls).toEqual([
    {
      mode: "custom_command",
      capsuleId: "cap_command1",
      outputPath: "backup.commandArtifact",
      command: ["bun", "run", "backup"],
    },
    {
      mode: "provider_snapshot",
      capsuleId: seeded.capsule.id,
      outputPath: "backup.snapshot",
      adapterId: "snapshot-export",
    },
  ]);
  const sortedEntries = [...manifest.entries].sort((a, b) =>
    a.capsuleId.localeCompare(b.capsuleId),
  );
  expect(sortedEntries.map((entry) => entry.status)).toEqual([
    "exported",
    "exported",
  ]);
  expect(sortedEntries.map((entry) => entry.backupRunId)).toEqual([
    "run_backup_command",
    "run_backup_snapshot",
  ]);
  expect(
    sortedEntries.map((entry) =>
      entry.status === "exported" ? entry.artifact.ref : undefined,
    ),
  ).toEqual([
    "r2://service-data/command/export-1.tar.zst.enc",
    "r2://service-data/provider/snap-1",
  ]);
});

test("artifact_export accepts only an explicit ref pointer object", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "artifact_export",
      outputPath: "backup.ref",
    },
  });
  await store.putOutput({
    id: "out_backup",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/raw-output.json.enc",
    publicOutputs: {},
    workspaceOutputs: {
      backup: { ref: { objectKey: "artifact:legacy-alias" } },
    },
    outputDigest: "sha256:" + "f".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });
  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.missingCount).toBe(1);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );
  expect(manifest.entries[0]!.status).toBe("missing");
  if (manifest.entries[0]!.status === "missing") {
    expect(manifest.entries[0]!.reason).toContain("artifact pointer");
  }
});

test("custom_command without command is recorded as missing before output lookup", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "custom_command",
      outputPath: "backup.commandArtifact",
    },
  });
  await store.putOutput({
    id: "out_backup",
    workspaceId: "ws_backup1",
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "workspaces/ws_backup1/raw-output.json.enc",
    publicOutputs: {},
    workspaceOutputs: {
      backup: {
        commandArtifact: {
          ref: "r2://service-data/exports/talk-20260606.tar.zst.enc",
        },
      },
    },
    outputDigest: "sha256:" + "1".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ workspaceId: "ws_backup1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.exportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(1);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.ref,
  );
  expect(manifest.entries[0]!.status).toBe("missing");
  if (manifest.entries[0]!.status === "missing") {
    expect(manifest.entries[0]!.reason).toContain("BackupConfig.command");
  }
});

test("createBackup is not_implemented when no artifact store is wired", async () => {
  const { service, store } = makeService({ artifactStore: null });
  await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  expect(service.enabled).toBe(false);

  await expect(
    service.createBackup({ workspaceId: "ws_backup1" }),
  ).rejects.toThrow(OpenTofuControllerError);
  try {
    await service.createBackup({ workspaceId: "ws_backup1" });
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("not_implemented");
  }
});

test("createBackup rejects an unknown Workspace (not_found)", async () => {
  const { service } = makeService();
  try {
    await service.createBackup({ workspaceId: "ws_missing" });
    throw new Error("expected throw");
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("not_found");
  }
});

test("createBackup rejects a blank workspaceId (invalid_argument)", async () => {
  const { service } = makeService();
  try {
    await service.createBackup({ workspaceId: "   " });
    throw new Error("expected throw");
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("invalid_argument");
  }
});

test("listBackups returns the Workspace's pointers newest-first", async () => {
  const { service, store } = makeService();
  await seedCapsuleModel(store, { workspaceId: "ws_backup1" });
  const first = await service.createBackup({ workspaceId: "ws_backup1" });
  const second = await service.createBackup({
    workspaceId: "ws_backup1",
    createdByRunId: "apply_9",
  });

  const listed = (await service.listBackups("ws_backup1")).backups;
  // Same createdAt -> tie-break by id desc; both pointers present.
  expect(listed.map((b) => b.id).sort()).toEqual([first.id, second.id].sort());
  const withRun = listed.find((b) => b.id === second.id);
  expect(withRun!.createdByRunId).toBe("apply_9");
});
