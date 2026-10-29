import { afterEach, expect, test } from "bun:test";
import type { Capsule } from "../../../../contract/capsules.ts";
import type { ProviderConnection } from "../../../../contract/connections.ts";
import type { UsageEvent } from "../../../../contract/billing.ts";
import type { Workspace, WorkspaceMember } from "../../../../contract/workspaces.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { D1AppOwnershipStore, InMemoryAppOwnershipStore, SqlAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { SqlOpenTofuControlStore } from "../../../../core/domains/deploy-control/store_sql.ts";
import { CloudflareD1OpenTofuControlStore, ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { PGliteSqlClient } from "../../../helpers/deploy-control/pglite_sql_client.ts";
import { SqliteFakeD1 } from "../../../helpers/deploy-control/sqlite_fake_d1.ts";
import { applyAppOwnershipBackfill, planAppOwnershipBackfill, type OwnershipBackfillContext } from "../../../../core/domains/app-ownership/backfill.ts";
import { runAppOwnershipBackfill } from "../../../../scripts/backfill-app-ownership.ts";

const now = "2026-10-28T00:00:00.000Z";
const pgClients: PGliteSqlClient[] = [];
afterEach(async () => { await Promise.all(pgClients.splice(0).map((client) => client.close())); });

function fixture() {
  const workspaces: Workspace[] = [
    { id: "personal", handle: "personal", displayName: "Personal", type: "personal", ownerUserId: "owner", createdAt: now, updatedAt: now },
    { id: "organization", handle: "organization", displayName: "Team", type: "organization", ownerUserId: "owner", createdAt: now, updatedAt: now },
  ];
  const members: WorkspaceMember[] = [
    { id: "m1", workspaceId: "personal", accountId: "owner", roles: ["owner"], status: "active", createdAt: now, updatedAt: now },
    { id: "m2", workspaceId: "organization", accountId: "admin", roles: ["admin"], status: "active", createdAt: now, updatedAt: now },
    { id: "m3", workspaceId: "organization", accountId: "ordinary", roles: ["member"], status: "active", createdAt: now, updatedAt: now },
    { id: "m4", workspaceId: "organization", accountId: "viewer", roles: ["viewer"], status: "active", createdAt: now, updatedAt: now },
    { id: "m5", workspaceId: "organization", accountId: "suspended", roles: ["admin"], status: "suspended", createdAt: now, updatedAt: now },
  ];
  const capsules = ["personal", "organization"].map((workspaceId) => ({
    id: `cap-${workspaceId}`, workspaceId, projectId: `prj-${workspaceId}`, name: "same", slug: "same",
    sourceId: "source", installConfigId: "config", environment: "production", status: "active", currentStateGeneration: 0,
    createdAt: now, updatedAt: now,
  } as Capsule));
  const connections: ProviderConnection[] = [
    { id: "connection", workspaceId: "organization", provider: "example", scope: "workspace", status: "verified", createdAt: now, updatedAt: now } as ProviderConnection,
    { id: "operator", workspaceId: "organization", provider: "example", scope: "operator", status: "verified", createdAt: now, updatedAt: now } as ProviderConnection,
  ];
  const events: (UsageEvent & { payerAccountId?: string })[] = [
    { id: "usage", workspaceId: "organization", kind: "runner_seconds", quantity: 1, usdMicros: 0, ratingStatus: "unrated", source: "runner", idempotencyKey: "usage", createdAt: now } as UsageEvent,
  ];
  const control = {
    listWorkspaces: async () => workspaces,
    getWorkspace: async (id: string) => workspaces.find((row) => row.id === id),
    listWorkspaceMembers: async (id: string) => members.filter((row) => row.workspaceId === id),
    getWorkspaceMember: async (id: string, account: string) => members.find((row) => row.workspaceId === id && row.accountId === account),
    listCapsules: async (id?: string) => capsules.filter((row) => !id || row.workspaceId === id),
    getCapsule: async (id: string) => capsules.find((row) => row.id === id),
    putCapsule: async (row: Capsule) => { capsules[capsules.findIndex((item) => item.id === row.id)] = row; return row; },
    listConnections: async (id: string) => connections.filter((row) => row.workspaceId === id),
    getConnection: async (id: string) => connections.find((row) => row.id === id),
    putConnection: async (row: ProviderConnection) => { connections[connections.findIndex((item) => item.id === row.id)] = row; return row; },
    listUsageEvents: async (id: string) => events.filter((row) => row.workspaceId === id),
    putUsageEvent: async (row: UsageEvent) => { events[events.findIndex((item) => item.id === row.id)] = row; return row; },
    getWorkspaceBillingBinding: async () => undefined,
  } as unknown as OpenTofuControlStore;
  return { control, ownership: new InMemoryAppOwnershipStore(control), capsules, connections, events, members };
}

test("dry-run inventories personal/organization legacy rows, reports collisions and requires confirmation for lesser roles", async () => {
  const context = fixture();
  const plan = await planAppOwnershipBackfill(context);
  expect(plan.writes.filter((write) => write.kind === "ownership")).toHaveLength(2);
  expect(plan.writes.filter((write) => write.kind === "member").map((write) => write.record.accountId)).toEqual(["admin"]);
  expect(plan.confirmationRequired.map((row) => row.accountId)).toEqual(["ordinary", "suspended", "viewer"]);
  expect(plan.collisions).toEqual([{ ownerAccountId: "owner", slug: "same", environment: "production", capsuleIds: ["cap-organization", "cap-personal"] }]);
  expect(plan.writes.filter((write) => write.kind === "connection")).toEqual([{ kind: "connection", id: "connection", ownerAccountId: "owner" }]);
  expect(plan.writes.filter((write) => write.kind === "usage")).toEqual([{ kind: "usage", id: "usage", payerAccountId: "owner" }]);
  expect(await context.ownership.getOwnership("cap-personal")).toBeUndefined();
  expect(context.connections[0]!.ownerAccountId).toBeUndefined();
  expect((await runAppOwnershipBackfill(context, {})).mode).toBe("dry-run");
});

test("bounded apply preserves old storage roots and owner authority and resumes to an empty plan", async () => {
  const context = fixture();
  const frozen = { ...context, workspaceMutationsFrozen: true as const };
  for (let iteration = 0; iteration < 8; iteration++) {
    const plan = await planAppOwnershipBackfill(context);
    if (!plan.writes.length) break;
    expect((await applyAppOwnershipBackfill(frozen, plan.digest, 2)).applied).toBeLessThanOrEqual(2);
  }
  expect((await planAppOwnershipBackfill(context)).writes).toEqual([]);
  expect((await context.ownership.getOwnership("cap-personal"))?.storageRoot).toBe("workspaces/personal/capsules/cap-personal");
  expect(await context.ownership.listMembers("cap-organization")).toMatchObject([{ accountId: "admin", status: "active" }]);
  expect(await context.ownership.resolveAppAccess("ordinary", "cap-organization")).toBeUndefined();
  expect(await context.ownership.resolveAppAccess("admin", "cap-organization")).toMatchObject({ role: "member", ownerAccountId: "owner" });
  expect(context.connections.find((row) => row.id === "operator")?.ownerAccountId).toBeUndefined();
  const complete = await planAppOwnershipBackfill(context);
  expect((await applyAppOwnershipBackfill(frozen, complete.digest)).applied).toBe(0);
});

test("orphan Capsules and unresolved app usage are reported; only unresolved payer stops apply", async () => {
  const context = fixture();
  context.capsules.push({ ...context.capsules[0]!, id: "z-orphan", workspaceId: "missing" },
    { ...context.capsules[0]!, id: "a-orphan", workspaceId: "missing" });
  context.events.push({ ...context.events[0]!, id: "missing-app-usage", capsuleId: "absent", idempotencyKey: "missing" },
    { ...context.events[0]!, id: "other-workspace-usage", capsuleId: "cap-personal", idempotencyKey: "mismatch" },
    { ...context.events[0]!, id: "already-paid", capsuleId: "removed-app", idempotencyKey: "paid",
      payerAccountId: "retained-payer" });
  const plan = await planAppOwnershipBackfill(context);
  expect(plan.orphanCapsules).toEqual([
    { capsuleId: "a-orphan", workspaceId: "missing" },
    { capsuleId: "z-orphan", workspaceId: "missing" },
  ]);
  expect(plan.unresolvedUsagePayers).toEqual([
    { eventId: "missing-app-usage", workspaceId: "organization", capsuleId: "absent", reason: "capsule_missing" },
    { eventId: "other-workspace-usage", workspaceId: "organization", capsuleId: "cap-personal", reason: "workspace_mismatch" },
  ]);
  expect(plan.writes.filter((row) => row.kind === "usage")).toEqual([
    { kind: "usage", id: "usage", payerAccountId: "owner" },
  ]);
  expect(plan.unresolvedUsagePayers.some((row) => row.eventId === "already-paid")).toBe(false);
  expect(await planAppOwnershipBackfill(context)).toEqual(plan);
  await expect(applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true }, plan.digest))
    .rejects.toThrow("unresolved usage payers");
  expect(await context.ownership.getOwnership("cap-organization")).toBeUndefined();
});

