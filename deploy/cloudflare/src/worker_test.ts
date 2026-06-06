import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CloudflareWorkerEnv,
  type CreatedCloudflareWorkerApp,
  createCloudflareWorker,
} from "./handler.ts";
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectNamespace,
  OpenTofuRunQueueMessage,
  QueueBatch,
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

test("Cloudflare Worker dispatches service control-plane routes in-process", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });
  const env = createEnv();

  for (const path of [
    "/health",
    "/capabilities",
    "/openapi.json",
    "/livez",
    "/readyz",
    "/status/summary",
    "/metrics",
    // A non-runtime-agent `/api/internal/v1/*` path must dispatch to the
    // service app (the runtime-agent app only owns `/api/internal/v1/runtime/*`).
    "/api/internal/v1/probe",
    "/v1/runner-profiles",
    "/v1/plan-runs",
    "/v1/plan-runs/plan_abcdef12",
    "/v1/apply-runs",
    "/v1/apply-runs/apply_abcdef12",
    "/v1/installations/ins_abcdef12",
    "/v1/installations/ins_abcdef12/deployments",
    "/v1/installations/ins_abcdef12/deployment-outputs",
  ]) {
    calls.length = 0;
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].app, "service");
    assert.equal(calls[0].url, `https://worker.example${path}`);
    assert.equal(
      calls[0].headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER),
      "worker",
    );
  }
});

test("Cloudflare Worker dispatches runtime-agent routes to the runtime-agent app", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
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

test("Cloudflare Worker preserves method, query, headers, and body", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls, 202)),
  });
  const body = JSON.stringify({
    spaceId: "space_test",
    audit: { reason: "test" },
  });
  const response = await worker.fetch(
    new Request("https://worker.example/api/internal/v1/runs?trace=1", {
      method: "POST",
      headers: {
        authorization: "Bearer internal-token",
        "content-type": "application/json",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
        "x-correlation-id": "corr_1",
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
  assert.equal(call.url, "https://worker.example/api/internal/v1/runs?trace=1");
  assert.equal(call.headers.get("authorization"), "Bearer internal-token");
  assert.equal(
    call.headers.get("traceparent"),
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(call.headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER), "worker");
  assert.equal(call.body, body);
});

test("OpenTofu run queue consumer rethrows for retry on a non-final attempt", async () => {
  // Async run lifecycle: the consumer loads the run from the in-process
  // deploy-control controller (D1-backed). The fake D1 returns no rows, so the
  // run is not found; on a non-final attempt the consumer rethrows so Cloudflare
  // Queues retries the message. (Happy-path / idempotency / mint behavior is
  // covered against the controller directly in the deploy-control consumer tests.)
  const worker = createCloudflareWorker();
  await assert.rejects(
    worker.queue(
      createQueueBatch({
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "run_queue_1",
        spaceId: "space_test",
      }, { attempts: 1 }),
      createEnv(),
    ),
  );
});

test("OpenTofu run queue consumer acks (no rethrow) on the final attempt", async () => {
  // On the final delivery the consumer must not rethrow (that would redeliver
  // forever); the message is acked and the DLQ consumer is the backstop.
  const worker = createCloudflareWorker();
  let acked = false;
  await worker.queue(
    createQueueBatch({
      kind: "takosumi.opentofu-run@v1",
      action: "plan",
      runId: "run_queue_final",
      spaceId: "space_test",
    }, { attempts: 3, onAck: () => (acked = true) }),
    createEnv(),
  );
  assert.equal(acked, true);
});

test("OpenTofu run DLQ consumer acks dead letters without rethrowing", async () => {
  const worker = createCloudflareWorker();
  let acked = false;
  await worker.queue(
    {
      queue: "takosumi-opentofu-runs-dlq",
      messages: [
        {
          id: "msg_dlq",
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "apply",
            runId: "run_dead",
            spaceId: "space_test",
          },
          ack: () => (acked = true),
        },
      ],
    },
    createEnv(),
  );
  assert.equal(acked, true);
});

test("Cloudflare Worker does not forward the old Deploy Control API paths", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });

  const response = await worker.fetch(
    new Request("https://worker.example/v1/installations/plan-runs", {
      method: "POST",
      body: "{}",
    }),
    createEnv(),
  );

  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test("Cloudflare Worker keeps edge-local routes outside the service app", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });
  const env = createEnv();

  assert.equal(
    (await worker.fetch(new Request("https://worker.example/healthz"), env))
      .status,
    200,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/queue/test", {
          method: "POST",
          body: JSON.stringify({ hello: "queue" }),
        }),
        env,
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/storage/healthz"),
        env,
      )
    ).status,
    200,
  );
  assert.equal(calls.length, 0);

  // Without a configured control-plane token the coordination route is not
  // exposed: it must not accept unauthenticated writes into the DO.
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/coordination/list-alarms", {
          method: "POST",
          body: "{}",
        }),
        env,
      )
    ).status,
    404,
  );
  assert.equal(calls.length, 0);
});

