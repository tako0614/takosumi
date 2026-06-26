import { expect, test } from "bun:test";
import {
  buildPhaseEnv,
  parseBuild,
  parseGeneratedRoot,
  parsePrebuiltArtifact,
  resourceChangesFromPlanJson,
} from "../../../runner/entrypoint.ts";
import { PROVIDER_CREDENTIAL_ENV_RULES } from "takosumi-contract/provider-env-rules";

// The BUILD phase runs untrusted user commands BEFORE the credentialed tofu
// phases. Its env must never carry any known provider credential env name,
// regardless of what is present in the runner's own process env.
test("buildPhaseEnv carries no known credential env name", () => {
  const credentialNames = new Set<string>();
  for (const rule of PROVIDER_CREDENTIAL_ENV_RULES) {
    for (const name of rule.envNames) credentialNames.add(name);
  }

  const polluted = [
    "CLOUDFLARE_API_TOKEN",
    "CF_API_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "GOOGLE_CREDENTIALS",
  ];
  const previous: Record<string, string | undefined> = {};
  for (const name of polluted) {
    previous[name] = Bun.env[name];
    Bun.env[name] = "should-not-leak";
  }
  try {
    const env = buildPhaseEnv();
    for (const name of credentialNames) {
      expect(env[name]).toBeUndefined();
    }
    // Sanity: the build env still carries the non-credential basics so build
    // tooling (bun/git) works.
    expect(typeof env.PATH).toBe("string");
    expect(env.PATH.length).toBeGreaterThan(0);
  } finally {
    for (const name of polluted) {
      const value = previous[name];
      if (value === undefined) delete Bun.env[name];
      else Bun.env[name] = value;
    }
  }
});

test("buildPhaseEnv preserves the baked tofu CLI config pointer", () => {
  const prev = Bun.env.TF_CLI_CONFIG_FILE;
  Bun.env.TF_CLI_CONFIG_FILE = "/opt/opentofu/tofu.rc";
  try {
    // The build phase does not run tofu, but threading TF_CLI_CONFIG_FILE here
    // is harmless and keeps env construction uniform; assert it is NOT a
    // credential and is allowed through.
    const env = buildPhaseEnv();
    expect(env.TF_CLI_CONFIG_FILE).toBe("/opt/opentofu/tofu.rc");
  } finally {
    if (prev === undefined) delete Bun.env.TF_CLI_CONFIG_FILE;
    else Bun.env.TF_CLI_CONFIG_FILE = prev;
  }
});

test("parseGeneratedRoot validates filenames and content", () => {
  expect(parseGeneratedRoot({})).toBeUndefined();
  const ok = parseGeneratedRoot({
    generatedRoot: { files: { "main.tf": "terraform {}" } },
  });
  expect(ok).toEqual({ files: { "main.tf": "terraform {}" } });
  const withModuleFiles = parseGeneratedRoot({
    generatedRoot: {
      files: { "main.tf": 'module "app" {}' },
      moduleFiles: [{ path: "modules/app/main.tf", text: 'output "x" {}' }],
    },
  });
  expect(withModuleFiles).toEqual({
    files: { "main.tf": 'module "app" {}' },
    moduleFiles: [{ path: "modules/app/main.tf", text: 'output "x" {}' }],
  });
  expect(() =>
    parseGeneratedRoot({ generatedRoot: { files: { "../escape.tf": "x" } } }),
  ).toThrow();
  expect(() =>
    parseGeneratedRoot({ generatedRoot: { files: { "sub/main.tf": "x" } } }),
  ).toThrow();
  expect(() => parseGeneratedRoot({ generatedRoot: { files: {} } })).toThrow();
  expect(() =>
    parseGeneratedRoot({ generatedRoot: { files: { "main.tf": 5 } } }),
  ).toThrow();
  expect(() =>
    parseGeneratedRoot({
      generatedRoot: {
        files: { "main.tf": "terraform {}" },
        moduleFiles: [{ path: "../escape.tf", text: "x" }],
      },
    }),
  ).toThrow();
});

test("parseBuild requires bun runtime, commands, and a safe artifactPath", () => {
  expect(parseBuild({})).toBeUndefined();
  const ok = parseBuild({
    build: {
      runtime: "bun",
      commands: ["bun install", "bun run build"],
      artifactPath: "dist/worker.js",
    },
  });
  expect(ok).toEqual({
    runtime: "bun",
    commands: ["bun install", "bun run build"],
    artifactPath: "dist/worker.js",
  });
  expect(() =>
    parseBuild({
      build: { runtime: "node", commands: ["x"], artifactPath: "dist" },
    }),
  ).toThrow();
  expect(() =>
    parseBuild({ build: { runtime: "bun", commands: [], artifactPath: "d" } }),
  ).toThrow();
  expect(() =>
    parseBuild({
      build: { runtime: "bun", commands: ["x"], artifactPath: "/abs" },
    }),
  ).toThrow();
  expect(() =>
    parseBuild({
      build: { runtime: "bun", commands: ["x"], artifactPath: "../escape" },
    }),
  ).toThrow();
});

test("parsePrebuiltArtifact requires a safe source-relative path", () => {
  expect(parsePrebuiltArtifact({})).toBeUndefined();
  expect(
    parsePrebuiltArtifact({
      prebuiltArtifact: { path: "dist/worker.js" },
    }),
  ).toEqual({ path: "dist/worker.js" });
  expect(() =>
    parsePrebuiltArtifact({ prebuiltArtifact: { path: "/abs" } }),
  ).toThrow();
  expect(() =>
    parsePrebuiltArtifact({ prebuiltArtifact: { path: "../escape" } }),
  ).toThrow();
});

test("resourceChangesFromPlanJson trims values and keeps sanitized scope metadata", () => {
  const planJson = JSON.stringify({
    resource_changes: [
      {
        address: "cloudflare_r2_bucket.this",
        type: "cloudflare_r2_bucket",
        name: "this",
        change: {
          actions: ["create"],
          before: null,
          after: {
            account_id: "acct_allowed",
            secret_text: "must-not-leak",
          },
        },
      },
      {
        address: "random_id.suffix",
        type: "random_id",
        change: { actions: ["delete", "create"] },
      },
      // no-op entries are still surfaced verbatim (policy decides meaning).
      {
        address: "random_pet.name",
        type: "random_pet",
        change: { actions: ["no-op"] },
      },
    ],
  });
  expect(resourceChangesFromPlanJson(planJson)).toEqual([
    {
      address: "cloudflare_r2_bucket.this",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
      scope: { cloudflareAccountId: "acct_allowed" },
    },
    {
      address: "random_id.suffix",
      type: "random_id",
      actions: ["delete", "create"],
    },
    { address: "random_pet.name", type: "random_pet", actions: ["no-op"] },
  ]);
  expect(resourceChangesFromPlanJson(JSON.stringify({}))).toEqual([]);
});
