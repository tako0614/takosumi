import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

async function callerBundle(root: string): Promise<string> {
  const adapter = fileURLToPath(new URL("../../../worker/src/billing_rpc.ts", import.meta.url));
  const composition = fileURLToPath(new URL("../../../worker/src/worker_service.ts", import.meta.url));
  const path = join(root, "billing-rpc-caller.ts");
  await Bun.write(path, `
    import { workerBillingComposition } from ${JSON.stringify(adapter)};
    import { createWorkerServiceApp } from ${JSON.stringify(composition)};
    export default {
      async fetch(request, env) {
        try {
          // This is the shipped OSS composition root with a real workerd D1
          // and RPC stub. No returned remote function object is involved.
          await createWorkerServiceApp(env, "takosumi-api", { operatorInstallConfigs: [] });
          const ports = await workerBillingComposition(env).billingExtensionFactory.create();
          const path = new URL(request.url).pathname;
          const ctx = {
            workspaceId: "workspace_native_rpc", billingSubjectId: "canonical_native_owner",
            runId: path === "/host-error" ? "host_error" : path === "/bad-dto" ? "bad_dto" : "plan_native_rpc",
            capsuleId: "capsule_native_rpc", now: 1700000000000,
            planResourceChanges: [{ address: "test.one", type: "test", actions: ["create"] }],
          };
          const appCtx = {
            workspaceId: ctx.workspaceId,
            capsuleId: ctx.capsuleId, payerAccountId: "canonical_native_owner", runId: ctx.runId, now: ctx.now,
            planResourceChanges: ctx.planResourceChanges,
          };
          const plan = await ports.showbackRater.ratePlan(ctx);
          const quota = await ports.quotaPolicy.evaluatePlanQuota({
            ...appCtx, estimatedUsdMicros: plan.usdMicros, ratingStatus: plan.ratingStatus,
          });
          const reservation = await ports.billingEnforcement.reservePlanBilling({
            ...appCtx, mode: "disabled", estimatedUsdMicros: plan.usdMicros,
            ratingStatus: plan.ratingStatus, policyPassedBeforeBilling: true,
          });
          await ports.billingEnforcement.assertReservationSatisfied(appCtx);
          await ports.billingEnforcement.captureRunBilling({
            ...appCtx, applyRunId: "apply_native_rpc", capturedUsdMicros: plan.usdMicros, ratingStatus: plan.ratingStatus,
          });
          await ports.billingEnforcement.releaseReservation(appCtx);
          const usage = await ports.showbackRater.rateUsage({
            ...ctx, kind: "runner_minute", quantity: 1.5, source: "runner", createdAt: "2026-10-14T00:00:00.000Z",
          });
          return Response.json({ plan, quota, reservation, usage, localChangeCount: ctx.planResourceChanges.length });
        } catch (error) {
          return Response.json({ error: error.message }, { status: 503 });
        }
      },
    };
  `);
  const result = await Bun.build({ entrypoints: [path], target: "browser", format: "esm", external: ["cloudflare:workers"], write: false });
  if (!result.success || result.outputs.length !== 1) throw new Error("billing RPC caller bundle failed");
  return await result.outputs[0]!.text();
}

