import assert from "node:assert/strict";
import type { CreatedPaaSApp } from "../../../packages/kernel/src/bootstrap.ts";
import { type CloudflareWorkerEnv, createCloudflareWorker } from "./handler.ts";
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectNamespace,
  R2Bucket,
} from "./bindings.ts";
import { TAKOSUMI_CLOUDFLARE_FRONT_HEADER } from "./routes.ts";

interface CapturedRequest {
  readonly app: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

Deno.test("Cloudflare Worker dispatches kernel control-plane routes in-process", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createKernelApp: () => Promise.resolve(createdApp("kernel", calls)),
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
    ]
  ) {
    calls.length = 0;
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].app, "kernel");
    assert.equal(calls[0].url, `https://worker.example${path}`);
    assert.equal(
      calls[0].headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER),
      "worker",
    );
  }
});

Deno.test("Cloudflare Worker dispatches runtime-agent routes to the runtime-agent app", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createKernelApp: () => Promise.resolve(createdApp("kernel", calls)),
    createRuntimeAgentApp: () =>
      Promise.resolve(createdApp("runtime-agent", calls)),
  });

  const response = await worker.fetch(
    new Request("https://worker.example/api/internal/v1/runtime/agents/enroll"),
    createEnv(),
  );

  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].app, "runtime-agent");
});

Deno.test("Cloudflare Worker preserves method, query, headers, and body", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createKernelApp: () => Promise.resolve(createdApp("kernel", calls, 202)),
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
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "x-correlation-id": "corr_1",
        "x-idempotency-key": "deploy_1",
        "x-request-id": "req_1",
      },
      body,
    }),
    createEnv(),
  );

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://worker.example/v1/deployments?dryRun=1");
  assert.equal(call.headers.get("authorization"), "Bearer deploy-token");
  assert.equal(call.headers.get("x-idempotency-key"), "deploy_1");
  assert.equal(
    call.headers.get("traceparent"),
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(call.headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER), "worker");
  assert.equal(call.body, body);
});

Deno.test("Cloudflare Worker keeps edge-local routes outside the kernel app", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createKernelApp: () => Promise.resolve(createdApp("kernel", calls)),
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

Deno.test("Cloudflare Worker no longer exposes runtime container routing", async () => {
  const worker = createCloudflareWorker({
    createKernelApp: () => Promise.resolve(createdApp("kernel", [])),
  });

  const response = await worker.fetch(
    new Request("https://worker.example/runtime/tasks/apply?instance=runner-1"),
    createEnv(),
  );

  assert.equal(response.status, 404);
});

function createdApp(
  name: string,
  calls: CapturedRequest[],
  status = 200,
): CreatedPaaSApp {
  return {
    app: {
      fetch: async (request: Request) => {
        calls.push(await captureRequest(name, request));
        return Response.json({ app: name }, { status });
      },
    },
    context: {},
    role: name === "runtime-agent" ? "takosumi-runtime-agent" : "takosumi-api",
  } as unknown as CreatedPaaSApp;
}

async function captureRequest(
  app: string,
  request: Request,
): Promise<CapturedRequest> {
  return {
    app,
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
    TAKOS_D1: new FakeD1Database(),
    TAKOS_ARTIFACTS: new FakeR2Bucket(),
    TAKOS_QUEUE: {
      send: () => Promise.resolve(),
    },
    TAKOS_COORDINATION: coordination,
  };
}

class FakeD1Database implements D1Database {
  prepare(_query: string): D1PreparedStatement {
    return new FakeD1PreparedStatement();
  }
}

class FakeD1PreparedStatement implements D1PreparedStatement {
  bind(..._values: readonly unknown[]): D1PreparedStatement {
    return this;
  }

  first<T = unknown>(): Promise<T | null> {
    return Promise.resolve({ ok: 1 } as T);
  }

  all<T = unknown>(): Promise<{ results: readonly T[] }> {
    return Promise.resolve({ results: [] });
  }

  run<T = unknown>(): Promise<{ results: readonly T[]; meta: { changes: 1 } }> {
    return Promise.resolve({ results: [], meta: { changes: 1 } });
  }
}

class FakeR2Bucket implements R2Bucket {
  put(): never {
    throw new Error("not implemented");
  }

  get(): never {
    throw new Error("not implemented");
  }

  head(): Promise<null> {
    return Promise.resolve(null);
  }

  list(): never {
    throw new Error("not implemented");
  }

  delete(): never {
    throw new Error("not implemented");
  }
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
