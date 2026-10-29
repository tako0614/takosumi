import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { BillingRpcService, BillingSettings } from "takosumi-contract/billing";
import { InMemoryAppOwnershipStore } from "../../../../core/domains/app-ownership/store.ts";
import { BillingService } from "../../../../core/domains/deploy-control/billing_service.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const now = 1_700_000_000_000;

async function transferAppOwner(store: InMemoryOpenTofuControlStore, ownerAccountId: string) {
  const ownership = new InMemoryAppOwnershipStore(store);
  const previous = await ownership.getOwnership("cap_required");
  expect(previous).toBeDefined();
  const ownershipEpoch = previous!.ownershipEpoch + 1;
  expect(await ownership.putOwnership({ ...previous!, ownerAccountId, ownershipEpoch }, previous!.ownershipEpoch)).toBe(true);
  expect(await store.getCapsule("cap_required")).toMatchObject({ ownerAccountId, ownershipEpoch });
}

function planRun(overrides: Partial<PlanRun> = {}): PlanRun {
  return {
    id: "plan_required", workspaceId: "ws_required", capsuleId: "cap_required",
    source: { kind: "git", url: "https://example.test/repo.git", ref: "main", path: "." },
    sourceDigest: "sha256:source", operation: "create", runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables", requiredProviders: [], status: "succeeded",
    policy: { status: "passed", reasons: [], checkedAt: now }, policyDecisionDigest: "sha256:policy",
    auditEvents: [], createdAt: now, updatedAt: now, ...overrides,
  };
}

function applyRun(): ApplyRun {
  return {
    id: "apply_required", planRunId: "plan_required", workspaceId: "ws_required",
    operation: "create", runnerProfileId: "opentofu-default", status: "succeeded",
    expected: {
      planRunId: "plan_required", runnerProfileId: "opentofu-default", sourceDigest: "sha256:source",
      variablesDigest: "sha256:variables", policyDecisionDigest: "sha256:policy",
      planDigest: "sha256:plan", planArtifactDigest: "sha256:artifact",
    },
    stateBackend: { kind: "operator-managed", ref: "state" },
    stateLock: { status: "recorded", backendRef: "state" },
    auditEvents: [], createdAt: now, updatedAt: now,
  };
}

async function fixture(required: boolean, settings?: BillingSettings) {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({
    id: "ws_required", handle: "required", displayName: "Required", type: "personal",
    ownerUserId: "canonical_owner", ...(settings ? { billingSettings: settings } : {}),
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  });
  await store.putCapsule({
    id: "cap_required", workspaceId: "ws_required", projectId: "project_required",
    name: "required", slug: "required", sourceId: "source_required", installConfigId: "config_required",
    environment: "production", currentStateGeneration: 0, status: "active",
    ownerAccountId: "canonical_owner", ownershipEpoch: 0,
    managementState: "active", managementEpoch: 0, storageRoot: "apps/cap_required",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  });
  await store.putPlanRun(planRun());
  await store.putApplyRun(applyRun());
  const calls: Array<{ method: string; context: unknown }> = [];
  const port: BillingRpcService = {
    ratePlan: async (context) => { calls.push({ method: "ratePlan", context }); return { ratingStatus: "rated", usdMicros: 37 }; },
    rateUsage: async (context) => { calls.push({ method: "rateUsage", context }); return { ratingStatus: "rated", usdMicros: 19 }; },
    evaluatePlanQuota: async (context) => { calls.push({ method: "evaluatePlanQuota", context }); return { reasons: [] }; },
    reservePlanBilling: async (context) => { calls.push({ method: "reservePlanBilling", context }); return { reasons: ["host_reservation_denied"] }; },
    assertReservationSatisfied: async (context) => { calls.push({ method: "assertReservationSatisfied", context }); },
    captureRunBilling: async (context) => { calls.push({ method: "captureRunBilling", context }); },
    releaseReservation: async (context) => { calls.push({ method: "releaseReservation", context }); },
  };
  const billing = new BillingService({
    store, now: () => now, newId: (prefix) => `${prefix}_required`,
    defaultBillingSettings: { mode: "disabled" }, requireWorkspace: async (id) => {
      const workspace = await store.getWorkspace(id);
      if (!workspace) throw new Error("missing test Workspace");
      return workspace;
    },
    enforcementRequired: required, rater: port, enforcement: port, quota: port,
  });
  const result = {
    planDigest: "sha256:plan", planArtifact: { kind: "remote", ref: "plan", digest: "sha256:artifact" },
    planResourceChanges: [{ address: "test.one", type: "test", actions: ["create"] }],
  };
  return { billing, store, calls, result, port };
}

