import { expect, test } from "bun:test";
import type { SourceSyncRun } from "takosumi-contract/sources";
import {
  ObjectKeyArtifactReferenceAllocator, type ArtifactReferenceAllocator,
} from "../../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryOpenTofuControlStore, type OpenTofuControlStore, type StoredSource,
  type WorkspaceManagementAuthority,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const WS = "workspace_retirement_admission";
const SRC = "source_retirement_admission";
const authority: WorkspaceManagementAuthority = {
  workspaceId: WS, managementState: "active", managementEpoch: 1,
};

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
    ownerUserId: "owner_retirement_admission", createdAt: NOW, updatedAt: NOW });
  const source: StoredSource = { id: SRC, workspaceId: WS, name: "Retirement admission",
    url: "https://github.com/example/retirement-admission.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: true, hookSecretHash: "hash", createdAt: NOW, updatedAt: NOW };
  await store.putSource(source);
  return source;
}

function queued(source: StoredSource, id: string): SourceSyncRun {
  return { id, kind: "source_sync", workspaceId: WS, sourceId: SRC,
    url: source.url, ref: source.defaultRef, path: source.defaultPath,
    archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/snapshot_${id}/source.tar.zst`,
    status: "queued", createdAt: NOW, updatedAt: NOW, snapshotId: `snapshot_${id}` };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("new source_sync admission refuses disabled and deleted Sources; exact replay remains read-only", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const source = await seed(store);
      const original = queued(source, "sync_existing");
      expect(await store.beginSourceSyncRun(original, authority), name)
        .toEqual({ status: "created", run: original });
      await store.putSource({ ...source, status: "disabled", autoSync: false, retiringAt: NOW });
      expect(await store.beginSourceSyncRun(original, authority), name)
        .toEqual({ status: "existing", run: original });
      expect(await store.beginSourceSyncRun(queued(source, "sync_disabled"), authority), name)
        .toEqual({ status: "conflict" });
      expect(await store.getSourceSyncRun("sync_disabled"), name).toBeUndefined();
      expect(await store.deleteSource(SRC), name).toBe(true);
      expect(await store.beginSourceSyncRun(original, authority), name)
        .toEqual({ status: "existing", run: original });
      expect(await store.beginSourceSyncRun(queued(source, "sync_deleted"), authority), name)
        .toEqual({ status: "conflict" });
      expect(await store.getSourceSyncRun("sync_deleted"), name).toBeUndefined();
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("a sync paused after reading active cannot publish a queued orphan after retirement", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      const entered = deferred();
      const resume = deferred();
      const delegate = new ObjectKeyArtifactReferenceAllocator();
      const allocator: ArtifactReferenceAllocator = {
        allocate: async (input) => {
          entered.release();
          await resume.promise;
          return delegate.allocate(input);
        },
      };
      const enqueued: string[] = [];
      let sequence = 0;
      const service = new SourcesService({ store, artifactReferenceAllocator: allocator,
        enqueueSourceSync: async ({ runId }) => { enqueued.push(runId); },
        now: () => new Date(NOW), newId: (prefix) => `${prefix}_${++sequence}`,
      });
      const pending = service.createSync(SRC);
      await entered.promise;
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      resume.release();
      await expect(pending, name).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await store.getSource(SRC), name).toBeUndefined();
      expect(await store.listSourceSyncRuns(SRC), name).toEqual([]);
      expect(enqueued, name).toEqual([]);
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.retired"), name)
        .toHaveLength(1);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retiringAt remains a hard sync fence even if a Source row says active", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const source = await seed(store);
      await store.putSource({ ...source, retiringAt: NOW });
      const service = new SourcesService({ store,
        artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      });
      await expect(service.createSync(SRC), name).rejects.toMatchObject({
        details: { reason: "source_not_active" },
      });
      await expect(service.patchSource(SRC, { status: "active", autoSync: true }), name)
        .rejects.toMatchObject({ details: { reason: "source_retiring" } });
      expect(await store.beginSourceSyncRun(queued(source, "sync_retiring_marker"), authority), name)
        .toEqual({ status: "conflict" });
      expect(await store.getSourceSyncRun("sync_retiring_marker"), name).toBeUndefined();
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);
