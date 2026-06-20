import { expect, test } from "bun:test";

import {
  assertRunnerPolicyForRequest,
  assertSourceUrlPolicy,
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
  id: "cloudflare-default",
  allowedProviders: ["cloudflare/cloudflare"],
  requireCredentialRefs: true,
  credentialRefs: [
    {
      provider: "cloudflare/cloudflare",
      ref: "secret://takosumi/cloudflare-default",
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

test("pre-init policy still fails closed when no root-only provider credential was minted", () => {
  expect(() =>
    assertRunnerPolicyForRequest(REQUEST, DEFAULT_STYLE_CLOUDFLARE_PROFILE),
  ).toThrow("required credential env for provider");
});

test("source URL policy rejects git/libcurl backslash parser differentials", () => {
  expect(() =>
    assertSourceUrlPolicy("https://github.com\\@10.0.0.1/acme/repo.git"),
  ).toThrow("source url is malformed");
});
