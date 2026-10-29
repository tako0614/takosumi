import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import type { SourceSyncRun } from "takosumi-contract/sources";
import { D1AppMintLeaseStore, SqlAppMintLeaseStore, type AppMintLeaseStore } from
  "../../../../core/domains/app-authorization/mint-leases.ts";
import { D1AppAuthorizationStore, SqlAppAuthorizationStore } from
  "../../../../core/domains/app-authorization/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore } from "../../../../worker/src/d1_opentofu_store.ts";
import { capsuleApplyRunAdmissionFence, type OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { AppAccessResolver } from "../../../../contract/app-access.ts";
import type { D1Like } from "../../../../core/adapters/storage/d1.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

setDefaultTimeout(30_000);
const clients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });

const access: AppAccessResolver = {
  async resolveAppAccess() { return undefined; },
  async listAccessibleApps() { return { apps: [] }; },
};
const releaseConnection = [{ id: "release-operator", authority: "release-owned" as const,
  expectedConnection: { id: "release-operator", scope: "operator", status: "verified" } }];

async function fixtures(now: () => number) {
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const d1 = new SqliteFakeD1();
  return [
    { label: "postgres", store: new SqlOpenTofuControlStore({ client: pg }) as OpenTofuControlStore,
      leases: new SqlAppMintLeaseStore(pg, { now }), ownership: new SqlAppAuthorizationStore(pg, access),
      async addMember(capsuleId: string, accountId: string) {
        await pg.query(`insert into takosumi_capsule_members
          (capsule_id,account_id,status,added_by,created_at,updated_at) values ($1,$2,'active','owner','now','now')`,
        [capsuleId, accountId]);
      },
      async revoke(capsuleId: string, accountId: string) {
        await pg.query(`delete from takosumi_capsule_members where capsule_id=$1 and account_id=$2`,
          [capsuleId, accountId]);
      },
      async corruptSource(sourceId: string) {
        await pg.query(`update takosumi_sources set source_json=jsonb_set(source_json::jsonb,
          '{ownerCapsuleId}', '"other-app"'::jsonb) where id=$1`, [sourceId]);
      },
      async addConnection(id: string) {
        await pg.query(`insert into takosumi_connections
          (id,space_id,provider,status,connection_json,created_at,updated_at,owner_account_id)
          values ($1,null,'fixture','verified',$2::jsonb,'now','now','owner')`,
        [id, JSON.stringify({ id, status: "verified", ownerAccountId: "owner" })]);
      },
      async revokeConnection(id: string) {
        await pg.query(`update takosumi_connections set status='revoked',
          connection_json=jsonb_set(connection_json::jsonb,'{status}','"revoked"'::jsonb) where id=$1`, [id]);
      },
      async leaseCount(capsuleId: string) {
        const result = await pg.query<{ count: number }>(
          `select count(*)::integer as count from takosumi_app_credential_mint_leases where capsule_id=$1`, [capsuleId]);
        return result.rows[0]?.count ?? -1;
      } },
    { label: "d1", store: new CloudflareD1OpenTofuControlStore(d1) as OpenTofuControlStore,
      leases: new D1AppMintLeaseStore(d1 as unknown as D1Like, { now }),
      ownership: new D1AppAuthorizationStore(d1 as unknown as D1Like, access),
      async addMember(capsuleId: string, accountId: string) {
        await d1.prepare(`insert into capsule_members
          (capsule_id,account_id,status,added_by,created_at,updated_at) values (?,?,'active','owner','now','now')`)
          .bind(capsuleId, accountId).run();
      },
      async revoke(capsuleId: string, accountId: string) {
        await d1.prepare(`delete from capsule_members where capsule_id=? and account_id=?`)
          .bind(capsuleId, accountId).run();
      },
      async corruptSource(sourceId: string) {
        await d1.prepare(`update sources set record_json=json_set(record_json,
          '$.ownerCapsuleId', 'other-app') where id=?`).bind(sourceId).run();
      },
      async addConnection(id: string) {
        await d1.prepare(`insert into connections
          (id,space_id,provider,status,connection_json,created_at,updated_at,owner_account_id)
          values (?,null,'fixture','verified',?,'now','now','owner')`)
          .bind(id, JSON.stringify({ id, status: "verified", ownerAccountId: "owner" })).run();
      },
      async revokeConnection(id: string) {
        await d1.prepare(`update connections set status='revoked',
          connection_json=json_set(connection_json,'$.status','revoked') where id=?`).bind(id).run();
      },
      async leaseCount(capsuleId: string) {
        const row = await d1.prepare(`select count(*) as count from app_credential_mint_leases where capsule_id=?`)
          .bind(capsuleId).first<{ count: number }>();
        return row?.count ?? -1;
      } },
  ] as const;
}

