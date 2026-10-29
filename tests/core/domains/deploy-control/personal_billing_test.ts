import { expect, test } from "bun:test";
import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import { InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { appBillingIdentity } from "../../../../core/domains/deploy-control/billing_workspace_compat.ts";
import { getPayerBillingBinding } from "../../../../core/domains/deploy-control/account_billing_service.ts";
import { BillingService } from "../../../../core/domains/deploy-control/billing_service.ts";
import { UsageReportingService, listPayerUsage } from "../../../../core/domains/deploy-control/usage_service.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";

const now = Date.parse("2026-10-28T00:00:00.000Z");

async function initializeAppOwner(store: InMemoryOpenTofuControlStore, capsule: Capsule, ownerAccountId: string) {
  const ownership = new InMemoryAppOwnershipStore(store);
  expect(await ownership.initializeOwnershipIfMissing({
    capsuleId: capsule.id, ownerAccountId, ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: `apps/${capsule.id}`,
  })).toBe(true);
}

async function transferAppOwner(store: InMemoryOpenTofuControlStore, capsuleId: string, ownerAccountId: string) {
  const ownership = new InMemoryAppOwnershipStore(store);
  const previous = await ownership.getOwnership(capsuleId);
  expect(previous).toBeDefined();
  const ownershipEpoch = previous!.ownershipEpoch + 1;
  expect(await ownership.putOwnership({ ...previous!, ownerAccountId, ownershipEpoch }, previous!.ownershipEpoch)).toBe(true);
  expect(await store.getCapsule(capsuleId)).toMatchObject({ ownerAccountId, ownershipEpoch });
}

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
    getCapsule: async () => app("stale_capsule_owner"),
    getAppBillingOwnership: async () => app("app_owner"),
    getWorkspace: async () => { throw new Error("Workspace must not be read"); },
  };
  expect(await appBillingIdentity(store, "app_one")).toEqual({ capsuleId: "app_one", payerAccountId: "app_owner" });
  for (const owner of ["", " ", null, 7]) {
    await expect(appBillingIdentity({ ...store, getAppBillingOwnership: async () => app(owner) }, "app_one"))
      .rejects.toThrow("App billing owner is unavailable");
  }
  await expect(appBillingIdentity({ ...store, getAppBillingOwnership: async () => ({ ownershipEpoch: 1 }) }, "app_one"))
    .rejects.toThrow("App billing owner is unavailable");
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
  const { capsule } = await seedCapsuleModel(store);
  const { capsule: otherCapsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_two", capsuleId: "app_two", sourceId: "source_two",
    snapshotId: "snapshot_two", installConfigId: "config_two",
  });
  await initializeAppOwner(store, capsule, "old_owner");
  await initializeAppOwner(store, otherCapsule, "old_owner");
  const ids = ["old", "new", "other_workspace", "unattributed"];
  const billing = new BillingService({
    store, now: () => now, newId: () => "unused", defaultBillingSettings: { mode: "showback" },
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const service = new UsageReportingService({
    store, now: () => now, newId: () => ids.shift()!, billing,
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const measurement = {
    kind: "storage.gb_hour", quantity: 1, usdMicros: 0, ratingStatus: "unrated" as const, source: "storage",
  };
  const old = await service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, capsuleId: capsule.id, idempotencyKey: "old",
  });
  expect(old.usageEvent.payerAccountId).toBe("old_owner");
  await transferAppOwner(store, capsule.id, "new_owner");
  const current = await service.recordMeteredUsage(capsule.workspaceId, {
    ...measurement, capsuleId: capsule.id, idempotencyKey: "new",
  });
  expect(current.usageEvent.payerAccountId).toBe("new_owner");
  await service.recordMeteredUsage(otherCapsule.workspaceId, {
    ...measurement, capsuleId: otherCapsule.id, idempotencyKey: "other_workspace",
  });
  await service.recordMeteredUsage(capsule.workspaceId, { ...measurement, idempotencyKey: "unattributed" });
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
  await initializeAppOwner(store, capsule, "user_test");
  await transferAppOwner(store, capsule.id, "transferred_owner");
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

test("independent metering after transfer accepts existing producer inputs and uses the current owner", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const { capsule } = await seedCapsuleModel(store);
  await initializeAppOwner(store, capsule, "user_test");
  const oldPlan: PlanRun = {
    id: "old_same_app_run", workspaceId: capsule.workspaceId, capsuleId: capsule.id,
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main", path: "." },
    sourceDigest: "sha256:source", operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables", requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: now }, policyDecisionDigest: "sha256:policy",
    auditEvents: [{ id: "old_billing", at: now, type: "plan.policy_evaluated", data: { billing: {
      identityVersion: 1, capsuleId: capsule.id, payerAccountId: "user_test",
    } } }], createdAt: now, updatedAt: now,
  };
  await store.putPlanRun(oldPlan);
  await transferAppOwner(store, capsule.id, "recipient");
  const billing = new BillingService({
    store, now: () => now, newId: () => "unused", defaultBillingSettings: { mode: "showback" },
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  let sequence = 0;
  const service = new UsageReportingService({
    store, now: () => now, newId: () => `independent_usage_${sequence++}`, billing,
    requireWorkspace: async (id) => (await store.getWorkspace(id))!,
  });
  const measurement = {
    capsuleId: capsule.id, kind: "storage.gb_hour", quantity: 1, usdMicros: 0, ratingStatus: "unrated" as const,
    source: "storage", idempotencyKey: "delayed_meter", createdAt: "2026-10-27T00:00:00.000Z",
  };
  for (const runId of [undefined, "made_up_run", oldPlan.id]) {
    const { usageEvent } = await service.recordMeteredUsage(capsule.workspaceId, {
      ...measurement, ...(runId ? { runId } : {}), idempotencyKey: `delayed_meter_${runId ?? "without_run"}`,
    });
    expect(usageEvent).toMatchObject({ capsuleId: capsule.id, payerAccountId: "recipient", createdAt: measurement.createdAt });
    expect(usageEvent.runId).toBe(runId);
  }
  expect((await listPayerUsage(store, "recipient")).usageEvents).toHaveLength(3);
  expect((await listPayerUsage(store, "user_test")).usageEvents).toEqual([]);
});