test("orphan Capsules are skipped while valid backfill writes progress", async () => {
  const context = fixture();
  context.capsules.push({ ...context.capsules[0]!, id: "old-destroyed-orphan",
    workspaceId: "removed-workspace", status: "destroyed" });
  const plan = await planAppOwnershipBackfill(context);
  expect(plan.orphanCapsules).toEqual([
    { capsuleId: "old-destroyed-orphan", workspaceId: "removed-workspace" },
  ]);
  expect(plan.writes.some((row) => row.kind === "ownership" &&
    row.record.capsuleId === "old-destroyed-orphan")).toBe(false);
  expect((await applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true },
    plan.digest, 1)).applied).toBe(1);
  expect(await context.ownership.getOwnership("old-destroyed-orphan")).toBeUndefined();
});

test("apply requires an explicitly verified Workspace mutation freeze; dry-run does not", async () => {
  const context = fixture();
  const plan = await planAppOwnershipBackfill(context);
  expect((await runAppOwnershipBackfill(context, {})).mode).toBe("dry-run");
  await expect(applyAppOwnershipBackfill(context, plan.digest)).rejects.toThrow("workspaceMutationsFrozen");
  await expect(runAppOwnershipBackfill(context, { apply: true, expectedDigest: plan.digest }))
    .rejects.toThrow("workspaceMutationsFrozen");
  await expect(applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: false } as unknown as OwnershipBackfillContext,
    plan.digest)).rejects.toThrow("workspaceMutationsFrozen");
  expect(await context.ownership.getOwnership("cap-organization")).toBeUndefined();
  expect((await runAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true },
    { apply: true, expectedDigest: plan.digest, batchSize: 1 })).mode).toBe("apply");
});

