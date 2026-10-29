import { expect, spyOn, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { SourceSnapshot, SourceSyncRun } from "takosumi-contract/sources";
import type { SqlClient, SqlParameters, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import {
  InMemoryOpenTofuControlStore, type OpenTofuControlStore, type StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import {
  deterministicInitialCapsuleId, deterministicInstallSourceId,
} from "../../../../core/domains/install-plans/source-reservation.ts";
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

async function seed(store: OpenTofuControlStore, ownerCapsuleId?: string): Promise<StoredSource> {
  await store.putWorkspace({ id: WS, handle: WS, displayName: WS, type: "personal",
    ownerUserId: "owner_retirement", createdAt: NOW, updatedAt: NOW });
  const source: StoredSource = { id: SRC, workspaceId: WS, name: "Retirement",
    url: "https://github.com/example/retirement.git", defaultRef: "main", defaultPath: ".",
    status: "active", autoSync: true, hookSecretHash: "hash", createdAt: NOW, updatedAt: NOW,
    ...(ownerCapsuleId ? { ownerCapsuleId } : {}) };
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

async function seedReservation(
  store: OpenTofuControlStore,
  label: string,
  identity: Partial<Pick<StoredSource, "id" | "ownerCapsuleId" | "createdByInstallPlanId">> = {},
): Promise<StoredSource> {
  const original = await seed(store);
  const createdByInstallPlanId = `git_retirement_${label}`;
  const id = deterministicInstallSourceId(createdByInstallPlanId);
  const source = { ...original, id, createdByInstallPlanId,
    ownerCapsuleId: deterministicInitialCapsuleId(createdByInstallPlanId),
    status: "disabled" as const, autoSync: false, retiringAt: NOW, ...identity };
  await store.putSource(source);
  await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
    id: `snapshot_${label}`, sourceId: source.id,
    archiveRef: `workspaces/${WS}/sources/${source.id}/snapshots/snapshot_${label}/source.tar.zst` });
  return (await store.getSource(source.id))!;
}

function reservationRetirementInput(source: StoredSource, label: string) {
  return { expectedSource: source,
    expectedWorkspaceManagementAuthority: { workspaceId: WS, managementState: "active" as const, managementEpoch: 1 },
    expectedSnapshotCount: 1, expectedSourceSyncRunCount: 0,
    activity: { id: `act_reservation_${label}`, workspaceId: WS, action: "source.retired",
      targetType: "source", targetId: source.id, metadata: {}, createdAt: NOW } };
}

function reservationCapsule(source: StoredSource, label: string, owner: boolean): Capsule {
  return { id: owner ? source.ownerCapsuleId! : `cap_${label}`,
    workspaceId: WS, projectId: "project_retirement", name: label, slug: label,
    sourceId: owner ? SRC : source.id, installConfigId: "config_retirement",
    environment: "production", status: "destroyed", currentStateGeneration: 0,
    createdAt: NOW, updatedAt: NOW };
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

test("retirement requires a present destroyed owner before marking or atomic deletion", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const source = await seed(store, "cap_missing");
      let deleted = false;
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async () => { deleted = true; } });
      await expect(service.retireOwnedSource(SRC, "destroyed"), name).rejects.toMatchObject({
        details: { reason: "source_owner_not_destroyed" },
      });
      expect(deleted, name).toBe(false);
      expect(await store.getSource(SRC), name).toMatchObject({ status: "active", autoSync: true });
      const marked = { ...source, status: "disabled" as const, autoSync: false, retiringAt: NOW };
      await store.putSource(marked);
      const result = await store.retireSource({ expectedSource: marked,
        expectedWorkspaceManagementAuthority: { workspaceId: WS, managementState: "active", managementEpoch: 1 },
        expectedSnapshotCount: 1, expectedSourceSyncRunCount: 1,
        activity: { id: `act_missing_${name}`, workspaceId: WS, action: "source.retired",
          targetType: "source", targetId: SRC, metadata: {}, createdAt: NOW } });
      expect(result, name).toMatchObject({ status: "blocked", blockers: ["source_owner_not_destroyed"] });
      expect(await store.getSource(SRC), name).toBeDefined();
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("atomic retirement accepts a missing reserved owner and preserves the destroyed-owner path", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      for (const label of ["accepted", "destroyed_owner"]) {
        const source = await seedReservation(store, label);
        if (label === "destroyed_owner") {
          await store.putCapsule({ ...reservationCapsule(source, label, true), sourceId: source.id });
        }
        expect(await store.retireSource(reservationRetirementInput(source, `${name}_${label}`)), name)
          .toMatchObject({ status: "deleted" });
        expect(await store.getSource(source.id), name).toBeUndefined();
        expect(await store.listSourceSnapshots(source.id), name).toEqual([]);
      }
      expect(await store.listActivityEvents(WS), name).toHaveLength(2);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("atomic reservation retirement preserves existing owners and all-status Capsule references", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      for (const [label, owner, status, references] of [
        ["owner_active", true, "active", true],
        ["owner_mismatch", true, "destroyed", false],
        ["other_active", false, "active", true],
        ["other_destroyed", false, "destroyed", true],
      ] as const) {
        const source = await seedReservation(store, label);
        await store.putCapsule({ id: owner ? source.ownerCapsuleId! : `cap_${label}`,
          workspaceId: WS, projectId: "project_retirement", name: label, slug: label,
          sourceId: references ? source.id : SRC, installConfigId: "config_retirement",
          environment: "production", status, currentStateGeneration: 0, createdAt: NOW, updatedAt: NOW });
        expect(await store.retireSource(reservationRetirementInput(source, `${name}_${label}`)), `${name}:${label}`)
          .toMatchObject({ status: "blocked" });
        expect(await store.getSource(source.id), name).toBeDefined();
        expect(await store.listSourceSnapshots(source.id), name).toHaveLength(1);
      }
      expect(await store.listActivityEvents(WS), name).toEqual([]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("a missing owner is not a reservation without exact creator-derived Source and owner ids", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      for (const [label, identity] of [
        ["wrong_source", { id: "source_not_reserved" }],
        ["wrong_owner", { ownerCapsuleId: "cap_not_reserved" }],
        ["missing_creator", { createdByInstallPlanId: undefined }],
      ] as const) {
        const source = await seedReservation(store, label, identity);
        expect(await store.retireSource(reservationRetirementInput(source, `${name}_${label}`)), name)
          .toMatchObject({ status: "blocked", blockers: ["source_owner_not_destroyed"] });
        expect(await store.getSource(source.id), name).toBeDefined();
      }
      expect(await store.listActivityEvents(WS), name).toEqual([]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("D1 reservation retirement rechecks Capsule absence when the final batch starts", async () => {
  class LateCapsuleD1 extends SqliteFakeD1 {
    beforeBatch?: () => Promise<void>;
    override async batch<T = unknown>(statements: Parameters<SqliteFakeD1["batch"]>[0]) {
      const before = this.beforeBatch;
      this.beforeBatch = undefined;
      if (before) await before();
      return await super.batch<T>(statements);
    }
  }
  const db = new LateCapsuleD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  for (const owner of [false, true]) {
    const label = `late_d1_${owner}`;
    const source = await seedReservation(store, label);
    db.beforeBatch = () => store.putCapsule(reservationCapsule(source, label, owner)).then(() => {});
    expect((await store.retireSource(reservationRetirementInput(source, label))).status).not.toBe("deleted");
    expect(await store.getSource(source.id)).toBeDefined();
    expect(await store.listSourceSnapshots(source.id)).toHaveLength(1);
  }
  expect(await store.listActivityEvents(WS)).toEqual([]);
});

test("Postgres reservation retirement rechecks Capsule absence in its final delete", async () => {
  const pg = await PGliteSqlClient.create();
  let lateCapsule: Capsule | undefined;
  const client: SqlClient = {
    query: (sql, parameters) => pg.query(sql, parameters),
    transaction: (body) => pg.transaction((transaction) => {
      const guarded: SqlTransaction = {
        async query<Row extends Record<string, unknown>>(sql: string, parameters?: SqlParameters) {
          if (sql.startsWith("delete from takosumi_sources s") && lateCapsule) {
            const capsule = lateCapsule;
            lateCapsule = undefined;
            await transaction.query(`insert into takosumi_capsules
              (id, space_id, project_id, name, environment, source_id, install_config_id,
               status, installation_json, created_at, updated_at)
              values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
              [capsule.id, capsule.workspaceId, capsule.projectId, capsule.name, capsule.environment,
                capsule.sourceId, capsule.installConfigId, capsule.status, JSON.stringify(capsule), NOW, NOW]);
          }
          return await transaction.query<Row>(sql, parameters);
        },
        transaction: (nested) => Promise.resolve(nested(guarded)),
      };
      return body(guarded);
    }),
  };
  const store = new SqlOpenTofuControlStore({ client });
  try {
    for (const owner of [false, true]) {
      const label = `late_pg_${owner}`;
      const source = await seedReservation(store, label);
      lateCapsule = reservationCapsule(source, label, owner);
      expect(await store.retireSource(reservationRetirementInput(source, label))).toMatchObject({ status: "conflict" });
      expect(lateCapsule).toBeUndefined();
      expect(await store.getSource(source.id)).toBeDefined();
      expect(await store.listSourceSnapshots(source.id)).toHaveLength(1);
    }
    expect(await store.listActivityEvents(WS)).toEqual([]);
  } finally {
    await pg.close();
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
      await store.putSource({ ...(await store.getSource(SRC))!, id: "source_foreign",
        name: "Live foreign Source", status: "active", autoSync: true, retiringAt: undefined });
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

test("mutually marked terminal Sources release each other's historical refs", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const sourceA = await seed(store);
      const sourceBId = "source_mutual";
      const sourceBRef = `workspaces/${WS}/sources/${sourceBId}/snapshots/snapshot_mutual/source.tar.zst`;
      await store.putSource({ ...sourceA, id: sourceBId, name: "Mutual" });
      await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
        id: "snapshot_mutual", sourceId: sourceBId, archiveRef: sourceBRef,
        fetchedByRunId: "sync_mutual" });
      await store.putSourceSyncRun({ ...(await store.listSourceSyncRuns(SRC))[0]!,
        id: "sync_mutual", sourceId: sourceBId, archiveRef: ref });
      await store.putSourceSyncRun({ ...(await store.listSourceSyncRuns(SRC))[0]!, archiveRef: sourceBRef });
      for (const id of [SRC, sourceBId]) {
        await store.putSource({ ...(await store.getSource(id))!, status: "disabled", autoSync: false,
          retiringAt: NOW });
      }
      const deleted: string[] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => { deleted.push(...archiveRefs); } });
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      expect(await service.retireOwnedSource(sourceBId, "destroyed"), name).toBe("retired");
      expect(deleted, name).toEqual([ref, sourceBRef]);
      expect((await store.listSourceSyncRuns(SRC))[0]?.archiveRef, name).toBe(sourceBRef);
      expect((await store.listSourceSyncRuns(sourceBId))[0]?.archiveRef, name).toBe(ref);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retirement preserves an external historical Run ref and deletes only its own archive", async () => {
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
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(0);
      expect(await store.listSourceSyncRuns(SRC), name).toHaveLength(1);
      expect((await store.listSourceSyncRuns(SRC))[0]?.archiveRef, name).toBe(externalRef);
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.retired"), name)
        .toHaveLength(1);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("terminal Source A releases its foreign Run ref so Source B can retire", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      const sourceA = await seed(store);
      const sourceBId = "source_foreign";
      const sourceBRef = `workspaces/${WS}/sources/${sourceBId}/snapshots/snapshot_foreign/source.tar.zst`;
      await store.putSource({ ...sourceA, id: sourceBId, name: "Foreign" });
      await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
        id: "snapshot_foreign", sourceId: sourceBId,
        archiveRef: sourceBRef, fetchedByRunId: "sync_foreign" });
      await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
        id: "snapshot_a_external", archiveRef: sourceBRef, fetchedByRunId: "sync_retirement" });
      const runA = (await store.listSourceSyncRuns(SRC))[0]!;
      await store.putSourceSyncRun({ ...runA, archiveRef: sourceBRef });
      const deleted: string[] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => { deleted.push(...archiveRefs); },
      });
      await expect(service.retireOwnedSource(sourceBId, "destroyed"), name).rejects.toMatchObject({
        details: { reason: "source_archive_shared_by_another_source" },
      });
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      expect(await store.getSource(SRC), name).toBeUndefined();
      expect(await store.getSource(sourceBId), name).toBeDefined();
      expect(await store.listSourceSnapshots(SRC), name).toHaveLength(0);
      expect(await store.listSourceSnapshots(sourceBId), name).toHaveLength(1);
      expect((await store.listSourceSyncRuns(SRC))[0]?.archiveRef, name).toBe(sourceBRef);
      expect(await service.retireOwnedSource(sourceBId, "destroyed"), name).toBe("retired");
      expect(deleted, name).toEqual([ref, sourceBRef]);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("retirement processes multiple bounded pages and resumes after a failed later page", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      for (let i = 0; i < 35; i++) {
        const id = `snapshot_extra_${String(i).padStart(3, "0")}`;
        await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
          id, archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/${id}/source.tar.zst` });
      }
      const calls: string[][] = [];
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async ({ archiveRefs }) => {
          calls.push([...archiveRefs]);
          if (calls.length === 2) throw new Error("second page custody failed");
        },
      });
      await expect(service.retireOwnedSource(SRC, "destroyed"), name)
        .rejects.toThrow("second page custody failed");
      const marker = await store.getSource(SRC);
      expect(marker?.retirementArchiveCursor, name).toBe(calls[0]?.at(-1));
      expect(marker?.retirementSnapshotCount, name).toBe(36);
      expect(calls[0]?.length, name).toBe(32);
      expect(await service.retireOwnedSource(SRC, "destroyed"), name).toBe("retired");
      expect(calls.map((refs) => refs.length), name).toEqual([32, 5, 5]);
      expect(await store.getSource(SRC), name).toBeUndefined();
      expect((await store.listActivityEvents(WS)).filter((event) => event.action === "source.retired"), name)
        .toHaveLength(1);
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("foreign reuse in a later archive page blocks every physical deletion", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      const foreignRef = `workspaces/${WS}/sources/${SRC}/snapshots/zz_foreign/source.tar.zst`;
      for (let i = 0; i < 35; i++) {
        const id = `snapshot_extra_${String(i).padStart(3, "0")}`;
        await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
          id, archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/${id}/source.tar.zst` });
      }
      await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
        id: "zz_foreign", archiveRef: foreignRef });
      await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
        id: "zz_shared", sourceId: "source_other", archiveRef: foreignRef });
      let deleted = false;
      const service = new SourcesService({ store, now: () => new Date(NOW),
        deleteRetiredSourceArchives: async () => { deleted = true; },
      });
      await expect(service.retireOwnedSource(SRC, "destroyed"), name).rejects.toMatchObject({
        details: { reason: "source_archive_shared_by_another_source" },
      });
      expect(deleted, name).toBe(false);
      expect(await store.getSource(SRC), name).toMatchObject({ status: "disabled", retiringAt: NOW });
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("D1 release refuses incoherent destroyed Capsule, mismatched ref identity, and missing owner", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const original = await seed(store);
  const foreignId = "source_foreign_corrupt";
  await store.putSource({ ...original, id: foreignId, name: "Foreign", status: "disabled",
    autoSync: false, retiringAt: NOW });
  await store.putSourceSnapshot({ ...(await store.getSourceSnapshot("snapshot_retirement"))!,
    id: "snapshot_foreign_corrupt", sourceId: foreignId, archiveRef: ref });
  const prefix = `workspaces/${WS}/sources/${SRC}/snapshots/`;
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBeUndefined();
  await store.putCapsule({ id: "cap_foreign_corrupt", workspaceId: WS, projectId: "project_retirement",
    name: "corrupt", slug: "corrupt", sourceId: foreignId, installConfigId: "config_retirement",
    environment: "production", status: "destroyed", currentStateGeneration: 0,
    createdAt: NOW, updatedAt: NOW });
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBeUndefined();
  await db.prepare(`update capsules set record_json = json_set(record_json, '$.status', 'active') where id = ?`)
    .bind("cap_foreign_corrupt").run();
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBe("foreign_reference");
  await db.prepare(`update capsules set record_json = json_set(record_json, '$.status', 'destroyed') where id = ?`)
    .bind("cap_foreign_corrupt").run();
  await db.prepare(`update capsules set record_json = json_remove(record_json, '$.status', '$.id') where id = ?`)
    .bind("cap_foreign_corrupt").run();
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBe("foreign_reference");
  await db.prepare(`update capsules set record_json = json_set(record_json, '$.status', 'destroyed', '$.id', ?) where id = ?`)
    .bind("cap_foreign_corrupt", "cap_foreign_corrupt").run();
  await db.prepare(`update source_snapshots set record_json = json_set(record_json, '$.sourceId', 'source_other') where id = ?`)
    .bind("snapshot_foreign_corrupt").run();
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBe("foreign_reference");
  await db.prepare(`update source_snapshots set record_json = json_set(record_json, '$.sourceId', ?) where id = ?`)
    .bind(foreignId, "snapshot_foreign_corrupt").run();
  await db.prepare(`update source_snapshots set record_json = json_remove(record_json, '$.sourceId') where id = ?`)
    .bind("snapshot_foreign_corrupt").run();
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBe("foreign_reference");
  await db.prepare(`update source_snapshots set record_json = json_set(record_json, '$.sourceId', ?) where id = ?`)
    .bind(foreignId, "snapshot_foreign_corrupt").run();
  await db.prepare(`update sources set record_json = json_set(record_json, '$.ownerCapsuleId', 'cap_missing') where id = ?`)
    .bind(foreignId).run();
  expect(await store.sourceRetirementArchiveBlocker(SRC, prefix)).toBe("foreign_reference");
});


test("retirement preflight never materializes complete Run or Capsule history", async () => {
  const fixtures = await adapters();
  try {
    for (const { name, store } of fixtures) {
      await seed(store);
      store.listSourceSyncRuns = async () => { throw new Error("unbounded Source Run history"); };
      store.listRunsByWorkspace = async () => { throw new Error("unbounded Workspace Run history"); };
      store.listCapsules = async () => { throw new Error("unbounded Workspace Capsule history"); };
      const service = new SourcesService({ store, deleteRetiredSourceArchives: async () => {} });
      expect(await service.retireOwnedSource(SRC, "bounded preflight"), name).toBe("retired");
      expect(await store.getSource(SRC), name).toBeUndefined();
    }
  } finally {
    await Promise.all(fixtures.map((fixture) => fixture.close()));
  }
}, 30_000);

test("one retirement invocation drains 1,000 archives and stops at its count budget", async () => {
  for (const archiveCount of [1_000, 1_050]) {
    const store = new InMemoryOpenTofuControlStore();
    await seed(store);
    const template = (await store.getSourceSnapshot("snapshot_retirement"))!;
    for (let i = 2; i < archiveCount; i++) {
      const id = `snapshot_extra_${String(i).padStart(4, "0")}`;
      await store.putSourceSnapshot({ ...template, id,
        archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/${id}/source.tar.zst` });
    }
    const calls: string[][] = [];
    const service = new SourcesService({ store, now: () => new Date(NOW),
      deleteRetiredSourceArchives: async ({ archiveRefs }) => { calls.push([...archiveRefs]); } });
    expect(await service.retireOwnedSource(SRC, "destroyed"))
      .toBe(archiveCount === 1_000 ? "retired" : "deferred");
    expect(calls.every((refs) => refs.length <= 32)).toBe(true);
    expect(calls.flat()).toHaveLength(Math.min(archiveCount, 1_024));
    if (archiveCount > 1_024) {
      expect((await store.getSource(SRC))?.retirementArchiveCursor).toBe(calls.at(-1)?.at(-1));
      expect(await store.listActivityEvents(WS)).toHaveLength(0);
      expect(await service.retireOwnedSource(SRC, "destroyed")).toBe("retired");
      expect(new Set(calls.flat()).size).toBe(archiveCount);
    }
    expect(await store.getSource(SRC)).toBeUndefined();
  }
});

test("retirement saves its cursor when the elapsed-time budget runs out", async () => {
  const store = new InMemoryOpenTofuControlStore();
  await seed(store);
  const template = (await store.getSourceSnapshot("snapshot_retirement"))!;
  for (let i = 0; i < 35; i++) {
    const id = `snapshot_timed_${i}`;
    await store.putSourceSnapshot({ ...template, id,
      archiveRef: `workspaces/${WS}/sources/${SRC}/snapshots/${id}/source.tar.zst` });
  }
  const deleted: string[] = [];
  const service = new SourcesService({ store, now: () => new Date(NOW),
    deleteRetiredSourceArchives: async ({ archiveRefs }) => { deleted.push(...archiveRefs); } });
  const clock = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(5_000);
  try {
    expect(await service.retireOwnedSource(SRC, "destroyed")).toBe("deferred");
    expect(deleted).toHaveLength(32);
    expect((await store.getSource(SRC))?.retirementArchiveCursor).toBe(deleted.at(-1));
  } finally {
    clock.mockRestore();
  }
  expect(await service.retireOwnedSource(SRC, "destroyed")).toBe("retired");
  expect(new Set(deleted).size).toBe(37);
});
