import assert from "node:assert/strict";
import { AwsHttpGatewayClient } from "../src/providers/aws/mod.ts";

interface RecordedRequest {
  readonly path: string;
  readonly body: unknown;
  readonly attempt: number;
}

function buildClient(
  responses: ReadonlyArray<{
    readonly status: number;
    readonly body: unknown;
  }>,
  options: { recorded?: RecordedRequest[] } = {},
): { client: AwsHttpGatewayClient; recorded: RecordedRequest[] } {
  const recorded = options.recorded ?? [];
  let attempt = 0;
  const fakeFetch: typeof fetch = (input, init) => {
    const url = input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : input.url);
    const path = url.pathname.replace(/^\//, "");
    attempt += 1;
    let body: unknown;
    try {
      body = JSON.parse(
        String((init as RequestInit | undefined)?.body ?? "null"),
      );
    } catch {
      body = null;
    }
    recorded.push({ path, body, attempt });
    const response = responses[Math.min(attempt - 1, responses.length - 1)];
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const client = new AwsHttpGatewayClient({
    baseUrl: "http://gateway.local",
    fetch: fakeFetch,
    retry: { maxAttempts: 3, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  return { client, recorded };
}

Deno.test("AwsHttpGatewayClient retries on 503 service unavailable", async () => {
  const recorded: RecordedRequest[] = [];
  const { client } = buildClient(
    [
      { status: 503, body: { message: "unavailable" } },
      { status: 503, body: { message: "unavailable" } },
      { status: 200, body: { result: { id: "ok" } } },
    ],
    { recorded },
  );
  const result = await client.materializeDesiredState({
    id: "ds_1",
    spaceId: "space",
    groupId: "group",
    activationId: "activation",
    appName: "docs",
    materializedAt: "2026-04-30T00:00:00.000Z",
    workloads: [],
    resources: [],
    routes: [],
  });
  assert.equal(recorded.length, 3);
  assert.equal((result as { id: string }).id, "ok");
});

Deno.test("AwsHttpGatewayClient does not retry on 400 validation", async () => {
  const recorded: RecordedRequest[] = [];
  const { client } = buildClient(
    [{ status: 400, body: { message: "bad input" } }],
    { recorded },
  );
  await assert.rejects(
    () => client.listOperations(),
    /HTTP 400/,
  );
  assert.equal(recorded.length, 1);
});

Deno.test("AwsHttpGatewayClient telemetry reports attempts and failure", async () => {
  const events: string[] = [];
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(new Response('{"message":"oops"}', { status: 500 }));
  const client = new AwsHttpGatewayClient({
    baseUrl: "http://gateway.local",
    fetch: fakeFetch,
    retry: { maxAttempts: 2, baseDelayMs: 1, sleep: () => Promise.resolve() },
    telemetry: {
      onAttempt: (e) => events.push(`attempt:${e.attempt}`),
      onFailure: (e) => events.push(`failure:${e.errorCategory}`),
    },
  });
  await assert.rejects(() => client.listOperations());
  assert.deepEqual(events, [
    "attempt:1",
    "failure:service-unavailable",
    "attempt:2",
    "failure:service-unavailable",
  ]);
});

Deno.test("AwsHttpGatewayClient detectDriftLocal compares snapshots", () => {
  const client = new AwsHttpGatewayClient({
    baseUrl: "http://gateway.local",
    fetch: () => Promise.resolve(new Response("{}", { status: 200 })),
  });
  const drift = client.detectDriftLocal({ a: 1 }, { a: 2 });
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, "a");
});

Deno.test("AwsHttpGatewayClient paginate yields items across pages", async () => {
  const pages = [
    { items: [{ id: "a" }], nextToken: "p2" },
    { items: [{ id: "b" }], nextToken: undefined },
  ];
  let pageIndex = 0;
  const fakeFetch: typeof fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ result: pages[pageIndex++] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  const client = new AwsHttpGatewayClient({
    baseUrl: "http://gateway.local",
    fetch: fakeFetch,
    retry: { maxAttempts: 1, baseDelayMs: 1, sleep: () => Promise.resolve() },
  });
  const items: { id: string }[] = [];
  for await (const item of client.paginate<{ id: string }>("custom/list")) {
    items.push(item);
  }
  assert.deepEqual(items.map((i) => i.id), ["a", "b"]);
});
