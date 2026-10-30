/**
 * TASK-0118 P9.1-f: a new app's Source archives and backups follow its
 * persisted `apps/{cap}` root, while an existing Capsule's keep the Workspace
 * layout byte for byte. The same through the memory, Postgres (PGlite) and
 * D1 (SQLite) stores, including Source retirement, which walks both prefixes
 * with one cursor.
 */
import { afterEach, expect, test } from "bun:test";
import type { SourceSnapshot } from "takosumi-contract/sources";
import { ObjectKeyArtifactReferenceAllocator } from "../../../../core/adapters/storage/artifact-references.ts";
import { BackupsService, InMemoryBackupArtifactStore } from "../../../../core/domains/backups/mod.ts";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  deterministicInitialCapsuleId,
  deterministicInstallSourceId,
} from "../../../../core/domains/install-plans/source-reservation.ts";
import { SourcesService } from "../../../../core/domains/sources/mod.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const NOW = "2026-10-30T00:00:00.000Z";
const OWNER = "tsub_storage_owner";
const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

interface Fixture {
  readonly name: string;
  readonly store: OpenTofuControlStore;
  /** Writes the physical root as Capsule creation or the ownership backfill does. */
  readonly persistStorageRoot: (capsuleId: string, root: string) => Promise<void>;
}

async function stores(): Promise<readonly Fixture[]> {
  const memory = new InMemoryOpenTofuControlStore();
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  return [
    {
      name: "memory",
      store: memory,
      persistStorageRoot: async (capsuleId, storageRoot) => {
        expect(memory.setCapsuleOwnership({
          capsuleId, ownerAccountId: OWNER, ownershipEpoch: 0,
          managementState: "active", managementEpoch: 0, storageRoot,
        })).toBe(true);
      },
    },
    {
      name: "postgres",
      store: new SqlOpenTofuControlStore({ client: pg }),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await pg.query(`update takosumi_capsules set storage_root=$2 where id=$1`, [capsuleId, storageRoot]);
      },
    },
    {
      name: "d1",
      store: new CloudflareD1OpenTofuControlStore(db),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await db.prepare(`update capsules set storage_root=? where id=?`).bind(storageRoot, capsuleId).run();
      },
    },
  ];
}

function sources(store: OpenTofuControlStore, appSourceArchiveRoots: boolean, ids = { n: 0 }) {
  return new SourcesService({
    store,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator({ appSourceArchiveRoots }),
    now: () => new Date(NOW),
    newId: (prefix) => `${prefix}_${String(++ids.n).padStart(4, "0")}`,
  });
}

/** One app-owned Source whose owner Capsule has the given persisted root. */
async function seedOwnedSource(fixture: Fixture, label: string, root: (capsuleId: string, workspaceId: string) => string) {
  const workspaceId = `ws_${label}`;
  const capsuleId = `cap_${label}`;
  const sourceId = `src_${label}`;
  const { source } = await seedCapsuleModel(fixture.store, {
    workspaceId, capsuleId, sourceId, name: label, installConfigId: `cfg_${label}`, snapshotId: `snap_seed_${label}`,
  });
  await fixture.persistStorageRoot(capsuleId, root(capsuleId, workspaceId));
  await fixture.store.putSource({ ...source, ownerCapsuleId: capsuleId });
  return { workspaceId, capsuleId, sourceId };
}