const HOST = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export class PrivateBilling extends WorkerEntrypoint {
    ratePlan(ctx) {
      if (ctx.runId === "bad_dto") return { ratingStatus: "unrated", usdMicros: 7 };
      const callerChangeCount = ctx.planResourceChanges.length;
      ctx.planResourceChanges.push({ address: "host.local", type: "test", actions: ["no-op"] });
      return { ratingStatus: "rated", usdMicros: 37, audit: {
        host: this.env.HOST_MARKER, workspace: ctx.workspaceId, subject: ctx.billingSubjectId,
        run: ctx.runId, callerChangeCount,
      } };
    }
    rateUsage(ctx) {
      return { ratingStatus: "rated", usdMicros: 19, audit: { quantity: ctx.quantity, source: ctx.source } };
    }
    reservePlanBilling(ctx) {
      return { reasons: [], audit: { run: ctx.runId, mode: ctx.mode, amount: ctx.estimatedUsdMicros } };
    }
    assertReservationSatisfied(ctx) {
      if (ctx.runId === "host_error") throw new Error("synthetic-private-host-subject-secret");
      if (ctx.payerAccountId !== "canonical_native_owner" || ctx.workspaceId !== "workspace_native_rpc" || "billingSubjectId" in ctx) throw new Error("wrong subject");
    }
    captureRunBilling(ctx) {
      if (ctx.runId !== "plan_native_rpc" || ctx.applyRunId !== "apply_native_rpc" || ctx.capturedUsdMicros !== 37)
        throw new Error("incorrect capture context");
    }
    releaseReservation(ctx) {
      if (ctx.runId !== "plan_native_rpc" || ctx.capsuleId !== "capsule_native_rpc") throw new Error("incorrect release context");
    }
    evaluatePlanQuota(ctx) {
      return { reasons: [], audit: { amount: ctx.estimatedUsdMicros, rating: ctx.ratingStatus } };
    }
  }
  export class IncompleteBilling extends WorkerEntrypoint {
    ratePlan() { return { ratingStatus: "rated", usdMicros: 37 }; }
    reservePlanBilling() { return { reasons: [] }; }
    evaluatePlanQuota() { return { reasons: [] }; }
  }
  export default { fetch() { return new Response("private RPC only", { status: 404 }); } };
`;

test("workerd direct billing service binding transfers seven plain DTO calls and fails closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-billing-rpc-"));
  let runtime: Miniflare | undefined;
  try {
    const bundle = await callerBundle(root);
    runtime = new Miniflare({
      host: "127.0.0.1", port: 0, workers: [
        {
          name: "caller", compatibilityDate: "2026-07-17",
          modules: [{ type: "ESModule", path: "billing-rpc-caller.mjs", contents: bundle }],
          bindings: { TAKOSUMI_BILLING_REQUIRED: "1", TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
          d1Databases: { TAKOSUMI_CONTROL_DB: "native-billing-control" },
          serviceBindings: { TAKOSUMI_BILLING: { name: "host", entrypoint: "PrivateBilling" } },
        },
        {
          name: "incomplete-caller", compatibilityDate: "2026-07-17",
          modules: [{ type: "ESModule", path: "billing-rpc-incomplete-caller.mjs", contents: bundle }],
          bindings: { TAKOSUMI_BILLING_REQUIRED: "1", TAKOSUMI_ENVIRONMENT: "test", TAKOSUMI_DEV_MODE: "1" },
          d1Databases: { TAKOSUMI_CONTROL_DB: "native-billing-incomplete-control" },
          serviceBindings: { TAKOSUMI_BILLING: { name: "host", entrypoint: "IncompleteBilling" } },
        },
        {
          name: "host", compatibilityDate: "2026-07-17",
          modules: [{ type: "ESModule", path: "billing-rpc-host.mjs", contents: HOST }],
          bindings: { HOST_MARKER: "actual-private-entrypoint" },
        },
      ],
    });
    const response = await runtime.dispatchFetch("https://billing.test/");
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toEqual({
      plan: { ratingStatus: "rated", usdMicros: 37, audit: {
        host: "actual-private-entrypoint", workspace: "workspace_native_rpc",
        subject: "canonical_native_owner", run: "plan_native_rpc", callerChangeCount: 1,
      } },
      quota: { reasons: [], audit: { amount: 37, rating: "rated" } },
      reservation: { reasons: [], audit: { run: "plan_native_rpc", mode: "disabled", amount: 37 } },
      usage: { ratingStatus: "rated", usdMicros: 19, audit: { quantity: 1.5, source: "runner" } },
      localChangeCount: 1,
    });
    const error = await runtime.dispatchFetch("https://billing.test/host-error");
    expect(error.status).toBe(503);
    expect(await error.json()).toEqual({ error: "TAKOSUMI_BILLING assertReservationSatisfied failed" });
    const malformed = await runtime.dispatchFetch("https://billing.test/bad-dto");
    expect(malformed.status).toBe(503);
    expect(await malformed.json()).toEqual({ error: "TAKOSUMI_BILLING returned invalid ratePlan DTO" });
    const incomplete = await (await runtime.getWorker("incomplete-caller")).fetch("https://billing.test/");
    expect(incomplete.status).toBe(503);
    expect(await incomplete.json()).toEqual({ error: "TAKOSUMI_BILLING assertReservationSatisfied failed" });
  } finally {
    if (runtime) await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
