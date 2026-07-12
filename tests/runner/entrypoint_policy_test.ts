import { expect, test } from "bun:test";

import {
  assertRunnerPolicyForRequest,
  assertSourceUrlPolicy,
  requiredProviderSourcesFromTerraformText,
} from "../../runner/entrypoint.ts";

const REQUEST = {
  planRun: {
    source: {
      kind: "prepared",
      url: "r2://takosumi-source/snap_test",
      digest:
        "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
  },
};

const DEFAULT_STYLE_CLOUDFLARE_PROFILE = {
  id: "opentofu-default",
  allowedProviders: ["cloudflare/cloudflare"],
  requireCredentialRefs: true,
  credentialRefs: [
    {
      provider: "cloudflare/cloudflare",
      ref: "secret://takosumi/opentofu-default",
      required: true,
    },
  ],
};

test("pre-init policy accepts root-only TF_VAR provider credentials", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        credentials: {
          TF_VAR_cloudflare_main_api_token: "run-scoped-token",
        },
      },
      DEFAULT_STYLE_CLOUDFLARE_PROFILE,
    ),
  ).not.toThrow();
});

test("pre-init policy admits credential-free utility providers without utility secrets", () => {
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
          TF_VAR_cloudflare_main_api_token: "run-scoped-token",
        },
      },
      {
        ...DEFAULT_STYLE_CLOUDFLARE_PROFILE,
        allowedProviders: [
          "registry.opentofu.org/cloudflare/cloudflare",
          "registry.opentofu.org/hashicorp/http",
        ],
        credentialRefs: [
          {
            provider: "registry.opentofu.org/cloudflare/cloudflare",
            ref: "secret://takosumi/opentofu-default",
            required: true,
          },
        ],
      },
    ),
  ).not.toThrow();
});

test("pre-init policy still fails closed when no root-only provider credential was minted", () => {
  expect(() =>
    assertRunnerPolicyForRequest(REQUEST, DEFAULT_STYLE_CLOUDFLARE_PROFILE),
  ).toThrow("required credential env for provider");
});

test("pre-init policy allows generated-root runs to use nominal local source anchors", () => {
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        ...REQUEST,
        planRun: {
          ...REQUEST.planRun,
          source: { kind: "local", path: "/resource-shape/generated-root" },
        },
        generatedRoot: {
          files: {
            "main.tf": 'terraform { required_version = ">= 1.6.0" }',
          },
        },
        credentials: {
          TF_VAR_cloudflare_main_api_token: "run-scoped-token",
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
          SNOWFLAKE_PASSWORD: "run-scoped-secret",
        },
      },
      {
        id: "opentofu-default",
        allowedProviders: [provider],
        requireCredentialRefs: true,
        credentialRefs: [
          {
            provider,
            ref: "env://SNOWFLAKE_PASSWORD",
            required: true,
          },
        ],
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

test("pre-init policy ignores runner-reserved declared-env names", () => {
  const provider = "registry.opentofu.org/example/example";
  expect(() =>
    assertRunnerPolicyForRequest(
      {
        planRun: {
          ...REQUEST.planRun,
          requiredProviders: [provider],
        },
        credentials: {
          TAKOSUMI_FORBIDDEN_TOKEN: "override",
        },
      },
      {
        id: "opentofu-default",
        allowedProviders: [provider],
        requireCredentialRefs: true,
        credentialRefs: [
          {
            provider,
            ref: "env://TAKOSUMI_FORBIDDEN_TOKEN",
            required: true,
          },
        ],
      },
    ),
  ).toThrow("required credential env for provider");
});

test("source URL policy rejects git/libcurl backslash parser differentials", () => {
  expect(() =>
    assertSourceUrlPolicy("https://github.com\\@10.0.0.1/acme/repo.git"),
  ).toThrow("source url is malformed");
});
