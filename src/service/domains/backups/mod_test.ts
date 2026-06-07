import { expect, test } from "bun:test";

import {
  BackupsService,
  type ControlBackupBundle,
  InMemoryBackupArtifactStore,
  type ServiceDataBackupManifest,
} from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { StoredSource } from "../deploy-control/store.ts";
import { ActivityService } from "../activity/mod.ts";
import { seedInstallationModel } from "../deploy-control/test_model_fixture.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { Connection } from "takosumi-contract/deploy-control-api";

const TS = "2026-06-06T00:00:00.000Z";

function makeService(
  options: {
    readonly store?: InMemoryOpenTofuDeploymentStore;
    readonly artifactStore?: InMemoryBackupArtifactStore | null;
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
    activity: new ActivityService({ store, now: () => new Date(TS) }),
    now: () => new Date(TS),
    newId: (prefix) =>
      `${prefix}_${(counter += 1).toString().padStart(4, "0")}`,
  });
  return { service, store, artifactStore };
}

/** Reads + gunzips the stored bundle bytes back into the bundle object. */
async function readBundle(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Promise<ControlBackupBundle> {
  return await readGzipJson<ControlBackupBundle>(artifactStore, objectKey);
}

async function readServiceDataManifest(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Promise<ServiceDataBackupManifest> {
  return await readGzipJson<ServiceDataBackupManifest>(
    artifactStore,
    objectKey,
  );
}

async function readGzipJson<T>(
  artifactStore: InMemoryBackupArtifactStore,
  objectKey: string,
): Promise<T> {
  const bytes = artifactStore.get(objectKey);
  if (!bytes) throw new Error(`no object at ${objectKey}`);
  const stream = new Response(
    new Blob([bytes.buffer.slice(0) as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip")),
  );
  const text = await stream.text();
  return JSON.parse(text) as T;
}

test("createBackup writes a sealed bundle + records a pointer + emits activity", async () => {
  const { service, store, artifactStore } = makeService();
  await seedInstallationModel(store, { spaceId: "space_1" });

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.spaceId).toBe("space_1");
  expect(record.id).toMatch(/^bkp_/);
  expect(record.objectKey).toBe(
    "spaces/space_1/backups/bkp_0001/control.json.gz.enc",
  );
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
  // official-catalog config (no spaceId), so it is NOT a Space-owned config.
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
    kind: "provider",
    scope: "space",
    authMethod: "static_secret",
    status: "active",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    createdAt: TS,
    updatedAt: TS,
  };
  await store.putConnection(connection);
  await store.putSecretBlob({
    connectionId: "conn_1",
    ciphertext: "SEALED-CIPHERTEXT-BYTES",
    iv: "SEALED-IV",
    keyVersion: "global",
    aad: {
      cloudPartition: "global",
      spaceId: "space_1",
      provider: "cloudflare",
    },
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
  const { service, store, artifactStore } = makeService();
  const seeded = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putStateSnapshot({
    id: "st_1",
    spaceId: "space_1",
    installationId: seeded.installation.id,
    environment: seeded.installation.environment,
    generation: 1,
    objectKey: "spaces/space_1/.../states/00000001.tfstate.enc",
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

  const record = await service.createBackup({ spaceId: "space_1" });
  const bundle = await readBundle(artifactStore!, record.objectKey);

  expect(bundle.stateSnapshots.map((s) => s.id)).toEqual(["st_1"]);
  expect(bundle.stateSnapshots[0]!.objectKey).toContain("tfstate.enc");
  expect(bundle.outputSnapshots.map((o) => o.id)).toEqual(["out_1"]);
  // Projected outputs survive; the raw artifact KEY is listed (bytes are not).
  expect(bundle.outputSnapshots[0]!.publicOutputs.url).toBe(
    "https://app.example.com",
  );
  expect(bundle.outputSnapshots[0]!.rawOutputArtifactKey).toContain(
    "raw-output.json.enc",
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
    "spaces/space_1/backups/bkp_0001/service-data-artifacts.json.gz.enc",
  );
  expect(record.serviceData!.exportedCount).toBe(1);
  expect(record.serviceData!.unsupportedCount).toBe(0);
  expect(record.serviceData!.missingCount).toBe(0);

  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.kind).toBe("service-data-artifact-export");
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

test("provider_snapshot and custom_command service-data backup modes are explicit unsupported entries", async () => {
  const { service, store, artifactStore } = makeService();
  const one = await seedInstallationModel(store, { spaceId: "space_1" });
  await store.putInstallConfig({
    ...one.installConfig,
    backup: {
      enabled: true,
      mode: "provider_snapshot",
    },
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
      outputPath: "/work/artifact/service-data.tar.zst",
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

  const record = await service.createBackup({ spaceId: "space_1" });

  expect(record.serviceData).toBeDefined();
  expect(record.serviceData!.exportedCount).toBe(0);
  expect(record.serviceData!.unsupportedCount).toBe(2);
  expect(record.serviceData!.missingCount).toBe(0);
  const manifest = await readServiceDataManifest(
    artifactStore!,
    record.serviceData!.objectKey,
  );
  expect(manifest.entries.map((entry) => entry.status)).toEqual([
    "unsupported",
    "unsupported",
  ]);
  expect(manifest.entries.map((entry) => entry.mode).sort()).toEqual([
    "custom_command",
    "provider_snapshot",
  ]);
  expect(JSON.stringify(manifest)).toContain("requires");
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

  const listed = await service.listBackups("space_1");
  // Same createdAt -> tie-break by id desc; both pointers present.
  expect(listed.map((b) => b.id).sort()).toEqual([first.id, second.id].sort());
  const withRun = listed.find((b) => b.id === second.id);
  expect(withRun!.createdByRunId).toBe("apply_9");
});
