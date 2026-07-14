import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  type CloudflareWorkerEnv,
  type CreatedCloudflareWorkerApp,
  createCloudflareWorker,
} from "../../../worker/src/handler.ts";
import type {
  D1Database,
  D1PreparedStatement,
  DurableObjectNamespace,
  OpenTofuRunQueueMessage,
  QueueBatch,
  R2Bucket,
} from "../../../worker/src/bindings.ts";
import { TAKOSUMI_CLOUDFLARE_FRONT_HEADER } from "../../../worker/src/routes.ts";

interface CapturedRequest {
  readonly app: string;
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}

test("Cloudflare Worker dispatches process routes in-process", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });
  const env = createEnv();

  for (const path of [
    "/capabilities",
    "/openapi.json",
    "/livez",
    "/readyz",
    "/metrics",
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

test("Cloudflare Worker keeps generic internal seams edge-closed by default", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });
  const env = createEnv();

  for (const path of [
    "/internal/v1/probe",
    "/internal/v1/runner-profiles",
    "/internal/v1/plan-runs",
    "/internal/v1/unknown",
  ]) {
    calls.length = 0;
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`),
      env,
    );
    assert.equal(response.status, 404, path);
    assert.equal(calls.length, 0, path);
  }
});

test("Cloudflare Worker dispatches internal seams only with local/private opt-in", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls)),
  });
  const env = createEnv({ internalEdgeIngress: true });

  for (const path of [
    "/internal/v1/probe",
    "/internal/v1/runner-profiles",
    "/internal/v1/plan-runs",
    "/internal/v1/plan-runs/plan_abcdef12",
    "/internal/v1/apply-runs",
    "/internal/v1/apply-runs/apply_abcdef12",
    "/internal/v1/capsules/ins_abcdef12",
    "/internal/v1/capsules/ins_abcdef12/state-versions",
    "/internal/v1/capsules/ins_abcdef12/outputs",
    "/internal/v1/capsules/inst_abcdef12",
    "/internal/v1/capsules/inst_abcdef12/state-versions",
    "/internal/v1/capsules/inst_abcdef12/outputs",
  ]) {
    calls.length = 0;
    const response = await worker.fetch(
      new Request(`https://worker.example${path}`),
      env,
    );
    assert.equal(response.status, 200, path);
    assert.equal(calls.length, 1, path);
    assert.equal(calls[0].app, "service", path);
    assert.equal(calls[0].url, `https://worker.example${path}`);
    assert.equal(
      calls[0].headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER),
      "worker",
    );
  }
});

test("Cloudflare Worker preserves method, query, headers, and body", async () => {
  const calls: CapturedRequest[] = [];
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", calls, 202)),
  });
  const body = JSON.stringify({
    workspaceId: "workspace_test",
    audit: { reason: "test" },
  });
  const response = await worker.fetch(
    new Request("https://worker.example/internal/v1/runs?trace=1", {
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
    createEnv({ internalEdgeIngress: true }),
  );

  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://worker.example/internal/v1/runs?trace=1");
  assert.equal(call.headers.get("authorization"), "Bearer internal-token");
  assert.equal(
    call.headers.get("traceparent"),
    "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
  );
  assert.equal(call.headers.get(TAKOSUMI_CLOUDFLARE_FRONT_HEADER), "worker");
  assert.equal(call.body, body);
});

test("OpenTofu run queue consumer schedules a run owner and acks quickly", async () => {
  const worker = createCloudflareWorker();
  const runOwnerCalls: CapturedRequest[] = [];
  const acked: string[] = [];

  await worker.queue(
    createQueueBatch(
      {
        kind: "takosumi.opentofu-run@v1",
        action: "plan",
        runId: "run_queue_1",
        workspaceId: "workspace_test",
      },
      { attempts: 1, onAck: () => acked.push("run") },
    ),
    createEnv({ runOwnerCalls }),
  );

  assert.deepEqual(acked, ["run"]);
  assert.equal(runOwnerCalls.length, 1);
  assert.equal(runOwnerCalls[0].app, "opentofu-run-owner");
  assert.equal(runOwnerCalls[0].method, "POST");
  assert.equal(runOwnerCalls[0].url, "https://opentofu-run-owner/start");
  assert.deepEqual(JSON.parse(runOwnerCalls[0].body), {
    kind: "takosumi.opentofu-run-owner.start@v1",
    action: "plan",
    runId: "run_queue_1",
    workspaceId: "workspace_test",
    queueAttempt: 1,
    messageId: "msg_1",
  });
});

test("OpenTofu run queue consumer acks and continues on the final attempt", async () => {
  // On a final scheduling failure the consumer must not rethrow (that would
  // redeliver forever); the message is acked after the best-effort failed
  // transition and the rest of the batch is still processed.
  const worker = createCloudflareWorker();
  const acked: string[] = [];
  await worker.queue(
    {
      queue: "takosumi-runs",
      messages: [
        {
          id: "msg_final",
          attempts: 3,
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "plan",
            runId: "run_queue_final",
            workspaceId: "workspace_test",
          },
          ack: () => acked.push("final"),
        },
        {
          id: "msg_invalid",
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "bogus",
            runId: "run_queue_invalid",
            workspaceId: "workspace_test",
          },
          ack: () => acked.push("invalid"),
        },
      ],
    },
    createEnv({ internalEdgeIngress: true, runOwnerStatus: 503 }),
  );
  assert.deepEqual(acked, ["final", "invalid"]);
});

