import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { SqlClient, SqlParameters, SqlQueryResult, SqlTransaction } from "../../../../core/adapters/storage/sql.ts";
import { PG_APP_CREDENTIAL_MINT_LEASE_SCHEMA, PG_APP_OWNERSHIP_TRANSFER_SCHEMA } from "../../../../core/domains/app-authorization/schema.ts";
import { SqlAppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";

function sqlPort(db: PGlite): SqlClient {
  return {
    async query<Row extends Record<string, unknown>>(query: string, parameters?: SqlParameters): Promise<SqlQueryResult<Row>> {
      const result = await db.query<Row>(query, parameters as readonly unknown[] | undefined);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
    async transaction<T>(fn: (transaction: SqlTransaction) => T | Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const port: SqlTransaction = {
          async query<Row extends Record<string, unknown>>(query: string, parameters?: SqlParameters): Promise<SqlQueryResult<Row>> {
            const result = await tx.query<Row>(query, parameters as readonly unknown[] | undefined);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
          },
          async transaction<U>(nested: (transaction: SqlTransaction) => U | Promise<U>): Promise<U> { return nested(port); },
        };
        return fn(port);
      });
    },
  };
}

async function fixture() {
  const db = new PGlite();
  await db.exec(`create table takosumi_capsules (
    id text primary key, owner_account_id text, ownership_epoch integer not null,
    management_state text not null, management_epoch integer not null,
    installation_json jsonb not null, source_id text, space_id text
  );
  create table takosumi_capsule_members (
    capsule_id text not null, account_id text not null, status text not null,
    added_by text, created_at text not null, updated_at text not null,
    primary key(capsule_id,account_id)
  );
  create table takosumi_runs (
    id text primary key, installation_id text, kind text not null, status text not null,
    lease_token text, heartbeat_at bigint, run_json jsonb not null, source_id text, space_id text
  );
  create table takosumi_sources (id text primary key, source_json jsonb not null, space_id text);
  create table takosumi_plan_run_inputs (plan_run_id text primary key, inputs_json jsonb not null);
  create table takosumi_provider_env_binding_sets (installation_id text not null, profile_json jsonb not null);
  insert into takosumi_capsules values ('cap1','owner',4,'active',0,
    '{"id":"cap1","ownerAccountId":"owner","ownershipEpoch":4,"managementState":"active","managementEpoch":0}', 'src1', 'ws1');
  insert into takosumi_capsule_members values ('cap1','member','active','owner','2026-01-01','2026-01-01');
  insert into takosumi_provider_env_binding_sets values ('cap1','{}');`);
  await db.exec(PG_APP_OWNERSHIP_TRANSFER_SCHEMA + PG_APP_CREDENTIAL_MINT_LEASE_SCHEMA);
  const access: AppAccessResolver = {
    async resolveAppAccess(accountId, capsuleId) {
      const result = await db.query<{ owner_account_id: string; ownership_epoch: number }>(
        `select owner_account_id,ownership_epoch from takosumi_capsules where id=$1`, [capsuleId],
      );
      const owner = result.rows[0];
      if (!owner) return undefined;
      if (owner.owner_account_id === accountId) return { capsuleId, role: "owner", ownerAccountId: accountId, ownershipEpoch: owner.ownership_epoch };
      const member = await db.query<{ status: string }>(
        `select status from takosumi_capsule_members where capsule_id=$1 and account_id=$2`, [capsuleId, accountId],
      );
      return member.rows[0]?.status === "active"
        ? { capsuleId, role: "member", ownerAccountId: owner.owner_account_id, ownershipEpoch: owner.ownership_epoch }
        : undefined;
    },
    async listAccessibleApps() { return { apps: [] }; },
  };
  return { db, store: new SqlAppAuthorizationStore(sqlPort(db), access) };
}

