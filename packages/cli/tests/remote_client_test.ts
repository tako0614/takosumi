import assert from "node:assert/strict";
import { callKernel } from "../src/remote_client.ts";

Deno.test("callKernel sends X-Idempotency-Key on write requests", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: Headers | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    assert.equal(String(input), "https://kernel.example/v1/deployments");
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await callKernel({
      url: "https://kernel.example/",
      token: "deploy-token",
      path: "/v1/deployments",
      body: { mode: "plan", manifest: {} },
      idempotencyKey: "idem-test",
    });
    assert.equal(result.status, 200);
    assert.equal(
      observedHeaders?.get("authorization"),
      "Bearer deploy-token",
    );
    assert.equal(observedHeaders?.get("x-idempotency-key"), "idem-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("callKernel does not send X-Idempotency-Key on GET requests", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: Headers | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    return Promise.resolve(
      new Response(JSON.stringify({ deployments: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await callKernel({
      url: "https://kernel.example",
      token: "deploy-token",
      method: "GET",
      path: "/v1/deployments",
    });
    assert.equal(result.status, 200);
    assert.equal(observedHeaders?.get("x-idempotency-key"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
