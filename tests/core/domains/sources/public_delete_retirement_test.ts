import { expect, test } from "bun:test";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { Capsule, InstallConfig } from "takosumi-contract/install-configs";
import type { ProviderBindingSet } from "takosumi-contract/connections";
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
const WS = "workspace_public_delete_retirement";
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

async function workspace(store: OpenTofuControlStore): Promise<void> {
  await store.putWorkspace({ id: WS, handle: WS, displayName: WS, type: "personal",
    ownerUserId: "owner_public_delete", createdAt: NOW, updatedAt: NOW });
}

function source(id: string, ownerCapsuleId?: string): StoredSource {
  return { id, workspaceId: WS, name: id,
    url: "https://github.com/example/public-delete.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: true, hookSecretHash: "hash", createdAt: NOW, updatedAt: NOW,
    ...(ownerCapsuleId ? { ownerCapsuleId } : {}) };
}

function snapshot(row: StoredSource): SourceSnapshot {
  return { id: `snapshot_${row.id}`, origin: "git", workspaceId: WS, sourceId: row.id,
    url: row.url, ref: row.defaultRef, path: row.defaultPath,
    resolvedCommit: "a".repeat(40),
    archiveRef: `workspaces/${WS}/sources/${row.id}/snapshots/snapshot_${row.id}/source.tar.zst`,
    archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: `run_${row.id}`, fetchedAt: NOW };
}

function syncRun(row: StoredSource): SourceSyncRun {
  return { id: `run_${row.id}`, kind: "source_sync", workspaceId: WS, sourceId: row.id,
    url: row.url, ref: row.defaultRef, path: row.defaultPath,
    archiveRef: `workspaces/${WS}/sources/${row.id}/snapshots/run_${row.id}/source.tar.zst`,
    status: "succeeded", createdAt: NOW, updatedAt: NOW, finishedAt: NOW };
}

async function history(store: OpenTofuControlStore, row: StoredSource): Promise<void> {
  await store.putSourceSnapshot(snapshot(row));
  await store.putSourceSyncRun(syncRun(row));
}

function destroyedCapsule(row: StoredSource, id: string): Capsule {
  return { id, workspaceId: WS, projectId: "project_public_delete", name: id, slug: id,
    sourceId: row.id, installConfigId: `config_${id}`, environment: "production",
    status: "destroyed", currentStateGeneration: 1, createdAt: NOW, updatedAt: NOW };
}

test("public DELETE of a destroyed app retires archives, snapshots and Source with actor activity", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await workspace(store);
      const row = source("source_owned_delete", "capsule_owned_delete");
      await store.putSource(row);
      await store.putCapsule(destroyedCapsule(row, row.ownerCapsuleId!));
      await history(store, row);
      const removed: string[] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => { removed.push(...archiveRefs); },
      });
      await expect(service.deleteSource(row.id, "operator_public_delete",
        { ...authority, managementEpoch: 2 }), name).rejects.toMatchObject({ code: "failed_precondition" });
      expect(await store.getSource(row.id), name).toMatchObject({ status: "active" });
      expect(removed, name).toEqual([]);
      expect((await service.deleteSource(row.id, "operator_public_delete", authority)).source.id, name).toBe(row.id);
      expect(removed, name).toEqual([snapshot(row).archiveRef, syncRun(row).archiveRef].sort());
      expect(await store.getSource(row.id), name).toBeUndefined();
      expect(await store.listSourceSnapshots(row.id), name).toEqual([]);
      expect(await store.listSourceSyncRuns(row.id), name).toHaveLength(1);
      const events = await store.listActivityEvents(WS);
      expect(events.filter((event) => event.action === "source.retired"), name)
        .toMatchObject([{ actorId: "operator_public_delete", targetId: row.id }]);
      expect(events.filter((event) => event.action === "source.deleted"), name).toEqual([]);
      await expect(service.deleteSource(row.id, "operator_public_delete", authority), name)
        .rejects.toMatchObject({ code: "not_found" });
    }
  } finally { await Promise.all(fixtures.map((fixture) => fixture.close())); }
}, 30_000);