test("Memory: transferred app owns legacy usage payer while Workspace-only usage keeps Workspace owner", async () => {
  const context = fixture();
  expect(await context.ownership.initializeOwnershipIfMissing({ capsuleId: "cap-organization", ownerAccountId: "transferred",
    ownershipEpoch: 3, managementState: "active", managementEpoch: 4,
    storageRoot: "apps/cap-organization" })).toBe(true);
  context.events.push({ ...context.events[0]!, id: "app-usage", capsuleId: "cap-organization",
    idempotencyKey: "app-usage" });
  const plan = await planAppOwnershipBackfill(context);
  expect(plan.writes.filter((row) => row.kind === "usage")).toEqual([
    { kind: "usage", id: "app-usage", payerAccountId: "transferred" },
    { kind: "usage", id: "usage", payerAccountId: "owner" },
  ]);
  const frozen = { ...context, workspaceMutationsFrozen: true as const };
  await applyAppOwnershipBackfill(frozen, plan.digest);
  expect(context.events.find((row) => row.id === "app-usage")?.payerAccountId).toBe("transferred");
  expect(context.events.find((row) => row.id === "usage")?.payerAccountId).toBe("owner");
});

test("apply rejects a stale reviewed inventory without writing", async () => {
  const context = fixture();
  const plan = await planAppOwnershipBackfill(context);
  context.members[1] = { ...context.members[1]!, status: "suspended" };
  await expect(applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true }, plan.digest)).rejects.toThrow("inventory changed");
  expect(await context.ownership.getOwnership("cap-personal")).toBeUndefined();
  await expect(runAppOwnershipBackfill(context, { apply: true })).rejects.toThrow("requires");
});

test("explicit new ownership and roster survive a backfill", async () => {
  const context = fixture();
  expect(await context.ownership.initializeOwnershipIfMissing({ capsuleId: "cap-organization", ownerAccountId: "other", ownershipEpoch: 3, managementState: "frozen", managementEpoch: 4, storageRoot: "apps/cap-organization" })).toBe(true);
  const plan = await planAppOwnershipBackfill(context);
  await applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true }, plan.digest);
  expect(await context.ownership.getOwnership("cap-organization")).toMatchObject({ ownerAccountId: "other", ownershipEpoch: 3, managementState: "frozen" });
  expect(await context.ownership.listMembers("cap-organization")).toEqual([]);
});

test("billing preserves the retained billing reference and refuses to choose between conflicting bindings", async () => {
  const context = fixture();
  context.control.getWorkspaceBillingBinding = async (workspaceId) => workspaceId === "organization" ? {
    intentId: "intent", workspaceId, billingAuthority: "authority", workspaceRef: "retained-ref",
    workspaceCreatedAt: now, actorAccountId: "owner", managementEpoch: 0, createdAt: now,
    organizationRef: "organization-ref", ownerAcknowledgementRef: "ack", boundAt: now,
  } : undefined;
  const plan = await planAppOwnershipBackfill(context);
  expect(plan.writes.filter((row) => row.kind === "billing")).toMatchObject([
    { record: { accountId: "owner", billingRef: "retained-ref", organizationRef: "organization-ref" } },
  ]);
  await applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: true }, plan.digest);
  expect((await planAppOwnershipBackfill(context)).writes).toEqual([]);
  const original = context.control.getWorkspaceBillingBinding;
  context.control.getWorkspaceBillingBinding = async (workspaceId) => workspaceId === "personal"
    ? { ...await original("organization")!, workspaceId, workspaceRef: "conflicting-ref" }
    : original(workspaceId);
  const conflict = await planAppOwnershipBackfill(context);
  expect(conflict.billingConflicts).toEqual([{ accountId: "owner", workspaceIds: ["organization", "personal"] }]);
  expect(conflict.writes.filter((row) => row.kind === "billing")).toEqual([]);
});

