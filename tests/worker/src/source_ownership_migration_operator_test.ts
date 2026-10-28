import { expect, test } from "bun:test";
import type { SourceOwnershipMigrationGroup, SourceOwnershipMigrationMutation,
  SourceOwnershipMigrationStore } from "../../../core/domains/sources/ownership-migration.ts";
import { handleSourceOwnershipMigrationOperatorRequest, R2SourceOwnershipArchiveCopier,
  SOURCE_OWNERSHIP_MIGRATION_PATH } from "../../../worker/src/source_ownership_migration_operator.ts";
import type { CloudflareWorkerEnv, R2Bucket } from "../../../worker/src/bindings.ts";

const origin = `https://operator.test${SOURCE_OWNERSHIP_MIGRATION_PATH}`;
const token = "test-operator-token";
const env = { TAKOSUMI_DEPLOY_CONTROL_TOKEN: token, TAKOSUMI_CONTROL_DB: {} } as CloudflareWorkerEnv;
const group: SourceOwnershipMigrationGroup = {
  source: { id: "src_legacy", workspaceId: "ws_1", name: "legacy", url: "https://example.test/repo.git",
    defaultRef: "main", defaultPath: ".", status: "active", autoSync: true, hookSecretHash: "a".repeat(64),
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
  capsules: [{ capsule: { id: "cap_1", workspaceId: "ws_1", projectId: "prj_1", name: "app",
    slug: "app", sourceId: "src_legacy", installConfigId: "cfg_1", environment: "production",
    currentStateGeneration: 0, status: "active", createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z" } }],
  snapshots: [], syncRuns: [], compatibilityRuns: [], planRuns: [], reports: [], gitPlans: [],
  installConfigs: [{ id: "cfg_1", workspaceId: "ws_1", name: "config", variableMapping: {} }],
  inFlightRunIds: [],
};

class FixtureStore implements SourceOwnershipMigrationStore {
  current: SourceOwnershipMigrationGroup = structuredClone(group);
  commits = 0;
  async listSourceIds() { return [this.current.source.id]; }
  async readGroup(id: string) { return id === this.current.source.id ? this.current : undefined; }
  async commitGroup(mutation: SourceOwnershipMigrationMutation): Promise<"committed"> {
    this.commits++;
    this.current = { ...this.current, source: mutation.retainedSource };
    return "committed";
  }
}

test("protected endpoint is read-only by default and applies only an exact dry-run digest", async () => {
  const store = new FixtureStore();
  const copier = { copyVerified: async () => { throw new Error("no archive expected"); } };
  const unauthorized = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin), env, { store, copier });
  expect(unauthorized?.status).toBe(401);
  const get = await handleSourceOwnershipMigrationOperatorRequest(new Request(`${origin}?sourceId=src_legacy`, {
    headers: { authorization: `Bearer ${token}` },
  }), env, { store, copier });
  expect(get?.status).toBe(200);
  const body = await get!.json() as { preparedAt: string; reportDigest: string;
    results: Array<{ status: string; inventory: { action: string } }> };
  expect(body.results[0]?.status).toBe("dry_run");
  expect(body.results[0]?.inventory.action).toBe("backfill");
  expect(store.commits).toBe(0);
  const bad = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: body.preparedAt,
      reportDigest: `sha256:${"0".repeat(64)}` }),
  }), env, { store, copier });
  expect(bad?.status).toBe(409);
  expect(store.commits).toBe(0);
  store.current = { ...store.current, source: { ...store.current.source, defaultRef: "changed" } };
  const changed = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: body.preparedAt,
      reportDigest: body.reportDigest }),
  }), env, { store, copier });
  expect(changed?.status).toBe(409);
  expect(store.commits).toBe(0);
  store.current = structuredClone(group);
  const apply = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: body.preparedAt,
      reportDigest: body.reportDigest }),
  }), env, { store, copier });
  expect(apply?.status).toBe(200);
  expect(store.commits).toBe(1);
  expect(store.current.source.ownerCapsuleId).toBe("cap_1");
});

