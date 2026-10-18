import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setImmediate as realSetImmediate } from "node:timers";
import {
  ControlApiError,
  getRun,
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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function observe<T>(promise: Promise<T>) {
  let outcome: { value: T } | { error: unknown } | undefined;
  void promise.then(
    (value) => { outcome = { value }; },
    (error) => { outcome = { error }; },
  );
  return () => outcome;
}

function flushContinuations(): Promise<void> {
  return new Promise((resolve) => { realSetImmediate(resolve); });
}

test("getRun bounds a fetch that ignores abort, with one encoded credentialed GET", async () => {
  const held = deferred<Response>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input, init) => {
    calls.push({ url: String(input), init });
    return held.promise;
  }) as typeof fetch;

  const outcome = observe(getRun("run/with space"));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("/api/v1/runs/run%2Fwith%20space");
  expect(calls[0]?.init?.method).toBe("GET");
  expect(calls[0]?.init?.credentials).toBe("include");
  expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  expect(jest.getTimerCount()).toBe(1);

  jest.advanceTimersByTime(29_999);
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  jest.advanceTimersByTime(1);
  await flushContinuations();
  expect(outcome()).toMatchObject({
    error: { status: 0, code: "request_timeout" },
  });
  expect((outcome() as { error: unknown }).error).toBeInstanceOf(ControlApiError);
  expect(calls[0]?.init?.signal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  expect(calls).toHaveLength(1);

  held.reject(new Error("late fetch rejection"));
  await flushContinuations();
  expect(outcome()).toMatchObject({
    error: { status: 0, code: "request_timeout" },
  });
});

test("getRun's whole-read deadline covers a body that never settles", async () => {
  const heldBody = deferred<unknown>();
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_input, init) => {
    calls.push(init ?? {});
    return {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => heldBody.promise,
    } as Response;
  }) as typeof fetch;

  const outcome = observe(getRun("run_body"));
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(30_000);
  await flushContinuations();
  expect(outcome()).toMatchObject({
    error: { status: 0, code: "request_timeout" },
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.signal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);

  heldBody.reject(new Error("late body rejection"));
  await flushContinuations();
  expect(outcome()).toMatchObject({
    error: { status: 0, code: "request_timeout" },
  });
});

test("getRun preserves 200 and HTTP errors and clears the timer early", async () => {
  const requests: RequestInit[] = [];
  let response = new Response(JSON.stringify({ run: { id: "run_ok", status: "succeeded" } }), {
    headers: { "content-type": "application/json" },
  });
  globalThis.fetch = (async (_input, init) => {
    requests.push(init ?? {});
    return response;
  }) as typeof fetch;

  await expect(getRun("run_ok")).resolves.toMatchObject({ id: "run_ok", status: "succeeded" });
  expect(jest.getTimerCount()).toBe(0);
  expect(requests[0]?.signal?.aborted).toBe(false);

  response = new Response(JSON.stringify({
    error: { code: "not_found", message: "No such run" },
  }), { status: 404, headers: { "content-type": "application/json" } });
  await expect(getRun("run_missing")).rejects.toMatchObject({
    status: 404, code: "not_found", message: "No such run",
  });
  expect(jest.getTimerCount()).toBe(0);

  response = new Response(JSON.stringify({ error: "forbidden" }), {
    status: 403, headers: { "content-type": "application/json" },
  });
  await expect(getRun("run_forbidden")).rejects.toMatchObject({ status: 403, code: "forbidden" });
  expect(jest.getTimerCount()).toBe(0);

  response = new Response("", { status: 401 });
  await expect(getRun("run_unauthorized")).rejects.toMatchObject({
    status: 401, code: "unauthorized",
  });
  expect(jest.getTimerCount()).toBe(0);
  expect(requests).toHaveLength(4);
});
