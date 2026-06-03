import { test } from "bun:test";
import assert from "node:assert/strict";
import { deployCommand } from "../commands/deploy.ts";
import { installCommand } from "../commands/install.ts";
import { planCommand } from "../commands/plan.ts";
import { rollbackCommand } from "../commands/rollback.ts";
import {
  expectedGuardFromOptions,
  parseSourceRef,
  resolveSourceArg,
} from "../deploy_control_client.ts";
import { __resetConfigFileCacheForTesting } from "../config.ts";

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

const CLOUDFLARE_PROVIDER = "registry.opentofu.org/cloudflare/cloudflare";

test("deploy control source parser maps supported source refs", () => {
  assert.deepEqual(parseSourceRef("./"), { kind: "local", path: "./" });
  assert.deepEqual(
    parseSourceRef("git:https://github.com/acme/app#main"),
    { kind: "git", url: "https://github.com/acme/app", ref: "main" },
  );
  assert.throws(
    () => parseSourceRef("catalog:com.acme.app@1"),
    /retired/,
  );
  assert.throws(
    () => parseSourceRef("bundle:https://example.com/app.tgz"),
    /retired/,
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
  assert.deepEqual(
    parseSourceRef("git:https://github.com/acme/app"),
    { kind: "git", url: "https://github.com/acme/app" },
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

test("apply expected guard maps canonical OpenTofu guard options", () => {
  assert.deepEqual(
    expectedGuardFromOptions({
      expectedPlanDigest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      expectedSourceCommit: "abc123",
    }),
    {
      planDigest:
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      sourceCommit: "abc123",
    },
  );
});

test("install command creates a PlanRun and ApplyRun", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeService(() =>
      installCommand.parseAsync([
        "--space",
        "space_personal",
        "--source",
        "git:https://github.com/acme/app#main",
        "--remote",
        "https://service.example",
        "--token",
        "deploy-control-token",
        "--provider",
        CLOUDFLARE_PROVIDER,
      ])
    );

    assert.equal(captured.length, 2);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].url, "https://service.example/v1/plan-runs");
    assert.equal(captured[0].authorization, "Bearer deploy-control-token");
    assert.deepEqual(captured[0].body, {
      spaceId: "space_personal",
      source: { kind: "git", url: "https://github.com/acme/app", ref: "main" },
      requiredProviders: [CLOUDFLARE_PROVIDER],
    });
    assert.equal(captured[1].url, "https://service.example/v1/apply-runs");
    assert.deepEqual(captured[1].body, {
      planRunId: "plan_cli",
      expected: fakeExpectedGuard(),
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("plan command creates only a new Installation PlanRun", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeService(() =>
      planCommand.parseAsync([
        "./",
        "--space",
        "space_personal",
        "--remote",
        "https://service.example/",
        "--token",
        "deploy-control-token",
        "--provider",
        CLOUDFLARE_PROVIDER,
      ])
    );

    assert.equal(captured.length, 1);
    assert.equal(captured[0].method, "POST");
    assert.equal(captured[0].url, "https://service.example/v1/plan-runs");
    assert.deepEqual(captured[0].body, {
      spaceId: "space_personal",
      source: { kind: "local", path: "./" },
      requiredProviders: [CLOUDFLARE_PROVIDER],
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("deploy command creates an update PlanRun and ApplyRun", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeService(() =>
      deployCommand.parseAsync([
        "ins_123",
        "--source",
        "git:https://github.com/acme/app#v1.0.0",
        "--expected-source-commit",
        "abc123",
        "--expected-plan-digest",
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "--remote",
        "https://service.example",
        "--token",
        "deploy-control-token",
        "--provider",
        CLOUDFLARE_PROVIDER,
      ])
    );

    assert.equal(captured.length, 3);
    assert.equal(captured[0].url, "https://service.example/v1/installations/ins_123");
    assert.equal(captured[1].url, "https://service.example/v1/plan-runs");
    assert.deepEqual(captured[1].body, {
      installationId: "ins_123",
      operation: "update",
      spaceId: "space_personal",
      source: {
        kind: "git",
        url: "https://github.com/acme/app",
        ref: "v1.0.0",
      },
      requiredProviders: [CLOUDFLARE_PROVIDER],
    });
    assert.equal(captured[2].url, "https://service.example/v1/apply-runs");
    assert.deepEqual(captured[2].body, {
      planRunId: "plan_cli",
      expected: {
        ...fakeExpectedGuard(),
        sourceCommit: "abc123",
        planDigest:
          "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("plan command creates only an update PlanRun", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeService(() =>
      planCommand.parseAsync([
        "--installation",
        "ins_123",
        "--source",
        "./",
        "--remote",
        "https://service.example",
        "--token",
        "deploy-control-token",
        "--provider",
        CLOUDFLARE_PROVIDER,
      ])
    );

    assert.equal(captured.length, 2);
    assert.equal(captured[0].url, "https://service.example/v1/installations/ins_123");
    assert.equal(captured[1].url, "https://service.example/v1/plan-runs");
    assert.deepEqual(captured[1].body, {
      installationId: "ins_123",
      operation: "update",
      spaceId: "space_personal",
      source: { kind: "local", path: "./" },
      requiredProviders: [CLOUDFLARE_PROVIDER],
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

test("rollback command redeploys from a previous Deployment source", async () => {
  const env = snapshotEnv();
  try {
    isolateConfig();
    const captured = await runCommandAgainstFakeService(() =>
      rollbackCommand.parseAsync([
        "ins_123",
        "dep_old",
        "--remote",
        "https://service.example",
        "--token",
        "deploy-control-token",
        "--provider",
        CLOUDFLARE_PROVIDER,
      ])
    );

    assert.equal(captured.length, 4);
    assert.equal(captured[0].url, "https://service.example/v1/installations/ins_123");
    assert.equal(captured[1].url, "https://service.example/v1/installations/ins_123/deployments");
    assert.equal(captured[2].url, "https://service.example/v1/plan-runs");
    assert.deepEqual(captured[2].body, {
      installationId: "ins_123",
      operation: "update",
      spaceId: "space_personal",
      source: { kind: "git", url: "https://github.com/acme/app", ref: "old" },
      requiredProviders: [CLOUDFLARE_PROVIDER],
    });
    assert.equal(captured[3].url, "https://service.example/v1/apply-runs");
    assert.deepEqual(captured[3].body, {
      planRunId: "plan_cli",
      expected: fakeExpectedGuard(),
    });
  } finally {
    restoreEnv(env);
    __resetConfigFileCacheForTesting();
  }
});

async function runCommandAgainstFakeService(
  run: () => Promise<unknown>,
): Promise<readonly CapturedRequest[]> {
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
      new Response(JSON.stringify(fakeServiceBody(url, init?.method ?? "GET")), {
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
  return captured;
}

function fakeServiceBody(url: string, method: string): unknown {
  const path = new URL(url).pathname;
  if (method === "GET" && path === "/v1/installations/ins_123") {
    return {
      installation: {
        id: "ins_123",
        spaceId: "space_personal",
        source: { kind: "git", url: "https://github.com/acme/app", ref: "main" },
      },
    };
  }
  if (
    method === "GET" &&
    path === "/v1/installations/ins_123/deployments"
  ) {
    return {
      deployments: [{
        id: "dep_old",
        source: { kind: "git", url: "https://github.com/acme/app", ref: "old" },
      }],
    };
  }
  if (method === "POST" && path === "/v1/plan-runs") {
    return {
      planRun: {
        id: "plan_cli",
        status: "succeeded",
        runnerProfileId: "cloudflare-default",
        sourceDigest:
          "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        variablesDigest:
          "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        policyDecisionDigest:
          "sha256:3333333333333333333333333333333333333333333333333333333333333333",
        planDigest:
          "sha256:4444444444444444444444444444444444444444444444444444444444444444",
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://plan_cli/tfplan",
          digest:
            "sha256:4444444444444444444444444444444444444444444444444444444444444444",
          contentType: "application/vnd.opentofu.plan",
        },
        sourceCommit: "commit_cli",
        providerLockDigest:
          "sha256:5555555555555555555555555555555555555555555555555555555555555555",
      },
    };
  }
  if (method === "POST" && path === "/v1/apply-runs") {
    return {
      applyRun: {
        id: "apply_cli",
        operation: "update",
        status: "succeeded",
      },
    };
  }
  return { ok: true };
}

function fakeExpectedGuard(): Record<string, string> {
  return {
    planRunId: "plan_cli",
    runnerProfileId: "cloudflare-default",
    sourceDigest:
      "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    variablesDigest:
      "sha256:2222222222222222222222222222222222222222222222222222222222222222",
    policyDecisionDigest:
      "sha256:3333333333333333333333333333333333333333333333333333333333333333",
    planDigest:
      "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    planArtifactDigest:
      "sha256:4444444444444444444444444444444444444444444444444444444444444444",
    sourceCommit: "commit_cli",
    providerLockDigest:
      "sha256:5555555555555555555555555555555555555555555555555555555555555555",
  };
}

function isolateConfig(): void {
  process.env["TAKOSUMI_CONFIG_FILE"] = "/tmp/takosumi-cli-missing-config.yml";
  __resetConfigFileCacheForTesting();
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(
  values: Readonly<Record<string, string | undefined>>,
): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const ENV_KEYS = [
  "TAKOSUMI_CONFIG_FILE",
  "TAKOSUMI_REMOTE_URL",
  "TAKOSUMI_DEPLOY_CONTROL_TOKEN",
] as const;
