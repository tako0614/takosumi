import { expect, test } from "bun:test";

import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { D1PreparedStatement, D1Result } from "../../../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../worker/src/d1_opentofu_store.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

const workspaceId = "workspace_d1_lane_race";
const sourceId = "source_d1_lane_race";
const url = "https://example.com/repo.git";
const t0 = "2026-10-01T00:00:00.000Z";
const commit = "a".repeat(40);

class InterleavedD1 extends SqliteFakeD1 {
  beforeNextBatch?: () => Promise<void>;

  override async batch<T = unknown>(
    statements: readonly D1PreparedStatement[],
  ): Promise<readonly D1Result<T>[]> {
    const hook = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    if (hook) await hook();
    return await super.batch<T>(statements);
  }
}

async function prepare(
  store: CloudflareD1OpenTofuControlStore,
  n: number,
) {
  const id = `ssr_d1_lane_race_${n}`;
  const snapshotId = `snapshot_d1_lane_race_${n}`;
  const at = `2026-10-01T00:00:0${n}.000Z`;
  const leaseToken = `lease_d1_lane_race_${n}`;
  const queued: SourceSyncRun = {
    id, kind: "source_sync", workspaceId, sourceId, url, ref: "main", path: ".",
    archiveRef: `archive-${n}`, snapshotId, status: "queued", createdAt: at, updatedAt: at,
  };
  await store.beginSourceSyncRun(queued, {
    workspaceId, managementState: "active", managementEpoch: 1,
  });
  const running: SourceSyncRun = {
    ...queued, status: "running", startedAt: at, heartbeatAt: n,
  };
  expect((await store.transitionRun({
    id, kind: "source_sync", expectFrom: ["queued"], run: running,
    setLeaseToken: leaseToken, heartbeatAt: n,
  })).won).toBe(true);
  const snapshot: SourceSnapshot = {
    id: snapshotId, origin: "git", workspaceId, sourceId, url, ref: "main",
    resolvedCommit: commit, path: ".", archiveRef: `archive-${n}`,
    archiveDigest: `sha256:${String(n).repeat(64)}`, archiveSizeBytes: 4096,
    repositoryInstallMetadata: { status: "absent" },
    repositoryManifest: { status: "absent" },
    repositoryModules: { status: "ready", scopePath: ".", modules: [] },
    fetchedByRunId: id, fetchedAt: at,
  };
  const terminalRun: SourceSyncRun = {
    ...running, status: "succeeded", finishedAt: at, resolvedCommit: commit,
    archiveDigest: snapshot.archiveDigest, archiveSizeBytes: snapshot.archiveSizeBytes,
  };
  return { terminalRun, leaseToken, snapshot };
}

test("D1 retries a same-lane settlement race while both leases remain held", async () => {
  const db = new InterleavedD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace({
    id: workspaceId, handle: "d1-lane-race", displayName: "D1 lane race",
    type: "personal", ownerUserId: "owner_d1_lane_race",
    createdAt: t0, updatedAt: t0,
  });
  await store.putSource({
    id: sourceId, workspaceId, name: "repo", url, defaultRef: "main",
    defaultPath: ".", status: "active", autoSync: true, hookSecretHash: "hash",
    createdAt: t0, updatedAt: t0,
  });
  const first = await prepare(store, 1);
  const second = await prepare(store, 2);
  db.beforeNextBatch = async () => {
    const winner = await store.commitSourceSyncSuccess(second);
    expect(winner.won).toBe(true);
  };

  const loser = await store.commitSourceSyncSuccess(first);
  expect(loser.won).toBe(true);
  expect(loser.run?.snapshotId).toBe(second.snapshot.id);
  expect(loser.run?.requestedSnapshotId).toBe(first.snapshot.id);
  expect((await store.listSourceSnapshots(sourceId)).map((row) => row.id)).toEqual([
    second.snapshot.id,
  ]);
  expect((await store.getSourceSyncRun(first.terminalRun.id))?.status).toBe("succeeded");
  expect((await store.getSourceSyncRun(second.terminalRun.id))?.status).toBe("succeeded");
});

test("D1 retries when the same lane snapshot gains repaired evidence", async () => {
  const db = new InterleavedD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  await store.putWorkspace({
    id: workspaceId, handle: "d1-lane-race", displayName: "D1 lane race",
    type: "personal", ownerUserId: "owner_d1_lane_race",
    createdAt: t0, updatedAt: t0,
  });
  await store.putSource({
    id: sourceId, workspaceId, name: "repo", url, defaultRef: "main",
    defaultPath: ".", status: "active", autoSync: true, hookSecretHash: "hash",
    createdAt: t0, updatedAt: t0,
  });
  const original = await prepare(store, 1);
  const originalWithInvalid = { ...original, snapshot: {
    ...original.snapshot,
    repositoryInstallMetadata: { status: "invalid", reason: "too_large" } as const,
  } };
  expect((await store.commitSourceSyncSuccess(originalWithInvalid)).won).toBe(true);

  const first = await prepare(store, 2);
  const firstWithInvalid = { ...first, snapshot: {
    ...first.snapshot,
    repositoryInstallMetadata: { status: "invalid", reason: "too_large" } as const,
  } };
  const second = await prepare(store, 3);
  const secondWithRepair = { ...second, snapshot: {
    ...second.snapshot,
    repositoryInstallMetadata: { status: "present", text: "repaired" } as const,
  } };
  db.beforeNextBatch = async () => {
    expect((await store.commitSourceSyncSuccess(secondWithRepair)).won).toBe(true);
  };

  const loser = await store.commitSourceSyncSuccess(firstWithInvalid);
  expect(loser.won).toBe(true);
  expect(loser.run?.snapshotId).toBe(original.snapshot.id);
  expect((await store.getSourceSnapshot(original.snapshot.id))?.repositoryInstallMetadata)
    .toEqual({ status: "present", text: "repaired" });
  expect((await store.listSourceSnapshots(sourceId)).map((row) => row.id))
    .toEqual([original.snapshot.id]);
});
