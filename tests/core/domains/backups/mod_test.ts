import { expect, test } from "bun:test";

import {
  BackupsService,
  type ControlBackupBundle,
  InMemoryBackupArtifactStore,
  type ServiceDataBackupManifest,
  type ServiceDataBackupRunner,
} from "../../../../core/domains/backups/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { ActivityService } from "../../../../core/domains/activity/mod.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";
import type { Connection } from "@takosumi/internal/deploy-control-api";

const TS = "2026-06-06T00:00:00.000Z";

function makeService(
  options: {
    readonly store?: InMemoryOpenTofuDeploymentStore;
    readonly artifactStore?: InMemoryBackupArtifactStore | null;
    readonly serviceDataRunner?: ServiceDataBackupRunner;
    readonly stateObjects?: Readonly<Record<string, Uint8Array>>;
  } = {},
): {
  readonly service: BackupsService;
  readonly store: InMemoryOpenTofuDeploymentStore;
  readonly artifactStore: InMemoryBackupArtifactStore | undefined;
} {
  const store = options.store ?? new InMemoryOpenTofuDeploymentStore();
  const artifactStore =
    options.artifactStore === null
      ? undefined
      : (options.artifactStore ?? new InMemoryBackupArtifactStore());
  let counter = 0;
  const service = new BackupsService({
    store,
    ...(artifactStore ? { artifactStore } : {}),
    stateObjectReader: {
      get: async (objectKey) => options.stateObjects?.[objectKey],
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
  objectKey: string,
): Promise<ControlBackupBundle> {
  return JSON.parse(
    new TextDecoder().decode(readZstdRawObject(artifactStore, objectKey)),
  ) as ControlBackupBundle;
}

async function readServiceDataManifest(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Promise<ServiceDataBackupManifest> {
  const tar = readZstdRawObject(artifactStore, objectKey);
  return JSON.parse(
    new TextDecoder().decode(tarEntry(tar, "service-data.json")),
  ) as ServiceDataBackupManifest;
}

function readJsonObject(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Record<string, unknown> {
  const bytes = artifactStore.get(objectKey);
  if (!bytes) throw new Error(`no object at ${objectKey}`);
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

function readZstdRawObject(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Uint8Array {
  const bytes = artifactStore.get(objectKey);
  if (!bytes) throw new Error(`no object at ${objectKey}`);
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
  for (let offset = 0; offset + 512 <= tar.byteLength; ) {
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
  await seedInstallationModel(store, { spaceId: "space_1" });

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.spaceId).toBe("space_1");
  expect(record.id).toMatch(/^bkp_/);
  expect(record.objectKey).toBe(
    "spaces/space_1/backups/bkp_0001/control.json.zst.enc",
  );
  expect(record.artifactsManifest?.objectKey).toBe(
    "spaces/space_1/backups/bkp_0001/artifacts.manifest.json",
  );
  const artifactsManifest = readJsonObject(
    artifactStore!,
    record.artifactsManifest!.objectKey,
  );
  expect(artifactsManifest.kind).toBe("backup-artifacts-manifest");
  expect(artifactsManifest.spaceId).toBe("space_1");
  expect(artifactsManifest.backupId).toBe(record.id);
  expect(artifactsManifest.artifacts).toEqual([
    expect.objectContaining({
      kind: "control",
      objectKey: record.objectKey,
      digest: record.digest,
      sizeBytes: record.sizeBytes,
    }),
  ]);
  expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(record.sizeBytes).toBeGreaterThan(0);
  expect(record.createdAt).toBe(TS);

  // Ledger pointer is persisted and listed.
  const listed = await store.listBackupRecords("space_1");
  expect(listed.map((b) => b.id)).toEqual([record.id]);

  // The object exists in backup storage and digests to the recorded digest.
  const bytes = artifactStore!.get(record.objectKey);
  expect(bytes).toBeDefined();
  expect(bytes!.byteLength).toBe(record.sizeBytes);

  // A Space Activity event was emitted (pointer metadata only).
  const events = await store.listActivityEvents("space_1");
  const backupEvent = events.find((e) => e.action === "backup.created");
  expect(backupEvent).toBeDefined();
  expect(backupEvent!.targetId).toBe(record.id);
  expect(backupEvent!.metadata.objectKey).toBe(record.objectKey);
});

test("control bundle captures the Space ledger as public projections", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });

  const record = await service.createBackup({ spaceId: "space_1" });
  const bundle = await readBundle(artifactStore!, record.objectKey);

  expect(bundle.kind).toBe("control");
  expect(bundle.bundleVersion).toBe(1);
  expect(bundle.spaceId).toBe("space_1");
  expect(bundle.capturedAt).toBe(TS);
  expect((bundle.space as { id: string }).id).toBe("space_1");
  expect(bundle.sources.map((s) => s.id)).toEqual([seeded.source.id]);
  expect(bundle.sourceSnapshots.map((s) => s.id)).toEqual([seeded.snapshot.id]);
  // Installations are Space-scoped and captured; the fixture InstallConfig is an
  // Built-in shared config (no spaceId), so it is NOT a Space-owned config.
  expect(bundle.installations.length).toBe(1);
  expect(bundle.installConfigs.length).toBe(0);

  // A Space-OWN InstallConfig is captured.
  await store.putInstallConfig({
    id: "cfg_space",
    spaceId: "space_1",
    name: "own",
    installType: "opentofu_module",
    trustLevel: "space",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: TS,
    updatedAt: TS,
  });
  const second = await service.createBackup({ spaceId: "space_1" });
  const bundle2 = await readBundle(artifactStore!, second.objectKey);
  expect(bundle2.installConfigs.length).toBe(1);
});

test("control bundle strips the Source internal hook-secret + sync fields", async () => {
  const { service, store, artifactStore } = makeService();
  await store.putSpace({
    id: "space_1",
    handle: "space-1",
    displayName: "S",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: TS,
    updatedAt: TS,
  });
  const source: StoredSource = {
    id: "src_secret",
    spaceId: "space_1",
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

  const record = await service.createBackup({ spaceId: "space_1" });
  const bundle = await readBundle(artifactStore!, record.objectKey);

  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain("TOP-SECRET-HASH");
  expect(serialized).not.toContain("hookSecretHash");
  expect(serialized).not.toContain("lastSeenCommit");
  expect(serialized).not.toContain("autoSync");
  // The public Source fields survive.
  expect(bundle.sources[0]!.id).toBe("src_secret");
  expect(bundle.sources[0]!.url).toBe("https://git.example.com/a/b.git");
});

test("control bundle includes PUBLIC connection records, never blobs", async () => {
  const { service, store, artifactStore } = makeService();
  await store.putSpace({
    id: "space_1",
    handle: "space-1",
    displayName: "S",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: TS,
    updatedAt: TS,
  });
  const connection: Connection = {
    id: "conn_1",
    spaceId: "space_1",
    provider: "cloudflare",
    kind: "cloudflare_api_token",
    scope: "space",
    authMethod: "static_secret",
    status: "active",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: TS,
    updatedAt: TS,
  };
  await store.putConnection(connection);
  await store.putSecretBlob({
    id: "secret_conn_1",
    connectionId: "conn_1",
    spaceId: "space_1",
    kind: "cloudflare_api_token",
    ciphertext: "SEALED-CIPHERTEXT-BYTES",
    encryptedDek: "secret-boundary-aes-gcm/v1/global",
    nonce: "SEALED-IV",
    keyVersion: 1,
    aad: JSON.stringify({
      cloudPartition: "global",
      spaceId: "space_1",
      provider: "cloudflare",
    }),
    createdAt: TS,
  });

  const record = await service.createBackup({ spaceId: "space_1" });
  const bundle = await readBundle(artifactStore!, record.objectKey);

  expect(bundle.connections.map((c) => c.id)).toEqual(["conn_1"]);
  expect(bundle.connections[0]!.envNames).toEqual(["CLOUDFLARE_API_TOKEN"]);
  // The sealed blob never enters the bundle.
  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain("SEALED-CIPHERTEXT-BYTES");
  expect(serialized).not.toContain("SEALED-IV");
});

test("control bundle carries state-snapshot metadata + output projection only", async () => {
  const stateObjectKey = "spaces/space_1/.../states/00000001.tfstate.enc";
  const { service, store, artifactStore } = makeService({
    stateObjects: {
      [stateObjectKey]: new TextEncoder().encode("SEALED-TFSTATE"),
    },
  });
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putStateSnapshot({
    id: "st_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    generation: 1,
    objectKey: stateObjectKey,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });
  await store.putOutputSnapshot({
    id: "out_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/.../raw-output.json.enc",
    publicOutputs: { url: "https://app.example.com" },
    spaceOutputs: { internal_id: "xyz" },
    outputDigest: "sha256:" + "c".repeat(64),
    createdAt: TS,
  });
  await store.putOutputSnapshot({
    id: "out_2",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    stateGeneration: 2,
    rawOutputArtifactKey: "spaces/space_1/.../raw-output-2.json.enc",
    publicOutputs: { url: "https://app2.example.com" },
    spaceOutputs: { internal_id: "abc" },
    outputDigest: "sha256:" + "d".repeat(64),
    createdAt: "2026-06-06T00:01:00.000Z",
  });
  await store.putProviderCatalogEntry({
    id: "cloudflare",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    displayName: "Cloudflare",
    recommendedEnvNames: ["CLOUDFLARE_API_TOKEN"],
    helpers: ["cloudflare_api_token", "cloudflare_oauth"],
    ownershipOptions: ["takos_provided", "own_key"],
    allowedResources: [],
    allowedDataSources: [],
    policyPackId: "policy_cloudflare",
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putProviderEnv({
    id: "penv_backup_secret_cloudflare",
    spaceId: "space_1",
    providerSource: "registry.opentofu.org/cloudflare/cloudflare",
    displayName: "Cloudflare",
    materialization: "secret",
    status: "ready",
    requiredEnvNames: ["CLOUDFLARE_API_TOKEN"],
    secretRef: "conn_backup_cloudflare",
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        envId: "penv_backup_secret_cloudflare",
      },
    ],
    createdAt: TS,
    updatedAt: TS,
  });
  await store.putOutputShare({
    id: "share_from",
    fromSpaceId: "space_1",
    toSpaceId: "space_2",
    producerInstallationId: seeded.installation.id,
    outputs: [{ name: "url", sensitive: false }],
    status: "active",
    createdAt: TS,
  });
  await store.putOutputShare({
    id: "share_to",
    fromSpaceId: "space_2",
    toSpaceId: "space_1",
    producerInstallationId: "inst_other",
    outputs: [{ name: "shared", sensitive: false }],
    status: "pending",
    createdAt: TS,
  });
  await store.putSecurityFinding({
    id: "finding_1",
    spaceId: "space_1",
    severity: "warning",
    type: "policy",
    message: "policy warning",
    metadata: {},
    createdAt: TS,
  });
  await store.putCreditBalance({
    spaceId: "space_1",
    availableCredits: 100,
    reservedCredits: 10,
    monthlyIncludedCredits: 100,
    purchasedCredits: 0,
    updatedAt: TS,
  });
  await store.putCreditReservation({
    id: "cr_1",
    spaceId: "space_1",
    runId: "run_1",
    estimatedCredits: 10,
    status: "reserved",
    mode: "showback",
    createdAt: TS,
    expiresAt: "2026-06-06T01:00:00.000Z",
  });
  await store.putUsageEvent({
    id: "usage_1",
    spaceId: "space_1",
    kind: "runner_minute",
    quantity: 1,
    credits: 3,
    source: "runner",
    idempotencyKey: "usage_1",
    createdAt: TS,
  });
  await store.putBackupRecord({
    id: "bkp_old",
    spaceId: "space_1",
    objectKey: "spaces/space_1/backups/bkp_old/control.json.zst.enc",
    digest: "sha256:" + "e".repeat(64),
    sizeBytes: 1,
    createdAt: "2026-06-05T00:00:00.000Z",
  });

  const record = await service.createBackup({ spaceId: "space_1" });
  const bundle = await readBundle(artifactStore!, record.objectKey);

  expect(record.stateArchive?.objectKey).toBe(
    "spaces/space_1/backups/bkp_0001/state.tar.zst.enc",
  );
  const stateTar = readZstdRawObject(
    artifactStore!,
    record.stateArchive!.objectKey,
  );
  expect(new TextDecoder().decode(tarEntry(stateTar, "state.json"))).toContain(
    '"kind":"state-backup-archive"',
  );
  expect(
    new TextDecoder().decode(
      tarEntry(
        stateTar,
        `states/${seeded.installation.id}/${seeded.installation.environment}/00000001.tfstate.enc`,
      ),
    ),
  ).toBe("SEALED-TFSTATE");
  const artifactsManifest = readJsonObject(
    artifactStore!,
    record.artifactsManifest!.objectKey,
  );
  expect(artifactsManifest.artifacts).toEqual([
    expect.objectContaining({ kind: "control", objectKey: record.objectKey }),
    expect.objectContaining({
      kind: "state",
      objectKey: record.stateArchive!.objectKey,
      digest: record.stateArchive!.digest,
      sizeBytes: record.stateArchive!.sizeBytes,
    }),
  ]);
  expect(bundle.stateSnapshots.map((s) => s.id)).toEqual(["st_1"]);
  expect(bundle.stateSnapshots[0]!.objectKey).toContain("tfstate.enc");
  expect(bundle.outputSnapshots.map((o) => o.id)).toEqual(["out_1", "out_2"]);
  // Projected outputs survive; the raw artifact KEY is listed (bytes are not).
  expect(bundle.outputSnapshots[0]!.publicOutputs.url).toBe(
    "https://app.example.com",
  );
  expect(bundle.outputSnapshots[0]!.rawOutputArtifactKey).toContain(
    "raw-output.json.enc",
  );
  expect(bundle.providerCatalog.map((entry: any) => entry.id)).toEqual([
    "cloudflare",
  ]);
  expect(
    bundle.providerEnvBindingSets.map((profile: any) => profile.id),
  ).toEqual(["dp_1"]);
  expect(bundle.outputSharesGranted.map((share: any) => share.id)).toEqual([
    "share_from",
  ]);
  expect(bundle.outputSharesReceived.map((share: any) => share.id)).toEqual([
    "share_to",
  ]);
  expect(bundle.securityFindings.map((finding: any) => finding.id)).toEqual([
    "finding_1",
  ]);
  expect((bundle.billing.creditBalance as any).availableCredits).toBe(100);
  expect(bundle.billing.creditReservations.map((row: any) => row.id)).toEqual([
    "cr_1",
  ]);
  expect(bundle.billing.usageEvents.map((row: any) => row.id)).toEqual([
    "usage_1",
  ]);
  expect(bundle.backupRecords.map((row: any) => row.id)).toEqual(["bkp_old"]);
});

test("state archive fails closed when a state object is missing", async () => {
  const stateObjectKey = "spaces/space_1/.../states/00000001.tfstate.enc";
  const { service, store } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putStateSnapshot({
    id: "st_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    generation: 1,
    objectKey: stateObjectKey,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });

  await expect(service.createBackup({ spaceId: "space_1" })).rejects.toThrow(
    /state snapshot object .* is missing/,
  );
});

test("artifact_export service-data backup writes a sealed artifact manifest", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "artifact_export",
      outputPath: "backup.artifact",
    },
  });
  await store.putOutputSnapshot({
    id: "out_backup",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/raw-output.json.enc",
    publicOutputs: {},
    spaceOutputs: {
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

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.objectKey).toBe(
    "spaces/space_1/backups/bkp_0001/service-data.tar.zst.enc",
  );
  expect(record.serviceData!.exportedCount).toBe(1);
  expect(record.serviceData!.unsupportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(0);

  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.kind).toBe("service-data-backup-manifest");
  expect(manifest.entries.length).toBe(1);
  const entry = manifest.entries[0]!;
  expect(entry.status).toBe("exported");
  expect(entry.installationId).toBe(seeded.installation.id);
  if (entry.status === "exported") {
    expect(entry.outputPath).toBe("backup.artifact");
    expect(entry.artifact.ref).toBe(
      "r2://service-data/exports/talk-20260606.tar.zst.enc",
    );
    expect(entry.artifact.digest).toBe("sha256:" + "d".repeat(64));
    expect(entry.artifact.sizeBytes).toBe(12345);
  }

  const events = await store.listActivityEvents("space_1");
  const backupEvent = events.find((e) => e.action === "backup.created");
  expect(
    (backupEvent!.metadata.serviceData as { exportedCount: number })
      .exportedCount,
  ).toBe(1);
});

test("installation-scoped backup records installation and environment on the BackupRecord", async () => {
  const { service, store } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });

  const record = await service.createBackup({
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
  });

  expect(record.installationId).toBe(seeded.installation.id);
  expect(record.environment).toBe(seeded.installation.environment);
  expect((await store.listBackupRecords("space_1"))[0]).toMatchObject({
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
  });
});

