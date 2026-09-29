import { afterEach, expect, test } from "bun:test";
import {
  createReviewableGitInstallPlan,
  createReviewableGitRevisionPlan,
  gitPlanReconcileDelayMs,
} from "../../../../dashboard/src/lib/control-api.ts";

// The coordinator reconcile loop used to sleep a flat 250 ms after every round
// trip. Each round trip is a command that claims the coordinator lease and
// advances one step, so a round that observes the same phase and the same CAS
// generation advanced nothing: the coordinator is waiting on a Source sync Run,
// a container-backed analysis, or a Plan Run. These tests use a virtual clock
// and a counting fetch double to measure how many round trips the loop issues
// for the same simulated run before and after the bounded, progress-aware
// cadence.

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const request = {
  source: { name: "Test", url: "https://example.com/repo.git", ref: "main" },
  capsule: { name: "Test", environment: "production" },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function installPlanResponse(input: {
  readonly phase: string;
  readonly generation: number;
  readonly nextAction: "reconcile" | "review_run";
}) {
  return {
    installPlan: {
      id: "install_1",
      workspaceId: "ws_1",
      createdBy: "user_1",
      requestDigest: `sha256:${"d".repeat(64)}`,
      source: {
        name: "Test",
        url: "https://example.com/repo.git",
        ref: "main",
        path: ".",
      },
      capsule: { name: "Test", environment: "production" },
      options: {},
      phase: input.phase,
      generation: input.generation,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      ...(input.nextAction === "review_run" ? { planRunId: "plan_1" } : {}),
    },
    nextAction: input.nextAction,
    links: { self: "/api/v1/install-plans/install_1" },
  };
}

function revisionPlanResponse(input: {
  readonly generation: number;
  readonly nextAction: "reconcile" | "review_run";
}) {
  return {
    revisionPlan: {
      id: "revision_1",
      operation: "revision",
      workspaceId: "ws_1",
      createdBy: "user_1",
      requestDigest: `sha256:${"d".repeat(64)}`,
      source: {
        name: "Test",
        url: "https://example.com/repo.git",
        ref: "main",
        path: ".",
      },
      capsule: { name: "Test", environment: "production" },
      options: {},
      revision: { ref: "main" },
      sourceId: "source_1",
      capsuleId: "capsule_1",
      installConfigId: "config_1",
      phase: input.nextAction === "review_run" ? "reviewable" : "syncing_source",
      generation: input.generation,
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      ...(input.nextAction === "review_run" ? { planRunId: "plan_1" } : {}),
    },
    nextAction: input.nextAction,
    links: { self: "/api/v1/install-plans/revision_1" },
  };
}

/**
 * Drives one install coordinator against a virtual clock.
 *
 * The fetch double answers `reconcile` while the virtual clock is below
 * `budgetMs` and then reports a reviewable Plan, which is exactly a plan whose
 * preparation takes `budgetMs` of wall clock to finish. `progressPerRound`
 * models the other case: every round trip really advances the coordinator.
 */
async function driveInstall(input: {
  readonly budgetMs: number;
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly progressPerRound: boolean;
  readonly maxReconciles?: number;
}) {
  let virtualNowMs = 0;
  const waits: number[] = [];
  let reconciles = 0;
  let generation = 1;
  globalThis.fetch = (async (
    fetchInput: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(fetchInput);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/install-plans")) {
      return json(
        installPlanResponse({
          phase: "syncing_source",
          generation,
          nextAction: "reconcile",
        }),
      );
    }
    if (method === "POST" && url.endsWith("/reconcile")) {
      reconciles += 1;
      if (virtualNowMs < input.budgetMs) {
        if (input.progressPerRound) generation += 1;
        return json(
          installPlanResponse({
            phase: "syncing_source",
            generation,
            nextAction: "reconcile",
          }),
        );
      }
      return json(
        installPlanResponse({
          phase: "reviewable",
          generation: generation + 1,
          nextAction: "review_run",
        }),
      );
    }
    return json({ error: "unexpected_request", url }, 500);
  }) as typeof fetch;

  const response = await createReviewableGitInstallPlan("ws_1", request, {
    idempotencyKey: "key_1",
    timeoutMs: 600_000,
    ...(input.maxReconciles === undefined
      ? {}
      : { maxReconciles: input.maxReconciles }),
    pollCadence: {
      minDelayMs: input.minDelayMs,
      maxDelayMs: input.maxDelayMs,
      jitter: () => 1,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        virtualNowMs += milliseconds;
      },
    },
  });
  return { reconciles, waits, virtualNowMs, response };
}

