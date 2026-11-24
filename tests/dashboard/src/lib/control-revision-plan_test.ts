import { afterEach, expect, test } from "bun:test";
import {
  advanceGitRevisionPlan,
  createReviewableGitRevisionPlan,
  isRevisionAlreadyCurrent,
  requireReviewableRevisionPlan,
} from "../../../../dashboard/src/lib/control-api.ts";
import {
  getOrCreateRevisionPlanAttempt,
  observeRevisionPlanAttempt,
  releaseObservedRevisionPlanAttempt,
} from "../../../../dashboard/src/lib/revision-plan-attempt.ts";

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

function revisionResponse(
  nextAction: "reconcile" | "review_run",
): unknown {
  return {
    revisionPlan: {
      id: "revision_plan_1",
      capsuleId: "capsule_1",
      operation: "revision",
      phase: nextAction === "review_run" ? "reviewable" : "syncing_source",
      ...(nextAction === "review_run" ? { planRunId: "plan_run_1" } : {}),
    },
    nextAction,
    links: {
      self: "/api/v1/revision-plans/revision_plan_1",
      ...(nextAction === "reconcile"
        ? {
            reconcile:
              "/api/v1/revision-plans/revision_plan_1/reconcile",
          }
        : { run: "/api/v1/runs/plan_run_1" }),
    },
  };
}

test("revision coordinator sends one ref, reconciles, and stops at review_run", async () => {
  const calls: Array<{
    readonly url: string;
    readonly method: string;
    readonly idempotencyKey: string | null;
    readonly body: unknown;
  }> = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url,
      method,
      idempotencyKey: new Headers(init?.headers).get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (url === "/api/v1/capsules/capsule_1/revision-plans") {
      return json(revisionResponse("reconcile"), 201);
    }
    if (url === "/api/v1/revision-plans/revision_plan_1/reconcile") {
      return json(revisionResponse("review_run"));
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  }) as typeof fetch;

  await expect(
    createReviewableGitRevisionPlan(
      "capsule_1",
      { ref: "refs/heads/release/v2" },
      { idempotencyKey: "revision-idem-1" },
    ),
  ).resolves.toMatchObject({
    nextAction: "review_run",
    revisionPlan: { planRunId: "plan_run_1" },
  });

  expect(calls).toEqual([
    {
      url: "/api/v1/capsules/capsule_1/revision-plans",
      method: "POST",
      idempotencyKey: "revision-idem-1",
      body: { ref: "refs/heads/release/v2" },
    },
    {
      url: "/api/v1/revision-plans/revision_plan_1/reconcile",
      method: "POST",
      idempotencyKey: null,
      body: undefined,
    },
  ]);
  expect(calls.some(({ url }) => url.endsWith("/approve"))).toBe(false);
  expect(calls.some(({ url }) => url.endsWith("/apply"))).toBe(false);
});

test("retiring the creator leaves the accepted revision for explicit continuation", async () => {
  let current = true;
  const calls: string[] = [];
  const isCurrent = () => current;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    calls.push(path);
    if (path === "/api/v1/capsules/capsule_1/revision-plans") {
      current = false;
      return json(revisionResponse("reconcile"), 201);
    }
    return json(revisionResponse("review_run"));
  }) as typeof fetch;

  await expect(createReviewableGitRevisionPlan(
    "capsule_1", { ref: "release/v2" }, { isCurrent },
  )).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual(["/api/v1/capsules/capsule_1/revision-plans"]);

  current = true;
  await expect(advanceGitRevisionPlan("revision_plan_1", { isCurrent }))
    .resolves.toMatchObject({ nextAction: "review_run", revisionPlan: { planRunId: "plan_run_1" } });
  expect(calls).toEqual([
    "/api/v1/capsules/capsule_1/revision-plans",
    "/api/v1/revision-plans/revision_plan_1/reconcile",
  ]);
});

