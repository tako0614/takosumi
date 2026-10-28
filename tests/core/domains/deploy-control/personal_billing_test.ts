import { expect, test } from "bun:test";
import type { Capsule } from "takosumi-contract/capsules";
import type { UsageEvent } from "takosumi-contract/billing";
import { appBillingIdentity } from "../../../../core/domains/deploy-control/billing_workspace_compat.ts";
import { getPayerBillingBinding } from "../../../../core/domains/deploy-control/account_billing_service.ts";
import { BillingService } from "../../../../core/domains/deploy-control/billing_service.ts";
import { UsageReportingService, listPayerUsage } from "../../../../core/domains/deploy-control/usage_service.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const now = Date.parse("2026-10-28T00:00:00.000Z");

function app(ownerAccountId?: unknown): Capsule {
  return {
    id: "app_one", workspaceId: "old_workspace", projectId: "old_project", name: "app", slug: "app",
    sourceId: "source_one", installConfigId: "config_one", environment: "production",
    currentStateGeneration: 0, status: "active", createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), ...(ownerAccountId !== undefined ? { ownerAccountId } : {}),
  } as Capsule;
}

test("app owner resolves without reading Workspace or an actor/member", async () => {
  const store = {
    getCapsule: async () => app("app_owner"),
    getWorkspace: async () => { throw new Error("Workspace must not be read"); },
  };
  expect(await appBillingIdentity(store, "app_one")).toEqual({ capsuleId: "app_one", payerAccountId: "app_owner" });
  for (const owner of ["", " ", null, 7]) {
    await expect(appBillingIdentity({ ...store, getCapsule: async () => app(owner) }, "app_one"))
      .rejects.toThrow("App billing owner is unavailable");
  }
  await expect(appBillingIdentity(store, undefined)).rejects.toThrow("Billing requires an app");
  await expect(appBillingIdentity({ ...store, getCapsule: async () => undefined }, "missing"))
    .rejects.toThrow("not found");
});

test("pre-v77 adapter uses only the app's canonical Workspace owner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store);
  expect(await appBillingIdentity(store, capsule.id)).toEqual({ capsuleId: capsule.id, payerAccountId: "user_test" });
});

test("billing binding is read by payer and preserves the existing opaque billingRef", async () => {
  const binding = {
    accountId: "app_owner", billingAuthority: "host-authority", billingRef: "old_workspace_ref",
    organizationRef: "organization_existing",
  };
  const read: string[] = [];
  expect(await getPayerBillingBinding({ getAccountBillingBinding: async (id) => { read.push(id); return binding; } }, "app_owner"))
    .toBe(binding);
  expect(read).toEqual(["app_owner"]);
  expect(await getPayerBillingBinding({ getAccountBillingBinding: async () => undefined }, "new_owner")).toBeUndefined();
  await expect(getPayerBillingBinding({ getAccountBillingBinding: async () => binding }, "other_member"))
    .rejects.toThrow("does not match the payer");
});

test("payer usage crosses old Workspace boundaries and retains the original owner after transfer", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const event = (id: string, workspaceId: string, payerAccountId?: string): UsageEvent => ({
    id, workspaceId, capsuleId: "app_one", ...(payerAccountId ? { payerAccountId } : {}),
    kind: "runner_minute", quantity: 1, usdMicros: 0, ratingStatus: "unrated", source: "runner",
    idempotencyKey: id, createdAt: new Date(now).toISOString(),
  });
  await store.putUsageEvent(event("old", "workspace_one", "old_owner"));
  await store.putUsageEvent(event("new", "workspace_one", "new_owner"));
  await store.putUsageEvent(event("other_workspace", "workspace_two", "old_owner"));
  await store.putUsageEvent(event("unattributed", "workspace_one"));
  store.getWorkspace = async () => { throw new Error("Workspace must not be read"); };
  store.getCapsule = async () => { throw new Error("Current ownership must not rewrite history"); };
  const first = await listPayerUsage(store, "old_owner", { limit: 1 });
  expect(first.usageEvents.map((row) => row.id)).toEqual(["other_workspace"]);
  const second = await listPayerUsage(store, "old_owner", { limit: 1, cursor: first.nextCursor });
  expect(second.usageEvents.map((row) => row.id)).toEqual(["old"]);
  expect(second.nextCursor).toBeUndefined();
  expect((await listPayerUsage(store, "new_owner")).usageEvents.map((row) => row.id)).toEqual(["new"]);
  expect((await listPayerUsage(store, "member")).usageEvents).toEqual([]);
});

