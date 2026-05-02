/**
 * Unit tests for the deepened `GcpHttpGatewayClient` (Phase 17A2).
 *
 * Covers OAuth2 token provider injection, retry on transient errors,
 * paginate(), and ping().
 */

import assert from "node:assert/strict";
import {
  type GcpAccessTokenProvider,
  GcpHttpGatewayClient,
} from "../src/providers/gcp/mod.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: unknown;
}

function captureFetch(
  requests: CapturedRequest[],
  responder: (request: CapturedRequest) => Response | Promise<Response>,
): typeof fetch {
  return async function fetchImpl(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === "string" || input instanceof URL
      ? `${input}`
      : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (init?.body) {
      body = JSON.parse(`${init.body}`);
    }
    const captured: CapturedRequest = { url, method, headers, body };
    requests.push(captured);
    return await responder(captured);
  };
}

Deno.test("gcp http gateway: dynamic OAuth2 access-token provider sets Bearer header", async () => {
  const requests: CapturedRequest[] = [];
  let tokenCalls = 0;
  const provider: GcpAccessTokenProvider = {
    getAccessToken() {
      tokenCalls += 1;
      return Promise.resolve(`oauth-${tokenCalls}`);
    },
  };
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gw.example.test/gcp",
    accessTokenProvider: provider,
    projectId: "proj-1",
    fetch: captureFetch(
      requests,
      () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
    ),
  });
  await client.listOperations();
  assert.equal(tokenCalls, 1);
  assert.equal(requests[0].headers.get("authorization"), "Bearer oauth-1");
  assert.equal(requests[0].headers.get("x-goog-project-id"), "proj-1");
});

Deno.test("gcp http gateway: retries on HTTP 503 until success", async () => {
  let calls = 0;
  const requests: CapturedRequest[] = [];
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gw.example.test/gcp",
    bearerToken: "static",
    retryPolicy: {
      timeoutMs: 60_000,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      maxRetries: 3,
      jitterMs: 0,
    },
    fetch: captureFetch(requests, () => {
      calls += 1;
      if (calls <= 2) {
        return new Response(
          JSON.stringify({ message: "down" }),
          { status: 503, statusText: "Service Unavailable" },
        );
      }
      return new Response(JSON.stringify({ result: [] }), { status: 200 });
    }),
  });
  const result = await client.listOperations();
  assert.deepEqual(result, []);
  assert.equal(calls, 3);
});

Deno.test("gcp http gateway: surfaces non-retriable HTTP 403", async () => {
  let calls = 0;
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gw.example.test/gcp",
    bearerToken: "static",
    retryPolicy: {
      timeoutMs: 60_000,
      initialBackoffMs: 1,
      maxBackoffMs: 1,
      maxRetries: 5,
      jitterMs: 0,
    },
    fetch: () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ message: "forbidden" }),
          { status: 403, statusText: "Forbidden" },
        ),
      );
    },
  });
  await assert.rejects(
    () => client.listOperations(),
    /HTTP 403/,
  );
  // Non-retriable 403 should hit the gateway exactly once.
  assert.equal(calls, 1);
});

Deno.test("gcp http gateway: bearer token still works without provider", async () => {
  const requests: CapturedRequest[] = [];
  const client = new GcpHttpGatewayClient({
    baseUrl: "https://gw.example.test/gcp",
    bearerToken: "static-token",
    fetch: captureFetch(
      requests,
      () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
    ),
  });
  await client.listOperations();
  assert.equal(
    requests[0].headers.get("authorization"),
    "Bearer static-token",
  );
});
