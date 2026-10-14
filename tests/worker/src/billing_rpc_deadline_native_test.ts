import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BILLING_RPC_DEADLINE_MS } from "../../../worker/src/billing_rpc.ts";

const METHODS = [
  "ratePlan", "rateUsage", "reservePlanBilling", "assertReservationSatisfied",
  "captureRunBilling", "releaseReservation", "evaluatePlanQuota",
] as const;

async function callerBundle(root: string): Promise<string> {
  const adapter = fileURLToPath(new URL("../../../worker/src/billing_rpc.ts", import.meta.url));
  const path = join(root, "billing-deadline-caller.ts");
  await Bun.write(path, `
    import { workerBillingComposition } from ${JSON.stringify(adapter)};
    export default {
      async fetch(request, env) {
        const [action, method] = new URL(request.url).pathname.slice(1).split("/");
        const ports = await workerBillingComposition(env).billingExtensionFactory.create();
        const common = {
          workspaceId: action === "pending" ? "workspace_pending" : "workspace_late_capture",
          billingSubjectId: "canonical_owner", runId: "plan_exact", now: 1700000000000,
        };
        const measurements = { planResourceChanges: [], estimatedUsdMicros: 37, ratingStatus: "rated" };
        try {
          switch (method) {
            case "ratePlan": await ports.showbackRater.ratePlan({ ...common, planResourceChanges: [] }); break;
            case "rateUsage": await ports.showbackRater.rateUsage({
              ...common, kind: "runner_minute", quantity: 1.5, source: "runner", createdAt: "2026-10-14T00:00:00.000Z",
            }); break;
            case "reservePlanBilling": await ports.billingEnforcement.reservePlanBilling({
              ...common, ...measurements, mode: "disabled", policyPassedBeforeBilling: true,
            }); break;
            case "assertReservationSatisfied": await ports.billingEnforcement.assertReservationSatisfied(common); break;
            case "captureRunBilling": await ports.billingEnforcement.captureRunBilling({
              ...common, applyRunId: "apply_exact", capturedUsdMicros: 37, ratingStatus: "rated",
            }); break;
            case "releaseReservation": await ports.billingEnforcement.releaseReservation(common); break;
            case "evaluatePlanQuota": await ports.quotaPolicy.evaluatePlanQuota({
              workspaceId: common.workspaceId, billingSubjectId: common.billingSubjectId, ...measurements,
            }); break;
            default: throw new Error("invalid test port");
          }
          return Response.json({ acknowledged: true });
        } catch (error) {
          return Response.json({ error: error.message }, { status: 503 });
        }
      },
    };
  `);
  const output = await Bun.build({ entrypoints: [path], target: "browser", format: "esm", write: false });
  if (!output.success || output.outputs.length !== 1) throw new Error("billing deadline caller bundle failed");
  return await output.outputs[0]!.text();
}

const HOST = `
  import { WorkerEntrypoint } from "cloudflare:workers";
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  export class PrivateBilling extends WorkerEntrypoint {
    async pending(method, context) {
      await this.env.LEDGER.prepare("insert into attempts(method, context) values (?, ?)")
        .bind(method, JSON.stringify(context)).run();
      await delay(${BILLING_RPC_DEADLINE_MS + 10_000});
      throw new Error("synthetic-private-delayed-host-detail");
    }
    ratePlan(ctx) { return this.pending("ratePlan", ctx); }
    rateUsage(ctx) { return this.pending("rateUsage", ctx); }
    reservePlanBilling(ctx) { return this.pending("reservePlanBilling", ctx); }
    assertReservationSatisfied(ctx) { return this.pending("assertReservationSatisfied", ctx); }
    releaseReservation(ctx) { return this.pending("releaseReservation", ctx); }
    evaluatePlanQuota(ctx) { return this.pending("evaluatePlanQuota", ctx); }
    async captureRunBilling(ctx) {
      if (ctx.workspaceId === "workspace_pending") return await this.pending("captureRunBilling", ctx);
      await this.env.LEDGER.prepare("insert into attempts(method, context) values (?, ?)")
        .bind("captureRunBilling", JSON.stringify(ctx)).run();
      const committed = await this.env.LEDGER.prepare(
        "insert into settlements(run_id, apply_id, amount) values (?, ?, ?) on conflict(run_id, apply_id) do nothing"
      ).bind(ctx.runId, ctx.applyRunId, ctx.capturedUsdMicros).run();
      if (committed.meta.changes === 1) {
        const lateAck = (async () => {
          await delay(${BILLING_RPC_DEADLINE_MS + 2_000});
          await this.env.LEDGER.prepare("update settlements set late_ack = 1 where run_id = ? and apply_id = ?")
            .bind(ctx.runId, ctx.applyRunId).run();
        })();
        // This host-owned continuation witnesses the late ACK independently of
        // the timed-out caller. No mutation retry lives in the OSS adapter.
        this.ctx.waitUntil(lateAck);
        await lateAck;
      }
    }
  }
  export default { async fetch(request, env) {
    if (new URL(request.url).pathname === "/init") {
      await env.LEDGER.batch([
        env.LEDGER.prepare("create table attempts(method text not null, context text not null)"),
        env.LEDGER.prepare("create table settlements(run_id text, apply_id text, amount integer, late_ack integer default 0, primary key(run_id, apply_id))"),
      ]);
    }
    return Response.json({
      attempts: (await env.LEDGER.prepare("select method, context from attempts order by rowid").all()).results,
      settlements: (await env.LEDGER.prepare("select * from settlements").all()).results,
    });
  } };
`;