for (const settings of [{ mode: "disabled" } as const, undefined]) {
  test(`required host ports cannot be bypassed by ${settings ? "explicit disabled" : "default disabled"} Workspace`, async () => {
    const { billing, store, calls, result } = await fixture(true, settings);
    const plan = planRun();
    const evaluated = await billing.evaluatePlanBilling({ planRun: plan, result, now, policyPassedBeforeBilling: true });
    expect(evaluated.reasons).toEqual(["host_reservation_denied"]);
    expect(calls.map((call) => call.method)).toEqual(["ratePlan", "evaluatePlanQuota", "reservePlanBilling"]);
    expect(calls[0]!.context).toMatchObject({ workspaceId: "ws_required", billingSubjectId: "canonical_owner" });
    for (const call of calls.slice(1)) {
      expect(call.context).toMatchObject({ workspaceId: "ws_required", capsuleId: "cap_required", payerAccountId: "canonical_owner" });
      expect(call.context).toHaveProperty("billingSubjectId", "canonical_owner");
    }
    expect(calls[2]!.context).toMatchObject({ runId: "plan_required", mode: "disabled", estimatedUsdMicros: 37 });
    const audited = planRun({ auditEvents: [{ id: "audit_required", type: "plan.policy_evaluated", at: now, data: { billing: evaluated.audit! } }] });
    await billing.assertApplyBillingAllowed(audited);
    await billing.captureApplyBillingUsage({ planRun: audited, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(audited);
    const usage = await billing.rateUsageMeasurement({
      workspaceId: "ws_required", capsuleId: "cap_required", runId: "apply_required", kind: "runner_minute",
      quantity: 1.5, source: "runner", createdAt: new Date(now).toISOString(),
    });
    expect(usage).toBeUndefined();
    expect(await store.listUsageEvents("ws_required")).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual([
      "ratePlan", "evaluatePlanQuota", "reservePlanBilling", "assertReservationSatisfied",
      "captureRunBilling", "releaseReservation", "rateUsage",
    ]);
    expect(calls[4]!.context).toMatchObject({ runId: "plan_required", applyRunId: "apply_required", capturedUsdMicros: 37, ratingStatus: "rated" });
    for (const call of calls.filter((call) => call.method !== "ratePlan" && call.method !== "rateUsage")) {
      expect(call.context).toMatchObject({ workspaceId: "ws_required", capsuleId: "cap_required", payerAccountId: "canonical_owner" });
      expect(call.context).toHaveProperty("billingSubjectId", "canonical_owner");
    }
  });
}

test("switching showback off after planning preserves required capture and reservation checks", async () => {
  const { billing, store, calls, result } = await fixture(true, { mode: "showback" });
  const evaluated = await billing.evaluatePlanBilling({ planRun: planRun(), result, now, policyPassedBeforeBilling: true });
  await billing.updateWorkspaceBillingSettings("ws_required", { billingSettings: { mode: "disabled" } });
  const plan = planRun({ auditEvents: [{ id: "audit_required", type: "plan.policy_evaluated", at: now, data: { billing: evaluated.audit! } }] });
  await billing.assertApplyBillingAllowed(plan);
  await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
  expect(calls.map((call) => call.method)).toContain("captureRunBilling");
  expect(await store.listUsageEvents("ws_required")).toEqual([]);
});

test("required host outage blocks apply rather than using the OSS no-op", async () => {
  const { billing, port } = await fixture(true);
  port.assertReservationSatisfied = async () => { throw new Error("test host unavailable"); };
  await expect(billing.assertApplyBillingAllowed(planRun())).rejects.toThrow("test host unavailable");
});

test("destroy and refresh-only keep safe cleanup without reservation even with required billing", async () => {
  for (const plan of [planRun({ operation: "destroy" }), planRun({ refreshOnly: true })]) {
    const { billing, calls, result } = await fixture(true);
    expect((await billing.evaluatePlanBilling({ planRun: plan, result, now, policyPassedBeforeBilling: true })).reasons).toEqual([]);
    await billing.assertApplyBillingAllowed(plan);
    await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(plan);
    expect(calls).toEqual([]);
  }
});

test("destroy and refresh-only finish unattributed when the physical owner is broken", async () => {
  for (const plan of [planRun({ operation: "destroy" }), planRun({ refreshOnly: true })]) {
    const { billing, store, calls, result } = await fixture(true, { mode: "showback" });
    store.getAppBillingOwnership = async () => ({ ownerAccountId: "", ownershipEpoch: 1 });
    const evaluated = await billing.evaluatePlanBilling({ planRun: plan, result, now, policyPassedBeforeBilling: true });
    expect(evaluated.reasons).toEqual([]);
    expect(evaluated.audit).not.toHaveProperty("payerAccountId");
    await billing.assertApplyBillingAllowed(plan);
    await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(plan);
    await store.putPlanRun(plan);
    expect(await billing.rateUsageMeasurement({
      workspaceId: plan.workspaceId, capsuleId: plan.capsuleId, runId: plan.id,
      kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString(),
    })).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
    expect((await store.listUsageEvents(plan.workspaceId))[0]).not.toHaveProperty("payerAccountId");
    expect(calls).toEqual([]);
    await expect(billing.evaluatePlanBilling({ planRun: planRun(), result, now, policyPassedBeforeBilling: true }))
      .rejects.toThrow("App billing owner is unavailable");
  }
});

test("release uses the reservation run when payer evidence is unavailable or corrupt", async () => {
  const { billing, store, calls } = await fixture(true, { mode: "showback" });
  store.getAppBillingOwnership = async () => ({ ownerAccountId: "", ownershipEpoch: 1 });
  for (const plan of [planRun(), planRun({ auditEvents: [{
    id: "invalid_pin", type: "plan.policy_evaluated", at: now,
    data: { billing: { identityVersion: 1, capsuleId: "cap_required" } },
  }] })]) {
    await billing.releaseApplyBilling(plan);
    expect(calls.at(-1)).toEqual({ method: "releaseReservation", context: {
      workspaceId: plan.workspaceId, billingSubjectId: "canonical_owner", runId: plan.id, now,
    } });
    await expect(billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now })).rejects.toThrow();
  }
});

