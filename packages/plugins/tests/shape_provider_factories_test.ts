import assert from "node:assert/strict";
import {
  LIFECYCLE_APPLY_PATH,
  LIFECYCLE_DESCRIBE_PATH,
  LIFECYCLE_DESTROY_PATH,
  type PlatformContext,
  type ProviderPlugin,
} from "takosumi-contract";
import {
  createTakosumiProductionProviders,
  RuntimeAgentLifecycle,
  type TakosumiProductionProviderOptions,
} from "../src/shape-providers/factories.ts";

const ctx = {} as PlatformContext;

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
  "aws-fargate",
  "aws-rds",
  "aws-s3",
  "azure-container-apps",
  "cloud-dns",
  "cloud-run",
  "cloud-sql",
  "cloudflare-container",
  "cloudflare-dns",
  "cloudflare-r2",
  "coredns-local",
  "docker-compose",
  "filesystem",
  "gcp-gcs",
  "k3s-deployment",
  "local-docker",
  "minio",
  "route53",
  "systemd-unit",
];

Deno.test("default opts returns the full curated set of providers", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
  });
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ALL_PROVIDER_IDS);
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
    "coredns-local",
    "docker-compose",
    "filesystem",
    "local-docker",
    "minio",
    "systemd-unit",
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
      "filesystem",
      "minio",
      "docker-compose",
      "systemd-unit",
      "local-docker",
      "coredns-local",
    ]
  ) {
    assert.ok(!ids.has(sh), `${sh} should be disabled`);
  }
});

Deno.test("each provider declares a 4-shape@v1 and at least one capability", () => {
  const providers = createTakosumiProductionProviders({
    agentUrl: "http://agent.test",
    token: "t",
  });
  const allowedShapes = new Set([
    "object-store",
    "web-service",
    "database-postgres",
    "custom-domain",
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
  const s3 = providers.find((p) => p.id === "aws-s3") as ProviderPlugin;
  assert.ok(s3, "aws-s3 provider missing");
  const result = await s3.apply(
    { name: "tenant-artifacts", region: "us-west-2" },
    ctx,
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
  assert.equal(body.provider, "aws-s3");
  assert.equal(body.resourceName, "tenant-artifacts");
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
  const fargate = providers.find((p) => p.id === "aws-fargate")!;
  await fargate.destroy(
    "arn:aws:ecs:us-east-1:000000000000:service/takos/api",
    ctx,
  );
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.path, LIFECYCLE_DESTROY_PATH);
  const body = call.body as Record<string, unknown>;
  assert.equal(body.shape, "web-service@v1");
  assert.equal(body.provider, "aws-fargate");
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
  const dns = providers.find((p) => p.id === "cloudflare-dns")!;
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
  const fs = providers.find((p) => p.id === "filesystem")!;
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
  const rds = providers.find((p) => p.id === "aws-rds")!;
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
      provider: "aws-s3",
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