test("Postgres and D1 backfill transferred app payer with idempotent apply and report orphan Capsules", async () => {
  const pg = await PGliteSqlClient.create();
  pgClients.push(pg);
  const d1 = new SqliteFakeD1();
  await ensureD1OpenTofuLedgerSchema(d1);
  const adapters = [
    { label: "Postgres", control: new SqlOpenTofuControlStore({ client: pg }) as OpenTofuControlStore,
      ownership: new SqlAppOwnershipStore(pg, new SqlOpenTofuControlStore({ client: pg })),
      clearPayer: async (id: string) => {
        await pg.query("update takosumi_usage_events set payer_account_id=null where id=$1", [id]);
      } },
    { label: "D1", control: new CloudflareD1OpenTofuControlStore(d1) as OpenTofuControlStore,
      ownership: new D1AppOwnershipStore(d1, new CloudflareD1OpenTofuControlStore(d1)),
      clearPayer: async (id: string) => {
        await d1.prepare("update usage_events set payer_account_id=null where id=?").bind(id).run();
      } },
  ];
  for (const { label, control, ownership, clearPayer } of adapters) {
    const workspace: Workspace = { id: `ws_${label}`, handle: `ws-${label.toLowerCase()}`,
      displayName: label, type: "personal", ownerUserId: "legacy-owner",
      createdAt: now, updatedAt: now };
    const app: Capsule = { id: `cap_${label}`, workspaceId: workspace.id,
      projectId: `prj_${label}`, name: "App", slug: "app", sourceId: `src_${label}`,
      installConfigId: `cfg_${label}`, environment: "production", status: "active",
      currentStateGeneration: 0, createdAt: now, updatedAt: now };
    await control.putWorkspace(workspace);
    await control.putCapsule(app);
    expect(await ownership.initializeOwnershipIfMissing({ capsuleId: app.id,
      ownerAccountId: "transferred-owner", ownershipEpoch: 3, managementState: "active",
      managementEpoch: 4, storageRoot: `apps/${app.id}` }), label).toBe(true);
    const event: UsageEvent = { id: `usage_${label}`, workspaceId: workspace.id,
      capsuleId: app.id, kind: "runner_minute", quantity: 1, usdMicros: 0,
      ratingStatus: "unrated", source: "runner", idempotencyKey: `usage_${label}`,
      createdAt: now };
    await control.putUsageEvent(event);
    await clearPayer(event.id); // Retained pre-expand event with no payer column value.
    const context = { control, ownership };
    const plan = await planAppOwnershipBackfill(context);
    expect(plan.writes.filter((row) => row.kind === "usage"), label).toEqual([
      { kind: "usage", id: event.id, payerAccountId: "transferred-owner" },
    ]);
    await expect(applyAppOwnershipBackfill(context, plan.digest), label)
      .rejects.toThrow("workspaceMutationsFrozen");
    await expect(applyAppOwnershipBackfill({ ...context, workspaceMutationsFrozen: false } as unknown as OwnershipBackfillContext,
      plan.digest), label).rejects.toThrow("workspaceMutationsFrozen");
    expect((await control.listUsageEvents(workspace.id))[0]?.payerAccountId, label).toBeUndefined();
    const frozen = { ...context, workspaceMutationsFrozen: true as const };
    expect((await applyAppOwnershipBackfill(frozen, plan.digest)).applied, label).toBe(1);
    expect((await control.listUsageEvents(workspace.id))[0]?.payerAccountId, label)
      .toBe("transferred-owner");
    const complete = await planAppOwnershipBackfill(context);
    expect(complete.writes, label).toEqual([]);
    expect((await applyAppOwnershipBackfill(frozen, complete.digest)).applied, label).toBe(0);

    const orphan: Capsule = { ...app, id: `orphan_${label}`, workspaceId: `missing_${label}`,
      name: "Orphan", slug: "orphan" };
    await control.putCapsule(orphan);
    const blocked = await planAppOwnershipBackfill(context);
    expect(blocked.orphanCapsules, label).toEqual([
      { capsuleId: orphan.id, workspaceId: orphan.workspaceId },
    ]);
    expect((await applyAppOwnershipBackfill(frozen, blocked.digest)).applied, label).toBe(0);
  }
});