test("metered and runner ratings attribute to the app owner rather than the old Workspace owner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store);
  const originalGetCapsule = store.getCapsule.bind(store);
  store.getCapsule = async (id) => {
    const value = await originalGetCapsule(id);
    return value ? { ...value, ownerAccountId: "transferred_owner" } : undefined;
  };
  const ratingSubjects: string[] = [];
  const billing = new BillingService({
    store, now: () => now, newId: () => "usage_runner", defaultBillingSettings: { mode: "showback" },
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
    rater: {
      ratePlan: async () => ({ ratingStatus: "unrated", usdMicros: 0 }),
      rateUsage: async (input) => { ratingSubjects.push(input.billingSubjectId); return { ratingStatus: "unrated", usdMicros: 0 }; },
    },
  });
  const service = new UsageReportingService({
    store, now: () => now, newId: () => "usage_meter", billing,
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const { usageEvent } = await service.recordMeteredUsage(capsule.workspaceId, {
    capsuleId: capsule.id, kind: "storage.gb_hour", quantity: 1, usdMicros: 0, ratingStatus: "unrated",
    source: "storage", idempotencyKey: "meter_app_one",
  });
  expect(usageEvent.payerAccountId).toBe("transferred_owner");
  const rating = await billing.rateUsageMeasurement({
    workspaceId: capsule.workspaceId, capsuleId: capsule.id, kind: "runner_minute", quantity: 1,
    source: "runner", createdAt: new Date(now).toISOString(),
  });
  expect(rating?.payerAccountId).toBe("transferred_owner");
  expect(ratingSubjects).toEqual(["transferred_owner"]);
});

test("independent metering after transfer rejects stale or absent ownership evidence", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store);
  const getCapsule = store.getCapsule.bind(store);
  store.getCapsule = async (id) => {
    const row = await getCapsule(id);
    return row ? { ...row, ownerAccountId: "recipient", ownershipEpoch: 1 } : undefined;
  };
  const billing = new BillingService({
    store, now: () => now, newId: () => "unused", defaultBillingSettings: { mode: "showback" },
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const service = new UsageReportingService({
    store, now: () => now, newId: () => "independent_usage", billing,
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const measurement = {
    capsuleId: capsule.id, kind: "storage.gb_hour", quantity: 1, usdMicros: 0, ratingStatus: "unrated" as const,
    source: "storage", idempotencyKey: "delayed_meter", createdAt: "2026-10-27T00:00:00.000Z",
  };
  await expect(service.recordMeteredUsage(capsule.workspaceId, measurement)).rejects.toThrow("ownership evidence");
  await expect(service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, runId: "made_up_run",
  })).rejects.toThrow("ownership evidence");
  await expect(service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, ownerSnapshot: { payerAccountId: "user_test", ownershipEpoch: 0 },
  })).rejects.toThrow("ownership evidence");
  const oldPlan = {
    id: "old_same_app_run", capsuleId: capsule.id,
    auditEvents: [{ type: "plan.policy_evaluated", data: { billing: {
      identityVersion: 1, capsuleId: capsule.id, payerAccountId: "user_test",
    } } }],
  };
  const getPlanRun = store.getPlanRun.bind(store);
  store.getPlanRun = async (id) => id === oldPlan.id ? oldPlan as never : getPlanRun(id);
  await expect(service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, runId: oldPlan.id,
  })).rejects.toThrow("ownership evidence");
  expect(await store.listUsageEvents(capsule.workspaceId)).toEqual([]);
  const accepted = await service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, ownerSnapshot: { payerAccountId: "recipient", ownershipEpoch: 1 },
  });
  expect(accepted.usageEvent.payerAccountId).toBe("recipient");
});
