import assert from "node:assert/strict";
import type { PlatformContext, ProviderPlugin } from "takosumi-contract";
import {
  createTakosumiProductionProviders,
  type TakosumiProductionProviderOptions,
} from "../src/shape-providers/factories.ts";

const ctx = {} as PlatformContext;

/**
 * Build a fake fetch that records calls and replies with the supplied JSON
 * payloads, looked up by URL pathname suffix. Mirrors the `noSleep`-style
 * lightweight stubbing used by `tests/aws_*_test.ts`.
 */
function fakeFetch(
  routes: Record<string, unknown>,
): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = (input, _init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    calls.push(url);
    const matched = Object.entries(routes).find(([suffix]) =>
      url.endsWith(suffix)
    );
    const body = matched ? JSON.stringify(matched[1]) : JSON.stringify({});
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fetchImpl, calls };
}

Deno.test("createTakosumiProductionProviders({}) returns 0 providers", () => {
  const providers = createTakosumiProductionProviders({});
  assert.equal(providers.length, 0);
});

Deno.test("selfhosted-only opts wires only selfhosted shape-providers (filesystem + minio + docker-compose + systemd-unit + local-docker + coredns-local)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "takosumi-factory-" });
  try {
    const providers = createTakosumiProductionProviders({
      selfhosted: { rootDir: dir },
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
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("all clouds opts returns 18 providers", () => {
  const providers = createTakosumiProductionProviders({
    aws: {
      region: "us-east-1",
      gatewayUrl: "https://aws-gateway.test/",
      bearerToken: "test",
    },
    gcp: {
      project: "test-project",
      region: "us-central1",
      gatewayUrl: "https://gcp-gateway.test/",
      bearerToken: "test",
    },
    cloudflare: {
      accountId: "test-acct",
      apiToken: "test",
      zoneId: "test-zone",
      gatewayUrl: "https://cf-gateway.test/",
    },
    kubernetes: {
      namespace: "takos",
      gatewayUrl: "https://k8s-gateway.test/",
      bearerToken: "test",
    },
    selfhosted: {
      rootDir: "/var/lib/takos/object-store",
    },
  });
  assert.equal(providers.length, 18);
  // every provider claims a takos shape@v1
  for (const provider of providers) {
    assert.ok(
      provider.implements.id.length > 0,
      `${provider.id} has no shape id`,
    );
    assert.equal(provider.implements.version, "v1");
  }
});

Deno.test("aws gateway lifecycle apply hits configured URL and parses descriptor", async () => {
  const { fetch: fakeFetchImpl, calls } = fakeFetch({
    "aws/s3/create-bucket": {
      bucketName: "tenant-artifacts",
      arn: "arn:aws:s3:::tenant-artifacts",
      region: "us-west-2",
      versioningEnabled: true,
      publicAccessBlockEnabled: true,
    },
  });
  const providers = createTakosumiProductionProviders({
    aws: {
      region: "us-west-2",
      gatewayUrl: "https://aws-gateway.test/",
      bearerToken: "test",
      fetch: fakeFetchImpl,
    },
  });
  const s3Provider = providers.find((p) => p.id === "aws-s3") as
    | ProviderPlugin
    | undefined;
  assert.ok(s3Provider, "aws-s3 provider missing");
  const result = await s3Provider!.apply(
    { name: "tenant-artifacts", region: "us-west-2" },
    ctx,
  );
  assert.equal(result.handle, "arn:aws:s3:::tenant-artifacts");
  const outputs = result.outputs as Record<string, unknown>;
  assert.equal(outputs.bucket, "tenant-artifacts");
  assert.equal(outputs.region, "us-west-2");
  assert.ok(
    calls.some((url) => url.endsWith("aws/s3/create-bucket")),
    "expected gateway call to aws/s3/create-bucket",
  );
});

Deno.test("cloudflare gateway lifecycle send api token as bearer", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    const initHeaders = (init as RequestInit | undefined)?.headers;
    const headers = new Headers(initHeaders);
    seen.push({ url, auth: headers.get("authorization") });
    const body = JSON.stringify({
      accountId: "test-acct",
      bucketName: "assets",
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const providers = createTakosumiProductionProviders({
    cloudflare: {
      accountId: "test-acct",
      apiToken: "secret-token",
      gatewayUrl: "https://cf-gateway.test/",
      fetch: fetchImpl,
    },
  });
  const r2 = providers.find((p) => p.id === "cloudflare-r2");
  assert.ok(r2, "cloudflare-r2 provider missing");
  await r2!.apply({ name: "assets" }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.auth, "Bearer secret-token");
  assert.ok(seen[0]?.url.endsWith("cloudflare/r2/create-bucket"));
});

Deno.test("missing gateway url throws when an aws shape-provider is invoked", async () => {
  let threw = false;
  try {
    const providers = createTakosumiProductionProviders({
      aws: { region: "us-east-1" },
    });
    const s3 = providers.find((p) => p.id === "aws-s3");
    await s3!.apply({ name: "x" }, ctx);
  } catch (error) {
    threw = true;
    assert.match(
      String((error as Error).message),
      /aws gatewayUrl is required/,
    );
  }
  assert.ok(threw, "expected aws gatewayUrl-required error");
});

Deno.test("opts include all clouds; provider ids cover the curated 18", () => {
  const opts: TakosumiProductionProviderOptions = {
    aws: { region: "us-east-1", gatewayUrl: "https://aws.test/" },
    gcp: { project: "p", region: "r", gatewayUrl: "https://gcp.test/" },
    cloudflare: { accountId: "a", gatewayUrl: "https://cf.test/" },
    kubernetes: { namespace: "n", gatewayUrl: "https://k.test/" },
    selfhosted: {},
  };
  const providers = createTakosumiProductionProviders(opts);
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, [
    "aws-fargate",
    "aws-rds",
    "aws-s3",
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
  ]);
});
