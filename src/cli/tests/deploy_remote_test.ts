import { test } from "bun:test";
import assert from "node:assert/strict";
import { deployCommand } from "../commands/deploy.ts";
import { installCommand } from "../commands/install.ts";
import { rollbackCommand } from "../commands/rollback.ts";
import {
  deploymentExpectedGuardFromOptions,
  parseSourceRef,
  resolveSourceArg,
} from "../installer_client.ts";
import { __resetConfigFileCacheForTesting } from "../config.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

test("installer source parser maps supported source refs", () => {
  assert.deepEqual(parseSourceRef("./"), { kind: "local", url: "./" });
  assert.deepEqual(
    parseSourceRef("git:https://github.com/acme/app#main"),
    { kind: "git", url: "https://github.com/acme/app", ref: "main" },
  );
  assert.throws(
    () => parseSourceRef("catalog:com.acme.app@1"),
    /operator catalog sources/,
  );
  assert.throws(
    () => parseSourceRef("bundle:https://example.com/app.tgz"),
    /operator catalog sources/,
  );
  assert.deepEqual(
    parseSourceRef(
      "prepared:https://example.com/app.tar#sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    ),
    {
      kind: "prepared",
      url: "https://example.com/app.tar",
      digest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
  );
  assert.throws(
    () => parseSourceRef("prepared:https://example.com/app.tar#sha256:abc"),
    /64 lowercase hex/,
  );
  assert.throws(
    () => parseSourceRef("git:https://github.com/acme/app"),
    /git source requires/,
  );
  assert.throws(
    () => parseSourceRef("prepared:https://example.com/app.tar"),
    /prepared source requires/,
  );
  assert.equal(resolveSourceArg({ argument: "./app" }), "./app");
  assert.throws(
    () => resolveSourceArg({ argument: "./a", flag: "./b" }),
    /either as an argument or with --source/,
  );
});

test("deploy expected guard parses null current pointer", () => {
  assert.deepEqual(
    deploymentExpectedGuardFromOptions({
      expectedManifestDigest: "sha256:manifest",
      expectedCurrentDeploymentId: "null",
    }),
    {
      manifestDigest: "sha256:manifest",
      currentDeploymentId: null,
    },
  );
});

test("install command posts source to /v1/installations", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeKernel(() =>
      installCommand.parseAsync([
        "--space",
        "space_personal",
        "--source",
        "git:https://github.com/acme/app#main",
        "--remote",
        "https://kernel.example",
        "--token",
        "installer-token",
      ])
    );

    assert.equal(captured.method, "POST");
    assert.equal(captured.url, "https://kernel.example/v1/installations");
    assert.equal(captured.authorization, "Bearer installer-token");
    assert.deepEqual(captured.body, {
      spaceId: "space_personal",
      source: { kind: "git", url: "https://github.com/acme/app", ref: "main" },
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("install dry-run posts source to /v1/installations/dry-run", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeKernel(() =>
      installCommand.parseAsync([
        "dry-run",
        "--space",
        "space_personal",
        "--source",
        "./",
        "--remote",
        "https://kernel.example/",
        "--token",
        "installer-token",
      ])
    );

    assert.equal(captured.method, "POST");
    assert.equal(
      captured.url,
      "https://kernel.example/v1/installations/dry-run",
    );
    assert.deepEqual(captured.body, {
      spaceId: "space_personal",
      source: { kind: "local", url: "./" },
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("deploy command posts to an installation deployment endpoint", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeKernel(() =>
      deployCommand.parseAsync([
        "ins_123",
        "--source",
        "git:https://github.com/acme/app#v1.0.0",
        "--expected-commit",
        "abc123",
        "--expected-manifest-digest",
        "sha256:manifest",
        "--expected-current-deployment-id",
        "dep_current",
        "--remote",
        "https://kernel.example",
        "--token",
        "installer-token",
      ])
    );

    assert.equal(captured.method, "POST");
    assert.equal(
      captured.url,
      "https://kernel.example/v1/installations/ins_123/deployments",
    );
    assert.deepEqual(captured.body, {
      source: {
        kind: "git",
        url: "https://github.com/acme/app",
        ref: "v1.0.0",
      },
      expected: {
        commit: "abc123",
        manifestDigest: "sha256:manifest",
        currentDeploymentId: "dep_current",
      },
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("deploy dry-run posts to the deployment dry-run endpoint", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeKernel(() =>
      deployCommand.parseAsync([
        "dry-run",
        "ins_123",
        "--source",
        "./",
        "--remote",
        "https://kernel.example",
        "--token",
        "installer-token",
      ])
    );

    assert.equal(captured.method, "POST");
    assert.equal(
      captured.url,
      "https://kernel.example/v1/installations/ins_123/deployments/dry-run",
    );
    assert.deepEqual(captured.body, {
      source: { kind: "local", url: "./" },
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("rollback command posts deploymentId to rollback endpoint", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeKernel(() =>
      rollbackCommand.parseAsync([
        "ins_123",
        "dep_old",
        "--remote",
        "https://kernel.example",
        "--token",
        "installer-token",
      ])
    );

    assert.equal(captured.method, "POST");
    assert.equal(
      captured.url,
      "https://kernel.example/v1/installations/ins_123/rollback",
    );
    assert.deepEqual(captured.body, { deploymentId: "dep_old" });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

async function runCommandAgainstFakeKernel(
  run: () => Promise<unknown>,
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
    const headers = new Headers(init?.headers);
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: parsed,
      authorization: headers.get("authorization"),
    });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  console.log = () => {};
  try {
    await run();
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
  "TAKOSUMI_INSTALLER_TOKEN",
] as const;
