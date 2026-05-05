import assert from "node:assert/strict";
import {
  formatPlatformOperationIdempotencyKey,
  LIFECYCLE_APPLY_PATH,
  LIFECYCLE_COMPENSATE_PATH,
  LIFECYCLE_DESCRIBE_PATH,
  LIFECYCLE_DESTROY_PATH,
  type PlatformContext,
  type PlatformOperationContext,
  type ProviderPlugin,
} from "takosumi-contract";
import {
  createTakosumiProductionProviders,
  RuntimeAgentLifecycle,
  type TakosumiProductionProviderOptions,
} from "../src/shape-providers/factories.ts";

const ctx = {} as PlatformContext;

function operationContext(
  phase: PlatformOperationContext["phase"],
): PlatformOperationContext {
  const idempotencyKey = {
    spaceId: "space:provider-test",
    operationPlanDigest:
      "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    journalEntryId: `operation:${phase}`,
  } as const;
  return {
    phase,
    walStage: "commit",
    operationId: idempotencyKey.journalEntryId,
    resourceName: phase === "apply" ? "tenant-artifacts" : "api",
    providerId: phase === "apply" ? "@takos/aws-s3" : "@takos/aws-fargate",
    op: phase === "apply" ? "create" : "delete",
    desiredDigest:
      "sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    operationPlanDigest: idempotencyKey.operationPlanDigest,
    idempotencyKey,
    idempotencyKeyString: formatPlatformOperationIdempotencyKey(
      idempotencyKey,
    ),
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

function recordingFetch(
  responder: (path: string, body: unknown) => unknown,
): { fetch: typeof fetch; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const path = new URL(url).pathname;
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    const rawBody = (init as RequestInit | undefined)?.body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : null;
    calls.push({
      url,
      path,
      authorization: headers.get("authorization"),
      body,
    });
    const response = responder(path, body);
    return await Promise.resolve(
      new Response(JSON.stringify(response ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fetchImpl, calls };
}

const ALL_PROVIDER_IDS = [
  "@takos/aws-fargate",
  "@takos/aws-rds",
  "@takos/aws-route53",
  "@takos/aws-s3",
  "@takos/azure-container-apps",
  "@takos/cloudflare-container",
  "@takos/cloudflare-dns",
  "@takos/cloudflare-r2",
  "@takos/cloudflare-workers",
  "@takos/gcp-cloud-dns",
  "@takos/gcp-cloud-run",
  "@takos/gcp-cloud-sql",
  "@takos/gcp-gcs",
  "@takos/kubernetes-deployment",
  "@takos/selfhost-coredns",
  "@takos/selfhost-docker-compose",
  "@takos/selfhost-filesystem",
  "@takos/selfhost-minio",
  "@takos/selfhost-postgres",
  "@takos/selfhost-systemd",
];

Deno.test("default opts returns the full curated set of providers", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
  });
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ALL_PROVIDER_IDS);
});

Deno.test("deno deploy provider is opt-in", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    enableDenoDeploy: true,
  });
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, [...ALL_PROVIDER_IDS, "@takos/deno-deploy"].sort());
});

Deno.test("disabling a cloud strips its providers from the registry", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    enableAws: false,
    enableGcp: false,
    enableAzure: false,
    enableCloudflare: false,
    enableKubernetes: false,
  });
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    "@takos/selfhost-coredns",
    "@takos/selfhost-docker-compose",
    "@takos/selfhost-filesystem",
    "@takos/selfhost-minio",
    "@takos/selfhost-postgres",
    "@takos/selfhost-systemd",
  ]);
});

Deno.test("disabling selfhost leaves only cloud providers", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    enableSelfhost: false,
  });
  const ids = new Set(providers.map((p) => p.id));
  for (
    const sh of [
      "@takos/selfhost-filesystem",
      "@takos/selfhost-minio",
      "@takos/selfhost-docker-compose",
      "@takos/selfhost-systemd",
      "@takos/selfhost-postgres",
      "@takos/selfhost-coredns",
    ]
  ) {
    assert.ok(!ids.has(sh), `${sh} should be disabled`);
  }
});

