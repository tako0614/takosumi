import assert from "node:assert/strict";
import {
  type CloudflareWorkerEnv,
  createCloudflareWorker,
  type DurableObjectNamespace,
} from "./handler.ts";
import {
  TAKOSUMI_CLOUDFLARE_FRONT_HEADER,
  TAKOSUMI_KERNEL_CONTAINER_INSTANCE,
} from "./routes.ts";

interface CapturedRequest {
  readonly instanceName: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

Deno.test("Cloudflare Worker proxies kernel control-plane routes to the kernel container", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    getContainer: (_namespace, instanceName) => ({
      fetch: async (request) => {
        calls.push(await captureRequest(instanceName, request));
        return Response.json({ proxied: true });
      },
    }),
  });
  const env = createEnv();

  for (
    const path of [
      "/health",
      "/capabilities",
      "/openapi.json",
      "/livez",
      "/readyz",
      "/status/summary",
      "/metrics",
      "/v1/deployments",
      "/v1/deployments/demo/audit?cursor=1",
      "/v1/artifacts/kinds",
      "/api/internal/v1/spaces",
      "/api/internal/v1/runtime/agents/enroll",
    ]
  ) {
    calls.length = 0;
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instanceName, TAKOSUMI_KERNEL_CONTAINER_INSTANCE);
    assert.equal(calls[0].url, `https://worker.example${path}`);
    assert.equal(
      calls[0].headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER),
      "worker",
    );
  }
});

Deno.test("Cloudflare Worker preserves kernel request method, query, headers, and body", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    getContainer: (_namespace, instanceName) => ({
      fetch: async (request) => {
        calls.push(await captureRequest(instanceName, request));
        return Response.json({ proxied: true }, { status: 202 });
      },
    }),
  });
  const body = JSON.stringify({
    mode: "apply",
    manifest: { kind: "Manifest" },
  });
  const response = await worker.fetch(
    new Request("https://worker.example/v1/deployments?dryRun=1", {
      method: "POST",
      headers: {
        authorization: "Bearer deploy-token",
        "content-type": "application/json",
        "traceparent":
          "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "x-correlation-id": "corr_1",
        "x-idempotency-key": "deploy_1",
        "x-request-id": "req_1",
        "x-takosumi-actor-context": "actor-json",
        "x-takosumi-internal-signature": "sig",
        "x-takosumi-internal-timestamp": "2026-04-15T00:00:00.000Z",
      },
      body,
    }),
    createEnv(),
  );

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.instanceName, TAKOSUMI_KERNEL_CONTAINER_INSTANCE);
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://worker.example/v1/deployments?dryRun=1");
  assert.equal(call.headers.get("authorization"), "Bearer deploy-token");
  assert.equal(call.headers.get("x-idempotency-key"), "deploy_1");
  assert.equal(call.headers.get("x-takosumi-internal-signature"), "sig");
  assert.equal(
    call.headers.get("x-takosumi-internal-timestamp"),
    "2026-04-15T00:00:00.000Z",
  );
  assert.equal(call.headers.get("x-takosumi-actor-context"), "actor-json");
  assert.equal(
    call.headers.get("traceparent"),
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(call.headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER), "worker");
  assert.equal(call.body, body);
});

Deno.test("Cloudflare Worker keeps edge-local routes outside the kernel proxy", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    getContainer: (_namespace, instanceName) => ({
      fetch: async (request) => {
        calls.push(await captureRequest(instanceName, request));
        return Response.json({ proxied: true });
      },
    }),
  });
  const env = createEnv();

  assert.equal(
    (await worker.fetch(new Request("https://worker.example/healthz"), env))
      .status,
    200,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (await worker.fetch(
      new Request("https://worker.example/queue/test", {
        method: "POST",
        body: JSON.stringify({ hello: "queue" }),
      }),
      env,
    )).status,
    200,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (await worker.fetch(
      new Request("https://worker.example/storage/healthz"),
      env,
    )).status,
    200,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (await worker.fetch(
      new Request("https://worker.example/coordination/list-alarms", {
        method: "POST",
        body: "{}",
      }),
      env,
    )).status,
    200,
  );
  assert.equal(calls.length, 0);
});

Deno.test("Cloudflare Worker preserves runtime container routing and unknown 404s", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    getContainer: (_namespace, instanceName) => ({
      fetch: async (request) => {
        calls.push(await captureRequest(instanceName, request));
        return Response.json({ proxied: true });
      },
    }),
  });
  const env = createEnv();

  const runtimeResponse = await worker.fetch(
    new Request("https://worker.example/runtime/tasks/apply?instance=runner-1"),
    env,
  );
  assert.equal(runtimeResponse.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].instanceName, "runner-1");
  assert.equal(
    calls[0].url,
    "https://worker.example/runtime/tasks/apply?instance=runner-1",
  );

  const unknownResponse = await worker.fetch(
    new Request("https://worker.example/not-found"),
    env,
  );
  assert.equal(unknownResponse.status, 404);
  assert.equal(calls.length, 1);
});

async function captureRequest(
  instanceName: string,
  request: Request,
): Promise<CapturedRequest> {
  return {
    instanceName,
    method: request.method,
    url: request.url,
    headers: new Headers(request.headers),
    body: await request.clone().text(),
  };
}

function createEnv(): CloudflareWorkerEnv {
  const coordination = new FakeNamespace((request) =>
    Response.json({ coordinationPath: new URL(request.url).pathname })
  );
  return {
    TAKOS_D1: {
      prepare: () => ({
        bind() {
          return this;
        },
        first<T = unknown>(): Promise<T | null> {
          return Promise.resolve({ ok: 1 } as T);
        },
      }),
    },
    TAKOS_ARTIFACTS: {
      head: () => Promise.resolve({ ok: true }),
    },
    TAKOS_QUEUE: {
      send: () => Promise.resolve(),
    },
    TAKOS_COORDINATION: coordination,
    TAKOS_WORKLOAD_CONTAINER: new FakeNamespace(() =>
      Response.json({ workload: true })
    ),
    TAKOS_KERNEL_CONTAINER: new FakeNamespace(() =>
      Response.json({ kernel: true })
    ),
  };
}

class FakeNamespace implements DurableObjectNamespace {
  constructor(
    private readonly handler: (
      request: Request,
    ) => Promise<Response> | Response,
  ) {}

  idFromName(name: string): string {
    return name;
  }

  get(_id: unknown): { fetch(request: Request): Promise<Response> } {
    return {
      fetch: async (request) => await this.handler(request),
    };
  }
}
