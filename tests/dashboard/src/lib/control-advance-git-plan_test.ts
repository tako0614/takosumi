import { afterEach, expect, test } from "bun:test";
import {
  advanceGitInstallPlan,
  advanceGitRevisionPlan,
} from "../../../../dashboard/src/lib/control-api.ts";
import { gitPlanProgressSignature } from "../../../../dashboard/src/lib/git-plan-progress.ts";

// The app page continues a stalled install attempt or version change through
// the coordinator's own reconcile command. The server bumps the coordinator's
// generation on every claim, so a loop that counted a new generation as
// progress reconciled at its 250 ms floor until the round bound (120 claims)
// even while the coordinator only waited on a Source sync. Progress is a
// change of phase, request, evidence or diagnostic instead.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const base = {
  workspaceId: "ws_1",
  createdBy: "user_1",
  requestDigest: `sha256:${"d".repeat(64)}`,
  source: { name: "Test", url: "https://example.com/repo.git", ref: "main", path: "." },
  capsule: { name: "Test", environment: "production" },
  options: {},
  createdAt: "2026-10-28T00:00:00.000Z",
  updatedAt: "2026-10-28T00:00:00.000Z",
};

function installResponse(generation: number, done: boolean, step = 0) {
  const phase = done ? "reviewable" : "syncing_source";
  return {
    installPlan: {
      ...base,
      id: "ip_1",
      operation: "install",
      mode: "attempt",
      capsuleId: "cap_1",
      phase,
      generation,
      ...(step > 0 ? { sourceSyncRunId: `ssr_${step}` } : {}),
      ...(done ? { planRunId: "plan_1" } : {}),
    },
    nextAction: done ? "review_run" : "reconcile",
    userAction: done ? { kind: "review", planRunId: "plan_1" } : { kind: "wait", phase },
    links: { self: "/api/v1/install-plans/ip_1" },
  };
}

function revisionResponse(generation: number, done: boolean) {
  return {
    revisionPlan: {
      ...base,
      id: "rp_1",
      operation: "revision",
      capsuleId: "cap_1",
      sourceId: "src_1",
      installConfigId: "cfg_1",
      phase: done ? "reviewable" : "syncing_source",
      generation,
      ...(done ? { planRunId: "plan_1" } : {}),
    },
    nextAction: done ? "review_run" : "reconcile",
    links: { self: "/api/v1/revision-plans/rp_1" },
  };
}

/**
 * Serves a coordinator that needs `budgetMs` of wall clock and answers every
 * reconcile with a new generation, on a virtual clock.
 */
function serveCoordinator(
  respond: (generation: number, done: boolean, round: number) => unknown,
  budgetMs: number,
) {
  const clock = { nowMs: 0, reconciles: 0, waits: [] as number[] };
  let generation = 1;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if ((init?.method ?? "GET").toUpperCase() !== "POST" || !url.endsWith("/reconcile")) {
      return json({ error: "unexpected_request", url }, 500);
    }
    clock.reconciles += 1;
    generation += 1;
    return json(respond(generation, clock.nowMs >= budgetMs, clock.reconciles));
  }) as typeof fetch;
  const pollCadence = {
    minDelayMs: 250,
    maxDelayMs: 2_000,
    jitter: () => 1,
    wait: async (milliseconds: number) => {
      clock.waits.push(milliseconds);
      clock.nowMs += milliseconds;
    },
  };
  return { clock, pollCadence };
}

test("continuing an install backs off while each claim only bumps the generation", async () => {
  const { clock, pollCadence } = serveCoordinator(
    (generation, done) => installResponse(generation, done),
    30_000,
  );
  const response = await advanceGitInstallPlan("ip_1", { timeoutMs: 600_000, pollCadence });
  expect(response.installPlan.planRunId).toBe("plan_1");
  // 250 + 500 + 1_000 + 2_000 * 15 crosses the 30 s Source sync on the 19th
  // wait; the first reconcile comes before the loop. A floor-only loop would
  // have spent all 121 claims and then timed out.
  expect(clock.waits.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
  expect(clock.reconciles).toBe(20);
});

test("continuing an install keeps the floor while each round brings new evidence", async () => {
  const { clock, pollCadence } = serveCoordinator(
    (generation, done, round) => installResponse(generation, done, round),
    5_000,
  );
  await advanceGitInstallPlan("ip_1", { timeoutMs: 600_000, pollCadence });
  expect(clock.waits.length).toBeGreaterThan(0);
  expect(clock.waits.every((delay) => delay === 250)).toBe(true);
});

test("continuing a version change backs off while each claim only bumps the generation", async () => {
  const { clock, pollCadence } = serveCoordinator(
    (generation, done) => revisionResponse(generation, done),
    30_000,
  );
  const response = await advanceGitRevisionPlan("rp_1", { timeoutMs: 600_000, pollCadence });
  expect(response.revisionPlan.planRunId).toBe("plan_1");
  expect(clock.waits.slice(0, 5)).toEqual([250, 500, 1_000, 2_000, 2_000]);
  expect(clock.reconciles).toBe(20);
});

test("the progress signature ignores the generation and sees phase, request, evidence and diagnostic", () => {
  const waiting = installResponse(2, false) as never;
  const sign = gitPlanProgressSignature;
  expect(sign(installResponse(3, false) as never)).toBe(sign(waiting));
  expect(sign(installResponse(3, false, 1) as never)).not.toBe(sign(waiting));
  expect(sign(installResponse(3, true) as never)).not.toBe(sign(waiting));
  const failing = installResponse(3, false) as unknown as {
    installPlan: Record<string, unknown>;
  };
  failing.installPlan.diagnostic = { code: "source_sync_failed", message: "x" };
  expect(sign(failing as never)).not.toBe(sign(waiting));
  expect(sign(revisionResponse(9, false) as never)).toBe(sign(revisionResponse(2, false) as never));
});