describe("PostgreSQL app authorization mutation store", () => {
  test("member removal cancels queued Run atomically and rejects stale epoch", async () => {
    const { db, store } = await fixture();
    try {
      const run = { id: "plan1", capsuleId: "cap1", status: "queued", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        ["plan1", "cap1", "plan", "queued", null, null, JSON.stringify(run)]);
      await db.query(`insert into takosumi_plan_run_inputs values ('plan1','{}')`);
      await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 3 })).rejects.toMatchObject({ code: "conflict" });
      expect((await db.query(`select status from takosumi_runs where id='plan1'`)).rows[0]).toEqual({ status: "queued" });
      await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
      expect((await db.query(`select status from takosumi_runs where id='plan1'`)).rows[0]).toEqual({ status: "cancelled" });
      expect((await db.query(`select * from takosumi_capsule_members`)).rows).toHaveLength(0);
      expect((await db.query(`select * from takosumi_plan_run_inputs`)).rows).toHaveLength(0);
    } finally { await db.close(); }
  });

  test("running app Source sync keeps its lease while queued Source sync fails on member removal", async () => {
    const { db, store } = await fixture();
    try {
      const now = "2026-01-01T00:00:00.000Z";
      const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
        actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
        archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
      await db.query(`insert into takosumi_sources values ('src1','{"id":"src1","workspaceId":"ws1","ownerCapsuleId":"cap1"}'::jsonb,'ws1')`);
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values ($1,null,'source_sync','queued',null,null,$2::jsonb,'src1','ws1')`, ["sync1", JSON.stringify(run)]);
      await db.query(`update takosumi_runs set status='running',lease_token='lease',run_json=$1::jsonb where id='sync1'`,
        [JSON.stringify({ ...run, status: "running" })]);
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values ($1,null,'source_sync','queued',null,null,$2::jsonb,'src1','ws1')`,
        ["sync2", JSON.stringify({ ...run, id: "sync2" })]);
      await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
      expect((await db.query(`select status,lease_token from takosumi_runs where id='sync1'`)).rows[0])
        .toEqual({ status: "running", lease_token: "lease" });
      const row = (await db.query<{ status: string; run_json: Record<string, unknown> }>(`select status,run_json from takosumi_runs where id='sync2'`)).rows[0];
      expect(row?.status).toBe("failed");
      expect(row?.run_json).toMatchObject({ status: "failed", errorCode: "app_access_revoked", finishedAt: expect.any(String) });
      expect((await db.query(`select account_id from takosumi_capsule_members`)).rows).toHaveLength(0);
      expect(await store.resolveAppAccess("member", "cap1")).toBeUndefined();
    } finally { await db.close(); }
  });

  test("cross-Workspace physical Source row blocks member removal", async () => {
    const { db, store } = await fixture();
    try {
      const now = "2026-01-01T00:00:00.000Z";
      const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
        actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
        archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
      await db.query(`insert into takosumi_sources values ('src1','{"id":"src1","workspaceId":"ws1","ownerCapsuleId":"cap1"}'::jsonb,'other')`);
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values ($1,null,'source_sync','queued',null,null,$2::jsonb,'src1','ws1')`, ["sync1", JSON.stringify(run)]);
      await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
        .rejects.toMatchObject({ code: "conflict" });
      expect((await db.query(`select status from takosumi_runs where id='sync1'`)).rows[0]).toEqual({ status: "queued" });
      expect((await db.query(`select account_id from takosumi_capsule_members`)).rows).toEqual([{ account_id: "member" }]);
    } finally { await db.close(); }
  });

  test("transfer drains an active lease before changing owner and binding authority", async () => {
    const { db, store } = await fixture();
    try {
      await db.query(`insert into takosumi_capsule_members values ('cap1','new','active','owner','2026-01-01','2026-01-01')`);
      await db.query(`insert into takosumi_sources values ('src1','{"id":"src1","workspaceId":"ws1","ownerCapsuleId":"cap1"}'::jsonb,'ws1')`);
      const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json) values ('run1','cap1','plan','running','lease',1,'{"id":"run1","status":"running"}')`);
      for (const [id, status] of [["planq", "queued"], ["planw", "waiting_approval"]] as const) {
        await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json) values ($1,'cap1','plan',$2,null,null,$3::jsonb)`,
          [id, status, JSON.stringify({ id, status, createdAt: 1, updatedAt: 1, auditEvents: [] })]);
      }
      await db.query(`insert into takosumi_plan_run_inputs values ('planq','{}')`);
      const sync = { id: "syncq", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
        actorAccountId: "owner", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
        status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values ($1,null,'source_sync','queued',null,null,$2::jsonb,'src1','ws1')`, ["syncq", JSON.stringify(sync)]);
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values ($1,null,'source_sync','running','lease',1,$2::jsonb,'src1','ws1')`,
        ["syncr", JSON.stringify({ ...sync, id: "syncr", status: "running" })]);
      expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("pending");
      expect((await db.query<{ management_state: string }>(`select management_state from takosumi_capsules where id='cap1'`)).rows[0]?.management_state).toBe("draining");
      expect((await db.query(`select id,status from takosumi_runs where id in ('planq','planw') order by id`)).rows).toEqual([
        { id: "planq", status: "cancelled" }, { id: "planw", status: "cancelled" },
      ]);
      expect((await db.query(`select * from takosumi_plan_run_inputs`)).rows).toHaveLength(0);
      expect((await db.query(`select status from takosumi_runs where id='syncq'`)).rows[0]).toEqual({ status: "failed" });
      await db.query(`update takosumi_runs set status='succeeded',lease_token=null where id='run1'`);
      await db.query(`update takosumi_runs set status='succeeded',lease_token=null where id='syncr'`);
      expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("accepted");
      expect((await db.query(`select owner_account_id,ownership_epoch from takosumi_capsules where id='cap1'`)).rows[0]).toEqual({ owner_account_id: "new", ownership_epoch: 5 });
      expect((await db.query(`select * from takosumi_provider_env_binding_sets`)).rows).toHaveLength(0);
      expect((await db.query(`select account_id from takosumi_capsule_members order by account_id`)).rows).toEqual([{ account_id: "member" }]);
    } finally { await db.close(); }
  });

  test("queued Apply cancellation follows Plan creator through the real PostgreSQL adapter", async () => {
    const { db, store } = await fixture();
    try {
      const plan = { id: "plan1", capsuleId: "cap1", status: "succeeded", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
      const apply = { id: "apply1", capsuleId: "cap1", planRunId: "plan1", status: "queued", createdAt: 2, updatedAt: 2, auditEvents: [] };
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, ["plan1", "cap1", "plan", "succeeded", null, null, JSON.stringify(plan)]);
      await db.query(`insert into takosumi_runs (id,installation_id,kind,status,lease_token,heartbeat_at,run_json) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, ["apply1", "cap1", "apply", "queued", null, null, JSON.stringify(apply)]);
      await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
      expect((await db.query(`select status from takosumi_runs where id='apply1'`)).rows[0]).toEqual({ status: "cancelled" });
    } finally { await db.close(); }
  });
});