Deno.test("each provider declares a curated shape@v1 and at least one capability", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
  });
  const allowedShapes = new Set([
    "object-store",
    "web-service",
    "database-postgres",
    "custom-domain",
    "worker",
  ]);
  for (const provider of providers) {
    assert.ok(
      allowedShapes.has(provider.implements.id),
      `${provider.id} declares unknown shape ${provider.implements.id}`,
    );
    assert.equal(provider.implements.version, "v1");
    assert.ok(
      provider.capabilities.length > 0,
      `${provider.id} has no capabilities`,
    );
  }
});

Deno.test("apply posts a lifecycle envelope to the runtime-agent", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch((path) => {
    if (path === LIFECYCLE_APPLY_PATH) {
      return {
        handle: "arn:aws:s3:::tenant-artifacts",
        outputs: {
          bucket: "tenant-artifacts",
          region: "us-west-2",
          endpoint: "https://s3.us-west-2.amazonaws.com/tenant-artifacts",
        },
      };
    }
    return {};
  });
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "secret-token",
    fetch: fetchImpl,
  });
  const s3 = providers.find((p) => p.id === "@takos/aws-s3") as ProviderPlugin;
  assert.ok(s3, "@takos/aws-s3 provider missing");
  const operation = operationContext("apply");
  const result = await s3.apply(
    { name: "tenant-artifacts", region: "us-west-2" },
    { ...ctx, tenantId: "tenant-a", operation },
  );
  assert.equal(result.handle, "arn:aws:s3:::tenant-artifacts");
  const outputs = result.outputs as Record<string, unknown>;
  assert.equal(outputs.bucket, "tenant-artifacts");

  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path, LIFECYCLE_APPLY_PATH);
  assert.equal(call.url, `http://agent.test${LIFECYCLE_APPLY_PATH}`);
  assert.equal(call.authorization, "Bearer secret-token");
  const body = call.body as Record<string, unknown>;
  assert.equal(body.shape, "object-store@v1");
  assert.equal(body.provider, "@takos/aws-s3");
  assert.equal(body.resourceName, "tenant-artifacts");
  assert.equal(body.tenantId, "tenant-a");
  assert.equal(body.idempotencyKey, operation.idempotencyKeyString);
  const operationRequest = body.operationRequest as Record<string, unknown>;
  assert.equal(operationRequest.spaceId, operation.idempotencyKey.spaceId);
  assert.equal(operationRequest.operationId, operation.operationId);
  assert.equal(operationRequest.operationAttempt, 1);
  assert.equal(operationRequest.journalCursor, operation.operationId);
  assert.equal(operationRequest.idempotencyKey, operation.idempotencyKeyString);
  assert.equal(operationRequest.operationKind, "materialize-create");
  assert.equal(operationRequest.recoveryMode, "normal");
  assert.equal(operationRequest.walStage, "commit");
  assert.deepEqual(operationRequest.expectedExternalIdempotencyKeys, [
    operation.idempotencyKeyString,
  ]);
  assert.deepEqual(
    (body.metadata as Record<string, unknown>).takosumiOperation,
    {
      phase: "apply",
      walStage: "commit",
      operationId: operation.operationId,
      resourceName: operation.resourceName,
      providerId: operation.providerId,
      op: "create",
      desiredDigest: operation.desiredDigest,
      operationPlanDigest: operation.operationPlanDigest,
      idempotencyKey: operation.idempotencyKey,
      idempotencyKeyString: operation.idempotencyKeyString,
    },
  );
  assert.deepEqual(
    body.spec,
    { name: "tenant-artifacts", region: "us-west-2" },
  );
});

Deno.test("destroy posts to the destroy path with the resource handle", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() => ({ ok: true }));
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test/",
    token: "t",
    fetch: fetchImpl,
  });
  const fargate = providers.find((p) => p.id === "@takos/aws-fargate")!;
  const operation: PlatformOperationContext = {
    ...operationContext("destroy"),
    recoveryMode: "continue",
  };
  await fargate.destroy(
    "arn:aws:ecs:us-east-1:000000000000:service/takos/api",
    { ...ctx, tenantId: "tenant-a", operation },
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path, LIFECYCLE_DESTROY_PATH);
  const body = call.body as Record<string, unknown>;
  assert.equal(body.shape, "web-service@v1");
  assert.equal(body.provider, "@takos/aws-fargate");
  assert.equal(body.tenantId, "tenant-a");
  assert.equal(body.idempotencyKey, operation.idempotencyKeyString);
  const operationRequest = body.operationRequest as Record<string, unknown>;
  assert.equal(operationRequest.operationKind, "materialize-delete");
  assert.equal(operationRequest.recoveryMode, "continue");
  assert.equal(operationRequest.walStage, "commit");
  assert.equal(
    ((body.metadata as Record<string, unknown>).takosumiOperation as {
      phase?: string;
      op?: string;
    }).phase,
    "destroy",
  );
  assert.equal(
    ((body.metadata as Record<string, unknown>).takosumiOperation as {
      phase?: string;
      op?: string;
    }).op,
    "delete",
  );
  assert.equal(
    body.handle,
    "arn:aws:ecs:us-east-1:000000000000:service/takos/api",
  );
});

