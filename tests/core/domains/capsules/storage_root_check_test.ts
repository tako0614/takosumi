/**
 * TASK-0118 P9.1-f: the read-only storage-root check resolves every Capsule
 * row, destroyed ones included, exactly as the stores do for allocation, and
 * reports rows that resolve only through the fallback stage 9.5 removes.
 */
import { afterEach, expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import {
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "../../../../core/domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import {
  checkCapsuleStorageRoots,
  d1CapsuleStorageRootCheckTarget,
  resolveCapsuleStorageRoot,
  sqlCapsuleStorageRootCheckTarget,
  type CapsuleStorageRootCheckTarget,
  type CapsuleStorageRootRow,
} from "../../../../core/domains/capsules/storage_root_check.ts";
import { runCapsuleStorageRootCheck } from "../../../../scripts/check-capsule-storage-roots.ts";
import {
  CloudflareD1OpenTofuControlStore,
  ensureD1OpenTofuLedgerSchema,
} from "../../../../worker/src/d1_opentofu_store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";

const clients: PGliteSqlClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

interface Fixture {
  readonly name: string;
  readonly store: OpenTofuControlStore;
  readonly target?: CapsuleStorageRootCheckTarget;
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
        expect(memory.setCapsuleOwnership({ capsuleId, ownerAccountId: "tsub_root_owner", ownershipEpoch: 0,
          managementState: "active", managementEpoch: 0, storageRoot })).toBe(true);
      },
    },
    {
      name: "postgres",
      store: new SqlOpenTofuControlStore({ client: pg }),
      target: sqlCapsuleStorageRootCheckTarget(pg),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await pg.query(`update takosumi_capsules set storage_root=$2 where id=$1`, [capsuleId, storageRoot]);
      },
    },
    {
      name: "d1",
      store: new CloudflareD1OpenTofuControlStore(db),
      target: d1CapsuleStorageRootCheckTarget(db),
      persistStorageRoot: async (capsuleId, storageRoot) => {
        await db.prepare(`update capsules set storage_root=? where id=?`).bind(storageRoot, capsuleId).run();
      },
    },
  ];
}

/** Four Capsules: persisted apps root, persisted legacy root, a destroyed row
 * with no root and a frozen scopeRef, and one with no root and no scopeRef. */
async function seed(fixture: Fixture): Promise<readonly string[]> {
  const ids = ["cap_apps", "cap_legacy", "cap_destroyed", "cap_prescope"];
  for (const id of ids) {
    await seedCapsuleModel(fixture.store, {
      workspaceId: "ws_roots", capsuleId: id, sourceId: `src_${id}`, name: id.replaceAll("_", "-"),
      installConfigId: `cfg_${id}`, snapshotId: `snap_${id}`,
    });
  }
  await fixture.persistStorageRoot("cap_apps", "apps/cap_apps");
  await fixture.persistStorageRoot("cap_legacy", "workspaces/ws_before/capsules/cap_legacy");
  const destroyed = (await fixture.store.getCapsule("cap_destroyed"))!;
  await fixture.store.putCapsule({ ...destroyed, scopeRef: "ws_frozen", status: "destroyed" } as Capsule);
  return ids;
}

test("every row resolves as the stores resolve it, destroyed rows included", async () => {
  for (const fixture of await stores()) {
    const ids = await seed(fixture);
    const expected = {
      cap_apps: "apps/cap_apps",
      cap_legacy: "workspaces/ws_before/capsules/cap_legacy",
      cap_destroyed: "workspaces/ws_frozen/capsules/cap_destroyed",
      cap_prescope: "workspaces/ws_roots/capsules/cap_prescope",
    } as Record<string, string>;
    for (const id of ids) {
      expect(await fixture.store.getCapsuleStorageRoot(id), `${fixture.name} ${id}`).toBe(expected[id]);
    }
    if (!fixture.target) continue;
    // The check reads the same rows the store reads and agrees with it.
    for (const row of await fixture.target.listRows()) {
      const resolved = resolveCapsuleStorageRoot(row);
      expect(resolved.ok && resolved.root, `${fixture.name} ${row.id}`).toBe(await fixture.store.getCapsuleStorageRoot(row.id));
    }
    const report = await runCapsuleStorageRootCheck(fixture.target);
    // The status column spelling of a live row differs per store; the
    // destroyed row is counted as destroyed in each.
    expect(report.byStatus.destroyed, fixture.name).toBe(1);
    expect(Object.values(report.byStatus).reduce((sum, n) => sum + n, 0), fixture.name).toBe(4);
    expect({ ...report, byStatus: undefined }, fixture.name).toEqual({
      total: 4,
      byStatus: undefined,
      byRoot: { apps: 1, legacy: 1, derived: 2 },
      derived: ["cap_destroyed", "cap_prescope"],
      unresolvable: [],
      workspaceColumnMismatch: [],
      orphanAppArchives: [],
      ok: true,
    });
  }
}, 60_000);