test.each([
  { start: "create", status: 502, code: "bad_gateway" },
  { start: "continue", status: 409, code: "reconcile_in_progress" },
  { start: "continue", status: 409, code: "reconcile_conflict" },
  { start: "continue", status: 0, code: "transport_error" },
] as const)("a $status $code from revision reconcile reads the stored review", async ({ start, status, code }) => {
  const calls: string[] = [];
  const createPath = "/api/v1/capsules/capsule_1/revision-plans";
  const revisionPath = "/api/v1/revision-plans/revision_plan_1";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (method === "POST" && path === createPath) return json(revisionResponse("reconcile"), 201);
    if (method === "POST" && path === `${revisionPath}/reconcile`) {
      if (status === 0) throw new TypeError("Failed to fetch");
      return json({ error: { code } }, status);
    }
    if (method === "GET" && path === revisionPath) {
      expect(init?.cache).toBe("no-store");
      return json(revisionResponse("review_run"));
    }
    throw new Error(`unexpected request: ${method} ${path}`);
  }) as typeof fetch;

  const request = start === "create"
    ? createReviewableGitRevisionPlan("capsule_1", { ref: "release/v2" })
    : advanceGitRevisionPlan("revision_plan_1");
  await expect(request).resolves.toMatchObject({
    nextAction: "review_run",
    revisionPlan: { id: "revision_plan_1", planRunId: "plan_run_1" },
  });
  expect(calls).toEqual([
    ...(start === "create" ? [`POST ${createPath}`] : []),
    `POST ${revisionPath}/reconcile`,
    `GET ${revisionPath}`,
  ]);
});

test.each(["unfinished", "wrong revision", "wrong app", "continuing wrong app", "missing Plan", "retired"] as const)(
  "revision readback stops without another POST when %s",
  async (result) => {
    const calls: string[] = [];
    const continuing = result === "continuing wrong app";
    let current = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path === "/api/v1/capsules/capsule_1/revision-plans") {
        return json(revisionResponse("reconcile"), 201);
      }
      if (method === "POST") return json({ error: { code: "bad_gateway" } }, 502);
      if (result === "retired") current = false;
      if (result === "unfinished") return json(revisionResponse("reconcile"));
      return json({
        nextAction: "review_run",
        revisionPlan: {
          id: result === "wrong revision" ? "revision_other" : "revision_plan_1",
          capsuleId: continuing || result === "wrong app" ? "capsule_other" : "capsule_1",
          phase: "reviewable",
          operation: "revision",
          ...(result !== "missing Plan" ? { planRunId: "plan_run_1" } : {}),
        },
      });
    }) as typeof fetch;
    const isCurrent = () => current;
    const request = continuing
      ? advanceGitRevisionPlan("revision_plan_1", { isCurrent, expectedCapsuleId: "capsule_1" })
      : createReviewableGitRevisionPlan("capsule_1", { ref: "release/v2" }, { isCurrent });
    await expect(request).rejects.toMatchObject(result === "retired" ? { name: "AbortError" } : { status: 502 });
    expect(calls).toEqual([
      ...(continuing ? [] : ["POST /api/v1/capsules/capsule_1/revision-plans"]),
      "POST /api/v1/revision-plans/revision_plan_1/reconcile",
      "GET /api/v1/revision-plans/revision_plan_1",
    ]);
  },
);

test("retiring the owner during the reconcile delay prevents the next command", async () => {
  let current = true;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return json(revisionResponse(calls.length <= 2 ? "reconcile" : "review_run"));
  }) as typeof fetch;

  await expect(advanceGitRevisionPlan("revision_plan_1", {
    isCurrent: () => current,
    pollCadence: { wait: async () => { current = false; } },
  })).rejects.toMatchObject({ name: "AbortError" });
  expect(calls).toEqual([
    "/api/v1/revision-plans/revision_plan_1/reconcile",
    "/api/v1/revision-plans/revision_plan_1/reconcile",
  ]);
});