Deno.test("compensate posts to the compensate path with the resource handle", async () => {
  const { fetch: fetchImpl, calls } = recordingFetch(() => ({
    ok: true,
    note: "compensated",
  }));
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test/",
    token: "t",
    fetch: fetchImpl,
  });
  const fargate = providers.find((p) => p.id === "@takos/aws-fargate")!;
  const result = await fargate.compensate?.(
    "arn:aws:ecs:us-east-1:000000000000:service/takos/api",
    { ...ctx, tenantId: "tenant-a" },
  );
  assert.deepEqual(result, { ok: true, note: "compensated" });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path, LIFECYCLE_COMPENSATE_PATH);
  const body = call.body as Record<string, unknown>;
  assert.equal(body.shape, "web-service@v1");
  assert.equal(body.provider, "@takos/aws-fargate");
  assert.equal(body.tenantId, "tenant-a");
  assert.equal(
    body.handle,
    "arn:aws:ecs:us-east-1:000000000000:service/takos/api",
  );
});

Deno.test("status posts to the describe path and maps statuses to ResourceStatus", async () => {
  const { fetch: fetchImpl } = recordingFetch((path) => {
    if (path === LIFECYCLE_DESCRIBE_PATH) {
      return {
        status: "running",
        outputs: { fqdn: "api.example.com" },
      };
    }
    return {};
  });
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    fetch: fetchImpl,
  });
  const dns = providers.find((p) => p.id === "@takos/cloudflare-dns")!;
  const status = await dns.status("rec_123", ctx);
  assert.equal(status.kind, "ready");
  assert.deepEqual(status.outputs, { fqdn: "api.example.com" });
});

Deno.test("status maps missing -> deleted", async () => {
  const { fetch: fetchImpl } = recordingFetch(() => ({ status: "missing" }));
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    fetch: fetchImpl,
  });
  const fs = providers.find((p) => p.id === "@takos/selfhost-filesystem")!;
  const status = await fs.status("bucket-1", ctx);
  assert.equal(status.kind, "deleted");
});

Deno.test("status maps error -> failed and forwards note", async () => {
  const { fetch: fetchImpl } = recordingFetch(() => ({
    status: "error",
    note: "rds aborted",
  }));
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
    fetch: fetchImpl,
  });
  const rds = providers.find((p) => p.id === "@takos/aws-rds")!;
  const status = await rds.status("db-1", ctx);
  assert.equal(status.kind, "failed");
  assert.equal(status.reason, "rds aborted");
});

Deno.test("RuntimeAgentLifecycle propagates HTTP error bodies", async () => {
  const fetchImpl: typeof fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
  const lifecycle = new RuntimeAgentLifecycle({
    agentUrl: "http://agent.test",
    token: "t",
    fetch: fetchImpl,
  });
  let threw = false;
  try {
    await lifecycle.apply({
      shape: "object-store@v1",
      provider: "@takos/aws-s3",
      resourceName: "x",
      spec: { name: "x" },
    });
  } catch (error) {
    threw = true;
    assert.match(
      String((error as Error).message),
      /runtime-agent .* failed: 500/,
    );
  }
  assert.ok(threw, "expected RuntimeAgentLifecycle to throw on 500");
});

Deno.test("createTakosumiProductionProviders satisfies the documented options shape", () => {
  const opts: TakosumiProductionProviderOptions = {
    agentUrl: "http://agent",
    token: "t",
    enableAws: true,
    enableGcp: false,
  };
  const providers = createTakosumiProductionProviders(opts);
  assert.ok(providers.length > 0);
});