test("a stalled 30s preparation is polled far less often than the flat 4 Hz loop", async () => {
  // The pre-change cadence: a flat 250 ms sleep after every reconcile.
  const legacy = await driveInstall({
    budgetMs: 30_000,
    minDelayMs: 250,
    maxDelayMs: 250,
    progressPerRound: false,
    maxReconciles: 10_000,
  });
  const bounded = await driveInstall({
    budgetMs: 30_000,
    minDelayMs: 250,
    maxDelayMs: 2_000,
    progressPerRound: false,
    maxReconciles: 10_000,
  });

  // Every reconcile is a POST that claims the coordinator lease and re-reads
  // the durable record, so the round-trip count is the cost being removed.
  expect(legacy.reconciles).toBe(121);
  // 250 + 500 + 1_000 + 2_000 * 15 = 31_750 ms of virtual waits, so the
  // 30_000 ms stall is crossed on the 19th reconcile round.
  expect(bounded.reconciles).toBe(19);
  expect(bounded.reconciles).toBeLessThanOrEqual(legacy.reconciles / 4);
  // The bounded loop still spends the same virtual wall clock; it just stops
  // asking while the coordinator reports nothing new.
  expect(bounded.virtualNowMs).toBeGreaterThanOrEqual(30_000);
  expect(legacy.response.nextAction).toBe("review_run");
  expect(bounded.response.nextAction).toBe("review_run");
});

test("a progressing coordinator keeps the 250 ms cadence", async () => {
  const legacy = await driveInstall({
    budgetMs: 30_000,
    minDelayMs: 250,
    maxDelayMs: 250,
    progressPerRound: true,
    maxReconciles: 10_000,
  });
  const bounded = await driveInstall({
    budgetMs: 30_000,
    minDelayMs: 250,
    maxDelayMs: 2_000,
    progressPerRound: true,
    maxReconciles: 10_000,
  });

  // A round that advanced the coordinator resets the cadence, so the loop is
  // never slower than the flat sleep it replaced.
  expect(bounded.waits.every((delay) => delay === 250)).toBe(true);
  expect(bounded.reconciles).toBe(legacy.reconciles);
});

test("the revision coordinator spends the same bounded cadence", async () => {
  let virtualNowMs = 0;
  let reconciles = 0;
  globalThis.fetch = (async (
    fetchInput: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(fetchInput);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" && url.endsWith("/revision-plans")) {
      return json(revisionPlanResponse({ generation: 1, nextAction: "reconcile" }));
    }
    if (method === "POST" && url.endsWith("/reconcile")) {
      reconciles += 1;
      return json(
        revisionPlanResponse({
          generation: 1,
          nextAction: virtualNowMs < 30_000 ? "reconcile" : "review_run",
        }),
      );
    }
    return json({ error: "unexpected_request", url }, 500);
  }) as typeof fetch;

  await createReviewableGitRevisionPlan("capsule_1", { ref: "main" }, {
    idempotencyKey: "key_1",
    timeoutMs: 600_000,
    pollCadence: {
      minDelayMs: 250,
      maxDelayMs: 2_000,
      jitter: () => 1,
      wait: async (milliseconds) => {
        virtualNowMs += milliseconds;
      },
    },
  });

  // 250 + 500 + 1_000 + 2_000 * 15 = 31_750 ms of virtual waits, i.e. the
  // 30_000 ms stall is crossed on the 19th reconcile round.
  expect(reconciles).toBe(19);
});

test("the delay schedule doubles from the floor to the ceiling", () => {
  const schedule = (stalledRounds: number, jitter: number) =>
    gitPlanReconcileDelayMs({
      stalledRounds,
      minDelayMs: 250,
      maxDelayMs: 2_000,
      jitter,
    });

  expect([1, 2, 3, 4, 5, 40].map((rounds) => schedule(rounds, 1))).toEqual([
    250, 500, 1_000, 2_000, 2_000, 2_000,
  ]);
  expect(schedule(4, 0)).toBe(250);
  expect(schedule(4, 0.5)).toBe(1_125);
  // A zero floor cannot be exceeded by jitter and never turns into a spin.
  expect(
    gitPlanReconcileDelayMs({
      stalledRounds: 9,
      minDelayMs: 0,
      maxDelayMs: 50,
      jitter: 1,
    }),
  ).toBe(50);
});

test("an invalid cadence is refused before any round trip", async () => {
  globalThis.fetch = (async () => json({ error: "must_not_be_called" })) as typeof fetch;
  await expect(
    createReviewableGitInstallPlan("ws_1", request, {
      pollCadence: { minDelayMs: 500, maxDelayMs: 100 },
    }),
  ).rejects.toThrow(/maxDelayMs/);
});