test("a version check that finds the applied version ends with its own answer, also when continued", async () => {
  const alreadyCurrent = {
    revisionPlan: {
      id: "revision_plan_1",
      capsuleId: "capsule_1",
      operation: "revision",
      phase: "failed",
      diagnostic: {
        code: "revision_already_current",
        message: "This app already runs this version.",
      },
    },
    nextAction: "none",
    links: { self: "/api/v1/revision-plans/revision_plan_1" },
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/v1/capsules/capsule_1/revision-plans") {
      return json(revisionResponse("reconcile"), 201);
    }
    if (url === "/api/v1/revision-plans/revision_plan_1/reconcile") {
      return json(alreadyCurrent);
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const created = await createReviewableGitRevisionPlan(
    "capsule_1",
    { ref: "a".repeat(40) },
    { idempotencyKey: "check-pinned" },
  ).then(() => undefined, (error: unknown) => error);
  expect(isRevisionAlreadyCurrent(created)).toBe(true);

  // "Continue" on a stopped check reaches the same answer instead of a
  // generic "could not start".
  const continued = await advanceGitRevisionPlan("revision_plan_1");
  let thrown: unknown;
  try {
    requireReviewableRevisionPlan(continued);
  } catch (error) {
    thrown = error;
  }
  expect(isRevisionAlreadyCurrent(thrown)).toBe(true);
  expect(isRevisionAlreadyCurrent(new Error("revision_already_current"))).toBe(false);
});

test("a lost create acknowledgement is recoverable only with the same key", async () => {
  const posts: Array<{ readonly key: string | null; readonly body: unknown }> =
    [];
  let createAttempts = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (!url.endsWith("/revision-plans")) {
      throw new Error(`unexpected request: ${url}`);
    }
    createAttempts += 1;
    posts.push({
      key: new Headers(init?.headers).get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (createAttempts === 1) throw new Error("lost acknowledgement");
    return json(revisionResponse("review_run"), 200);
  }) as typeof fetch;

  await expect(
    createReviewableGitRevisionPlan(
      "capsule_1",
      { ref: "release/v2" },
      { idempotencyKey: "revision-replay-key" },
    ),
  ).rejects.toThrow("lost acknowledgement");

  await expect(
    createReviewableGitRevisionPlan(
      "capsule_1",
      { ref: "release/v2" },
      { idempotencyKey: "revision-replay-key" },
    ),
  ).resolves.toMatchObject({ revisionPlan: { planRunId: "plan_run_1" } });

  expect(posts).toEqual([
    { key: "revision-replay-key", body: { ref: "release/v2" } },
    { key: "revision-replay-key", body: { ref: "release/v2" } },
  ]);
});

test("a reconcile 4xx can resume the same coordinator with the same key", async () => {
  const calls: Array<{ readonly url: string; readonly key: string | null }> =
    [];
  let createAttempts = 0;
  let reconcileAttempts = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const key = new Headers(init?.headers).get("idempotency-key");
    calls.push({ url, key });
    if (url.endsWith("/revision-plans")) {
      createAttempts += 1;
      return json(
        revisionResponse("reconcile"),
        createAttempts === 1 ? 201 : 200,
      );
    }
    if (url.endsWith("/reconcile")) {
      reconcileAttempts += 1;
      if (reconcileAttempts === 1) {
        return json(
          {
            error: {
              code: "revision_plan_retryable",
              message: "reconcile is temporarily unavailable",
            },
          },
          409,
        );
      }
      return json(revisionResponse("review_run"));
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  const options = { idempotencyKey: "revision-reconcile-retry-key" } as const;
  await expect(
    createReviewableGitRevisionPlan(
      "capsule_1",
      { ref: "release/v2" },
      options,
    ),
  ).rejects.toMatchObject({ status: 409 });

  await expect(
    createReviewableGitRevisionPlan(
      "capsule_1",
      { ref: "release/v2" },
      options,
    ),
  ).resolves.toMatchObject({ revisionPlan: { planRunId: "plan_run_1" } });

  expect(calls).toEqual([
    {
      url: "/api/v1/capsules/capsule_1/revision-plans",
      key: "revision-reconcile-retry-key",
    },
    {
      url: "/api/v1/revision-plans/revision_plan_1/reconcile",
      key: null,
    },
    {
      url: "/api/v1/capsules/capsule_1/revision-plans",
      key: "revision-reconcile-retry-key",
    },
    {
      url: "/api/v1/revision-plans/revision_plan_1/reconcile",
      key: null,
    },
  ]);
});

test("a changed ref is a distinct request and gets a distinct key", async () => {
  const posts: Array<{ readonly key: string | null; readonly body: unknown }> =
    [];
  let createAttempts = 0;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (!url.endsWith("/revision-plans")) {
      throw new Error(`unexpected request: ${url}`);
    }
    createAttempts += 1;
    posts.push({
      key: new Headers(init?.headers).get("idempotency-key"),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    if (createAttempts === 1) {
      return json(
        {
          error: {
            code: "invalid_request",
            message: "The revision ref is invalid.",
          },
        },
        400,
      );
    }
    return json(revisionResponse("review_run"));
  }) as typeof fetch;

  await expect(
    createReviewableGitRevisionPlan("capsule_1", { ref: "release/v2" }),
  ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  await expect(
    createReviewableGitRevisionPlan("capsule_1", { ref: "release/v3" }),
  ).resolves.toMatchObject({ revisionPlan: { planRunId: "plan_run_1" } });

  expect(posts).toHaveLength(2);
  expect(posts[0]?.body).toEqual({ ref: "release/v2" });
  expect(posts[1]?.body).toEqual({ ref: "release/v3" });
  expect(posts[0]?.key).toBeString();
  expect(posts[1]?.key).toBeString();
  expect(posts[0]?.key).not.toBe(posts[1]?.key);
});

test("only a received create ACK binds the attempt for later coordinator completion", async () => {
  for (const loseCreateAck of [false, true]) {
    const attempts = new Map();
    const request = { ref: "release/recovery" };
    const requestJson = JSON.stringify(request);
    const attempt = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", requestJson);
    const calls: string[] = [];
    let observed = 0;
    let ready = false;
    const response = () => ({
      revisionPlan: {
        id: "revision_recovery", capsuleId: "capsule_1", operation: "revision",
        revision: { targetRef: request.ref },
        ...(ready ? { planRunId: "run_recovered" } : {}),
      },
      nextAction: ready ? "review_run" : "reconcile",
      links: { self: "/api/v1/revision-plans/revision_recovery" },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      calls.push(path);
      if (path === "/api/v1/capsules/capsule_1/revision-plans") {
        expect(new Headers(init?.headers).get("idempotency-key")).toBe(attempt.idempotencyKey);
        if (loseCreateAck) throw new Error("fixture lost create ACK");
        return json(response(), 201);
      }
      if (path === "/api/v1/revision-plans/revision_recovery/reconcile") {
        if (!ready) {
          ready = true;
          if (!loseCreateAck) throw new Error("fixture lost reconcile ACK");
        }
        return json(response());
      }
      throw new Error(`unexpected fixture request: ${path}`);
    }) as typeof fetch;
    await expect(createReviewableGitRevisionPlan("capsule_1", request, {
      idempotencyKey: attempt.idempotencyKey,
      onCreated: (created) => {
        observed += 1;
        observeRevisionPlanAttempt(attempts, "capsule_1", requestJson, attempt, created.revisionPlan);
      },
    })).rejects.toThrow(loseCreateAck ? "fixture lost create ACK" : "fixture lost reconcile ACK");
    expect(observed).toBe(loseCreateAck ? 0 : 1);
    // This explicit continuation may find a Plan even when the initial ACK
    // was lost. Only the observed request/ID association permits release.
    const recovered = requireReviewableRevisionPlan(await advanceGitRevisionPlan("revision_recovery"));
    expect(recovered.revisionPlan.planRunId).toBe("run_recovered");
    releaseObservedRevisionPlanAttempt(attempts, "capsule_1", requestJson, recovered.revisionPlan.id);
    const next = getOrCreateRevisionPlanAttempt(attempts, "capsule_1", requestJson);
    if (loseCreateAck) expect(next.idempotencyKey).toBe(attempt.idempotencyKey);
    else expect(next.idempotencyKey).not.toBe(attempt.idempotencyKey);
    expect(calls.filter(path => path.endsWith("/revision-plans"))).toHaveLength(1);
    expect(calls.some(path => /\/(apply|approve)$/.test(path))).toBe(false);
  }
});