test("installation-scoped backup records the latest restore target generation", async () => {
  const stateObjectKey1 = "spaces/space_1/.../states/00000001.tfstate.enc";
  const stateObjectKey2 = "spaces/space_1/.../states/00000002.tfstate.enc";
  const { service, store } = makeService({
    stateObjects: {
      [stateObjectKey1]: new TextEncoder().encode("SEALED-TFSTATE-1"),
      [stateObjectKey2]: new TextEncoder().encode("SEALED-TFSTATE-2"),
    },
  });
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putStateSnapshot({
    id: "st_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    generation: 1,
    objectKey: stateObjectKey1,
    digest: "sha256:" + "b".repeat(64),
    createdByRunId: "apply_1",
    createdAt: TS,
  });
  await store.putStateSnapshot({
    id: "st_2",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    generation: 2,
    objectKey: stateObjectKey2,
    digest: "sha256:" + "c".repeat(64),
    createdByRunId: "apply_2",
    createdAt: TS,
  });

  const record = await service.createBackup({
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
  });

  expect(record.restoreTarget).toEqual({
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    stateGeneration: 2,
    stateSnapshotId: "st_2",
  });
});

test("service-data runner-local refs are recorded as missing, not exported", async () => {
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
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      outputPath: "backup.snapshot",
    },
  });

  const record = await service.createBackup({ spaceId: "space_1" });
  expect(record.serviceData!.exportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(1);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.entries[0]!.status).toBe("missing");
  if (manifest.entries[0]!.status === "missing") {
    expect(manifest.entries[0]!.reason).toContain("not durable");
  }
});

