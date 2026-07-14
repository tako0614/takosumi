import { expect, test } from "bun:test";
import {
  assertNoLegacyArtifactDispatch,
  buildPhaseEnv,
  parseGeneratedRoot,
  parseSourceBuild,
  plannedOutputsFromPlanJson,
  resourceChangesFromPlanJson,
} from "../../../runner/entrypoint.ts";
import { parseOperatorModule } from "../../../runner/lib/parsing.ts";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";

// Credential-free helper commands must never carry known provider credential env
// names, regardless of what is present in the runner's own process env.
test("buildPhaseEnv carries no known credential env name", () => {
  const credentialNames = new Set<string>();
  for (const recipe of REFERENCE_CREDENTIAL_RECIPES) {
    for (const name of recipe.envNames ?? []) credentialNames.add(name);
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
    // Sanity: the helper env still carries non-credential basics so runner
    // utility commands can execute.
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
    // Some credential-free helpers do not run tofu, but threading
    // TF_CLI_CONFIG_FILE here is harmless and keeps env construction uniform;
    // assert it is NOT a
    // credential and is allowed through.
    const env = buildPhaseEnv();
    expect(env.TF_CLI_CONFIG_FILE).toBe("/opt/opentofu/tofu.rc");
  } finally {
    if (prev === undefined) delete Bun.env.TF_CLI_CONFIG_FILE;
    else Bun.env.TF_CLI_CONFIG_FILE = prev;
  }
});

test("generatedRoot contains only wrapper files and operatorModule is separate", () => {
  expect(parseGeneratedRoot({})).toBeUndefined();
  const ok = parseGeneratedRoot({
    generatedRoot: { files: { "main.tf": "terraform {}" } },
  });
  expect(ok).toEqual({ files: { "main.tf": "terraform {}" } });
  expect(() =>
    parseGeneratedRoot({
      generatedRoot: {
        files: { "main.tf": 'module "child" {}' },
        moduleFiles: [{ path: "main.tf", text: 'output "x" {}' }],
      },
    }),
  ).toThrow(/generatedRoot\.moduleFiles is retired/);
  expect(
    parseOperatorModule({
      operatorModule: {
        files: [{ path: "main.tf", text: 'output "x" {}' }],
      },
    }),
  ).toEqual({
    files: [{ path: "main.tf", text: 'output "x" {}' }],
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
    parseOperatorModule({
      operatorModule: {
        files: [{ path: "../escape.tf", text: "x" }],
      },
    }),
  ).toThrow();
});

test("parseSourceBuild accepts argv commands and rejects unsafe paths", () => {
  expect(parseSourceBuild({})).toBeUndefined();
  expect(
    parseSourceBuild({
      sourceBuild: {
        commands: [
          { argv: ["bun", "install", "--frozen-lockfile"] },
          { argv: ["bun", "run", "build"], workingDirectory: "web" },
        ],
        outputs: ["web/dist/index.js"],
      },
    }),
  ).toEqual({
    commands: [
      { argv: ["bun", "install", "--frozen-lockfile"] },
      { argv: ["bun", "run", "build"], workingDirectory: "web" },
    ],
    outputs: ["web/dist/index.js"],
  });
  expect(() =>
    parseSourceBuild({
      sourceBuild: {
        commands: [{ argv: ["bun", "run", "build"], workingDirectory: ".." }],
        outputs: ["dist/index.js"],
      },
    }),
  ).toThrow(/must not escape/);
  expect(() =>
    parseSourceBuild({
      sourceBuild: {
        commands: [{ argv: ["bun", "run", "build"] }],
        outputs: ["../dist/index.js"],
      },
    }),
  ).toThrow(/must not escape/);
  expect(() =>
    parseSourceBuild({
      sourceBuild: {
        commands: [{ argv: [] }],
        outputs: ["dist/index.js"],
      },
    }),
  ).toThrow(/1-32 arguments/);
  expect(() =>
    parseSourceBuild({
      sourceBuild: {
        commands: [{ argv: ["bun", "run", "build"] }],
        outputs: ["."],
      },
    }),
  ).toThrow(/must name a produced path/);
});

test("runner rejects retired app build and prebuilt artifact dispatch", () => {
  expect(() => assertNoLegacyArtifactDispatch({})).not.toThrow();
  expect(() =>
    assertNoLegacyArtifactDispatch({
      build: {
        runtime: "bun",
        commands: ["bun install", "bun run build"],
        artifactPath: "dist/worker.js",
      },
    }),
  ).toThrow(/build dispatch is retired/);
  expect(() =>
    assertNoLegacyArtifactDispatch({
      prebuiltArtifact: { path: "dist/worker.js" },
    }),
  ).toThrow(/prebuiltArtifact dispatch is retired/);
});

test("resourceChangesFromPlanJson projects only policy-selected generic scope facts", () => {
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
        change: { actions: ["no-op"], importing: { id: "redacted" } },
      },
    ],
  });
  expect(
    resourceChangesFromPlanJson(planJson, [
      {
        resourceTypePattern: "cloudflare_*",
        dimensions: { account_id: "/account_id" },
      },
    ]),
  ).toEqual([
    {
      address: "cloudflare_r2_bucket.this",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
      scope: { facts: { account_id: "acct_allowed" } },
    },
    {
      address: "random_id.suffix",
      type: "random_id",
      actions: ["delete", "create"],
    },
    {
      address: "random_pet.name",
      type: "random_pet",
      actions: ["no-op"],
      importing: true,
    },
  ]);
  expect(resourceChangesFromPlanJson(JSON.stringify({}))).toEqual([]);
});