test("stored-service composition refuses apply before R2 copy or DB commit", async () => {
  const store = new FixtureStore();
  store.current = { ...structuredClone(group), source: { ...group.source, ownerCapsuleId: "cap_1" },
    snapshots: [{ id: "snap_foreign", origin: "git", workspaceId: "ws_1", sourceId: "src_legacy",
      url: "https://example.test/repo.git", ref: "main", path: ".", resolvedCommit: "abc",
      archiveRef: "workspaces/ws_1/sources/src_other/snapshots/snap_foreign/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
      fetchedByRunId: "ssr_foreign", fetchedAt: "2026-10-01T00:00:00.000Z" }] };
  let reads = 0, writes = 0, injectedCopies = 0;
  const bucket = { get: async () => { reads++; return null; },
    put: async () => { writes++; return null; } } as unknown as R2Bucket;
  const storedEnv = { ...env, R2_SOURCE: bucket,
    TAKOSUMI_STORED_SERVICE_USAGE: {}, TAKOSUMI_STORED_OBJECT_OWNERS: {} } as CloudflareWorkerEnv;
  const dryRun = await handleSourceOwnershipMigrationOperatorRequest(new Request(`${origin}?sourceId=src_legacy`, {
    headers: { authorization: `Bearer ${token}` },
  }), storedEnv, { store });
  expect(dryRun?.status).toBe(200);
  const dry = await dryRun!.json() as { preparedAt: string; reportDigest: string };
  const request = () => new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: dry.preparedAt, reportDigest: dry.reportDigest }),
  });
  for (const dependencies of [{ store }, { store, copier: { copyVerified: async () => { injectedCopies++; } } }]) {
    const response = await handleSourceOwnershipMigrationOperatorRequest(request(), storedEnv, dependencies);
    expect(response?.status).toBe(503);
    expect(await response!.json()).toEqual({ error: "source_archive_custody_unavailable" });
  }
  expect(reads).toBe(0);
  expect(writes).toBe(0);
  expect(injectedCopies).toBe(0);
  expect(store.commits).toBe(0);
});

test("R2 archive copier verifies bytes, uses create-only write, and rejects mismatched replay", async () => {
  const sourceKey = "workspaces/ws_1/sources/src_old/snapshots/snap_1/source.tar.zst";
  const targetKey = "workspaces/ws_1/sources/src_new/snapshots/snap_1/source.tar.zst";
  const bytes = new TextEncoder().encode("archive bytes");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const objects = new Map([[sourceKey, bytes]]);
  let writes = 0;
  const bucket = {
    get: async (key: string) => {
      const data = objects.get(key);
      return data ? { size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) } : null;
    },
    put: async (key: string, value: Uint8Array, options: { onlyIf?: { etagDoesNotMatch?: string } }) => {
      expect(options.onlyIf?.etagDoesNotMatch).toBe("*");
      if (objects.has(key)) return null;
      writes++;
      objects.set(key, value);
      return { size: value.length };
    },
  } as unknown as R2Bucket;
  const copier = new R2SourceOwnershipArchiveCopier(bucket);
  await copier.copyVerified({ from: sourceKey, to: targetKey, digest, sizeBytes: bytes.length });
  await copier.copyVerified({ from: sourceKey, to: targetKey, digest, sizeBytes: bytes.length });
  expect(writes).toBe(1);
  expect(copier.copyVerified({ from: sourceKey, to: targetKey, digest: `sha256:${"0".repeat(64)}`,
    sizeBytes: bytes.length })).rejects.toThrow("digest_mismatch");
});

