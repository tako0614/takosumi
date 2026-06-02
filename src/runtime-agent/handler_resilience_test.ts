import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeResponse,
  LifecycleDestroyResponse,
} from "takosumi-contract/reference/runtime-agent-lifecycle";
import type { RuntimeHandler } from "./handlers.ts";
import { withRuntimeHandlerResilience } from "./handler_resilience.ts";

const applyReq: LifecycleApplyRequest = {
  shape: "object-store@v1",
  provider: "@takos/test",
  spaceId: "space:test",
  resourceName: "bucket",
  spec: { name: "bucket" },
};

test("withRuntimeHandlerResilience retries transient handler errors", async () => {
  const delays: number[] = [];
  let calls = 0;
  const handler = testRuntimeHandler({
    apply: () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("HTTP 503"));
      return Promise.resolve({ handle: "ok", outputs: {} });
    },
  });
  const wrapped = withRuntimeHandlerResilience(handler, {
    attempts: 3,
    baseDelayMs: 10,
    sleep: (delayMs) => {
      delays.push(delayMs);
      return Promise.resolve();
    },
  });

  const result = await wrapped.apply(applyReq, {});

  assert.deepEqual(result, { handle: "ok", outputs: {} });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [10]);
});

test("withRuntimeHandlerResilience does not retry non-transient errors", async () => {
  let calls = 0;
  const handler = testRuntimeHandler({
    apply: () => {
      calls++;
      return Promise.reject(new Error("HTTP 400 invalid spec"));
    },
  });
  const wrapped = withRuntimeHandlerResilience(handler, {
    attempts: 3,
    sleep: () => {
      throw new Error("should not sleep");
    },
  });

  await assert.rejects(
    () => wrapped.apply(applyReq, {}),
    { message: "HTTP 400 invalid spec" },
  );
  assert.equal(calls, 1);
});

test("withRuntimeHandlerResilience refreshes credentials before retry", async () => {
  let calls = 0;
  let refreshes = 0;
  const handler = testRuntimeHandler({
    apply: () => {
      calls++;
      if (calls === 1) return Promise.reject(new Error("HTTP 401 expired"));
      return Promise.resolve({ handle: "fresh", outputs: {} });
    },
  });
  const wrapped = withRuntimeHandlerResilience(handler, {
    attempts: 2,
    refreshCredentials: (ctx) => {
      refreshes++;
      assert.equal(ctx.operation, "apply");
      assert.equal(ctx.provider, "@takos/test");
      return Promise.resolve();
    },
  });

  const result = await wrapped.apply(applyReq, {});

  assert.deepEqual(result, { handle: "fresh", outputs: {} });
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
});

test("withRuntimeHandlerResilience surfaces the final retry error", async () => {
  let calls = 0;
  const handler = testRuntimeHandler({
    apply: () => {
      calls++;
      return Promise.reject(new TypeError("network offline"));
    },
  });
  const wrapped = withRuntimeHandlerResilience(handler, {
    attempts: 2,
    sleep: () => Promise.resolve(),
  });

  await assert.rejects(
    () => wrapped.apply(applyReq, {}),
    { name: "TypeError", message: "network offline" },
  );
  assert.equal(calls, 2);
});

test("withRuntimeHandlerResilience can be disabled", () => {
  const handler = testRuntimeHandler();
  assert.equal(withRuntimeHandlerResilience(handler, false), handler);
});

function testRuntimeHandler(overrides: Partial<RuntimeHandler> = {}): RuntimeHandler {
  return {
    provider: "@takos/test",
    shape: "object-store@v1",
    acceptedArtifactKinds: [],
    apply: () =>
      Promise.resolve<LifecycleApplyResponse>({ handle: "ok", outputs: {} }),
    destroy: () => Promise.resolve<LifecycleDestroyResponse>({ ok: true }),
    describe: () =>
      Promise.resolve<LifecycleDescribeResponse>({ status: "running" }),
    ...overrides,
  };
}