test("new Source archives follow the owner's apps root; legacy and Workspace Sources keep their keys", async () => {
  for (const fixture of await stores()) {
    const { name, store } = fixture;
    const app = await seedOwnedSource(fixture, "app", (cap) => `apps/${cap}`);
    const legacy = await seedOwnedSource(fixture, "legacy", (cap, ws) => `workspaces/${ws}/capsules/${cap}`);
    const ids = { n: 0 };
    const enabled = sources(store, true, ids);

    const appRun = (await enabled.createSync(app.sourceId, {}, undefined, OWNER)).run;
    expect(appRun.archiveRef, name)
      .toBe(`apps/${app.capsuleId}/sources/${app.sourceId}/snapshots/${appRun.snapshotId}/source.tar.zst`);
    expect((await store.getSourceSyncRun(appRun.id))?.archiveRef, name).toBe(appRun.archiveRef);

    // An existing Capsule's Source: the origin/main layout, byte for byte.
    const legacyRun = (await enabled.createSync(legacy.sourceId, {}, undefined, OWNER)).run;
    expect(legacyRun.archiveRef, name).toBe(
      `workspaces/${legacy.workspaceId}/sources/${legacy.sourceId}/snapshots/${legacyRun.snapshotId}/source.tar.zst`,
    );

    // Off until the Runner image accepts `apps/` keys: the Workspace layout.
    const disabledRun = (await sources(store, false, ids).createSync(app.sourceId, { ref: "other" }, undefined, OWNER)).run;
    expect(disabledRun.archiveRef, name).toBe(
      `workspaces/${app.workspaceId}/sources/${app.sourceId}/snapshots/${disabledRun.snapshotId}/source.tar.zst`,
    );

    // An install reservation syncs before its Capsule exists; that Capsule is
    // created with exactly `apps/{reserved id}`.
    const planId = `git_storage_${name}`;
    const reservedCapsuleId = deterministicInitialCapsuleId(planId);
    const reservation = { ...(await store.getSource(app.sourceId))!, id: deterministicInstallSourceId(planId),
      ownerCapsuleId: reservedCapsuleId, createdByInstallPlanId: planId };
    await store.putSource(reservation);
    const reservedRun = (await enabled.createSync(reservation.id)).run;
    expect(reservedRun.archiveRef, name).toBe(
      `apps/${reservedCapsuleId}/sources/${reservation.id}/snapshots/${reservedRun.snapshotId}/source.tar.zst`,
    );

    // A Workspace Source has no owner and keeps the Workspace layout.
    const shared = { ...(await store.getSource(app.sourceId))!, id: "src_shared" };
    delete (shared as { ownerCapsuleId?: string }).ownerCapsuleId;
    await store.putSource(shared);
    const sharedRun = (await enabled.createSync("src_shared")).run;
    expect(sharedRun.archiveRef, name).toBe(
      `workspaces/${app.workspaceId}/sources/src_shared/snapshots/${sharedRun.snapshotId}/source.tar.zst`,
    );
  }
}, 60_000);

function snapshot(workspaceId: string, sourceId: string, id: string, archiveRef: string): SourceSnapshot {
  return {
    id, origin: "git", workspaceId, sourceId, url: "https://git.example.com/example/app.git",
    ref: "main", path: ".", resolvedCommit: "a".repeat(40), archiveRef,
    archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "run_fixture_sync", fetchedAt: NOW,
  };
}

test("retirement deletes an app-owned Source's apps and Workspace archives with one cursor", async () => {
  for (const fixture of await stores()) {
    const { name, store } = fixture;
    const { workspaceId, capsuleId, sourceId } = await seedOwnedSource(fixture, "retire", (cap) => `apps/${cap}`);
    const capsule = (await store.getCapsule(capsuleId))!;
    await store.putCapsule({ ...capsule, status: "destroyed" });
    const appsPrefix = `apps/${capsuleId}/sources/${sourceId}/snapshots/`;
    const legacyPrefix = `workspaces/${workspaceId}/sources/${sourceId}/snapshots/`;
    // 31 apps-layout archives and 3 Workspace ones (the seeded fixture's plus 2):
    // the first page crosses from one prefix into the other.
    const appsRefs = Array.from({ length: 31 }, (_, i) => `${appsPrefix}snap_a${String(i).padStart(2, "0")}/source.tar.zst`);
    for (const [i, ref] of appsRefs.entries()) {
      await store.putSourceSnapshot(snapshot(workspaceId, sourceId, `snap_a${String(i).padStart(2, "0")}`, ref));
    }
    for (const id of ["snap_l1", "snap_l2"]) {
      await store.putSourceSnapshot(snapshot(workspaceId, sourceId, id, `${legacyPrefix}${id}/source.tar.zst`));
    }
    const legacyRefs = [
      // The fixture's seeded snapshot (its key names `snap_fixture`).
      `${legacyPrefix}snap_fixture/source.tar.zst`,
      `${legacyPrefix}snap_l1/source.tar.zst`,
      `${legacyPrefix}snap_l2/source.tar.zst`,
    ];
    const calls: { ownerCapsuleId?: string; archiveRefs: readonly string[] }[] = [];
    const service = new SourcesService({
      store, now: () => new Date(NOW),
      deleteRetiredSourceArchives: async ({ ownerCapsuleId, archiveRefs }) => {
        calls.push({ ...(ownerCapsuleId ? { ownerCapsuleId } : {}), archiveRefs: [...archiveRefs] });
      },
    });
    expect(await service.retireOwnedSource(sourceId, "destroyed"), name).toBe("retired");
    expect(calls, name).toEqual([
      { ownerCapsuleId: capsuleId, archiveRefs: [...appsRefs, legacyRefs[0]!] },
      { ownerCapsuleId: capsuleId, archiveRefs: legacyRefs.slice(1) },
    ]);
    expect(await store.getSource(sourceId), name).toBeUndefined();
    expect(await store.listSourceSnapshots(sourceId), name).toEqual([]);
  }
}, 60_000);