test("OpenTofu run queue consumer acks invalid message shapes", async () => {
  const worker = createCloudflareWorker();
  const acked: string[] = [];
  await worker.queue(
    {
      queue: "takosumi-runs",
      messages: [
        {
          id: "msg_invalid_action",
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "bogus",
            runId: "run_queue_invalid",
            workspaceId: "workspace_test",
          },
          ack: () => acked.push("invalid_action"),
        },
        {
          id: "msg_missing_run",
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "plan",
            workspaceId: "workspace_test",
          },
          ack: () => acked.push("missing_run"),
        },
      ],
    },
    createEnv(),
  );
  assert.deepEqual(acked, ["invalid_action", "missing_run"]);
});

test("OpenTofu run queue consumer rejects non-OpenTofu queue batches", async () => {
  const worker = createCloudflareWorker();
  let acked = false;
  await assert.rejects(
    worker.queue(
      {
        queue: "takosumi-control-plane",
        messages: [
          {
            id: "msg_control",
            body: { job: "control-plane-work" },
            ack: () => (acked = true),
          },
        ],
      },
      createEnv(),
    ),
    /non-OpenTofu queue delivered/,
  );
  assert.equal(acked, false);
});

test("OpenTofu run queue consumer rejects non-OpenTofu messages", async () => {
  const worker = createCloudflareWorker();
  let acked = false;
  await assert.rejects(
    worker.queue(
      {
        queue: "takosumi-runs",
        messages: [
          {
            id: "msg_other",
            body: { kind: "takosumi.other-work@v1" },
            ack: () => (acked = true),
          },
        ],
      },
      createEnv(),
    ),
    /non-OpenTofu message delivered/,
  );
  assert.equal(acked, false);
});

test("OpenTofu run DLQ consumer acks dead letters without rethrowing", async () => {
  const worker = createCloudflareWorker();
  let acked = false;
  await worker.queue(
    {
      queue: "takosumi-runs-dlq",
      messages: [
        {
          id: "msg_dlq",
          body: {
            kind: "takosumi.opentofu-run@v1",
            action: "apply",
            runId: "run_dead",
            workspaceId: "workspace_test",
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
    404,
  );
  assert.equal(calls.length, 0);

  assert.equal(
    (
      await worker.fetch(
        new Request("https://worker.example/storage/healthz"),
        env,
      )
    ).status,
    404,
  );
  assert.equal(calls.length, 0);

  // The coordination Durable Object is only reached through the Worker binding
  // used by the embedded service. It must never be exposed as an edge HTTP
  // route or forwarded to the generic deploy-control seam.
  assert.equal(
    (
      await worker.fetch(
        new Request(
          `https://worker.example/internal/v1/${"coordination"}/list-alarms`,
          {
            method: "POST",
            body: "{}",
          },
        ),
        env,
      )
    ).status,
    404,
  );
  assert.equal(calls.length, 0);
});

test("Cloudflare Worker does not expose the coordination Durable Object route", async () => {
  const worker = createCloudflareWorker({
    createServiceApp: () => Promise.resolve(createdApp("service", [])),
  });
  const env = createEnv({ deployControlToken: "operator-secret" });

  const response = await worker.fetch(
    new Request(
      `https://worker.example/internal/v1/${"coordination"}/list-alarms`,
      {
        method: "POST",
        body: "{}",
        headers: { authorization: "Bearer operator-secret" },
      },
    ),
    env,
  );
  assert.equal(response.status, 404);
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
  readonly runOwnerCalls?: CapturedRequest[];
  readonly runOwnerStatus?: number;
  readonly deployControlToken?: string;
  readonly internalEdgeIngress?: boolean;
}

function createEnv(options: CreateEnvOptions = {}): CloudflareWorkerEnv {
  const coordination = new FakeNamespace((request) =>
    Response.json({ coordinationPath: new URL(request.url).pathname }),
  );
  const runner = new FakeNamespace(async (request) => {
    options.runnerCalls?.push(await captureRequest("opentofu-runner", request));
    return Response.json({ ok: true, runner: "opentofu" });
  });
  const runOwner = new FakeNamespace(async (request) => {
    options.runOwnerCalls?.push(
      await captureRequest("opentofu-run-owner", request),
    );
    return Response.json(
      {
        ok:
          options.runOwnerStatus === undefined || options.runOwnerStatus < 400,
      },
      { status: options.runOwnerStatus ?? 202 },
    );
  });
  return {
    TAKOSUMI_CONTROL_DB: new FakeD1Database(),
    R2_ARTIFACTS: new FakeR2Bucket(),
    RUN_QUEUE: {
      send: () => Promise.resolve(),
    },
    COORDINATION: coordination,
    RUN_OWNER: runOwner,
    RUNNER: runner,
    ...(options.deployControlToken
      ? { TAKOSUMI_DEPLOY_CONTROL_TOKEN: options.deployControlToken }
      : {}),
    ...(options.internalEdgeIngress
      ? { TAKOSUMI_EXPOSE_INTERNAL_EDGE: "1" }
      : {}),
  };
}

function createQueueBatch(
  message: OpenTofuRunQueueMessage,
  options: { readonly attempts?: number; readonly onAck?: () => void } = {},
): QueueBatch<OpenTofuRunQueueMessage> {
  return {
    queue: "takosumi-runs",
    messages: [
      {
        id: "msg_1",
        body: message,
        ...(options.attempts !== undefined
          ? { attempts: options.attempts }
          : {}),
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
