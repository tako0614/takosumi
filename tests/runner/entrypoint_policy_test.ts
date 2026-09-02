import { expect, test } from "bun:test";

import {
  assertRunnerPolicyForRequest,
  assertSourceUrlPolicy,
  requiredProviderSourcesFromTerraformText,
} from "../../runner/entrypoint.ts";
import { assertResolvedHostNotBlocked } from "../../runner/lib/policy.ts";

const REQUEST = {
  planRun: {
    source: {
      kind: "git",
      url: "https://git.example.com/example/capsule.git",
      commit: "1111111111111111111111111111111111111111",
    },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  },
};

const DEFAULT_STYLE_CLOUDFLARE_PROFILE = {
  id: "opentofu-default",
  allowedProviders: ["cloudflare/cloudflare"],
  requireProviderBindings: true,
};

const CLOUDFLARE_CREDENTIAL_MANIFEST = {
  bindings: [
    {
      providerSource: "registry.opentofu.org/cloudflare/cloudflare",
      connectionId: "conn_cloudflare",
      recipeId: "cloudflare",
      authMode: "api_token",
      envNames: ["CLOUDFLARE_API_TOKEN"],
      fileEnvNames: [],
      requiredEnvGroups: [["CLOUDFLARE_API_TOKEN"]],
    },
  ],
};

test("pre-init policy accepts CredentialRecipe provider env", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        credentials: {
          env: { CLOUDFLARE_API_TOKEN: "run-scoped-token" },
          manifest: CLOUDFLARE_CREDENTIAL_MANIFEST,
        },
      },
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).not.toThrow();
});

test("pre-init policy admits credential-free providers when the profile does not require refs", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        planRun: {
          ...REQUEST.planRun,
          requiredProviders: [
            "registry.opentofu.org/cloudflare/cloudflare",
            "registry.opentofu.org/hashicorp/http",
          ],
        },
        credentials: {
          env: { CLOUDFLARE_API_TOKEN: "run-scoped-token" },
          manifest: CLOUDFLARE_CREDENTIAL_MANIFEST,
        },
      },
      {
        ...DEFAULT_STYLE_CLOUDFLARE_PROFILE,
        allowedProviders: [
          "registry.opentofu.org/cloudflare/cloudflare",
          "registry.opentofu.org/hashicorp/http",
        ],
        requireProviderBindings: false,
      },
    ),
  ).not.toThrow();
});

test("pre-init policy never widens a default-registry rule to another registry", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        planRun: {
          ...REQUEST.planRun,
          requiredProviders: ["registry.example.com/cloudflare/cloudflare"],
        },
      },
      {
        ...DEFAULT_STYLE_CLOUDFLARE_PROFILE,
        requireProviderBindings: false,
      },
    ),
  ).toThrow(
    "provider registry.example.com/cloudflare/cloudflare is not allowed",
  );
});

test("pre-init policy still fails closed when no provider credential was minted", () => {
  expect(() =>
    assertRunnerPolicyForRequest(REQUEST, DEFAULT_STYLE_CLOUDFLARE_PROFILE),
  ).toThrow("explicit run credential recipe is required for provider");
});

test("pre-init policy allows current Git runs with explicit generated roots", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        planRun: REQUEST.planRun,
        generatedRoot: {
          files: {
            "main.tf": 'terraform { required_version = ">= 1.6.0" }',
          },
        },
        credentials: {
          env: { CLOUDFLARE_API_TOKEN: "run-scoped-token" },
          manifest: CLOUDFLARE_CREDENTIAL_MANIFEST,
        },
      },
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).not.toThrow();
});

test("pre-init policy accepts declared-env provider credentials under real env names", () => {
  const provider = "registry.opentofu.org/snowflake-labs/snowflake";
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        planRun: {
          ...REQUEST.planRun,
          requiredProviders: [provider],
        },
        credentials: {
          env: { SNOWFLAKE_PASSWORD: "run-scoped-secret" },
          manifest: {
            bindings: [
              {
                providerSource: provider,
                connectionId: "conn_snowflake",
                recipeId: "generic-env",
                authMode: "env",
                envNames: ["SNOWFLAKE_PASSWORD"],
                fileEnvNames: [],
                requiredEnvGroups: [["SNOWFLAKE_PASSWORD"]],
              },
            ],
          },
        },
      },
      {
        id: "opentofu-default",
        allowedProviders: [provider],
        requireProviderBindings: true,
      },
    ),
  ).not.toThrow();
});

test("required provider extraction reads only required_providers sources", () => {
  expect(
    requiredProviderSourcesFromTerraformText(`
      module "child" {
        source = "./module"
      }

      terraform {
        required_providers {
          null = {
            source = "hashicorp/null"
            version = "~> 3.2"
          }
          cloudflare = {
            source = "cloudflare/cloudflare"
          }
        }
      }
    `),
  ).toEqual([
    "registry.opentofu.org/cloudflare/cloudflare",
    "registry.opentofu.org/hashicorp/null",
  ]);
});