test("public DELETE retains history after custody failure and resumes, including unowned Sources", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await workspace(store);
      const row = source("source_unowned_history");
      await store.putSource(row);
      await history(store, row);
      let attempts = 0;
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async () => {
          if (++attempts === 1) throw new Error("custody unavailable");
        },
      });
      await expect(service.deleteSource(row.id, "operator_public_delete", authority), name)
        .rejects.toThrow("custody unavailable");
      expect(await store.getSource(row.id), name).toMatchObject({ status: "disabled", retiringAt: NOW });
      expect(await store.listSourceSnapshots(row.id), name).toHaveLength(1);
      expect(await store.listActivityEvents(WS), name).toEqual([]);
      expect((await service.deleteSource(row.id, "operator_public_delete", authority)).source.id, name).toBe(row.id);
      expect(await store.getSource(row.id), name).toBeUndefined();
      expect(await store.listSourceSnapshots(row.id), name).toEqual([]);
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.retired"), name)
        .toHaveLength(1);
    }
  } finally { await Promise.all(fixtures.map((fixture) => fixture.close())); }
}, 30_000);

test("pristine unowned public DELETE preserves source.deleted", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await workspace(store);
      const row = source("source_pristine");
      await store.putSource(row);
      const service = new SourcesService({ store, now: () => new Date(NOW) });
      expect((await service.deleteSource(row.id, "operator_public_delete", authority)).source.id, name).toBe(row.id);
      expect(await store.getSource(row.id), name).toBeUndefined();
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.deleted"), name)
        .toMatchObject([{ actorId: "operator_public_delete", targetId: row.id, metadata: {} }]);
    }
  } finally { await Promise.all(fixtures.map((fixture) => fixture.close())); }
}, 30_000);

test("old Source-only delete CAS cannot remove a newly claimed, retiring or synced Source", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await workspace(store);
      const stale = source("source_claim_race");
      await store.putSource(stale);
      const capsuleId = "capsule_claim_race";
      const config: InstallConfig = { id: `config_${capsuleId}`, workspaceId: WS, name: capsuleId,
        variableMapping: {}, outputAllowlist: {}, policy: {}, createdAt: NOW, updatedAt: NOW };
      const capsule = { ...destroyedCapsule(stale, capsuleId), status: "pending" as const };
      const providerBindingSet: ProviderBindingSet = { id: `binding_${capsuleId}`, workspaceId: WS,
        capsuleId, environment: "production", bindings: [], createdAt: NOW, updatedAt: NOW };
      expect((await store.createCapsuleInitialAuthority({ installConfig: config, capsule, providerBindingSet })).status, name)
        .toBe("created");
      const input = (expectedSource: StoredSource, suffix: string) => ({ expectedSource,
        expectedWorkspaceManagementAuthority: authority,
        activity: { id: `activity_${suffix}`, workspaceId: WS, action: "source.deleted",
          targetType: "source", targetId: expectedSource.id, metadata: {}, createdAt: NOW } });
      expect((await store.deleteSourceWithActivity(input(stale, "stale"))).status, name).toBe("conflict");
      expect(await store.deleteSourceWithActivity(input((await store.getSource(stale.id))!, "claimed")), name)
        .toMatchObject({ status: "blocked", blockers: ["source_retirement_required"] });

      const retiring = { ...source("source_retiring_race"), status: "disabled" as const,
        autoSync: false, retiringAt: NOW };
      await store.putSource(retiring);
      expect(await store.deleteSourceWithActivity(input(retiring, "retiring")), name)
        .toMatchObject({ status: "blocked", blockers: ["source_retirement_required"] });

      const synced = source("source_synced_race");
      await store.putSource(synced);
      await history(store, synced);
      expect(await store.deleteSourceWithActivity(input(synced, "synced")), name)
        .toMatchObject({ status: "blocked", blockers: ["source_retirement_required"] });
      for (const id of [stale.id, retiring.id, synced.id]) expect(await store.getSource(id), name).toBeDefined();
      expect(await store.listActivityEvents(WS), name).toEqual([]);
    }
  } finally { await Promise.all(fixtures.map((fixture) => fixture.close())); }
}, 30_000);
