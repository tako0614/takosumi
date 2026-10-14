import { expect, test } from "bun:test";
import type { ApplyRun, PlanRun } from "@takosumi/internal/deploy-control-api";
import type { BillingRpcService, BillingSettings } from "takosumi-contract/billing";
import { BillingService } from "../../../../core/domains/deploy-control/billing_service.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const now = 1_700_000_000_000;

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
    for (const call of calls) expect(call.context).toMatchObject({ workspaceId: "ws_required", billingSubjectId: "canonical_owner" });
    expect(calls[2]!.context).toMatchObject({ runId: "plan_required", mode: "disabled", estimatedUsdMicros: 37 });
    const audited = planRun({ auditEvents: [{ id: "audit_required", type: "plan.policy_evaluated", at: now, data: { billing: evaluated.audit! } }] });
    await billing.assertApplyBillingAllowed(audited);
    await billing.captureApplyBillingUsage({ planRun: audited, applyRun: applyRun(), now });
    await billing.releaseApplyBilling(audited);
    const usage = await billing.rateUsageMeasurement({
      workspaceId: "ws_required", runId: "apply_required", kind: "runner_minute",
      quantity: 1.5, source: "runner", createdAt: new Date(now).toISOString(),
    });
    expect(usage).toBeUndefined();
    expect(await store.listUsageEvents("ws_required")).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual([
      "ratePlan", "evaluatePlanQuota", "reservePlanBilling", "assertReservationSatisfied",
      "captureRunBilling", "releaseReservation", "rateUsage",
    ]);
    expect(calls[4]!.context).toMatchObject({ runId: "plan_required", applyRunId: "apply_required", capturedUsdMicros: 37, ratingStatus: "rated" });
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