test("Cloudflare Worker requires the operator bearer on /coordination/*", async () => {
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", [])),
  });
  const env = createEnv({ deployControlToken: "operator-secret" });

  // Missing bearer.
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/coordination/list-alarms", {
          method: "POST",
          body: "{}",
        }),
        env,
      )
    ).status,
    401,
  );

  // Wrong bearer.
  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/coordination/list-alarms", {
          method: "POST",
          body: "{}",
          headers: { authorization: "Bearer wrong-secret" },
        }),
        env,
      )
    ).status,
    401,
  );

  // Correct bearer forwards to the coordination Durable Object.
  const ok = await worker.fetch(
    new Request("https://worker.example/coordination/list-alarms", {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer operator-secret" },
    }),
    env,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), {
    coordinationPath: "/list-alarms",
  });
});

test("Cloudflare Worker no longer exposes runtime container routing", async () => {
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", [])),
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
): CreatedCloudflareWorkerApp {
  return {
    app: {
      fetch: async (request: Request) => {
        calls.push(await captureRequest(name, request));
        return Response.json({ app: name }, { status });
      },
    },
  };
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

interface CreateEnvOptions {
  readonly runnerCalls?: CapturedRequest[];
  readonly deployControlToken?: string;
}

function createEnv(options: CreateEnvOptions = {}): CloudflareWorkerEnv {
  const coordination = new FakeNamespace((request) =>
    Response.json({ coordinationPath: new URL(request.url).pathname }),
  );
  const runner = new FakeNamespace(async (request) => {
    options.runnerCalls?.push(await captureRequest("opentofu-runner", request));
    return Response.json({ ok: true, runner: "opentofu" });
  });
  return {
    TAKOS_D1: new FakeD1Database(),
    TAKOS_ARTIFACTS: new FakeR2Bucket(),
    TAKOS_QUEUE: {
      send: () => Promise.resolve(),
    },
    TAKOS_OPENTOFU_RUN_QUEUE: {
      send: () => Promise.resolve(),
    },
    TAKOS_COORDINATION: coordination,
    TAKOS_OPENTOFU_RUNNER: runner,
    ...(options.deployControlToken
      ? { TAKOSUMI_DEPLOY_CONTROL_TOKEN: options.deployControlToken }
      : {}),
  };
}

function createQueueBatch(
  message: OpenTofuRunQueueMessage,
  options: { readonly attempts?: number; readonly onAck?: () => void } = {},
): QueueBatch<OpenTofuRunQueueMessage> {
  return {
    queue: "takosumi-opentofu-runs",
    messages: [
      {
        id: "msg_1",
        body: message,
        ...(options.attempts !== undefined ? { attempts: options.attempts } : {}),
        ...(options.onAck ? { ack: options.onAck } : {}),
      },
    ],
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
