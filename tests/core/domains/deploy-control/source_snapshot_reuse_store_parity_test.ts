import { expect, test } from "bun:test";

import type { OpenTofuControlStore, StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryOpenTofuControlStore, mergeReusableSourceSnapshotObservations, SourceSnapshotConflictError } from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import type { D1PreparedStatement, D1Result } from "../../../../worker/src/bindings.ts";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import type { Capsule } from "takosumi-contract/capsules";

const WORKSPACE = "workspace_snapshot_reuse";
const SOURCE = "src_snapshot_reuse";
const URL = "https://example.com/acme/repo.git";
const T0 = "2026-10-01T00:00:00.000Z";

class SnapshotLaneRaceD1 extends SqliteFakeD1 {
  beforeNextBatch?: () => Promise<void>;
  override async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    if (hook) await hook();
    return await super.batch<T>(statements);
  }
}

class SnapshotLaneRaceMemory extends InMemoryOpenTofuControlStore {
  onNextSourceRead?: () => Promise<void>;
  override async getSource(id: string): Promise<StoredSource | undefined> {
    const source = await super.getSource(id);
    const hook = this.onNextSourceRead;
    this.onNextSourceRead = undefined;
    if (hook) await hook();
    return source;
  }
}

function source(): StoredSource {
  return { id: SOURCE, workspaceId: WORKSPACE, name: "repo", url: URL, defaultRef: "main", defaultPath: ".",
    status: "active", createdAt: T0, updatedAt: T0, hookSecretHash: "hash", autoSync: true };
}

function workspace(): Workspace {
  return { id: WORKSPACE, handle: "snapshot-reuse", displayName: "Snapshot reuse", type: "personal",
    ownerUserId: "owner_snapshot_reuse", createdAt: T0, updatedAt: T0 };
}

function snapshot(n: number, commit: string, ref = "main", path = ".", metadata: Partial<SourceSnapshot> = {}): SourceSnapshot {
  const id = `snap_reuse_${n}`;
  const runId = `ssr_reuse_${n}`;
  const digest = `sha256:${String(n).padStart(64, "a")}`;
  return { id, origin: "git", workspaceId: WORKSPACE, sourceId: SOURCE, url: URL, ref,
    resolvedCommit: commit, path, archiveRef: `archive-${n}`, archiveDigest: digest,
    archiveSizeBytes: 4096, repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" }, repositoryModules: { status: "ready", scopePath: path, modules: [] },
    fetchedByRunId: runId, fetchedAt: `2026-10-01T00:00:0${n}.000Z`, ...metadata };
}

async function prepare(
  store: OpenTofuControlStore,
  n: number,
  commitHash: string,
  ref = "main",
  path = ".",
  metadata: Partial<SourceSnapshot> = {},
): Promise<{ readonly terminalRun: SourceSyncRun; readonly leaseToken: string; readonly snapshot: SourceSnapshot }> {
  const id = `ssr_reuse_${n}`;
  const createdAt = `2026-10-01T00:00:0${n}.000Z`;
  const queued: SourceSyncRun = { id, kind: "source_sync", workspaceId: WORKSPACE, sourceId: SOURCE,
    url: URL, ref, path, archiveRef: `archive-${n}`, status: "queued", createdAt, updatedAt: createdAt,
    snapshotId: `snap_reuse_${n}` };
  await store.beginSourceSyncRun(queued, { workspaceId: WORKSPACE, managementState: "active", managementEpoch: 1 });
  const running: SourceSyncRun = { ...queued, status: "running", startedAt: createdAt, updatedAt: createdAt, heartbeatAt: n };
  const claimed = await store.transitionRun({ id, kind: "source_sync", expectFrom: ["queued"], run: running,
    setLeaseToken: `lease-${n}`, heartbeatAt: n });
  expect(claimed.won).toBe(true);
  const observed = snapshot(n, commitHash, ref, path, metadata);
  const terminal: SourceSyncRun = { ...running, status: "succeeded", updatedAt: observed.fetchedAt,
    finishedAt: observed.fetchedAt, resolvedCommit: commitHash, archiveDigest: observed.archiveDigest,
    archiveSizeBytes: observed.archiveSizeBytes };
  return { terminalRun: terminal, leaseToken: `lease-${n}`, snapshot: observed };
}

