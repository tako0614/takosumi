import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { D1Like, D1LikePreparedStatement } from "../../../../core/adapters/storage/d1.ts";
import { AppAuthorizationError } from "../../../../core/domains/app-authorization/errors.ts";
import { D1_APP_CREDENTIAL_MINT_LEASE_SCHEMA, D1_APP_OWNERSHIP_TRANSFER_SCHEMA } from "../../../../core/domains/app-authorization/schema.ts";
import { D1AppAuthorizationStore } from "../../../../core/domains/app-authorization/store.ts";

function fixture() {
  const sqlite = new Database(":memory:");
  let beforeBatch: (() => void) | undefined;
  let lastBatchSize = 0;
  sqlite.exec(`create table capsules (
    id text primary key, owner_account_id text, ownership_epoch integer not null,
    management_state text not null, management_epoch integer not null,
    record_json text not null, source_id text, space_id text
  );
  create table capsule_members (
    capsule_id text not null, account_id text not null, status text not null,
    added_by text, created_at text not null, updated_at text not null,
    primary key(capsule_id,account_id)
  );
  create table runs (
    id text primary key, installation_id text, type text not null, status text not null,
    lease_token text, heartbeat_at integer, run_json text not null, source_id text, space_id text
  );
  create table sources (id text primary key, record_json text not null, space_id text);
  create table runs_inputs (plan_run_id text primary key, inputs_json text not null);
  create table provider_env_binding_sets (installation_id text not null, record_json text not null);
  create table audit_events (id text primary key, space_id text not null, actor_id text,
    action text not null, target_type text not null, target_id text not null,
    run_id text, created_at text not null, record_json text not null);
  insert into capsules values ('cap1','owner',4,'active',0,
    '{"id":"cap1","ownerAccountId":"owner","ownershipEpoch":4,"managementState":"active","managementEpoch":0}', 'src1', 'ws1');
  insert into capsule_members values ('cap1','member','active','owner','2026-01-01','2026-01-01');
  insert into provider_env_binding_sets values ('cap1','{}');`);
  for (const statement of [...D1_APP_OWNERSHIP_TRANSFER_SCHEMA, ...D1_APP_CREDENTIAL_MINT_LEASE_SCHEMA]) sqlite.exec(statement);
  const d1: D1Like = {
    prepare(sql: string) {
      const make = (params: readonly unknown[]): BoundStatement => ({
        sql, params,
        bind(...next: readonly unknown[]) { return make(next); },
        async first<T>() { return (sqlite.prepare(sql).get(...params as []) ?? null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...params as []) as T[] }; },
        async run() { return { meta: { changes: sqlite.prepare(sql).run(...params as []).changes } }; },
      });
      return make([]);
    },
    async batch(statements) {
      lastBatchSize = statements.length;
      const hook = beforeBatch;
      beforeBatch = undefined;
      hook?.();
      return sqlite.transaction(() => statements.map((statement) => {
        // The fixture preserves D1's one-batch transaction boundary.
        const sql = (statement as BoundStatement).sql;
        const params = (statement as BoundStatement).params;
        if (/^\s*select\b/iu.test(sql)) return { results: sqlite.prepare(sql).all(...params as []), meta: { changes: 0 } };
        return { results: [], meta: { changes: sqlite.prepare(sql).run(...params as []).changes } };
      }))();
    },
  };
  const access: AppAccessResolver = {
    async resolveAppAccess(accountId, capsuleId) {
      const owner = sqlite.prepare(`select owner_account_id,ownership_epoch from capsules where id=?`).get(capsuleId) as {
        owner_account_id: string; ownership_epoch: number;
      } | null;
      if (!owner) return undefined;
      if (owner.owner_account_id === accountId) return { capsuleId, role: "owner", ownerAccountId: accountId, ownershipEpoch: owner.ownership_epoch };
      const member = sqlite.prepare(`select status from capsule_members where capsule_id=? and account_id=?`).get(capsuleId, accountId) as { status: string } | null;
      return member?.status === "active"
        ? { capsuleId, role: "member", ownerAccountId: owner.owner_account_id, ownershipEpoch: owner.ownership_epoch }
        : undefined;
    },
    async listAccessibleApps() { return { apps: [] }; },
  };
  return { sqlite, store: new D1AppAuthorizationStore(d1, access),
    lastBatchSize() { return lastBatchSize; },
    beforeNextBatch(hook: () => void) { beforeBatch = hook; } };
}

