import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { setImmediate as realSetImmediate } from "node:timers";
import { main } from "../../../cli/src/main.ts";

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
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, no) => { reject = no; });
  return { promise, reject };
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

test("status bounds a fetch that ignores abort, with one encoded GET", async () => {
  const held = deferred<Response>();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  globalThis.fetch = ((input, init) => {
    calls.push({ url: String(input), init });
    return held.promise;
  }) as typeof fetch;

  const outcome = observe(main([
    "status", "run/with space", "--url", "https://deploy.example.test/",
    "--token", "status-token",
  ], { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }));
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://deploy.example.test/api/v1/runs/run%2Fwith%20space");
  expect(calls[0]?.init?.method).toBe("GET");
  expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer status-token");
  expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  expect(jest.getTimerCount()).toBe(1);

  jest.advanceTimersByTime(29_999);
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  jest.advanceTimersByTime(1);
  await flushContinuations();
  expect(outcome()).toEqual({ value: 1 });
  expect(stdout).toEqual([]);
  expect(stderr).toEqual(["status request timed out after 30000ms"]);
  expect(calls[0]?.init?.signal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  expect(calls).toHaveLength(1);

  held.reject(new Error("late fetch rejection"));
  await flushContinuations();
  expect(outcome()).toEqual({ value: 1 });
});

test("status deadline includes response.text() and consumes late body rejection", async () => {
  const heldBody = deferred<string>();
  const calls: RequestInit[] = [];
  const stderr: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    calls.push(init ?? {});
    return {
      ok: true,
      status: 200,
      text: () => heldBody.promise,
    } as Response;
  }) as typeof fetch;

  const outcome = observe(main([
    "status", "run_body", "--url", "https://deploy.example.test/",
  ], { stdout: () => {}, stderr: (line) => stderr.push(line) }));
  await flushContinuations();
  expect(outcome()).toBeUndefined();
  expect(jest.getTimerCount()).toBe(1);
  jest.advanceTimersByTime(30_000);
  await flushContinuations();
  expect(outcome()).toEqual({ value: 1 });
  expect(stderr).toEqual(["status request timed out after 30000ms"]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.signal?.aborted).toBe(true);
  expect(jest.getTimerCount()).toBe(0);
  heldBody.reject(new Error("late body rejection"));
  await flushContinuations();
  expect(outcome()).toEqual({ value: 1 });
});

test("status preserves success and HTTP errors; logs do not gain this timer", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  let response = Response.json({ id: "run_ok", type: "apply", status: "succeeded" });
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return response;
  }) as typeof fetch;
  const io = { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) };

  expect(await main(["status", "run_ok", "--url", "https://deploy.example.test/"], io)).toBe(0);
  expect(stdout).toEqual(["apply run_ok succeeded"]);
  expect(stderr).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
  expect(requests[0]?.init?.signal?.aborted).toBe(false);

  response = Response.json({ error: { message: "No such run" } }, { status: 404 });
  expect(await main(["status", "run_missing", "--url", "https://deploy.example.test/"], io)).toBe(1);
  expect(stderr).toEqual(["No such run"]);
  expect(jest.getTimerCount()).toBe(0);

  response = Response.json({ diagnostics: [], auditEvents: [] });
  expect(await main(["logs", "run_ok", "--url", "https://deploy.example.test/"], io)).toBe(0);
  expect(requests[2]?.init?.signal).toBeUndefined();
  expect(jest.getTimerCount()).toBe(0);
});
