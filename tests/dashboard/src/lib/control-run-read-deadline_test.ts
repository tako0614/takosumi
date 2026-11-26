import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setImmediate as realSetImmediate } from "node:timers";
import {
  ControlApiError,
  getCapsuleAppWithSignal,
  getCapsuleConfigurationContext,
  getRun,
  listAccessibleApps,
  listAccessibleAppsPage,
  resetAppOwnershipCache,
} from "../../../../dashboard/src/lib/control-api.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetAppOwnershipCache();
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  resetAppOwnershipCache();
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

const appId = "cap/demo";
const appPath = "/api/v1/capsules/cap%2Fdemo";
const appView = {
  kind: "takosumi.capsule-app@v1",
  capsuleId: appId,
  state: "installed",
  primaryAction: "open",
  problems: [],
  screens: [],
  version: {},
  progress: {},
  uninstall: {},
};

test.each([
  ["app view", `${appPath}/app`, (signal?: AbortSignal) => getCapsuleAppWithSignal(appId, signal)],
  ["settings context", appPath, (signal?: AbortSignal) => getCapsuleConfigurationContext(appId, { signal })],
] as const)("%s exposes a retryable error when its GET stalls", async (_name, path, read) => {
  const held = deferred<Response>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = ((input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1 ? held.promise : Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
  }) as typeof fetch;

  const outcome = observe(read());
  jest.advanceTimersByTime(29_999);
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  expect(calls).toHaveLength(1);
  jest.advanceTimersByTime(1);
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { status: 0, code: "request_timeout" } });
  expect(calls[0]?.init?.signal?.aborted).toBe(true);

  const lateStatus = jest.fn(() => 401);
  held.resolve({ get status() { return lateStatus(); } } as Response);
  await flushContinuations();
  expect(lateStatus).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);

  await expect(read()).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call).toMatchObject({ url: path, init: { method: "GET", credentials: "include" } });
  }
  expect(jest.getTimerCount()).toBe(0);
});

test("app view body waits are bounded and a later read can open the same app", async () => {
  const heldBody = deferred<unknown>();
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => heldBody.promise,
  } as Response)) as typeof fetch;
  const outcome = observe(getCapsuleAppWithSignal(appId));
  await flushContinuations();
  jest.advanceTimersByTime(30_000);
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { status: 0, code: "request_timeout" } });

  globalThis.fetch = (async () => Response.json({ app: appView })) as typeof fetch;
  await expect(getCapsuleAppWithSignal(appId)).resolves.toEqual(appView);
  heldBody.resolve({ app: { ...appView, state: "uninstalled" } });
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { status: 0, code: "request_timeout" } });
  expect(jest.getTimerCount()).toBe(0);
});

test("retiring an app read settles immediately even if fetch ignores abort", async () => {
  const held = deferred<Response>();
  const fetchApp = jest.fn(() => held.promise);
  globalThis.fetch = fetchApp as unknown as typeof fetch;
  const caller = new AbortController();
  const outcome = observe(getCapsuleAppWithSignal(appId, caller.signal));
  caller.abort();
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { name: "AbortError" } });
  expect(jest.getTimerCount()).toBe(0);
  await expect(getCapsuleAppWithSignal(appId, caller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchApp).toHaveBeenCalledTimes(1);
  held.reject(new Error("late fetch rejection"));
  await flushContinuations();
});

test("a settings read discards a response decoded after its caller retires", async () => {
  const body = deferred<unknown>();
  const decode = jest.fn(() => body.promise);
  globalThis.fetch = (async () => ({
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: decode,
  } as Response)) as typeof fetch;
  let current = true;
  const result = observe(getCapsuleConfigurationContext(appId, { isCurrent: () => current }));
  await flushContinuations();
  expect(decode).toHaveBeenCalledTimes(1);
  current = false;
  body.resolve({});
  await flushContinuations();
  expect(result()).toMatchObject({ error: { name: "AbortError" } });
  expect(jest.getTimerCount()).toBe(0);
});

test("a stalled account apps GET times out once for all consumers and its retry gets a new response", async () => {
  const held = deferred<Response>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const current = { capsuleId: "recovered", role: "owner", name: "Recovered app" };
  globalThis.fetch = ((input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1 ? held.promise : Promise.resolve(Response.json({ apps: [current] }));
  }) as typeof fetch;

  const caller = new AbortController();
  const abandoned = observe(listAccessibleAppsPage(undefined, caller.signal));
  const home = observe(listAccessibleAppsPage());
  const account = observe(listAccessibleApps());
  caller.abort();
  await flushContinuations();
  expect(abandoned()).toMatchObject({ error: { name: "AbortError" } });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.init?.signal?.aborted).toBe(false);

  jest.advanceTimersByTime(29_999);
  await flushContinuations();
  expect(home()).toBeUndefined();
  expect(account()).toBeUndefined();
  jest.advanceTimersByTime(1);
  await flushContinuations();
  expect(home()).toMatchObject({ error: { code: "request_timeout" } });
  expect(account()).toMatchObject({ error: { code: "request_timeout" } });
  expect(calls[0]?.init?.signal?.aborted).toBe(true);
  expect(calls).toHaveLength(1);

  await expect(listAccessibleAppsPage()).resolves.toMatchObject({ apps: [current] });
  const lateStatus = jest.fn(() => 401);
  held.resolve({ get status() { return lateStatus(); } } as Response);
  await flushContinuations();
  expect(lateStatus).not.toHaveBeenCalled();
  await expect(listAccessibleApps()).resolves.toEqual([current]);
  expect(calls.map(({ url, init }) => [url, init?.method])).toEqual([
    ["/api/v1/apps", "GET"], ["/api/v1/apps", "GET"],
  ]);
  expect(jest.getTimerCount()).toBe(0);
});

test("the deadline covers a scoped app search response body and a retry keeps its cursor", async () => {
  const held = deferred<unknown>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1 ? {
      status: 200,
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => held.promise,
    } as Response : Response.json({ apps: [], appliedQuery: "office" });
  }) as typeof fetch;
  const load = () => listAccessibleAppsPage("current page", undefined, "Office", { cache: "no-store" });
  const outcome = observe(load());
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  jest.advanceTimersByTime(30_000);
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { code: "request_timeout" } });
  expect(calls[0]?.init?.signal?.aborted).toBe(true);
  expect(calls).toHaveLength(1);

  await expect(load()).resolves.toMatchObject({ apps: [], appliedQuery: "office" });
  held.resolve({ apps: [{ capsuleId: "retired", role: "owner" }], appliedQuery: "office" });
  await flushContinuations();
  expect(outcome()).toMatchObject({ error: { code: "request_timeout" } });
  expect(calls[1]).toMatchObject({ url: calls[0]?.url, init: { method: "GET", cache: "no-store" } });
  expect(new URL(calls[1]!.url, "https://dashboard.invalid").searchParams.get("cursor")).toBe("current page");
  expect(jest.getTimerCount()).toBe(0);
});