test("pre-init policy rejects runner-reserved names in the credential manifest", () => {
  const provider = "registry.opentofu.org/example/example";
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        planRun: {
          ...REQUEST.planRun,
          requiredProviders: [provider],
        },
        credentials: {
          env: { TAKOSUMI_FORBIDDEN_TOKEN: "override" },
          manifest: {
            bindings: [
              {
                providerSource: provider,
                connectionId: "conn_example",
                recipeId: "generic-env",
                authMode: "env",
                envNames: ["TAKOSUMI_FORBIDDEN_TOKEN"],
                fileEnvNames: [],
                requiredEnvGroups: [["TAKOSUMI_FORBIDDEN_TOKEN"]],
              },
            ],
          },
        },
      },
      {
        id: "opentofu-default",
        allowedProviders: [provider],
        requireProviderBindings: true,
      },
    ),
  ).toThrow("run credential manifest envNames contains an unsafe env name");
});

test("source URL policy rejects git/libcurl backslash parser differentials", () => {
  expect(() =>
    assertSourceUrlPolicy("https://github.com\\@10.0.0.1/acme/repo.git"),
  ).toThrow("source url is malformed");
});

test("resolved-host policy accepts public addresses through an injected runner resolver", async () => {
  const seen: string[] = [];
  await expect(
    assertResolvedHostNotBlocked(
      "git.example.test",
      "source host",
      async (host) => {
        seen.push(host);
        return ["203.0.113.10", "2001:db8::10"];
      },
    ),
  ).resolves.toBeUndefined();
  expect(seen).toEqual(["git.example.test"]);
});

test("resolved-host policy rejects any private answer and unresolved names", async () => {
  await expect(
    assertResolvedHostNotBlocked(
      "mixed.example.test",
      "source host",
      async () => ["203.0.113.10", "10.0.0.5"],
    ),
  ).rejects.toThrow("resolves to a blocked address (10.0.0.5)");

  await expect(
    assertResolvedHostNotBlocked(
      "missing.example.test",
      "source host",
      async () => [],
    ),
  ).rejects.toThrow("could not be resolved for SSRF validation");
});

test("resolved-host policy rejects internal names before invoking a resolver", async () => {
  let called = false;
  await expect(
    assertResolvedHostNotBlocked(
      "metadata.example.internal",
      "source host",
      async () => {
        called = true;
        return ["203.0.113.10"];
      },
    ),
  ).rejects.toThrow("is an internal-only name");
  expect(called).toBe(false);
});

const RUNTIME_INPUT_VARIABLE = "takosumi_runtime_inputs__takoform";

function runtimeInputRequest(runtimeInputs: unknown, withManifest = true) {
  return {
    ...REQUEST,
    credentials: {
      env: { CLOUDFLARE_API_TOKEN: "run-scoped-token" },
      ...(withManifest ? { manifest: CLOUDFLARE_CREDENTIAL_MANIFEST } : {}),
      runtimeInputs,
    },
  };
}

test("pre-init policy accepts a well-formed run-scoped sensitive input dispatch", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      runtimeInputRequest([
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: ["ENCRYPTION_KEY", "SIGNING_KEY"],
          values: { ENCRYPTION_KEY: "a".repeat(64), SIGNING_KEY: "b".repeat(64) },
        },
      ]),
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).not.toThrow();
});

test("run-scoped sensitive inputs require an explicit run credential manifest", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      runtimeInputRequest(
        [
          {
            variableName: RUNTIME_INPUT_VARIABLE,
            names: ["SIGNING_KEY"],
            values: {},
          },
        ],
        false,
      ),
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).toThrow("explicit run credential manifest");
});

test("pre-init policy mirrors the provider limits on run-scoped sensitive inputs", () => {
  const cases: readonly [unknown, string][] = [
    [
      [
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: ["signing_key"],
          values: {},
        },
      ],
      "names are malformed",
    ],
    [
      [
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: [`A${"B".repeat(64)}`],
          values: {},
        },
      ],
      "names are malformed",
    ],
    [
      [
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: Array.from({ length: 65 }, (_unused, index) => `NAME_${index}`),
          values: {},
        },
      ],
      "names are malformed",
    ],
    [
      [
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: ["SIGNING_KEY"],
          values: { SIGNING_KEY: "x".repeat(32769) },
        },
      ],
      "exceeds 32768 bytes",
    ],
    [
      [
        {
          variableName: RUNTIME_INPUT_VARIABLE,
          names: ["SIGNING_KEY"],
          values: {},
          extra: true,
        },
      ],
      "entry is malformed",
    ],
    [{ variableName: RUNTIME_INPUT_VARIABLE }, "payload is malformed"],
  ];
  for (const [runtimeInputs, message] of cases) {
    expect(() =>
      assertRunnerPolicyForRequest(
        runtimeInputRequest(runtimeInputs),
        DEFAULT_STYLE_CLOUDFLARE_PROFILE,
      ),
    ).toThrow(message);
  }
});

test("pre-init policy refuses a run-scoped sensitive input map larger than the provider accepts", () => {
  const names = Array.from({ length: 40 }, (_unused, index) => `NAME_${index}`)
    .sort();
  const values = Object.fromEntries(
    names.map((name) => [name, "x".repeat(32000)]),
  );
  expect(() =>
    assertRunnerPolicyForRequest(
      runtimeInputRequest([
        { variableName: RUNTIME_INPUT_VARIABLE, names, values },
      ]),
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).toThrow("exceed 1048576 bytes in total");
});