test("scope projection omits sensitive, unknown, non-scalar, and unselected values", () => {
  const changes = resourceChangesFromPlanJson(
    JSON.stringify({
      resource_changes: [
        {
          address: "vendor_service.this",
          type: "vendor_service",
          change: {
            actions: ["create"],
            before: {
              account: "old-account-must-not-be-used",
              pending: "old-region-must-not-be-used",
            },
            after: {
              region: "eu-test-1",
              account: "secret-account",
              pending: "unknown-value",
              labels: { environment: "production" },
              unselected: "must-not-cross-boundary",
            },
            after_sensitive: { account: true },
            after_unknown: { pending: true },
          },
        },
      ],
    }),
    [
      {
        resourceTypePattern: "vendor_*",
        dimensions: {
          region: "/region",
          account: "/account",
          pending: "/pending",
          labels: "/labels",
        },
      },
    ],
  );

  expect(changes).toEqual([
    {
      address: "vendor_service.this",
      type: "vendor_service",
      actions: ["create"],
      scope: { facts: { region: "eu-test-1" } },
    },
  ]);
  expect(JSON.stringify(changes)).not.toContain("must-not-cross-boundary");
  expect(JSON.stringify(changes)).not.toContain("secret-account");
  expect(JSON.stringify(changes)).not.toContain("unknown-value");
  expect(JSON.stringify(changes)).not.toContain("old-account-must-not-be-used");
  expect(JSON.stringify(changes)).not.toContain("old-region-must-not-be-used");
});

test("plannedOutputsFromPlanJson returns only allowlisted known non-sensitive outputs", () => {
  const planJson = JSON.stringify({
    output_changes: {
      runtime_document: {
        after: {
          name: "office",
          compute: {
            web: {
              consume: [{ publication: "storage.object" }],
            },
          },
        },
        after_unknown: false,
        after_sensitive: false,
      },
      unknown: {
        after: { url: "https://unknown.example" },
        after_unknown: { url: true },
        after_sensitive: false,
      },
      secret: {
        after: "must-not-cross-runner-boundary",
        after_unknown: false,
        after_sensitive: true,
      },
      not_requested: {
        after: "hidden",
        after_unknown: false,
        after_sensitive: false,
      },
    },
  });
  expect(
    plannedOutputsFromPlanJson(planJson, {
      runtime_document: { from: "runtime_document" },
      unknown: { from: "unknown" },
      secret: { from: "secret", sensitive: true },
    }),
  ).toEqual({
    runtime_document: {
      sensitive: false,
      value: {
        name: "office",
        compute: {
          web: { consume: [{ publication: "storage.object" }] },
        },
      },
    },
  });
});