test("provider_snapshot and custom_command service-data backup modes capture projected pointers", async () => {
  const { service, store, artifactStore } = makeService();
  const one = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...one.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      outputPath: "backup.snapshot",
    },
  });
  await store.putOutputSnapshot({
    id: "out_snapshot",
    spaceId: "space_1",
    installationId: one.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/raw-output.json.enc",
    publicOutputs: {},
    spaceOutputs: {
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
    spaceId: "space_1",
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
    trustLevel: "space",
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
  await store.putInstallation({
    id: "inst_two",
    spaceId: "space_1",
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
  await store.putOutputSnapshot({
    id: "out_command",
    spaceId: "space_1",
    installationId: "inst_two",
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/raw-output-two.json.enc",
    publicOutputs: {},
    spaceOutputs: {
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

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.exportedCount).toBe(2);
  expect(record.serviceData!.unsupportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(0);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
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
    installationId: string;
    outputPath: string;
    provider?: string;
    command?: readonly string[];
  }> = [];
  const { service, store, artifactStore } = makeService({
    serviceDataRunner: {
      async run(input) {
        calls.push({
          mode: input.mode,
          installationId: input.installation.id,
          outputPath: input.outputPath,
          ...(input.provider ? { provider: input.provider } : {}),
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
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
      outputPath: "backup.snapshot",
    },
    policy: {
      ...seeded.installConfig.policy,
      allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
  });
  await seedInstallationModel(store, {
    spaceId: "space_1",
    installationId: "inst_cmd",
    installConfigId: "cfg_cmd",
    name: "cmd",
  });
  await store.putInstallConfig({
    id: "cfg_cmd",
    spaceId: "space_1",
    name: "command",
    installType: "opentofu_module",
    trustLevel: "space",
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

  const record = await service.createBackup({ spaceId: "space_1" });
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );

  const sortedCalls = [...calls].sort((a, b) =>
    a.installationId.localeCompare(b.installationId),
  );
  expect(sortedCalls).toEqual([
    {
      mode: "custom_command",
      installationId: "inst_cmd",
      outputPath: "backup.commandArtifact",
      command: ["bun", "run", "backup"],
    },
    {
      mode: "provider_snapshot",
      installationId: seeded.installation.id,
      outputPath: "backup.snapshot",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
    },
  ]);
  const sortedEntries = [...manifest.entries].sort((a, b) =>
    a.installationId.localeCompare(b.installationId),
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

test("artifact_export without a projected artifact pointer is recorded as missing", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "artifact_export",
      outputPath: "backup.ref",
    },
  });
  await store.putOutputSnapshot({
    id: "out_backup",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/raw-output.json.enc",
    publicOutputs: {},
    spaceOutputs: { backup: { ref: "https://example.com/not-owned.tar" } },
    outputDigest: "sha256:" + "f".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ spaceId: "space_1" });
  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.missingCount).toBe(1);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.entries[0]!.status).toBe("missing");
  if (manifest.entries[0]!.status === "missing") {
    expect(manifest.entries[0]!.reason).toContain("artifact pointer");
  }
});

test("custom_command without command is recorded as missing before output lookup", async () => {
  const { service, store, artifactStore } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...seeded.installConfig,
    backup: {
      enabled: true,
      mode: "custom_command",
      outputPath: "backup.commandArtifact",
    },
  });
  await store.putOutputSnapshot({
    id: "out_backup",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    stateGeneration: 1,
    rawOutputArtifactKey: "spaces/space_1/raw-output.json.enc",
    publicOutputs: {},
    spaceOutputs: {
      backup: {
        commandArtifact: {
          ref: "r2://service-data/exports/talk-20260606.tar.zst.enc",
        },
      },
    },
    outputDigest: "sha256:" + "1".repeat(64),
    createdAt: TS,
  });

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.exportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(1);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.entries[0]!.status).toBe("missing");
  if (manifest.entries[0]!.status === "missing") {
    expect(manifest.entries[0]!.reason).toContain("BackupConfig.command");
  }
});

test("createBackup is not_implemented when no artifact store is wired", async () => {
  const { service, store } = makeService({ artifactStore: null });
  await seedInstallationModel(store, { spaceId: "space_1" });
  expect(service.enabled).toBe(false);

  await expect(service.createBackup({ spaceId: "space_1" })).rejects.toThrow(
    OpenTofuControllerError,
  );
  try {
    await service.createBackup({ spaceId: "space_1" });
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("not_implemented");
  }
});

test("createBackup rejects an unknown Space (not_found)", async () => {
  const { service } = makeService();
  try {
    await service.createBackup({ spaceId: "space_missing" });
    throw new Error("expected throw");
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("not_found");
  }
});

test("createBackup rejects a blank spaceId (invalid_argument)", async () => {
  const { service } = makeService();
  try {
    await service.createBackup({ spaceId: "   " });
    throw new Error("expected throw");
  } catch (err) {
    expect((err as OpenTofuControllerError).code).toBe("invalid_argument");
  }
});

test("listBackups returns the Space's pointers newest-first", async () => {
  const { service, store } = makeService();
  await seedInstallationModel(store, { spaceId: "space_1" });
  const first = await service.createBackup({ spaceId: "space_1" });
  const second = await service.createBackup({
    spaceId: "space_1",
    createdByRunId: "apply_9",
  });

  const listed = (await service.listBackups("space_1")).backups;
  // Same createdAt -> tie-break by id desc; both pointers present.
  expect(listed.map((b) => b.id).sort()).toEqual([first.id, second.id].sort());
  const withRun = listed.find((b) => b.id === second.id);
  expect(withRun!.createdByRunId).toBe("apply_9");
});