test("another live Source's reference to an apps-layout archive blocks retirement", async () => {
  for (const fixture of await stores()) {
    const { name, store } = fixture;
    const { workspaceId, capsuleId, sourceId } = await seedOwnedSource(fixture, "shared", (cap) => `apps/${cap}`);
    const capsule = (await store.getCapsule(capsuleId))!;
    await store.putCapsule({ ...capsule, status: "destroyed" });
    const ref = `apps/${capsuleId}/sources/${sourceId}/snapshots/snap_shared/source.tar.zst`;
    await store.putSourceSnapshot(snapshot(workspaceId, sourceId, "snap_shared", ref));
    const foreign = { ...(await store.getSource(sourceId))!, id: "src_foreign" };
    delete (foreign as { ownerCapsuleId?: string }).ownerCapsuleId;
    await store.putSource(foreign);
    await store.putSourceSnapshot(snapshot(workspaceId, "src_foreign", "snap_foreign", ref));
    let deleted = false;
    const service = new SourcesService({ store, now: () => new Date(NOW),
      deleteRetiredSourceArchives: async () => { deleted = true; } });
    await expect(service.retireOwnedSource(sourceId, "destroyed"), name).rejects.toMatchObject({
      details: { reason: "source_archive_shared_by_another_source" },
    });
    expect(deleted, name).toBe(false);
  }
}, 60_000);

test("a backup labelled with a new app goes under its apps root; an existing Capsule's keeps its key", async () => {
  for (const fixture of await stores()) {
    const { name, store } = fixture;
    const app = await seedOwnedSource(fixture, "bkapp", (cap) => `apps/${cap}`);
    const legacy = await seedOwnedSource(fixture, "bklegacy", (cap, ws) => `workspaces/${ws}/capsules/${cap}`);
    let n = 0;
    const artifactStore = new InMemoryBackupArtifactStore();
    const backups = new BackupsService({
      store,
      artifactStore,
      artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
      stateObjectReader: { get: async () => undefined },
      now: () => new Date(NOW),
      newId: (prefix) => `${prefix}_${String(++n).padStart(4, "0")}`,
    });
    const appBackup = await backups.createBackup({
      workspaceId: app.workspaceId, capsuleId: app.capsuleId, environment: "production", scope: "capsule",
    });
    expect(appBackup.ref, name).toBe(`apps/${app.capsuleId}/backups/${appBackup.id}/control.json.zst.enc`);
    expect(appBackup.artifactsManifest?.ref, name)
      .toBe(`apps/${app.capsuleId}/backups/${appBackup.id}/artifacts.manifest.json`);
    expect(artifactStore.get(appBackup.ref), name).toBeDefined();

    const legacyBackup = await backups.createBackup({
      workspaceId: legacy.workspaceId, capsuleId: legacy.capsuleId, environment: "production", scope: "capsule",
    });
    expect(legacyBackup.ref, name).toBe(`workspaces/${legacy.workspaceId}/backups/${legacyBackup.id}/control.json.zst.enc`);

    // A Workspace export names no Capsule and keeps the Workspace layout.
    const workspaceBackup = await backups.createBackup({ workspaceId: app.workspaceId });
    expect(workspaceBackup.ref, name).toBe(`workspaces/${app.workspaceId}/backups/${workspaceBackup.id}/control.json.zst.enc`);
  }
}, 60_000);