test("workerd bounds every billing port and reconciles a late capture ACK with one exact-ref replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "takosumi-billing-deadline-"));
  let runtime: Miniflare | undefined;
  try {
    runtime = new Miniflare({
      host: "127.0.0.1", port: 0, workers: [
        {
          name: "caller", compatibilityDate: "2026-07-17",
          modules: [{ type: "ESModule", path: "billing-deadline-caller.mjs", contents: await callerBundle(root) }],
          bindings: { TAKOSUMI_BILLING_REQUIRED: "1" },
          serviceBindings: { TAKOSUMI_BILLING: { name: "host", entrypoint: "PrivateBilling" } },
        },
        {
          name: "host", compatibilityDate: "2026-07-17",
          modules: [{ type: "ESModule", path: "billing-deadline-host.mjs", contents: HOST }],
          d1Databases: { LEDGER: "billing-deadline-ledger" },
        },
      ],
    });
    const host = await runtime.getWorker("host");
    expect((await host.fetch("https://host.test/init")).status).toBe(200);
    const started = performance.now();
    const responses = await Promise.all([
      ...METHODS.map((method) => runtime!.dispatchFetch(`https://caller.test/pending/${method}`)),
      runtime.dispatchFetch("https://caller.test/late/captureRunBilling"),
    ]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(BILLING_RPC_DEADLINE_MS - 100);
    expect(elapsed).toBeLessThan(BILLING_RPC_DEADLINE_MS + 5_000);
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: `TAKOSUMI_BILLING ${METHODS[index] ?? "captureRunBilling"} timed out`,
      });
    }
    const beforeReplay = await (await host.fetch("https://host.test/receipts")).json();
    expect(beforeReplay.attempts).toHaveLength(8);
    expect(beforeReplay.settlements).toEqual([{ run_id: "plan_exact", apply_id: "apply_exact", amount: 37, late_ack: 0 }]);
    for (const method of METHODS) {
      expect(beforeReplay.attempts.filter((attempt: { method: string; context: string }) =>
        attempt.method === method && JSON.parse(attempt.context).workspaceId === "workspace_pending",
      )).toHaveLength(1);
    }
    // The Run finalizer chooses this single replay, retaining every original
    // reference after the timeout. The adapter itself has made no retry.
    const replay = await runtime.dispatchFetch("https://caller.test/late/captureRunBilling");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ acknowledged: true });
    let receipts = await (await host.fetch("https://host.test/receipts")).json();
    const captures = receipts.attempts.filter((attempt: { method: string; context: string }) =>
      attempt.method === "captureRunBilling" && JSON.parse(attempt.context).workspaceId === "workspace_late_capture",
    );
    expect(captures).toHaveLength(2);
    expect(captures[0].context).toBe(captures[1].context);
    expect(receipts.settlements).toHaveLength(1);
    const lateAckDeadline = performance.now() + 5_000;
    while (receipts.settlements[0]?.late_ack !== 1 && performance.now() < lateAckDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      receipts = await (await host.fetch("https://host.test/receipts")).json();
    }
    expect(receipts.settlements).toEqual([{ run_id: "plan_exact", apply_id: "apply_exact", amount: 37, late_ack: 1 }]);
    expect(receipts.attempts).toHaveLength(9);
  } finally {
    if (runtime) await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