test("rows that resolve to no canonical root are reported, never repaired", async () => {
  for (const fixture of await stores()) {
    if (!fixture.target) continue;
    await seed(fixture);
    await fixture.persistStorageRoot("cap_apps", "apps/cap_other");
    if (fixture.name === "d1") {
      const db = (fixture.store as unknown as { db: SqliteFakeD1 }).db;
      await db.prepare(`update capsules set record_json = json_set(record_json, '$.scopeRef', json('null')) where id = ?`).bind("cap_destroyed").run();
      await db.prepare(`update capsules set record_json = json_remove(record_json, '$.workspaceId') where id = ?`).bind("cap_prescope").run();
    }
    const report = await checkCapsuleStorageRoots(fixture.target);
    expect(report.ok, fixture.name).toBe(false);
    const reasons = Object.fromEntries(report.unresolvable.map((entry) => [entry.capsuleId, entry.reason]));
    expect(reasons, fixture.name).toEqual(fixture.name === "d1"
      ? { cap_apps: "storage_root_not_canonical", cap_destroyed: "scope_invalid", cap_prescope: "scope_missing" }
      : { cap_apps: "storage_root_not_canonical" });
    // Read-only: nothing was changed.
    expect(await fixture.store.getCapsuleStorageRoot("cap_legacy")).toBe("workspaces/ws_before/capsules/cap_legacy");
  }
}, 60_000);

test("a record naming another Workspace than its column, and apps/ archives of a Capsule that never existed, are reported", async () => {
  for (const fixture of await stores()) {
    if (!fixture.target) continue;
    await seed(fixture);
    const sourceRecord = (await fixture.store.getSource("src_cap_apps"))!;
    // An abandoned install reservation: an apps/ archive for a Capsule with no row.
    await fixture.store.putSourceSnapshot({
      id: "snap_abandoned", origin: "git", workspaceId: "ws_roots", sourceId: sourceRecord.id, url: sourceRecord.url,
      ref: "main", path: ".", resolvedCommit: "a".repeat(40),
      archiveRef: `apps/cap_never_created/sources/${sourceRecord.id}/snapshots/snap_abandoned/source.tar.zst`,
      archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 1, fetchedByRunId: "run_abandoned",
      fetchedAt: "2026-10-30T00:00:00.000Z",
    });
    // And an archive of an existing app is not an orphan.
    await fixture.store.putSourceSnapshot({
      id: "snap_owned", origin: "git", workspaceId: "ws_roots", sourceId: sourceRecord.id, url: sourceRecord.url,
      ref: "main", path: ".", resolvedCommit: "a".repeat(40),
      archiveRef: `apps/cap_apps/sources/${sourceRecord.id}/snapshots/snap_owned/source.tar.zst`,
      archiveDigest: `sha256:${"b".repeat(64)}`, archiveSizeBytes: 1, fetchedByRunId: "run_owned",
      fetchedAt: "2026-10-30T00:00:00.000Z",
    });
    if (fixture.name === "d1") {
      await (fixture.store as unknown as { db: SqliteFakeD1 }).db
        .prepare("update capsules set space_id = ? where id = ?").bind("ws_moved", "cap_legacy").run();
    } else {
      await (clients.at(-1)!).query("update takosumi_capsules set space_id = $2 where id = $1", ["cap_legacy", "ws_moved"]);
    }
    const report = await checkCapsuleStorageRoots(fixture.target);
    expect(report.workspaceColumnMismatch, fixture.name).toEqual(["cap_legacy"]);
    expect(report.orphanAppArchives, fixture.name).toEqual([
      { sourceId: sourceRecord.id, capsuleId: "cap_never_created", refs: 1 },
    ]);
    expect(report.ok, fixture.name).toBe(false);
  }
}, 60_000);

test("resolution of individual rows", () => {
  const row = (extra: Partial<CapsuleStorageRootRow>): CapsuleStorageRootRow => ({
    id: "cap_1", status: "active", columnWorkspaceId: "ws_1", storageRoot: null, recordValid: true, recordId: "cap_1",
    recordWorkspaceId: "ws_1", recordScopeRef: undefined, ...extra,
  });
  expect(resolveCapsuleStorageRoot(row({ storageRoot: "apps/cap_1" }))).toEqual({ ok: true, root: "apps/cap_1", kind: "apps" });
  expect(resolveCapsuleStorageRoot(row({ storageRoot: undefined }))).toEqual({ ok: true, root: "workspaces/ws_1/capsules/cap_1", kind: "derived" });
  expect(resolveCapsuleStorageRoot(row({ recordScopeRef: "ws_frozen" })))
    .toEqual({ ok: true, root: "workspaces/ws_frozen/capsules/cap_1", kind: "derived" });
  expect(resolveCapsuleStorageRoot(row({ recordValid: false }))).toEqual({ ok: false, reason: "record_invalid" });
  expect(resolveCapsuleStorageRoot(row({ recordId: "cap_2" }))).toEqual({ ok: false, reason: "record_id_mismatch" });
  expect(resolveCapsuleStorageRoot(row({ storageRoot: "workspaces/ws_1/capsules/cap_2" })))
    .toEqual({ ok: false, reason: "storage_root_not_canonical" });
  expect(resolveCapsuleStorageRoot(row({ recordWorkspaceId: null }))).toEqual({ ok: false, reason: "scope_missing" });
  expect(resolveCapsuleStorageRoot(row({ recordScopeRef: { type: "null" } }))).toEqual({ ok: false, reason: "scope_invalid" });
  expect(resolveCapsuleStorageRoot(row({ recordScopeRef: ".." }))).toEqual({ ok: false, reason: "scope_invalid" });
});