function plan(capsule: Capsule, id: string, createdBy = "owner"): PlanRun {
  return { id, workspaceId: capsule.workspaceId, capsuleId: capsule.id, createdBy,
    ownershipEpoch: 0, appManagementEpoch: 0,
    source: { kind: "git", url: "https://git.example.test/app.git",
      commit: "0123456789abcdef0123456789abcdef01234567" },
    sourceDigest: "sha256:source", operation: "update", runnerProfileId: "runner",
    variablesDigest: "sha256:variables", executionInputsDigest: "sha256:inputs",
    requiredProviders: [], requiredProviderRequirements: [], status: "queued",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy", auditEvents: [], createdAt: 1, updatedAt: 1 };
}

async function runningPlan(store: OpenTofuControlStore, capsule: Capsule, id: string,
  createdBy = "owner"): Promise<PlanRun> {
  const queued = plan(capsule, id, createdBy);
  const management = { workspaceId: capsule.workspaceId, managementState: "active" as const, managementEpoch: 1 };
  expect((await store.preparePlanRun({ run: queued,
    inputs: { planRunId: id, variables: {} }, expectedWorkspaceManagementAuthority: management })).status).toBe("created");
  const claimed = await store.transitionRun({ id, kind: "plan", expectFrom: ["queued"],
    setLeaseToken: `run-lease-${id}`, heartbeatAt: 2,
    run: { ...queued, status: "running", startedAt: 2, heartbeatAt: 2 } });
  expect(claimed.won).toBe(true);
  return claimed.run as PlanRun;
}

async function seedOwned(store: OpenTofuControlStore, id: string): Promise<Capsule> {
  const { capsule } = await seedCapsuleModel(store, { capsuleId: id });
  const owned: Capsule = { ...capsule, ownerAccountId: "owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0 };
  await store.putCapsule(owned);
  return owned;
}

test("durable mint lease keeps a settled Run transfer pending while a driver is paused", async () => {
  let now = Date.now();
  for (const fixture of await fixtures(() => now)) {
    const { label, store, leases, ownership } = fixture;
    const capsule = await seedOwned(store, `cap_mint_race_${label}`);
    const running = await runningPlan(store, capsule, `plan_mint_race_${label}`);
    const lease = await leases.begin({ capsuleId: capsule.id, runId: running.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["owner"], connections: releaseConnection });
    expect(lease, label).toBeDefined();
    const settled = { ...running, status: "failed" as const, updatedAt: 3 };
    expect((await store.transitionRun({ id: running.id, kind: "plan", expectFrom: ["running"],
      expectLeaseToken: `run-lease-${running.id}`, clearLeaseToken: true, run: settled })).won, label).toBe(true);
    const transfer = await ownership.createTransfer({ capsuleId: capsule.id,
      actorAccountId: "owner", toAccountId: "recipient", expectedOwnershipEpoch: 0 });
    expect((await ownership.acceptTransfer({ transferId: transfer.transferId,
      actorAccountId: "recipient" })).state, label).toBe("pending");
    expect(await leases.finish(lease!, "issued"), label).toBe(false);
    expect((await ownership.acceptTransfer({ transferId: transfer.transferId,
      actorAccountId: "recipient" })).state, label).toBe("accepted");
    now += 100;
  }
});

test("mint finish discards after actor revocation, expiry, or canonical actor mismatch", async () => {
  let now = 1_000;
  for (const fixture of await fixtures(() => now)) {
    const { label, store, leases, addMember, revoke } = fixture;
    const capsule = await seedOwned(store, `cap_mint_actor_${label}`);
    await addMember(capsule.id, "member");
    const running = await runningPlan(store, capsule, `plan_mint_actor_${label}`, "member");
    const input = { capsuleId: capsule.id, runId: running.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["member"], connections: releaseConnection };
    expect(await leases.begin({ ...input, expectedActorAccountIds: ["owner"] }), label).toBeUndefined();
    const revoked = await leases.begin(input);
    expect(revoked, label).toBeDefined();
    await revoke(capsule.id, "member");
    expect(await leases.finish(revoked!, "issued"), label).toBe(false);
    await addMember(capsule.id, "member");
    const expired = await leases.begin(input);
    expect(expired, label).toBeDefined();
    now = expired!.expiresAt;
    expect(await leases.finish(expired!, "issued"), label).toBe(false);
    now += 1;
  }
});

test("mint lease issues once while authority remains current", async () => {
  for (const fixture of await fixtures(() => 1_000)) {
    const { label, store, leases } = fixture;
    const capsule = await seedOwned(store, `cap_mint_success_${label}`);
    const running = await runningPlan(store, capsule, `plan_mint_success_${label}`);
    const lease = await leases.begin({ capsuleId: capsule.id, runId: running.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["owner"], connections: releaseConnection });
    expect(lease, label).toBeDefined();
    // An inconsistent internal handle must not consume the real driver's fence.
    expect(await leases.finish({ ...lease!, runId: "unrelated-run" }, "discarded"), label).toBe(false);
    expect(await leases.finish(lease!, "issued"), label).toBe(true);
    expect(await leases.finish(lease!, "issued"), label).toBe(false);
  }
});

test("Apply mint derives both creator and approver from persisted Plan and Apply", async () => {
  for (const fixture of await fixtures(() => 1_000)) {
    const { label, store, leases, addMember, revoke } = fixture;
    const capsule = await seedOwned(store, `cap_mint_apply_${label}`);
    await addMember(capsule.id, "creator");
    await addMember(capsule.id, "approver");
    const running = await runningPlan(store, capsule, `plan_mint_apply_${label}`, "creator");
    const queued: ApplyRun = {
      id: `apply_mint_${label}`, planRunId: running.id, workspaceId: capsule.workspaceId,
      capsuleId: capsule.id, operation: "update", runnerProfileId: "runner", status: "queued",
      approval: { approvedBy: "approver", approvedAt: 2 },
      expected: { planRunId: running.id, capsuleId: capsule.id,
        currentStateVersionId: capsule.currentStateVersionId ?? null,
        capsuleExecutionAuthorityEpoch: 1, runnerProfileId: "runner",
        sourceDigest: running.sourceDigest, variablesDigest: running.variablesDigest,
        policyDecisionDigest: running.policyDecisionDigest!, planDigest: "sha256:plan",
        planArtifactDigest: "sha256:artifact" },
      stateBackend: { kind: "operator-managed", ref: "state" },
      stateLock: { status: "pending", backendRef: "state" },
      auditEvents: [], createdAt: 2, updatedAt: 2,
    };
    expect((await store.beginApplyRun(queued,
      { workspaceId: capsule.workspaceId, managementState: "active", managementEpoch: 1 },
      capsuleApplyRunAdmissionFence(capsule, 1))).status, label).toBe("created");
    const claimed = await store.transitionRun({ id: queued.id, kind: "apply", expectFrom: ["queued"],
      setLeaseToken: `run-lease-${queued.id}`, heartbeatAt: 3,
      run: { ...queued, status: "running", startedAt: 3, heartbeatAt: 3 } });
    expect(claimed.won, label).toBe(true);
    const input = { capsuleId: capsule.id, runId: queued.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["creator", "approver"], connections: releaseConnection };
    expect(await leases.begin({ ...input, expectedActorAccountIds: ["creator"] }), label).toBeUndefined();
    const lease = await leases.begin(input);
    expect(lease, label).toBeDefined();
    await revoke(capsule.id, "approver");
    expect(await leases.finish(lease!, "issued"), label).toBe(false);
  }
});

test("Source mint requires the persisted app Source, actor, and running Run", async () => {
  for (const fixture of await fixtures(() => 1_000)) {
    const { label, store, leases, corruptSource, leaseCount } = fixture;
    const { source } = await seedCapsuleModel(store, { capsuleId: `cap_mint_source_${label}`,
      sourceId: `src_mint_source_${label}` });
    const original = (await store.getCapsule(`cap_mint_source_${label}`))!;
    const capsule: Capsule = { ...original, ownerAccountId: "owner", ownershipEpoch: 0,
      managementState: "active", managementEpoch: 0 };
    await store.putCapsule(capsule);
    await store.putSource({ ...source, ownerCapsuleId: capsule.id, authConnectionId: "release-operator" });
    const queued: SourceSyncRun = { id: `source_run_${label}`, kind: "source_sync",
      workspaceId: capsule.workspaceId, sourceId: source.id, actorAccountId: "owner",
      ownershipEpoch: 0, url: source.url, ref: source.defaultRef, path: ".",
      archiveRef: "archive-source", status: "queued", createdAt: "2026-10-28T00:00:00.000Z",
      updatedAt: "2026-10-28T00:00:00.000Z" };
    expect((await store.beginSourceSyncRun(queued, { workspaceId: capsule.workspaceId,
      managementState: "active", managementEpoch: 1 })).status, label).toBe("created");
    const claimed = await store.transitionRun({ id: queued.id, kind: "source_sync",
      expectFrom: ["queued"], setLeaseToken: `run-lease-${queued.id}`, heartbeatAt: 2,
      run: { ...queued, status: "running", startedAt: queued.createdAt, heartbeatAt: 2 } });
    expect(claimed.won, label).toBe(true);
    const input = { capsuleId: capsule.id, runId: queued.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["owner"], connections: releaseConnection };
    const lease = await leases.begin(input);
    expect(lease, label).toBeDefined();
    expect(await leases.finish(lease!, "issued"), label).toBe(true);
    const stale = await leases.begin(input);
    expect(stale, label).toBeDefined();
    await corruptSource(source.id);
    expect(await leases.finish(stale!, "issued"), label).toBe(false);
    expect(await leaseCount(capsule.id), label).toBe(0);
    expect(await leases.begin(input), label).toBeUndefined();
  }
});

test("stored Connection revocation during driver wait blocks final credential release", async () => {
  for (const fixture of await fixtures(() => 1_000)) {
    const { label, store, leases, addConnection, revokeConnection, leaseCount } = fixture;
    const capsule = await seedOwned(store, `cap_mint_connection_${label}`);
    const running = await runningPlan(store, capsule, `plan_mint_connection_${label}`);
    const connectionId = `conn_mint_connection_${label}`;
    await addConnection(connectionId);
    const input = { capsuleId: capsule.id, runId: running.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["owner"],
      connections: [{ id: connectionId, authority: "stored" as const,
        expectedConnection: { id: connectionId, status: "verified", ownerAccountId: "owner" } }] };
    // Vault descriptors can retain an explicit undefined optional field after
    // rotation; the durable JSON row correctly omits that field.
    const valid = await leases.begin({ ...input, connections: input.connections.map((binding) => ({
      ...binding, expectedConnection: { ...binding.expectedConnection, secretPartition: undefined },
    })) });
    expect(valid, label).toBeDefined();
    expect(await leases.finish(valid!, "issued"), label).toBe(true);
    const lease = await leases.begin(input);
    expect(lease, label).toBeDefined();
    await revokeConnection(connectionId);
    expect(await leases.finish(lease!, "issued"), label).toBe(false);
    expect(await leaseCount(capsule.id), label).toBe(0);
    expect(await leases.begin(input), label).toBeUndefined();
  }
});

test("D1 transfer's final atomic guard rejects a lease inserted after its pre-read", async () => {
  const db = new SqliteFakeD1();
  const store = new CloudflareD1OpenTofuControlStore(db);
  const capsule = await seedOwned(store, "cap_mint_final_guard");
  let armed = false;
  let batches = 0;
  const intercepted: D1Like = {
    prepare(query) { return db.prepare(query); },
    async batch(statements) {
      if (armed && ++batches === 3) {
        await db.prepare(`insert into app_credential_mint_leases
          (id,capsule_id,run_id,owner_account_id,ownership_epoch,management_epoch,
           actor_account_ids_json,expires_at,created_at) values (?,?,?,?,?,?,?,?,?)`)
          .bind("inflight", capsule.id, "settled-run", "owner", 0, 0,
            '["owner"]', Date.now() + 120_000, new Date().toISOString()).run();
      }
      return await db.batch(statements);
    },
  };
  const ownership = new D1AppAuthorizationStore(intercepted, access);
  const transfer = await ownership.createTransfer({ capsuleId: capsule.id,
    actorAccountId: "owner", toAccountId: "recipient", expectedOwnershipEpoch: 0 });
  armed = true;
  await expect(ownership.acceptTransfer({ transferId: transfer.transferId,
    actorAccountId: "recipient" })).rejects.toThrow();
  expect((await store.getCapsule(capsule.id))?.ownerAccountId).toBe("owner");
  expect((await store.getCapsule(capsule.id))?.managementState).toBe("draining");
  await db.prepare(`delete from app_credential_mint_leases where id='inflight'`).run();
  expect((await ownership.acceptTransfer({ transferId: transfer.transferId,
    actorAccountId: "recipient" })).state).toBe("accepted");
});

test("an owned app cannot mint when its private lease table is absent", async () => {
  const pg = await PGliteSqlClient.create();
  clients.push(pg);
  const d1 = new SqliteFakeD1();
  for (const [label, store, leases, removeTable] of [
    ["postgres", new SqlOpenTofuControlStore({ client: pg }), new SqlAppMintLeaseStore(pg),
      async () => { await pg.query(`drop table takosumi_app_credential_mint_leases`); }],
    ["d1", new CloudflareD1OpenTofuControlStore(d1), new D1AppMintLeaseStore(d1 as unknown as D1Like),
      async () => { await d1.prepare(`drop table app_credential_mint_leases`).run(); }],
  ] as const) {
    const capsule = await seedOwned(store, `cap_mint_missing_${label}`);
    const running = await runningPlan(store, capsule, `plan_mint_missing_${label}`);
    await removeTable();
    await expect(leases.begin({ capsuleId: capsule.id, runId: running.id,
      expectedOwnerAccountId: "owner", expectedOwnershipEpoch: 0,
      expectedManagementEpoch: 0, expectedActorAccountIds: ["owner"], connections: releaseConnection }), label).rejects.toThrow();
  }
});
