import { expect, test } from "bun:test";
import type { Capsule } from "../../../../contract/capsules.ts";
import type { ProviderConnection } from "../../../../contract/connections.ts";
import type { UsageEvent } from "../../../../contract/billing.ts";
import type { Workspace, WorkspaceMember } from "../../../../contract/workspaces.ts";
import type { OpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { applyAppOwnershipBackfill, planAppOwnershipBackfill } from "../../../../core/domains/app-ownership/backfill.ts";
import { runAppOwnershipBackfill } from "../../../../scripts/backfill-app-ownership.ts";

const now = "2026-10-28T00:00:00.000Z";

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
  for (let iteration = 0; iteration < 8; iteration++) {
    const plan = await planAppOwnershipBackfill(context);
    if (!plan.writes.length) break;
    expect((await applyAppOwnershipBackfill(context, plan.digest, 2)).applied).toBeLessThanOrEqual(2);
  }
  expect((await planAppOwnershipBackfill(context)).writes).toEqual([]);
  expect((await context.ownership.getOwnership("cap-personal"))?.storageRoot).toBe("workspaces/personal/capsules/cap-personal");
  expect(await context.ownership.listMembers("cap-organization")).toMatchObject([{ accountId: "admin", status: "active" }]);
  expect(await context.ownership.resolveAppAccess("ordinary", "cap-organization")).toBeUndefined();
  expect(await context.ownership.resolveAppAccess("admin", "cap-organization")).toMatchObject({ role: "member", ownerAccountId: "owner" });
  expect(context.connections.find((row) => row.id === "operator")?.ownerAccountId).toBeUndefined();
});

test("apply rejects a stale reviewed inventory without writing", async () => {
  const context = fixture();
  const plan = await planAppOwnershipBackfill(context);
  context.members[1] = { ...context.members[1]!, status: "suspended" };
  await expect(applyAppOwnershipBackfill(context, plan.digest)).rejects.toThrow("inventory changed");
  expect(await context.ownership.getOwnership("cap-personal")).toBeUndefined();
  await expect(runAppOwnershipBackfill(context, { apply: true })).rejects.toThrow("requires");
});

test("explicit new ownership and roster survive a backfill", async () => {
  const context = fixture();
  await context.ownership.putOwnership({ capsuleId: "cap-organization", ownerAccountId: "other", ownershipEpoch: 3, managementState: "frozen", managementEpoch: 4, storageRoot: "apps/cap-organization" });
  const plan = await planAppOwnershipBackfill(context);
  await applyAppOwnershipBackfill(context, plan.digest);
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
  await applyAppOwnershipBackfill(context, plan.digest);
  expect((await planAppOwnershipBackfill(context)).writes).toEqual([]);
  const original = context.control.getWorkspaceBillingBinding;
  context.control.getWorkspaceBillingBinding = async (workspaceId) => workspaceId === "personal"
    ? { ...await original("organization")!, workspaceId, workspaceRef: "conflicting-ref" }
    : original(workspaceId);
  const conflict = await planAppOwnershipBackfill(context);
  expect(conflict.billingConflicts).toEqual([{ accountId: "owner", workspaceIds: ["organization", "personal"] }]);
  expect(conflict.writes.filter((row) => row.kind === "billing")).toEqual([]);
});
