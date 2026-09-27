import { afterEach, expect, test } from "bun:test";
import {
  createReviewableGitInstallPlan,
  createReviewableGitRevisionPlan,
  getGitInstallPlan,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function response(kind: "install" | "revision", nextAction: "reconcile" | "review_run") {
  return new Response(JSON.stringify({
    [`${kind}Plan`]: {
      id: `${kind}_1`,
      ...(nextAction === "review_run" ? { planRunId: "plan_1" } : {}),
    },
    nextAction,
  }), { headers: { "content-type": "application/json" } });
}

const request = {
  source: { name: "Test", url: "https://example.com/repo.git", ref: "main" },
  capsule: { name: "Test", environment: "production" },
};

for (const kind of ["install", "revision"] as const) {
  const start = (timeoutMs: number) => kind === "install"
    ? createReviewableGitInstallPlan("ws_1", request, {
      idempotencyKey: "stable_attempt",
      timeoutMs,
    })
    : createReviewableGitRevisionPlan("cap_1", { ref: "main" }, {
      idempotencyKey: "stable_attempt",
      timeoutMs,
    });

  for (const blockedPhase of ["create", "reconcile"] as const) {
    test(`${kind}: a stalled ${blockedPhase} is bounded and same-key retry resumes`, async () => {
      const calls: Array<{ url: string; key: string | null }> = [];
      let stalled = true;
      let aborted = false;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, key: new Headers(init?.headers).get("idempotency-key") });
        const isReconcile = url.endsWith("/reconcile");
        if (stalled && isReconcile === (blockedPhase === "reconcile")) {
          const signal = init?.signal;
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        return response(kind, isReconcile || !stalled ? "review_run" : "reconcile");
      }) as typeof fetch;

      // Bound the assertion as well so the regression fails promptly when the
      // client has no deadline, instead of hanging the test runner.
      await expect(Promise.race([
        start(25),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100)),
      ])).rejects.toMatchObject({
        status: 504,
        code: `${kind}_plan_reconcile_timeout`,
      });
      expect(aborted).toBe(true);
      expect(calls).toHaveLength(blockedPhase === "create" ? 1 : 2);
      stalled = false;
      await expect(start(1_000)).resolves.toMatchObject({ nextAction: "review_run" });
      expect(calls.filter(({ url }) => !url.endsWith("/reconcile")).map(({ key }) => key))
        .toEqual(["stable_attempt", "stable_attempt"]);
      expect(calls.some(({ url }) => /\/(approve|apply)$/.test(url))).toBe(false);
    });
  }

  test(`${kind}: a late response body cannot continue the timed-out coordinator`, async () => {
    const calls: string[] = [];
    let finishBody!: (value: unknown) => void;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const result = response(kind, "reconcile");
      // A response body may remain pending after headers arrived. Also model a
      // transport which settles late despite aborting the client request.
      result.json = () => new Promise((resolve) => { finishBody = resolve; });
      return result;
    }) as typeof fetch;

    await expect(Promise.race([
      start(25),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100)),
    ])).rejects.toMatchObject({
      status: 504,
      code: `${kind}_plan_reconcile_timeout`,
    });
    finishBody({ [`${kind}Plan`]: { id: `${kind}_1` }, nextAction: "reconcile" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
  });

  test(`${kind}: the deadline also bounds the reconciliation pause`, async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return response(kind, "reconcile");
    }) as typeof fetch;

    await expect(Promise.race([
      start(25),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 100)),
    ])).rejects.toMatchObject({
      status: 504,
      code: `${kind}_plan_reconcile_timeout`,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toHaveLength(2);
  });
}

test("install: timeout retains a known coordinator and read-only status finds its late Plan", async () => {
  const calls: Array<{ url: string; method: string; key: string | null }> = [];
  let progressId: string | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      key: new Headers(init?.headers).get("idempotency-key"),
    });
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          installPlan: {
            id: "install_1",
            capsuleId: "cap_1",
            planRunId: "plan_1",
            phase: "reviewable",
          },
          nextAction: "review_run",
          links: {
            self: "/api/v1/install-plans/install_1",
            run: "/api/v1/runs/plan_1",
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    }
    if (url.endsWith("/reconcile")) {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }
    return response("install", "reconcile");
  }) as typeof fetch;

  await expect(
    createReviewableGitInstallPlan("ws_1", request, {
      idempotencyKey: "stable_attempt",
      timeoutMs: 25,
      onProgress: (value) => {
        progressId = value.installPlan.id;
      },
    }),
  ).rejects.toMatchObject({ code: "install_plan_reconcile_timeout" });

  expect(progressId).toBe("install_1");
  const status = await getGitInstallPlan(progressId!);
  expect(status).toMatchObject({
    nextAction: "review_run",
    installPlan: { id: "install_1", capsuleId: "cap_1", planRunId: "plan_1" },
  });
  expect(calls).toEqual([
    {
      url: "/api/v1/workspaces/ws_1/install-plans",
      method: "POST",
      key: "stable_attempt",
    },
    {
      url: "/api/v1/install-plans/install_1/reconcile",
      method: "POST",
      key: null,
    },
    { url: "/api/v1/install-plans/install_1", method: "GET", key: null },
  ]);
});

test("install: unknown create acknowledgement never invents a coordinator ID", async () => {
  let progressId: string | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as typeof fetch;

  await expect(
    createReviewableGitInstallPlan("ws_1", request, {
      idempotencyKey: "stable_attempt",
      timeoutMs: 25,
      onProgress: (value) => {
        progressId = value.installPlan.id;
      },
    }),
  ).rejects.toMatchObject({ code: "install_plan_reconcile_timeout" });

  expect(progressId).toBeUndefined();
});
