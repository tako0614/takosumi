import { afterEach, expect, test } from "bun:test";
import {
  createReviewableGitRevisionPlan,
} from "../../../../dashboard/src/lib/control-api.ts";

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
