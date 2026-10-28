import { expect, test } from "bun:test";

import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Workspace } from "takosumi-contract/workspaces";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import type { StoredSource } from "../../../../core/domains/deploy-control/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";

test("Postgres settles a reused legacy archive alias using the raw snapshot CAS", async () => {
  const client = await PGliteSqlClient.create();
  try {
    const store = new SqlOpenTofuControlStore({ client });
    const workspaceId = "workspace_pg_legacy_snapshot";
    const sourceId = "source_pg_legacy_snapshot";
    const url = "https://example.com/repository.git";
    const commit = "a".repeat(40);
    const createdAt = "2026-10-01T00:00:00.000Z";
    const workspace: Workspace = {
      id: workspaceId, handle: "pg-legacy-snapshot", displayName: "PG legacy snapshot",
      type: "personal", ownerUserId: "owner_pg_legacy_snapshot", createdAt, updatedAt: createdAt,
    };
    const source: StoredSource = {
      id: sourceId, workspaceId, name: "repository", url, defaultRef: "main",
      defaultPath: ".", status: "active", createdAt, updatedAt: createdAt,
      hookSecretHash: "hash", autoSync: false,
    };
    await store.putWorkspace(workspace);
    await store.putSource(source);

    const old: SourceSnapshot = {
      id: "snapshot_pg_legacy_old", origin: "git", workspaceId, sourceId,
      url, ref: "main", path: ".", resolvedCommit: commit,
      archiveRef: `workspaces/${workspaceId}/sources/${sourceId}/snapshots/snapshot_pg_legacy_old/source.tar.zst`,
      archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 4096,
      repositoryInstallMetadata: { status: "absent" },
      repositoryManifest: { status: "absent" },
      repositoryModules: { status: "ready", scopePath: ".", modules: [] },
      fetchedByRunId: "sync_pg_legacy_old", fetchedAt: "2026-10-01T00:00:01.000Z",
    };
    const { archiveRef: legacyArchive, ...oldWithoutArchiveRef } = old;
    await client.query(
      `insert into takosumi_source_snapshots (id, source_id, snapshot_json, fetched_at)
       values ($1, $2, $3::jsonb, $4)`,
      [old.id, sourceId, JSON.stringify({ ...oldWithoutArchiveRef, archiveObjectKey: legacyArchive }), old.fetchedAt],
    );

    const runId = "sync_pg_legacy_new";
    const fetchedAt = "2026-10-01T00:00:02.000Z";
    const requestedSnapshotId = "snapshot_pg_legacy_new";
    const allocatedArchive = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/${requestedSnapshotId}/source.tar.zst`;
    const queued: SourceSyncRun = {
      id: runId, kind: "source_sync", workspaceId, sourceId,
      url, ref: "main", path: ".", archiveRef: allocatedArchive,
      status: "queued", createdAt: fetchedAt, updatedAt: fetchedAt,
      snapshotId: requestedSnapshotId,
    };
    await store.beginSourceSyncRun(queued, {
      workspaceId, managementState: "active", managementEpoch: 1,
    });
    const running: SourceSyncRun = {
      ...queued, status: "running", startedAt: fetchedAt,
      updatedAt: fetchedAt, heartbeatAt: 1,
    };
    const leaseToken = "lease_pg_legacy_new";
    expect((await store.transitionRun({
      id: runId, kind: "source_sync", expectFrom: ["queued"], run: running,
      setLeaseToken: leaseToken, heartbeatAt: 1,
    })).won).toBe(true);
    const observed: SourceSnapshot = {
      ...old, id: requestedSnapshotId, archiveRef: allocatedArchive,
      fetchedByRunId: runId, fetchedAt,
    };
    const terminalRun: SourceSyncRun = {
      ...running, status: "succeeded", finishedAt: fetchedAt, updatedAt: fetchedAt,
      resolvedCommit: commit, archiveDigest: observed.archiveDigest,
      archiveSizeBytes: observed.archiveSizeBytes,
    };
    const committed = await store.commitSourceSyncSuccess({ terminalRun, leaseToken, snapshot: observed });
    expect(committed.won).toBe(true);
    expect(committed.run?.snapshotId).toBe(old.id);
    expect(committed.run?.requestedSnapshotId).toBe(requestedSnapshotId);
    expect(committed.snapshot?.archiveRef).toBe(legacyArchive);
    expect((await store.listSourceSnapshots(sourceId)).map((row) => row.id)).toEqual([old.id]);
    const persisted = await client.query<{ readonly snapshot_json: SourceSnapshot & { readonly archiveObjectKey?: string } }>(
      "select snapshot_json from takosumi_source_snapshots where id = $1",
      [old.id],
    );
    expect(persisted.rows[0]?.snapshot_json.archiveRef).toBe(legacyArchive);
    expect(persisted.rows[0]?.snapshot_json.archiveObjectKey).toBeUndefined();
  } finally {
    await client.close();
  }
});
