import assert from "node:assert/strict";
import { deployCommand } from "../src/commands/deploy.ts";
import { __resetConfigFileCacheForTesting } from "../src/config.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
}

Deno.test(
  "deploy command posts explicit manifests directly to /v1/deployments in remote mode",
  async () => {
    const manifestPath = await writeManifest();
    const env = snapshotEnv();
    try {
      isolateConfig();
      const captured = await runDeployAgainstFakeKernel([
        manifestPath,
        "--remote",
        "https://kernel.example",
        "--token",
        "deploy-token",
      ]);

      assert.equal(captured.method, "POST");
      assert.equal(captured.url, "https://kernel.example/v1/deployments");
      assert.equal(captured.authorization, "Bearer deploy-token");
      assert.ok(
        captured.idempotencyKey,
        "remote deploy must carry an idempotency key",
      );
      const body = captured.body as Record<string, unknown>;
      assert.equal(body.mode, "apply");
      assert.deepEqual(body.manifest, {
        apiVersion: "1.0",
        kind: "Manifest",
        metadata: { name: "remote-cli-app" },
        resources: [
          {
            shape: "object-store@v1",
            name: "assets",
            provider: "@takos/selfhost-filesystem",
            spec: { name: "assets" },
          },
        ],
      });
    } finally {
      restoreEnv(env);
      __resetConfigFileCacheForTesting();
      await Deno.remove(manifestPath);
    }
  },
);

Deno.test(
  "deploy command normalizes a trailing-slash remote URL",
  async () => {
    const manifestPath = await writeManifest();
    const env = snapshotEnv();
    try {
      isolateConfig();
      const captured = await runDeployAgainstFakeKernel([
        manifestPath,
        "--remote",
        "https://kernel.example/",
        "--token",
        "deploy-token",
      ]);

      assert.equal(captured.url, "https://kernel.example/v1/deployments");
    } finally {
      restoreEnv(env);
      __resetConfigFileCacheForTesting();
      await Deno.remove(manifestPath);
    }
  },
);

Deno.test(
  "deploy command uses the same remote deployment route for dry-run plans",
  async () => {
    const manifestPath = await writeManifest();
    const env = snapshotEnv();
    try {
      isolateConfig();
      const captured = await runDeployAgainstFakeKernel([
        manifestPath,
        "--remote",
        "https://kernel.example",
        "--token",
        "deploy-token",
        "--dry-run",
      ]);

      assert.equal(captured.method, "POST");
      assert.equal(captured.url, "https://kernel.example/v1/deployments");
      const body = captured.body as Record<string, unknown>;
      assert.equal(body.mode, "plan");
      assert.ok(body.manifest && typeof body.manifest === "object");
    } finally {
      restoreEnv(env);
      __resetConfigFileCacheForTesting();
      await Deno.remove(manifestPath);
    }
  },
);

async function runDeployAgainstFakeKernel(
  args: string[],
): Promise<CapturedRequest> {
  const captured: CapturedRequest[] = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    const auth = init?.headers
      ? new Headers(init.headers).get("authorization")
      : null;
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: parsed,
      authorization: auth,
      idempotencyKey: init?.headers
        ? new Headers(init.headers).get("x-idempotency-key")
        : null,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ status: "ok", outcome: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  console.log = () => {};
  try {
    await deployCommand.parse(args);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  if (captured.length !== 1) {
    throw new Error(
      `expected exactly one fetch call, got ${captured.length}`,
    );
  }
  return captured[0];
}

async function writeManifest(): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    path,
    JSON.stringify({
      apiVersion: "1.0",
      kind: "Manifest",
      metadata: { name: "remote-cli-app" },
      resources: [
        {
          shape: "object-store@v1",
          name: "assets",
          provider: "@takos/selfhost-filesystem",
          spec: { name: "assets" },
        },
      ],
    }),
  );
  return path;
}

function isolateConfig(): void {
  Deno.env.set("TAKOSUMI_CONFIG_FILE", "/tmp/takosumi-cli-missing-config.yml");
  __resetConfigFileCacheForTesting();
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, Deno.env.get(key)]));
}

function restoreEnv(
  values: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

const ENV_KEYS = [
  "TAKOSUMI_CONFIG_FILE",
  "TAKOSUMI_REMOTE_URL",
  "TAKOSUMI_KERNEL_URL",
  "TAKOSUMI_DEPLOY_TOKEN",
  "TAKOSUMI_TOKEN",
] as const;