test("optional host ports preserve self-host disabled behavior", async () => {
  const { billing, calls, result } = await fixture(false);
  const plan = planRun();
  expect((await billing.evaluatePlanBilling({ planRun: plan, result, now, policyPassedBeforeBilling: true })).reasons).toEqual([]);
  await billing.assertApplyBillingAllowed(plan);
  await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
  await billing.releaseApplyBilling(plan);
  expect(await billing.rateUsageMeasurement({ workspaceId: "ws_required", kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString() })).toBeUndefined();
  expect(calls).toEqual([]);
});

test("every enforcement and quota port uses the current app owner after transfer", async () => {
  const { billing, store, calls, result } = await fixture(true, { mode: "showback" });
  await transferAppOwner(store, "new_app_owner");
  const evaluated = await billing.evaluatePlanBilling({ planRun: planRun(), result, now, policyPassedBeforeBilling: true });
  const plan = planRun({ auditEvents: [{ id: "audit_transferred", type: "plan.policy_evaluated", at: now, data: { billing: evaluated.audit! } }] });
  await billing.assertApplyBillingAllowed(plan);
  await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
  await billing.releaseApplyBilling(plan);
  expect(calls[0]!.context).toMatchObject({ billingSubjectId: "new_app_owner" });
  for (const call of calls.slice(1)) {
    expect(call.context).toMatchObject({ workspaceId: "ws_required", capsuleId: "cap_required", payerAccountId: "new_app_owner" });
    expect(call.context).toHaveProperty("billingSubjectId", "new_app_owner");
  }
  expect((await store.listUsageEvents("ws_required"))[0]!.payerAccountId).toBe("new_app_owner");
});

test("ownership transfer cannot redirect a pending reservation settlement or runner history", async () => {
  const { billing, store, calls, result } = await fixture(true, { mode: "showback" });
  const evaluated = await billing.evaluatePlanBilling({ planRun: planRun(), result, now, policyPassedBeforeBilling: true });
  const plan = planRun({ auditEvents: [{ id: "audit_reserved", type: "plan.policy_evaluated", at: now, data: { billing: evaluated.audit! } }] });
  await store.putPlanRun(plan);
  await store.putApplyRun(applyRun());
  await transferAppOwner(store, "owner_after_reservation");
  await expect(billing.assertApplyBillingAllowed(plan)).rejects.toThrow("App owner changed");
  // Provider work may have committed before transfer; exact old-payer capture
  // and release remain retryable without assigning a debt to the recipient.
  await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
  await billing.captureApplyBillingUsage({ planRun: plan, applyRun: applyRun(), now });
  await billing.releaseApplyBilling(plan);
  for (const call of calls.filter((call) => call.method === "captureRunBilling" || call.method === "releaseReservation")) {
    expect(call.context).toMatchObject({ workspaceId: "ws_required", capsuleId: "cap_required", payerAccountId: "canonical_owner" });
  }
  expect(calls.filter((call) => call.method === "captureRunBilling")[0]!.context)
    .toEqual(calls.filter((call) => call.method === "captureRunBilling")[1]!.context);
  expect((await store.listUsageEvents("ws_required"))).toHaveLength(1);
  expect((await store.listUsageEvents("ws_required"))[0]!.payerAccountId).toBe("canonical_owner");
  for (const runId of [plan.id, applyRun().id]) {
    const rating = await billing.rateUsageMeasurement({
      workspaceId: "ws_required", capsuleId: "cap_required", runId,
      kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString(),
    });
    expect(rating?.payerAccountId).toBe("canonical_owner");
    expect(calls.at(-1)!.context).toMatchObject({ billingSubjectId: "canonical_owner" });
  }
  const future = await billing.evaluatePlanBilling({
    planRun: planRun({ id: "plan_after_transfer" }), result, now, policyPassedBeforeBilling: true,
  });
  expect(future.audit).toMatchObject({ capsuleId: "cap_required", payerAccountId: "owner_after_reservation" });
  expect(calls.at(-1)!.context).toMatchObject({
    workspaceId: "ws_required", capsuleId: "cap_required", payerAccountId: "owner_after_reservation", runId: "plan_after_transfer",
  });
  expect((await store.listUsageEvents("ws_required"))[0]!.payerAccountId).toBe("canonical_owner");
});

