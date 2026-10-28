import { expect, test } from "bun:test";
import type { BillingRpcService } from "takosumi-contract/billing";
import { workerBillingComposition } from "../../../worker/src/billing_rpc.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

function service(overrides: Partial<BillingRpcService> = {}): BillingRpcService {
  return {
    ratePlan: async () => ({ ratingStatus: "rated", usdMicros: 7 }),
    rateUsage: async () => ({ ratingStatus: "unrated", usdMicros: 0 }),
    reservePlanBilling: async () => ({ reasons: [] }),
    assertReservationSatisfied: async () => {},
    captureRunBilling: async () => {},
    releaseReservation: async () => {},
    evaluatePlanQuota: async () => ({ reasons: [] }),
    ...overrides,
  };
}

const plan = {
  workspaceId: "workspace_rpc", billingSubjectId: "canonical_owner",
  capsuleId: "capsule_rpc", payerAccountId: "canonical_owner",
  runId: "plan_rpc", planResourceChanges: [], now: 1,
} as const;

test("self-host omission preserves defaults and in-process factory identity", () => {
  expect(workerBillingComposition({})).toEqual({});
  const factory = { create: () => ({}) };
  expect(workerBillingComposition({ TAKOSUMI_BILLING_EXTENSION_FACTORY: factory }))
    .toEqual({ billingExtensionFactory: factory });
});

test("billing configuration rejects missing required, invalid flags, incomplete ports and dual owners", () => {
  expect(() => workerBillingComposition({ TAKOSUMI_BILLING_REQUIRED: "1" })).toThrow("not configured");
  for (const required of ["0", "true", "", " 1 "]) {
    expect(() => workerBillingComposition({ TAKOSUMI_BILLING_REQUIRED: required })).toThrow("must be 1");
  }
  expect(() => workerBillingComposition({
    TAKOSUMI_BILLING: {} as BillingRpcService,
  })).toThrow("all seven");
  expect(() => workerBillingComposition({
    TAKOSUMI_BILLING: service(), TAKOSUMI_BILLING_EXTENSION_FACTORY: { create: () => ({}) },
  })).toThrow("mutually exclusive");
});

test("Worker composition rejects missing required billing before initializing D1", async () => {
  const db = new SqliteFakeD1();
  const env = {
    TAKOSUMI_CONTROL_DB: db, TAKOSUMI_BILLING_REQUIRED: "1",
    TAKOSUMI_DEV_MODE: "1", TAKOSUMI_ENVIRONMENT: "test",
  } as unknown as CloudflareWorkerEnv;
  await expect(createWorkerServiceApp(env, "takosumi-api")).rejects.toThrow("not configured");
  expect(await db.prepare("select name from sqlite_master where type = 'table'").all()).toEqual({ results: [], success: true });
});

test("required in-process factory must return a complete composition", async () => {
  const env = {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(), TAKOSUMI_BILLING_REQUIRED: "1",
    TAKOSUMI_BILLING_EXTENSION_FACTORY: { create: () => ({}) },
    TAKOSUMI_DEV_MODE: "1", TAKOSUMI_ENVIRONMENT: "test",
  } as unknown as CloudflareWorkerEnv;
  await expect(createWorkerServiceApp(env, "takosumi-api", { operatorInstallConfigs: [] }))
    .rejects.toThrow("all seven");
});

test("remote failures keep the port name and omit private exception details", async () => {
  const composition = workerBillingComposition({
    TAKOSUMI_BILLING: service({ ratePlan: async () => { throw new Error("synthetic-private-subject-and-secret"); } }),
  });
  const ports = await composition.billingExtensionFactory!.create();
  await expect(ports.showbackRater!.ratePlan(plan)).rejects.toThrow(/^TAKOSUMI_BILLING ratePlan failed$/);
});

test("RPC refuses malformed rating, reasons, non-JSON audit and non-void receipt", async () => {
  for (const result of [
    { ratingStatus: "rated", usdMicros: -1 },
    { ratingStatus: "unrated", usdMicros: 5 },
    { ratingStatus: "rated", usdMicros: 1, privateBalance: 99 },
    { ratingStatus: "rated", usdMicros: 1, audit: { when: new Date() } },
    { ratingStatus: "rated", usdMicros: 1, audit: { callback: () => {} } },
  ]) {
    const ports = await workerBillingComposition({
      TAKOSUMI_BILLING: service({ ratePlan: async () => result as never }),
    }).billingExtensionFactory!.create();
    await expect(ports.showbackRater!.ratePlan(plan)).rejects.toThrow("invalid ratePlan DTO");
  }
  const ports = await workerBillingComposition({
    TAKOSUMI_BILLING: service({
      evaluatePlanQuota: async () => ({ reasons: [7] } as never),
      captureRunBilling: async () => ({ ok: true } as never),
    }),
  }).billingExtensionFactory!.create();
  await expect(ports.quotaPolicy!.evaluatePlanQuota({ ...plan, estimatedUsdMicros: 7, ratingStatus: "rated" }))
    .rejects.toThrow("invalid evaluatePlanQuota DTO");
  await expect(ports.billingEnforcement!.captureRunBilling({ ...plan, applyRunId: "apply_rpc", capturedUsdMicros: 7, ratingStatus: "rated" }))
    .rejects.toThrow("invalid captureRunBilling DTO");
});
