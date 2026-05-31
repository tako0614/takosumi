import { test } from "bun:test";
import assert from "node:assert/strict";
import { callKernel } from "../remote_client.ts";

test("callKernel sends auth + JSON body on write requests", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: Headers | undefined;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    assert.equal(String(input), "https://kernel.example/v1/installations");
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
      token: "installer-token",
      path: "/v1/installations",
      body: { spaceId: "space_1", source: { kind: "local", url: "./" } },
    });
    assert.equal(result.status, 200);
    assert.equal(
      observedHeaders?.get("authorization"),
      "Bearer installer-token",
    );
    // Idempotency header was removed with the Phase A spec rewrite —
    // installs are tracked by Installation id instead.
    assert.equal(observedHeaders?.get("x-idempotency-key"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callKernel passes through GET requests without idempotency residue", async () => {
  const originalFetch = globalThis.fetch;
  let observedHeaders: Headers | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    observedHeaders = new Headers(init?.headers);
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const result = await callKernel({
      url: "https://kernel.example",
      token: "installer-token",
      method: "GET",
      path: "/health",
    });
    assert.equal(result.status, 200);
    assert.equal(observedHeaders?.get("x-idempotency-key"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