for (const required of [false, true]) {
  test(`${required ? "required" : "optional"} host legacy capsule-less finalization stays unattributed and can finish`, async () => {
    const { billing, store, calls, result } = await fixture(required, { mode: "showback" });
    const legacy = planRun({ capsuleId: undefined });
    store.getCapsule = async () => { throw new Error("Capsule-less finalization must not resolve an owner"); };
    store.getAppBillingOwnership = async () => { throw new Error("Capsule-less finalization must not read ownership"); };
    if (!required) await billing.assertApplyBillingAllowed(legacy);
    await billing.captureApplyBillingUsage({ planRun: legacy, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(legacy);
    expect(await billing.rateUsageMeasurement({
      workspaceId: "ws_required", runId: applyRun().id,
      kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString(),
    })).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
    const rows = await store.listUsageEvents("ws_required");
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("capsuleId");
    expect(rows[0]).not.toHaveProperty("payerAccountId");
    expect(await store.listUsageEventsForPayerPage("canonical_owner", {})).toEqual({ items: [] });
    if (required) {
      const next = planRun({ id: "new_plan_without_app", capsuleId: undefined });
      await expect(billing.evaluatePlanBilling({ planRun: next, result, now, policyPassedBeforeBilling: true }))
        .rejects.toThrow("Billing requires an app");
      await expect(billing.assertApplyBillingAllowed(next)).rejects.toThrow("Plan billing payer is unavailable");
    }
    expect(calls).toEqual([{ method: "releaseReservation", context: {
      workspaceId: "ws_required", billingSubjectId: "canonical_owner", runId: legacy.id, now,
    } }]);
  });
}

for (const required of [false, true]) {
  test(`${required ? "required" : "optional"} host pre-change plan after transfer remains unattributed and malformed new pins fail closed`, async () => {
    const { billing, store, calls } = await fixture(required, { mode: "showback" });
    const legacy = planRun();
    await store.putPlanRun(legacy);
    await transferAppOwner(store, "recipient");
    if (required) {
      await expect(billing.assertApplyBillingAllowed(legacy)).rejects.toThrow("Plan billing payer is unavailable");
    } else {
      await billing.assertApplyBillingAllowed(legacy);
    }
    await billing.captureApplyBillingUsage({ planRun: legacy, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(legacy);
    const usage = (await store.listUsageEvents("ws_required"))[0];
    expect(usage).toMatchObject({ workspaceId: "ws_required", capsuleId: "cap_required" });
    expect(usage).not.toHaveProperty("payerAccountId");
    expect(await store.listUsageEventsForPayerPage("canonical_owner", {})).toEqual({ items: [] });
    expect(await store.listUsageEventsForPayerPage("recipient", {})).toEqual({ items: [] });
    const rating = await billing.rateUsageMeasurement({
      workspaceId: "ws_required", capsuleId: "cap_required", runId: legacy.id,
      kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString(),
    });
    expect(rating).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
    expect(calls).toEqual([{ method: "releaseReservation", context: {
      workspaceId: "ws_required", billingSubjectId: "canonical_owner", runId: legacy.id, now,
    } }]);
    const corrupt = planRun({ auditEvents: [{
      id: "audit_corrupt", type: "plan.policy_evaluated", at: now,
      data: { billing: { identityVersion: 1, capsuleId: "cap_required" } },
    }] });
    await expect(billing.captureApplyBillingUsage({ planRun: corrupt, applyRun: applyRun(), now }))
      .rejects.toThrow("Plan billing identity is invalid");
  });
}


test("missing Core Run evidence never falls back to the current owner", async () => {
  const { billing, calls } = await fixture(false, { mode: "showback" });
  const rating = await billing.rateUsageMeasurement({
    workspaceId: "ws_required", capsuleId: "cap_required", runId: "missing_run",
    kind: "runner_minute", quantity: 1, source: "runner", createdAt: new Date(now).toISOString(),
  });
  expect(rating).toEqual({ ratingStatus: "unrated", usdMicros: 0 });
  expect(calls).toEqual([]);
});