interface BoundStatement extends D1LikePreparedStatement {
  readonly sql: string;
  readonly params: readonly unknown[];
}

describe("D1 app authorization mutation store", () => {
  test("owner epoch change after read rolls back the entire guarded batch as a conflict", async () => {
    const { sqlite, store, beforeNextBatch } = fixture();
    beforeNextBatch(() => sqlite.prepare(`update capsules set ownership_epoch=5 where id='cap1'`).run());
    await expect(store.addMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 4, consent: "connections_and_code" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select account_id from capsule_members order by account_id`).all()).toEqual([{ account_id: "member" }]);
    expect(sqlite.prepare(`select ownership_epoch from capsules where id='cap1'`).get()).toEqual({ ownership_epoch: 5 });
  });

  test("owner switch after transfer read cannot create a pending transfer", async () => {
    const { sqlite, store, beforeNextBatch } = fixture();
    beforeNextBatch(() => sqlite.prepare(`update capsules set owner_account_id='new_owner' where id='cap1'`).run());
    await expect(store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "recipient", expectedOwnershipEpoch: 4 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select count(*) as n from capsule_ownership_transfers`).get()).toEqual({ n: 0 });
  });

  test("member deletion or Run claim after read cannot cancel a live Run", async () => {
    for (const change of ["member", "run"] as const) {
      const { sqlite, store, beforeNextBatch } = fixture();
      const run = { id: "plan1", capsuleId: "cap1", status: "queued", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
      sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`)
        .run("plan1", "cap1", "plan", "queued", null, null, JSON.stringify(run));
      sqlite.prepare(`insert into runs_inputs values (?,?)`).run("plan1", "{}");
      beforeNextBatch(() => {
        if (change === "member") sqlite.prepare(`delete from capsule_members where capsule_id='cap1' and account_id='member'`).run();
        else sqlite.prepare(`update runs set status='running',lease_token='lease',run_json=? where id='plan1'`)
          .run(JSON.stringify({ ...run, status: "running" }));
      });
      await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(sqlite.prepare(`select status from runs where id='plan1'`).get()).toEqual({ status: change === "member" ? "queued" : "running" });
      expect(sqlite.prepare(`select count(*) as n from runs_inputs`).get()).toEqual({ n: 1 });
    }
  });

  test("a newly enqueued member Run after read cannot be left live by removal", async () => {
    const { sqlite, store, beforeNextBatch } = fixture();
    const run = { id: "plan1", capsuleId: "cap1", status: "queued", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`)
      .run("plan1", "cap1", "plan", "queued", null, null, JSON.stringify(run));
    sqlite.prepare(`insert into runs_inputs values (?,?)`).run("plan1", "{}");
    beforeNextBatch(() => sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json)
      values (?,?,?,?,?,?,?)`).run("plan2", "cap1", "plan", "queued", null, null,
        JSON.stringify({ ...run, id: "plan2" })));
    await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select id,status from runs order by id`).all()).toEqual([
      { id: "plan1", status: "queued" }, { id: "plan2", status: "queued" },
    ]);
    expect(sqlite.prepare(`select count(*) as n from runs_inputs`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`select account_id from capsule_members`).all()).toEqual([{ account_id: "member" }]);
  });

  test("Source linkage change after read rolls back member revocation", async () => {
    const { sqlite, store, beforeNextBatch } = fixture();
    const now = "2026-01-01T00:00:00.000Z";
    const source = { id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" };
    const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
      archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`).run("src1", JSON.stringify(source), "ws1");
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", null, null, JSON.stringify(run), "src1", "ws1");
    beforeNextBatch(() => sqlite.prepare(`update sources set record_json=? where id='src1'`)
      .run(JSON.stringify({ ...source, workspaceId: "other" })));
    await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select status from runs where id='sync1'`).get()).toEqual({ status: "queued" });
    expect(sqlite.prepare(`select account_id from capsule_members`).all()).toEqual([{ account_id: "member" }]);
  });

  test("unrelated SQL constraints are not normalized to an ownership conflict", async () => {
    const { sqlite, store, beforeNextBatch } = fixture();
    beforeNextBatch(() => sqlite.prepare(`create trigger reject_new_member before insert on capsule_members
      begin select raise(abort, 'unrelated storage failure'); end`).run());
    await expect(store.addMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 4, consent: "connections_and_code" }))
      .rejects.toThrow("unrelated storage failure");
  });

  test("member add rejects stale owner epoch and persists active membership", async () => {
    const { sqlite, store } = fixture();
    await expect(store.addMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 3, consent: "connections_and_code" })).rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select count(*) as n from capsule_members`).get()).toEqual({ n: 1 });
    expect(await store.addMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "new", expectedOwnershipEpoch: 4, consent: "connections_and_code" })).toEqual({ accountId: "new", status: "active" });
    expect((await store.listMembers("cap1")).members).toHaveLength(2);
  });

  test("member removal cancels queued Run and its inputs in the same batch", async () => {
    const { sqlite, store } = fixture();
    const run = { id: "plan1", capsuleId: "cap1", status: "queued", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("plan1", "cap1", "plan", "queued", null, null, JSON.stringify(run));
    sqlite.prepare(`insert into runs_inputs values (?,?)`).run("plan1", "{}");
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    expect(sqlite.prepare(`select status from runs where id='plan1'`).get()).toEqual({ status: "cancelled" });
    expect(sqlite.prepare(`select count(*) as n from runs_inputs`).get()).toEqual({ n: 0 });
    expect(sqlite.prepare(`select count(*) as n from capsule_members`).get()).toEqual({ n: 0 });
  });

  test("running Plan remains leased while member is removed and queued Plan is cancelled", async () => {
    const { sqlite, store } = fixture();
    const run = { id: "plan1", capsuleId: "cap1", status: "running", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("plan1", "cap1", "plan", "running", "lease", 1, JSON.stringify(run));
    const queued = { ...run, id: "plan2", status: "queued" };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("plan2", "cap1", "plan", "queued", null, null, JSON.stringify(queued));
    sqlite.prepare(`insert into runs_inputs values (?,?)`).run("plan2", "{}");
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    expect(sqlite.prepare(`select id,status,lease_token from runs order by id`).all()).toEqual([
      { id: "plan1", status: "running", lease_token: "lease" },
      { id: "plan2", status: "cancelled", lease_token: null },
    ]);
    expect(sqlite.prepare(`select count(*) as n from runs_inputs`).get()).toEqual({ n: 0 });
    expect(await store.resolveAppAccess("member", "cap1")).toBeUndefined();
  });

  test("queued app Source sync is failed before member deletion", async () => {
    const { sqlite, store } = fixture();
    const now = "2026-01-01T00:00:00.000Z";
    const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
      archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`).run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" }), "ws1");
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", null, null, JSON.stringify(run), "src1", "ws1");
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    const row = sqlite.prepare(`select status,run_json from runs where id='sync1'`).get() as { status: string; run_json: string };
    expect(row.status).toBe("failed");
    expect(JSON.parse(row.run_json)).toMatchObject({ status: "failed", errorCode: "app_access_revoked", finishedAt: expect.any(String) });
    expect(sqlite.prepare(`select count(*) as n from capsule_members`).get()).toEqual({ n: 0 });
  });

  test("queued Source sync with a lease fails closed and keeps membership", async () => {
    const { sqlite, store } = fixture();
    const now = "2026-01-01T00:00:00.000Z";
    const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
      archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`)
      .run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" }), "ws1");
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", "lease", 1, JSON.stringify(run), "src1", "ws1");
    await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select status,lease_token from runs where id='sync1'`).get()).toEqual({ status: "queued", lease_token: "lease" });
    expect(await store.resolveAppAccess("member", "cap1")).toMatchObject({ role: "member" });
  });

  test("ambiguous Source blocks removal but running owned Source stays leased after removal", async () => {
    const { sqlite, store } = fixture();
    const now = "2026-01-01T00:00:00.000Z";
    const run = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "member", url: "https://example.test/repo", ref: "main", path: ".",
      archiveRef: "archive", status: "queued", createdAt: now, updatedAt: now };
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`).run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1" }), "ws1");
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", null, null, JSON.stringify(run), "src1", "ws1");
    await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 })).rejects.toMatchObject({ code: "conflict" });
    sqlite.prepare(`update sources set record_json=? where id='src1'`).run(JSON.stringify({ id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" }));
    sqlite.prepare(`update runs set status='running',lease_token='lease',run_json=? where id='sync1'`).run(JSON.stringify({ ...run, status: "running" }));
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    expect(sqlite.prepare(`select status,lease_token from runs where id='sync1'`).get()).toEqual({ status: "running", lease_token: "lease" });
    expect(await store.resolveAppAccess("member", "cap1")).toBeUndefined();
  });

  test("cross-Workspace or mismatched Source linkage cannot be failed during member removal", async () => {
    for (const mismatch of ["source_space", "source_json_space", "run_space", "run_json_space", "capsule_source", "source_json_id", "run_json_source"] as const) {
      const { sqlite, store } = fixture();
      const now = "2026-01-01T00:00:00.000Z";
      const source = { id: mismatch === "source_json_id" ? "other" : "src1", workspaceId: mismatch === "source_json_space" ? "other" : "ws1", ownerCapsuleId: "cap1" };
      const run = { id: "sync1", kind: "source_sync", workspaceId: mismatch === "run_json_space" ? "other" : "ws1",
        sourceId: mismatch === "run_json_source" ? "other" : "src1", actorAccountId: "member",
        url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
        status: "queued", createdAt: now, updatedAt: now };
      sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`)
        .run("src1", JSON.stringify(source), mismatch === "source_space" ? "other" : "ws1");
      sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
        values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", null, null,
          JSON.stringify(run), "src1", mismatch === "run_space" ? "other" : "ws1");
      if (mismatch === "capsule_source") sqlite.prepare(`update capsules set source_id='other' where id='cap1'`).run();
      await expect(store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(sqlite.prepare(`select status from runs where id='sync1'`).get()).toEqual({ status: "queued" });
      expect(sqlite.prepare(`select account_id from capsule_members`).all()).toEqual([{ account_id: "member" }]);
    }
  });

  test("queued Apply inherits the removed member actor from its Plan", async () => {
    const { sqlite, store } = fixture();
    const plan = { id: "plan1", capsuleId: "cap1", status: "succeeded", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] };
    const apply = { id: "apply1", capsuleId: "cap1", planRunId: "plan1", status: "queued", createdAt: 2, updatedAt: 2, auditEvents: [] };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("plan1", "cap1", "plan", "succeeded", null, null, JSON.stringify(plan));
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("apply1", "cap1", "apply", "queued", null, null, JSON.stringify(apply));
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    expect(sqlite.prepare(`select status from runs where id='apply1'`).get()).toEqual({ status: "cancelled" });
    expect(sqlite.prepare(`select status from runs where id='plan1'`).get()).toEqual({ status: "succeeded" });
  });

  test("queued Apply requested by removed member is cancelled even when Plan creator differs", async () => {
    const { sqlite, store } = fixture();
    const plan = { id: "plan1", status: "succeeded", createdBy: "owner", createdAt: 1, updatedAt: 1, auditEvents: [] };
    const apply = { id: "apply1", planRunId: "plan1", status: "queued", createdBy: "member",
      approval: { approvedBy: "member" }, createdAt: 2, updatedAt: 2, auditEvents: [] };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,run_json) values (?,?,?,?,?,?)`)
      .run("plan1", "cap1", "plan", "succeeded", null, JSON.stringify(plan));
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,run_json) values (?,?,?,?,?,?)`)
      .run("apply1", "cap1", "apply", "queued", null, JSON.stringify(apply));
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member", expectedOwnershipEpoch: 4 });
    expect(sqlite.prepare(`select status from runs where id='apply1'`).get()).toEqual({ status: "cancelled" });
  });

  test("large member revocation settles Plans and Source syncs in one bounded atomic batch", async () => {
    const { sqlite, store, lastBatchSize } = fixture();
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`)
      .run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" }), "ws1");
    for (let index = 0; index < 80; index++) {
      const id = `plan${index}`;
      sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,run_json) values (?,?,?,?,?,?)`)
        .run(id, "cap1", "plan", "queued", null,
          JSON.stringify({ id, status: "queued", createdBy: "member", createdAt: 1, updatedAt: 1, auditEvents: [] }));
      sqlite.prepare(`insert into runs_inputs values (?,?)`).run(id, "{}");
      const sourceId = `sync${index}`;
      sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,run_json,source_id,space_id)
        values (?,?,?,?,?,?,?,?)`).run(sourceId, null, "source_sync", "queued", null,
          JSON.stringify({ id: sourceId, kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
            actorAccountId: "member", status: "queued", createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z" }), "src1", "ws1");
    }
    await store.removeMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "member",
      expectedOwnershipEpoch: 4 });
    expect(lastBatchSize()).toBeLessThan(480);
    expect(sqlite.prepare(`select count(*) as n from runs where status='cancelled'`).get()).toEqual({ n: 80 });
    expect(sqlite.prepare(`select count(*) as n from runs where status='failed'`).get()).toEqual({ n: 80 });
    expect(sqlite.prepare(`select count(*) as n from capsule_members`).get()).toEqual({ n: 0 });
  });

  test("member consent and ownership transfer notices are durable", async () => {
    const { sqlite, store } = fixture();
    await store.addMember({ capsuleId: "cap1", actorAccountId: "owner", accountId: "second",
      expectedOwnershipEpoch: 4, consent: "connections_and_code" });
    const consent = sqlite.prepare(`select record_json from audit_events where action='app.member_added'`).get() as { record_json: string };
    expect(JSON.parse(consent.record_json)).toMatchObject({ memberAccountId: "second", consent: "connections_and_code" });
    const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
    expect((await store.listTransfers({ capsuleId: "cap1", state: "pending" })).map((item) => item.transferId)).toEqual([transfer.transferId]);
    expect((await store.listTransfers({ toAccountId: "new", state: "pending" })).map((item) => item.transferId)).toEqual([transfer.transferId]);
    expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("accepted");
    expect(sqlite.prepare(`select count(*) as n from audit_events where action='app.ownership_transferred'`).get()).toEqual({ n: 3 });
    expect(sqlite.prepare(`select count(*) as n from capsule_members`).get()).toEqual({ n: 0 });
  });

  test("transfer drains, blocks active Runs, then swaps owner and clears bindings atomically", async () => {
    const { sqlite, store } = fixture();
    sqlite.prepare(`insert into capsule_members values ('cap1','new','active','owner','2026-01-01','2026-01-01')`).run();
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`).run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1", ownerCapsuleId: "cap1" }), "ws1");
    const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("run1", "cap1", "plan", "running", "lease", 1, JSON.stringify({ id: "run1", status: "running" }));
    for (const [id, status] of [["planq", "queued"], ["planw", "waiting_approval"]] as const) {
      sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run(id, "cap1", "plan", status, null, null,
        JSON.stringify({ id, status, createdAt: 1, updatedAt: 1, auditEvents: [] }));
    }
    sqlite.prepare(`insert into runs_inputs values (?,?)`).run("planq", "{}");
    const sync = { id: "syncq", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "owner", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
      status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("syncq", null, "source_sync", "queued", null, null, JSON.stringify(sync), "src1", "ws1");
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("syncr", null, "source_sync", "running", "lease", 1,
        JSON.stringify({ ...sync, id: "syncr", status: "running" }), "src1", "ws1");
    expect(await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).toEqual({ transferId: transfer.transferId, state: "pending" });
    expect(sqlite.prepare(`select management_state,owner_account_id from capsules where id='cap1'`).get()).toEqual({ management_state: "draining", owner_account_id: "owner" });
    expect(sqlite.prepare(`select id,status from runs where id in ('planq','planw') order by id`).all()).toEqual([
      { id: "planq", status: "cancelled" }, { id: "planw", status: "cancelled" },
    ]);
    expect(sqlite.prepare(`select count(*) as n from runs_inputs`).get()).toEqual({ n: 0 });
    expect(sqlite.prepare(`select status from runs where id='syncq'`).get()).toEqual({ status: "failed" });
    sqlite.prepare(`update runs set status='succeeded',lease_token=null where id='run1'`).run();
    sqlite.prepare(`update runs set status='succeeded',lease_token=null where id='syncr'`).run();
    expect(await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).toEqual({ transferId: transfer.transferId, state: "accepted" });
    expect(sqlite.prepare(`select owner_account_id,ownership_epoch,management_state from capsules where id='cap1'`).get()).toEqual({ owner_account_id: "new", ownership_epoch: 5, management_state: "active" });
    expect(sqlite.prepare(`select count(*) as n from provider_env_binding_sets`).get()).toEqual({ n: 0 });
    expect(sqlite.prepare(`select account_id from capsule_members order by account_id`).all()).toEqual([]);
  });

  test("only current owner cancels transfer and clears drain", async () => {
    const { sqlite, store } = fixture();
    const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
    await expect(store.cancelTransfer({ transferId: transfer.transferId, actorAccountId: "member" })).rejects.toMatchObject({ code: "app_owner_only" });
    await store.cancelTransfer({ transferId: transfer.transferId, actorAccountId: "owner" });
    expect(sqlite.prepare(`select state from capsule_ownership_transfers where id=?`).get(transfer.transferId)).toEqual({ state: "cancelled" });
  });

  test("transfer refuses a queued Source sync with ambiguous app linkage", async () => {
    const { sqlite, store } = fixture();
    sqlite.prepare(`insert into sources (id,record_json,space_id) values (?,?,?)`).run("src1", JSON.stringify({ id: "src1", workspaceId: "ws1" }), "ws1");
    const sync = { id: "sync1", kind: "source_sync", workspaceId: "ws1", sourceId: "src1",
      actorAccountId: "owner", url: "https://example.test/repo", ref: "main", path: ".", archiveRef: "archive",
      status: "queued", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json,source_id,space_id)
      values (?,?,?,?,?,?,?,?,?)`).run("sync1", null, "source_sync", "queued", null, null, JSON.stringify(sync), "src1", "ws1");
    const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
    await expect(store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select owner_account_id,ownership_epoch from capsules where id='cap1'`).get()).toEqual({ owner_account_id: "owner", ownership_epoch: 4 });
    expect(sqlite.prepare(`select management_state from capsules where id='cap1'`).get()).toEqual({ management_state: "active" });
    expect(sqlite.prepare(`select status from runs where id='sync1'`).get()).toEqual({ status: "queued" });
  });

  test("cancel cannot resume a different management drain", async () => {
    const { sqlite, store } = fixture();
    const transfer = await store.createTransfer({ capsuleId: "cap1", actorAccountId: "owner", toAccountId: "new", expectedOwnershipEpoch: 4 });
    sqlite.prepare(`insert into runs (id,installation_id,type,status,lease_token,heartbeat_at,run_json) values (?,?,?,?,?,?,?)`).run("run1", "cap1", "plan", "running", "lease", 1, JSON.stringify({ id: "run1", status: "running" }));
    expect((await store.acceptTransfer({ transferId: transfer.transferId, actorAccountId: "new" })).state).toBe("pending");
    sqlite.prepare(`update capsules set management_epoch=management_epoch+1 where id='cap1'`).run();
    await expect(store.cancelTransfer({ transferId: transfer.transferId, actorAccountId: "owner" })).rejects.toMatchObject({ code: "conflict" });
    expect(sqlite.prepare(`select management_state from capsules where id='cap1'`).get()).toEqual({ management_state: "draining" });
    expect(sqlite.prepare(`select state from capsule_ownership_transfers where id=?`).get(transfer.transferId)).toEqual({ state: "pending" });
  });
});