test("R2 archive copier refuses corrupted post-write readback", async () => {
  const sourceKey = "workspaces/ws_1/sources/src_old/snapshots/snap_2/source.tar.zst";
  const targetKey = "workspaces/ws_1/sources/src_new/snapshots/snap_2/source.tar.zst";
  const bytes = new TextEncoder().encode("correct archive");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const digest = `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const stored = new Map([[sourceKey, bytes]]);
  const bucket = {
    get: async (key: string) => {
      const value = stored.get(key);
      return value ? { size: value.length, arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null;
    },
    put: async (key: string, value: Uint8Array) => {
      stored.set(key, new Uint8Array(value.length));
      return { size: value.length };
    },
  } as unknown as R2Bucket;
  expect(new R2SourceOwnershipArchiveCopier(bucket).copyVerified({ from: sourceKey, to: targetKey,
    digest, sizeBytes: bytes.length })).rejects.toThrow("digest_mismatch");
});

test("operator POST resumes a large archive set with a bound copy receipt", async () => {
  const store = new FixtureStore();
  store.current = { ...structuredClone(group), source: { ...group.source, ownerCapsuleId: "cap_1" },
    snapshots: Array.from({ length: 17 }, (_, index) => ({
      id: `snap_${index}`, origin: "git" as const, workspaceId: "ws_1", sourceId: "src_legacy",
      url: "https://example.test/repo.git", ref: "main", path: ".", resolvedCommit: "abc",
      archiveRef: `workspaces/ws_1/sources/src_foreign/snapshots/snap_${index}/source.tar.zst`,
      archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
      fetchedByRunId: `ssr_${index}`, fetchedAt: "2026-10-01T00:00:00.000Z",
    })) };
  let copied = 0;
  const copier = { copyVerified: async () => { copied++; } };
  const get = await handleSourceOwnershipMigrationOperatorRequest(new Request(`${origin}?sourceId=src_legacy`, {
    headers: { authorization: `Bearer ${token}` },
  }), env, { store, copier });
  const dry = await get!.json() as { preparedAt: string; reportDigest: string };
  const first = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: dry.preparedAt, reportDigest: dry.reportDigest }),
  }), env, { store, copier });
  expect(first?.status).toBe(202);
  const pending = await first!.json() as { nextCopyCursor: number; copyReceipt: string };
  expect(pending.nextCopyCursor).toBe(16);
  expect(copied).toBe(16);
  expect(store.commits).toBe(0);
  const forged = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: dry.preparedAt,
      reportDigest: dry.reportDigest, copyCursor: 16, copyReceipt: "0".repeat(64) }),
  }), env, { store, copier });
  expect(forged?.status).toBe(409);
  expect(copied).toBe(16);
  const final = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sourceId: "src_legacy", preparedAt: dry.preparedAt,
      reportDigest: dry.reportDigest, copyCursor: pending.nextCopyCursor,
      copyReceipt: pending.copyReceipt }),
  }), env, { store, copier });
  expect(final?.status).toBe(200);
  expect(copied).toBe(17);
  expect(store.commits).toBe(1);
});

test("failed archive readback prevents the DB group commit", async () => {
  const store = new FixtureStore();
  store.current = { ...structuredClone(group), source: { ...group.source, ownerCapsuleId: "cap_1" },
    snapshots: [{ id: "snap_foreign", origin: "git", workspaceId: "ws_1", sourceId: "src_legacy",
      url: "https://example.test/repo.git", ref: "main", path: ".", resolvedCommit: "abc",
      archiveRef: "workspaces/ws_1/sources/src_other/snapshots/snap_foreign/source.tar.zst",
      archiveDigest: `sha256:${"a".repeat(64)}`, archiveSizeBytes: 1,
      fetchedByRunId: "ssr_foreign", fetchedAt: "2026-10-01T00:00:00.000Z" }] };
  const copier = { copyVerified: async () => { throw new Error("source_archive_copy_readback_missing"); } };
  const dry = await handleSourceOwnershipMigrationOperatorRequest(new Request(`${origin}?sourceId=src_legacy`, {
    headers: { authorization: `Bearer ${token}` },
  }), env, { store, copier });
  const body = await dry!.json() as { preparedAt: string; reportDigest: string };
  const previousError = console.error;
  console.error = () => {};
  try {
    const apply = await handleSourceOwnershipMigrationOperatorRequest(new Request(origin, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sourceId: "src_legacy", preparedAt: body.preparedAt,
        reportDigest: body.reportDigest }),
    }), env, { store, copier });
    expect(apply?.status).toBe(500);
    expect(store.commits).toBe(0);
  } finally {
    console.error = previousError;
  }
});
