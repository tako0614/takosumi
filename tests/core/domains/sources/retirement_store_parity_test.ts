import { expect, test } from "bun:test";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryOpenTofuControlStore, type OpenTofuControlStore, type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const WS = "workspace_retirement";
const SRC = "source_retirement";
const ref = `workspaces/${WS}/sources/${SRC}/snapshots/snapshot_retirement/source.tar.zst`;
const runRef = `workspaces/${WS}/sources/${SRC}/snapshots/snapshot_run/source.tar.zst`;

async function adapters(): Promise<readonly { name: string; store: OpenTofuControlStore; close(): Promise<void> }[]> {
  const pg = await PGliteSqlClient.create();
  return [
    { name: "memory", store: new InMemoryOpenTofuControlStore(), close: async () => {} },
    { name: "postgres", store: new SqlOpenTofuControlStore({ client: pg }), close: () => pg.close() },
    { name: "d1", store: new CloudflareD1OpenTofuControlStore(new SqliteFakeD1()), close: async () => {} },
  ];
}

async function seed(store: OpenTofuControlStore): Promise<StoredSource> {
  await store.putWorkspace({ id: WS, handle: WS, displayName: WS, type: "personal",
    ownerUserId: "owner_retirement", createdAt: NOW, updatedAt: NOW });
  const source: StoredSource = { id: SRC, workspaceId: WS, name: "Retirement",
    url: "https://github.com/example/retirement.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: true, hookSecretHash: "hash", createdAt: NOW, updatedAt: NOW };
  await store.putSource(source);
  const snapshot: SourceSnapshot = { id: "snapshot_retirement", origin: "git", workspaceId: WS,
    sourceId: SRC, url: source.url, ref: "main", path: ".", resolvedCommit: "a".repeat(40),
    archiveRef: ref, archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "sync_retirement", fetchedAt: NOW };
  await store.putSourceSnapshot(snapshot);
  const run: SourceSyncRun = { id: "sync_retirement", kind: "source_sync", workspaceId: WS,
    sourceId: SRC, url: source.url, ref: "main", path: ".", archiveRef: runRef,
    status: "succeeded", createdAt: NOW, updatedAt: NOW, finishedAt: NOW };
  await store.putSourceSyncRun(run);
  return source;
}

test("retirement keeps its work list after custody failure, then resumes across all stores", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      let attempts = 0;
      const deleted: string[][] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => {
          deleted.push([...archiveRefs]);
          if (++attempts === 1) throw new Error("injected custody failure");
        },
      });
      await expect(service.retireOwnedSource(SRC, "destroyed"), name).rejects.toThrow("injected custody failure");
      expect(await store.getSource(SRC), name).toMatchObject({ status: "disabled", autoSync: false, retiringAt: NOW });
      expect((await service.getSource(SRC)).source, name).not.toHaveProperty("retiringAt");
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(1);
      await expect(service.createSync(SRC), name).rejects.toMatchObject({ details: { reason: "source_not_active" } });
      await expect(service.patchSource(SRC, { status: "active" }), name)
        .rejects.toMatchObject({ details: { reason: "source_retiring" } });
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("already_retired");
      expect(deleted, name).toEqual([[ref, runRef], [ref, runRef]]);
      expect(await store.getSource(SRC), name).toBeUndefined();
      expect(await store.listSourceSnapshots(SRC), name).toEqual([]);
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.retired"), name)
        .toHaveLength(1);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retirement refuses live references and a changed archive census atomically", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const source = await seed(store);
      const marked = { ...source, status: "disabled" as const, autoSync: false, retiringAt: NOW };
      await store.putSource(marked);
      const input = { expectedSource: marked,
        expectedWorkspaceManagementAuthority: { workspaceId: WS, managementState: "active" as const, managementEpoch: 1 },
        expectedSnapshotCount: 0, expectedSourceSyncRunCount: 1,
        activity: { id: `act_${name}`, workspaceId: WS, action: "source.retired",
          targetType: "source", targetId: SRC, metadata: {}, createdAt: NOW } };
      expect((await store.retireSource(input)).status, name).toBe("conflict");
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(1);
      await store.putCapsule({ id: "cap_live", workspaceId: WS, projectId: "project_retirement",
        name: "live", slug: "live", sourceId: SRC, installConfigId: "config_retirement",
        environment: "production", status: "active", currentStateGeneration: 0,
        createdAt: NOW, updatedAt: NOW });
      const blocked = await store.retireSource({ ...input, expectedSnapshotCount: 1 });
      expect(blocked, name).toMatchObject({ status: "blocked" });
      expect(await store.getSource(SRC), name).toBeDefined();
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(1);
      expect(await store.listActivityEvents(WS), name).toEqual([]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retirement defers an in-flight sync and leaves historically shared archives for migration", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      const originalRun = (await store.listSourceSyncRuns(SRC))[0]!;
      await store.putSourceSyncRun({ ...originalRun, status: "queued", finishedAt: undefined });
      let deleted = false;
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async () => { deleted = true; },
      });
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("deferred");
      expect(deleted, name).toBe(false);
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(1);
      await store.putSourceSyncRun(originalRun);
      await store.putSourceSnapshot({ ...(await store.listSourceSnapshots(SRC))[0]!,
        id: "snapshot_foreign", sourceId: "source_foreign", fetchedByRunId: "sync_foreign" });
      await expect(service.retireOwnedSource(SRC, "destroyed"), name).rejects.toMatchObject({
        details: { reason: "source_archive_shared_by_another_source" },
      });
      expect(deleted, name).toBe(false);
      expect(await store.getSource(SRC), name).toBeDefined();
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(1);
      expect(await store.listActivityEvents(WS), name).toEqual([]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retirement removes its own archive but leaves an external historical archive in custody", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      const run = (await store.listSourceSyncRuns(SRC))[0]!;
      const externalRef = `workspaces/${WS}/sources/source_foreign/snapshots/snapshot_foreign/source.tar.zst`;
      await store.putSourceSyncRun({ ...run, archiveRef: externalRef });
      let removed: readonly string[] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => { removed = archiveRefs; },
      });
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      expect(removed, name).toEqual([ref]);
      expect(await store.getSource(SRC), name).toBeUndefined();
      expect(await store.listSourceSnapshots(SRC), name).toEqual([]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);
