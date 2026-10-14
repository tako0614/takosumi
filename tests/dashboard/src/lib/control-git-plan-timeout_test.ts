import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setImmediate as realSetImmediate } from "node:timers";
import {
  createReviewableGitInstallPlan,
  createReviewableGitRevisionPlan,
  type GitPlanPollCadence,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  return () => outcome;
}

// Let response parsing and promise continuations settle without advancing the
// virtual clock. This is an event-loop checkpoint, not an elapsed-time race.
function flushContinuations(): Promise<void> {
  return new Promise((resolve) => { realSetImmediate(resolve); });
}

async function expectDeadline(
  outcome: () => unknown,
  kind: "install" | "revision",
) {
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(24);
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  jest.advanceTimersByTime(1);
  await flushContinuations();
  expect(outcome()).toMatchObject({
    error: { status: 504, code: `${kind}_plan_reconcile_timeout` },
  });
  expect(jest.getTimerCount()).toBe(0);
}

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
  const start = (timeoutMs: number, pollCadence?: GitPlanPollCadence) => kind === "install"
    ? createReviewableGitInstallPlan("ws_1", request, {
      idempotencyKey: "stable_attempt",
      timeoutMs,
      pollCadence,
    })
    : createReviewableGitRevisionPlan("cap_1", { ref: "main" }, {
      idempotencyKey: "stable_attempt",
      timeoutMs,
      pollCadence,
    });

  for (const blockedPhase of ["create", "reconcile"] as const) {
    test(`${kind}: a stalled ${blockedPhase} is bounded and same-key retry resumes`, async () => {
      const calls: Array<{ url: string; key: string | null }> = [];
      let stalled = true;
      let aborted = false;
      const entered = deferred<void>();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, key: new Headers(init?.headers).get("idempotency-key") });
        const isReconcile = url.endsWith("/reconcile");
        if (stalled && isReconcile === (blockedPhase === "reconcile")) {
          const signal = init?.signal;
          entered.resolve();
          return await new Promise<Response>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            }, { once: true });
          });
        }
        return response(kind, isReconcile || !stalled ? "review_run" : "reconcile");
      }) as typeof fetch;

      const outcome = observe(start(25));
      await entered.promise;
      await expectDeadline(outcome, kind);
      expect(aborted).toBe(true);
      expect(calls).toHaveLength(blockedPhase === "create" ? 1 : 2);
      stalled = false;
      await expect(start(1_000)).resolves.toMatchObject({ nextAction: "review_run" });
      expect(calls.filter(({ url }) => !url.endsWith("/reconcile")).map(({ key }) => key))
        .toEqual(["stable_attempt", "stable_attempt"]);
      expect(calls.some(({ url }) => /\/(approve|apply)$/.test(url))).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    });
  }

  test(`${kind}: a late response body cannot continue the timed-out coordinator`, async () => {
    const calls: string[] = [];
    let finishBody!: (value: unknown) => void;
    const entered = deferred<void>();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      const result = response(kind, "reconcile");
      // A response body may remain pending after headers arrived. Also model a
      // transport which settles late despite aborting the client request.
      result.json = () => new Promise((resolve) => {
        finishBody = resolve;
        entered.resolve();
      });
      return result;
    }) as typeof fetch;

    const outcome = observe(start(25));
    await entered.promise;
    await expectDeadline(outcome, kind);
    finishBody({ [`${kind}Plan`]: { id: `${kind}_1` }, nextAction: "reconcile" });
    await flushContinuations();
    expect(calls).toHaveLength(1);
  });

  test(`${kind}: the deadline also bounds the reconciliation pause`, async () => {
    const calls: string[] = [];
    const entered = deferred<void>();
    const pause = deferred<void>();
    let pauseMs: number | undefined;
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      signal = init?.signal;
      return response(kind, "reconcile");
    }) as typeof fetch;

    const outcome = observe(start(25, {
      jitter: () => 0,
      wait: (milliseconds) => {
        pauseMs = milliseconds;
        entered.resolve();
        return pause.promise;
      },
    }));
    await entered.promise;
    expect(pauseMs).toBe(250);
    expect(calls).toHaveLength(2);
    await expectDeadline(outcome, kind);
    expect(signal?.aborted).toBe(true);

    // The pause is still pending when the caller rejects. Even a late pause
    // completion must not issue another reconcile, approve, or apply command.
    pause.resolve();
    await flushContinuations();
    jest.advanceTimersByTime(300);
    await flushContinuations();
    expect(calls).toHaveLength(2);
    expect(calls.some((url) => /\/(approve|apply)$/.test(url))).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test(`${kind}: a reviewable response clears the shared deadline`, async () => {
    globalThis.fetch = (async () => response(kind, "review_run")) as typeof fetch;
    await expect(start(25)).resolves.toMatchObject({ nextAction: "review_run" });
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(25);
    await flushContinuations();
    expect(jest.getTimerCount()).toBe(0);
  });
}
