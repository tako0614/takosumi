import { expect, test } from "bun:test";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { D1Like } from "../../../../core/adapters/storage/d1.ts";
import { D1_APP_OWNERSHIP_TRANSFER_SCHEMA, PG_APP_OWNERSHIP_TRANSFER_SCHEMA } from "../../../../core/domains/app-authorization/schema.ts";
import { D1AppAuthorizationStore, SqlAppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";

const emptyAccess: AppAccessResolver = {
  async resolveAppAccess() { return undefined; },
  async listAccessibleApps() { return { apps: [] }; },
};

test("D1 mutation store uses the actual current ledger tables", async () => {
  const db = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(db);
  const capsuleColumns = await db.prepare("pragma table_info(capsules)").all<{ name: string }>();
  const existing = new Set(capsuleColumns.results.map((row) => row.name));
  for (const [name, definition] of [
    ["owner_account_id", "text"], ["ownership_epoch", "integer not null default 0"],
    ["management_state", "text not null default 'active'"], ["management_epoch", "integer not null default 0"],
  ] as const) {
    if (!existing.has(name)) await db.exec(`alter table capsules add column ${name} ${definition}`);
  }
  await db.exec(`create table if not exists capsule_members (
    capsule_id text not null, account_id text not null, status text not null,
    added_by text, created_at text not null, updated_at text not null,
    primary key(capsule_id,account_id)
  )`);
  for (const statement of D1_APP_OWNERSHIP_TRANSFER_SCHEMA) await db.exec(statement);
  await db.prepare(`insert into capsules (
    id,space_id,project_id,name,slug,source_id,install_config_id,
    environment,current_state_generation,status,record_json,created_at,updated_at,
    owner_account_id,ownership_epoch,management_state,management_epoch
  ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    "cap_real", "ws_real", "prj_real", "app", "app", "src_real", "cfg_real",
    "production", 0, "active", JSON.stringify({ id: "cap_real", ownerAccountId: "owner", ownershipEpoch: 0 }),
    "2026-01-01", "2026-01-01", "owner", 0, "active", 0,
  ).run();
  const store = new D1AppAuthorizationStore(db as unknown as D1Like, emptyAccess);
  expect(await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 })).toEqual({ accountId: "member", status: "active" });
  expect((await store.listMembers("cap_real")).members).toEqual([{ accountId: "member", status: "active" }]);
  await db.prepare(`insert into sources (id,space_id,status,record_json,created_at,updated_at) values (?,?,?,?,?,?)`)
    .bind("src_real", "ws_real", "active", JSON.stringify({ id: "src_real", ownerCapsuleId: "cap_real" }), "2026-01-01", "2026-01-01").run();
  const sync = { id: "sync_real", kind: "source_sync", workspaceId: "ws_real", sourceId: "src_real",
    actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
    status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  await db.prepare(`insert into runs (id,space_id,source_id,type,status,run_json,created_at) values (?,?,?,?,?,?,?)`)
    .bind("sync_real", "ws_real", "src_real", "source_sync", "queued", JSON.stringify(sync), "2026-01-01").run();
  await store.removeMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 });
  expect((await db.prepare(`select status from runs where id='sync_real'`).first())).toEqual({ status: "failed" });
  expect((await db.prepare(`select count(*) as n from capsule_members where capsule_id='cap_real'`).first())).toEqual({ n: 0 });
  await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 });
  for (const [id, status] of [["plan_queued", "queued"], ["plan_waiting", "waiting_approval"]] as const) {
    const run = { id, workspaceId: "ws_real", capsuleId: "cap_real", status, createdBy: "owner", createdAt: 1, updatedAt: 1, auditEvents: [] };
    await db.prepare(`insert into runs (id,space_id,installation_id,type,status,run_json,created_at)
      values (?,?,?,?,?,?,?)`).bind(id, "ws_real", "cap_real", "plan", status, JSON.stringify(run), "2026-01-01").run();
  }
  await db.prepare(`insert into runs_inputs (plan_run_id,inputs_json) values (?,?)`).bind("plan_queued", "{}").run();
  await db.prepare(`insert into runs (id,space_id,source_id,type,status,run_json,created_at) values (?,?,?,?,?,?,?)`)
    .bind("sync_transfer", "ws_real", "src_real", "source_sync", "queued",
      JSON.stringify({ ...sync, id: "sync_transfer", actorAccountId: "owner" }), "2026-01-01").run();
  const transfer = await store.createTransfer({ capsuleId: "cap_real", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 0 });
  await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 0 });
  expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("accepted");
  expect((await db.prepare(`select owner_account_id,ownership_epoch from capsules where id='cap_real'`).first())).toEqual({ owner_account_id: "new", ownership_epoch: 1 });
  expect((await db.prepare(`select status from runs where id='plan_queued'`).first())).toEqual({ status: "cancelled" });
  expect((await db.prepare(`select status from runs where id='plan_waiting'`).first())).toEqual({ status: "cancelled" });
  expect((await db.prepare(`select status from runs where id='sync_transfer'`).first())).toEqual({ status: "failed" });
  expect((await db.prepare(`select count(*) as n from runs_inputs`).first())).toEqual({ n: 0 });
  expect((await db.prepare(`select account_id from capsule_members where capsule_id='cap_real'`).all()).results).toEqual([{ account_id: "member" }]);
});

test("PostgreSQL mutation store uses the actual current ledger tables", async () => {
  const client = await PGliteSqlClient.create();
  try {
    for (const sql of [
      `alter table takosumi_capsules add column if not exists owner_account_id text`,
      `alter table takosumi_capsules add column if not exists ownership_epoch integer not null default 0`,
      `alter table takosumi_capsules add column if not exists management_state text not null default 'active'`,
      `alter table takosumi_capsules add column if not exists management_epoch integer not null default 0`,
    ]) await client.exec(sql);
    await client.exec(`create table if not exists takosumi_capsule_members (
      capsule_id text not null, account_id text not null, status text not null,
      added_by text, created_at text not null, updated_at text not null,
      primary key(capsule_id,account_id)
    )`);
    await client.exec(PG_APP_OWNERSHIP_TRANSFER_SCHEMA);
    await client.query(`insert into takosumi_capsules (
      id,space_id,project_id,name,environment,source_id,install_config_id,
      current_state_version_id,status,installation_json,created_at,updated_at,
      owner_account_id,ownership_epoch,management_state,management_epoch
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)`, [
      "cap_real", "ws_real", "prj_real", "app", "production", "src_real", "cfg_real",
      null, "active", JSON.stringify({ id: "cap_real", ownerAccountId: "owner", ownershipEpoch: 0 }),
      "2026-01-01", "2026-01-01", "owner", 0, "active", 0,
    ]);
    const store = new SqlAppAuthorizationStore(client, emptyAccess);
    expect(await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 })).toEqual({ accountId: "member", status: "active" });
    expect((await store.listMembers("cap_real")).members).toEqual([{ accountId: "member", status: "active" }]);
    await client.query(`insert into takosumi_sources (id,space_id,status,source_json,created_at,updated_at)
      values ($1,$2,$3,$4::jsonb,$5,$6)`, ["src_real", "ws_real", "active",
      JSON.stringify({ id: "src_real", ownerCapsuleId: "cap_real" }), "2026-01-01", "2026-01-01"]);
    const sync = { id: "sync_real", kind: "source_sync", workspaceId: "ws_real", sourceId: "src_real",
      actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
      status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    await client.query(`insert into takosumi_runs (id,space_id,source_id,kind,status,run_json,created_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, ["sync_real", "ws_real", "src_real", "source_sync", "queued", JSON.stringify(sync), "2026-01-01"]);
    await store.removeMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 });
    expect((await client.query(`select status from takosumi_runs where id='sync_real'`)).rows[0]).toEqual({ status: "failed" });
    expect((await client.query(`select count(*)::integer as n from takosumi_capsule_members where capsule_id='cap_real'`)).rows[0]).toEqual({ n: 0 });
    await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 0 });
    for (const [id, status] of [["plan_queued", "queued"], ["plan_waiting", "waiting_approval"]] as const) {
      const run = { id, workspaceId: "ws_real", capsuleId: "cap_real", status, createdBy: "owner", createdAt: 1, updatedAt: 1, auditEvents: [] };
      await client.query(`insert into takosumi_runs (id,space_id,installation_id,kind,status,run_json,created_at)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, [id, "ws_real", "cap_real", "plan", status, JSON.stringify(run), "2026-01-01"]);
    }
    await client.query(`insert into takosumi_plan_run_inputs (plan_run_id,inputs_json) values ('plan_queued','{}'::jsonb)`);
    await client.query(`insert into takosumi_runs (id,space_id,source_id,kind,status,run_json,created_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7)`, ["sync_transfer", "ws_real", "src_real", "source_sync", "queued",
      JSON.stringify({ ...sync, id: "sync_transfer", actorAccountId: "owner" }), "2026-01-01"]);
    const transfer = await store.createTransfer({ capsuleId: "cap_real", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 0 });
    await store.addMember({ capsuleId: "cap_real", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 0 });
    expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("accepted");
    expect((await client.query(`select owner_account_id,ownership_epoch from takosumi_capsules where id='cap_real'`)).rows[0]).toEqual({ owner_account_id: "new", ownership_epoch: 1 });
    expect((await client.query(`select id,status from takosumi_runs where id in ('plan_queued','plan_waiting') order by id`)).rows).toEqual([
      { id: "plan_queued", status: "cancelled" }, { id: "plan_waiting", status: "cancelled" },
    ]);
    expect((await client.query(`select status from takosumi_runs where id='sync_transfer'`)).rows[0]).toEqual({ status: "failed" });
    expect((await client.query(`select * from takosumi_plan_run_inputs`)).rows).toHaveLength(0);
    expect((await client.query(`select account_id from takosumi_capsule_members where capsule_id='cap_real'`)).rows).toEqual([{ account_id: "member" }]);
  } finally { await client.close(); }
});