async function commit(
  store: OpenTofuControlStore,
  n: number,
  commitHash: string,
  ref = "main",
  path = ".",
  metadata: Partial<SourceSnapshot> = {},
) {
  return await store.commitSourceSyncSuccess(await prepare(store, n, commitHash, ref, path, metadata));
}

test("all stores reuse only the newest matching lane snapshot and preserve/repair observations safely", async () => {
  const postgres = await PGliteSqlClient.create();
  try {
    const stores: ReadonlyArray<[string, OpenTofuControlStore]> = [
      ["memory", new InMemoryOpenTofuControlStore()],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    for (const [label, store] of stores) {
      await store.putWorkspace(workspace());
      await store.putSource(source());
      const a = "a".repeat(40);
      const b = "b".repeat(40);
      const manifestDigest = `sha256:${"c".repeat(64)}`;
      const first = await commit(store, 1, a, "main", ".", {
        repositoryInstallMetadata: { status: "present", text: "verified display metadata" },
        repositoryManifest: { status: "invalid", reason: "invalid_document", digest: manifestDigest },
        repositoryModules: { status: "invalid", scopePath: ".", reason: "scan_failed" },
      });
      expect(first.won, label).toBe(true);
      const same = await commit(store, 2, a, "main", ".", {
        repositoryInstallMetadata: { status: "invalid", reason: "too_large" },
        repositoryManifest: { status: "present", digest: manifestDigest, document: {
          apiVersion: "takosumi.com/v2.2", kind: "Repository", install: { modules: { ".": { inputs: [] } } },
        } as never },
        repositoryModules: { status: "ready", scopePath: ".", modules: [] },
      });
      expect(same.run?.snapshotId, label).toBe("snap_reuse_1");
      expect(same.run?.requestedSnapshotId, label).toBe("snap_reuse_2");
      expect(same.snapshot?.id, label).toBe("snap_reuse_1");
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(1);
      const canonical = (await store.getSourceSnapshot("snap_reuse_1"))!;
      expect(canonical.repositoryInstallMetadata, label).toEqual({ status: "present", text: "verified display metadata" });
      expect(canonical.repositoryManifest?.status, label).toBe("present");
      expect(canonical.repositoryModules?.status, label).toBe("ready");

      await commit(store, 3, b);
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(2);
      await commit(store, 4, a);
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(3);
      await commit(store, 5, a, "develop");
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(4);
      await commit(store, 6, a, "develop", "modules/app");
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(5);
      const changedReady = await commit(store, 7, a, "develop", "modules/app", {
        repositoryModules: { status: "ready", scopePath: "modules/app", modules: [
          { path: "modules/app", providerPackages: [], rootProviderRequirements: [] },
        ] },
      });
      expect(changedReady.won, label).toBe(true);
      expect(changedReady.run?.snapshotId, label).toBe("snap_reuse_7");
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(6);
      expect((await store.getLatestSourceSnapshotForLane({
        sourceId: SOURCE, workspaceId: WORKSPACE, url: URL, ref: "develop", path: "modules/app",
      }))?.id, label).toBe("snap_reuse_7");
      expect(await store.getLatestSourceSnapshotForLane({
        sourceId: SOURCE, workspaceId: WORKSPACE, url: URL, ref: "develop", path: "other",
      }), label).toBeUndefined();
      expect(await store.hasSourceSnapshotArchiveReference("archive-7"), label).toBe(true);
      expect(await store.hasSourceSnapshotArchiveReference("archive-unused"), label).toBe(false);
      await store.putSource({ ...source(), id: `${SOURCE}_other` });
      await store.putSourceSnapshot({ ...snapshot(8, a), sourceId: `${SOURCE}_other`,
        archiveRef: "archive-other-source" });
      expect(await store.hasSourceSnapshotArchiveReference("archive-other-source"), label).toBe(true);
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(6);
    }
  } finally {
    await postgres.close();
  }
});

test("snapshot observation merge preserves valid evidence, fills missing, repairs same-digest invalid and rejects digest drift", () => {
  const existing = snapshot(1, "a".repeat(40), "main", ".", {
    repositoryInstallMetadata: { status: "present", text: "valid" },
    repositoryManifest: { status: "present", digest: `sha256:${"c".repeat(64)}`, document: {
      apiVersion: "takosumi.com/v2.2", kind: "Repository", install: { modules: { ".": { inputs: [] } } },
    } as never },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
  });
  const observed = snapshot(2, "a".repeat(40), "main", ".", {
    repositoryInstallMetadata: { status: "invalid", reason: "too_large" },
    repositoryManifest: { status: "invalid", reason: "invalid_document", digest: `sha256:${"c".repeat(64)}` },
    repositoryModules: { status: "invalid", scopePath: ".", reason: "scan_failed" },
  });
  const preserved = mergeReusableSourceSnapshotObservations(existing, observed);
  expect(preserved?.repositoryInstallMetadata).toEqual(existing.repositoryInstallMetadata);
  expect(preserved?.repositoryManifest).toEqual(existing.repositoryManifest);
  expect(preserved?.repositoryModules).toEqual(existing.repositoryModules);
  expect(mergeReusableSourceSnapshotObservations(existing, {
    ...observed,
    repositoryManifest: { status: "present", digest: `sha256:${"f".repeat(64)}`, document: {
      apiVersion: "takosumi.com/v2.2", kind: "Repository", install: { modules: { ".": { inputs: [] } } },
    } as never },
  })).toBeUndefined();
  expect(mergeReusableSourceSnapshotObservations(existing, {
    ...observed,
    repositoryManifest: { status: "absent" },
  })).toBeUndefined();
  expect(() => mergeReusableSourceSnapshotObservations(existing, {
    ...existing, repositoryModules: { status: "ready", scopePath: ".", modules: [
      { path: ".", providerPackages: [], rootProviderRequirements: [] },
    ] },
  })).toThrow(SourceSnapshotConflictError);

  const digest = `sha256:${"d".repeat(64)}`;
  const invalid = { ...existing, repositoryManifest: { status: "invalid" as const, reason: "invalid_document" as const, digest } };
  const repaired = mergeReusableSourceSnapshotObservations(invalid, {
    ...observed, repositoryManifest: { status: "present", digest, document: {
      apiVersion: "takosumi.com/v2.2", kind: "Repository", install: { modules: { ".": { inputs: [] } } },
    } as never },
  });
  expect(repaired?.repositoryManifest?.status).toBe("present");
  expect(mergeReusableSourceSnapshotObservations(invalid, {
    ...observed, repositoryManifest: { status: "present", digest: `sha256:${"e".repeat(64)}`, document: {
      apiVersion: "takosumi.com/v2.2", kind: "Repository", install: { modules: { ".": { inputs: [] } } },
    } as never },
  })).toBeUndefined();
});

test("D1 retries a newer same-lane snapshot inserted after reuse selection", async () => {
  const db = new SnapshotLaneRaceD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace(workspace());
  await store.putSource(source());
  const a = "a".repeat(40);
  await commit(store, 1, a);
  const input = await prepare(store, 2, a);
  db.beforeNextBatch = async () => {
    await store.putSourceSnapshot(snapshot(3, "b".repeat(40)));
  };
  const result = await store.commitSourceSyncSuccess(input);
  expect(result.won).toBe(true);
  expect(result.run?.snapshotId).toBe("snap_reuse_2");
  expect((await store.getSourceSyncRun("ssr_reuse_2"))?.status).toBe("succeeded");
  expect((await store.listSourceSnapshots(SOURCE)).map((row) => row.id).sort()).toEqual([
    "snap_reuse_1", "snap_reuse_2", "snap_reuse_3",
  ]);
});

test("in-memory concurrent same-lane settlements retry observation and reuse the winner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace(workspace());
  await store.putSource(source());
  const a = "a".repeat(40);
  const [first, second] = await Promise.all([prepare(store, 1, a), prepare(store, 2, a)]);
  const results = await Promise.allSettled([
    store.commitSourceSyncSuccess(first),
    store.commitSourceSyncSuccess(second),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
  expect((await store.listSourceSnapshots(SOURCE)).length).toBe(1);
  const runs = await Promise.all([
    store.getSourceSyncRun(first.terminalRun.id),
    store.getSourceSyncRun(second.terminalRun.id),
  ]);
  expect(runs.filter((run) => run?.status === "succeeded")).toHaveLength(2);
  expect(runs[0]?.snapshotId).toBe(runs[1]?.snapshotId);
});

test("in-memory lane retry refreshes its owner and ignores unrelated app changes", async () => {
  const store = new SnapshotLaneRaceMemory();
  await store.putWorkspace(workspace());
  await store.putSource({ ...source(), ownerCapsuleId: "cap_reuse_race" });
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const capsule: Capsule = {
    id: "cap_reuse_race", workspaceId: WORKSPACE, projectId: "project_reuse_race",
    name: "race", slug: "race", sourceId: SOURCE, installConfigId: "config_reuse_race",
    installingPrincipalId: "principal_reuse_race", environment: "production",
    currentStateGeneration: 0, status: "active", createdAt: T0, updatedAt: T0,
  };
  await store.putCapsule(capsule);
  await commit(store, 1, a);
  const input = await prepare(store, 2, a);
  store.onNextSourceRead = async () => {
    expect((await commit(store, 3, b)).won).toBe(true);
    await store.putCapsule({ ...capsule, status: "stale" });
  };
  expect((await store.commitSourceSyncSuccess(input)).won).toBe(true);
  expect((await store.getSourceSyncRun("ssr_reuse_2"))?.status).toBe("succeeded");
  expect((await store.listSourceSnapshots(SOURCE)).map((row) => row.id).sort()).toEqual([
    "snap_reuse_1", "snap_reuse_2", "snap_reuse_3",
  ]);

  const unrelated = await prepare(store, 4, a);
  store.onNextSourceRead = async () => {
    await store.putCapsule({ ...capsule, id: "cap_unrelated", name: "unrelated", slug: "unrelated", sourceId: "src_unrelated" });
  };
  expect((await store.commitSourceSyncSuccess(unrelated)).won).toBe(true);
  expect((await store.getSourceSyncRun("ssr_reuse_4"))?.status).toBe("succeeded");

  const changedOwner = await prepare(store, 5, a);
  store.onNextSourceRead = async () => { await store.putCapsule(capsule); };
  await expect(store.commitSourceSyncSuccess(changedOwner)).rejects.toThrow("SourceSync settlement observations changed");
  expect((await store.getSourceSyncRun("ssr_reuse_5"))?.status).toBe("running");
});

test("a same-commit re-sync records resolvedRef on the existing snapshot in every store", async () => {
  const postgres = await PGliteSqlClient.create();
  try {
    const stores: ReadonlyArray<[string, OpenTofuControlStore]> = [
      ["memory", new InMemoryOpenTofuControlStore()],
      ["postgres", new SqlOpenTofuControlStore({ client: postgres })],
      ["d1", new CloudflareD1OpenTofuControlStore(new SqliteFakeD1())],
    ];
    for (const [label, store] of stores) {
      await store.putWorkspace(workspace());
      await store.putSource(source());
      const a = "a".repeat(40);
      // A snapshot fetched before the runner recorded resolvedRef (it may be adopted).
      expect((await commit(store, 1, a, "HEAD")).won, label).toBe(true);
      expect((await store.getSourceSnapshot("snap_reuse_1"))?.resolvedRef, label).toBeUndefined();
      const resynced = await commit(store, 2, a, "HEAD", ".", { resolvedRef: "refs/heads/main" });
      expect(resynced.snapshot?.id, label).toBe("snap_reuse_1");
      expect((await store.getSourceSnapshot("snap_reuse_1"))?.resolvedRef, label).toBe("refs/heads/main");
      expect((await store.listSourceSnapshots(SOURCE)).length, label).toBe(1);
      // A new commit is a new snapshot; the earlier one keeps its record.
      const b = "b".repeat(40);
      expect((await commit(store, 3, b, "HEAD", ".", { resolvedRef: "refs/heads/main" })).snapshot?.id, label).toBe("snap_reuse_3");
      expect((await store.getSourceSnapshot("snap_reuse_1"))?.resolvedRef, label).toBe("refs/heads/main");
    }
  } finally {
    await postgres.close();
  }
});
