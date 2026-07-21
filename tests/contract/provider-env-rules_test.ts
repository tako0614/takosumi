import { expect, test } from "bun:test";

import {
  canonicalProviderSource,
  isProviderEnvName,
  isReservedProviderEnvName,
  providerMatches,
  sameProviderSource,
} from "../../contract/provider-env-rules.ts";

test("sameProviderSource normalizes only explicit default-registry sources", () => {
  expect(
    sameProviderSource(
      "registry.opentofu.org/snowflake-labs/snowflake",
      "snowflake-labs/snowflake",
    ),
  ).toBe(true);
  expect(sameProviderSource("snowflake", "snowflake-labs/snowflake")).toBe(
    false,
  );
  expect(
    sameProviderSource(
      "registry.terraform.io/hashicorp/random",
      "hashicorp/random",
    ),
  ).toBe(false);
  expect(
    sameProviderSource(
      "providers.example.test/acme/service",
      "registry.opentofu.org/acme/service",
    ),
  ).toBe(false);
});

test("canonicalProviderSource never expands vendor local names", () => {
  expect(canonicalProviderSource("cloudflare")).toBe("cloudflare");
  expect(canonicalProviderSource("gcp")).toBe("gcp");
  expect(canonicalProviderSource("cloudflare/cloudflare")).toBe(
    "registry.opentofu.org/cloudflare/cloudflare",
  );
  expect(canonicalProviderSource("snowflake-labs/snowflake")).toBe(
    "registry.opentofu.org/snowflake-labs/snowflake",
  );
  expect(canonicalProviderSource("providers.example.test/acme/service")).toBe(
    "providers.example.test/acme/service",
  );
});

test("providerMatches does not widen a policy rule through provider tails", () => {
  expect(
    providerMatches("hashicorp/aws", "registry.opentofu.org/hashicorp/aws"),
  ).toBe(true);
  expect(providerMatches("registry.opentofu.org/hashicorp/aws", "aws")).toBe(
    false,
  );
  expect(providerMatches("aws", "registry.opentofu.org/hashicorp/aws")).toBe(
    false,
  );
});

test("provider env name validation admits provider variables but rejects runner-reserved names", () => {
  expect(isProviderEnvName("SNOWFLAKE_PASSWORD")).toBe(true);
  expect(isProviderEnvName("not_uppercase")).toBe(false);
  expect(isReservedProviderEnvName("SNOWFLAKE_PASSWORD")).toBe(false);
  expect(isReservedProviderEnvName("PATH")).toBe(true);
  expect(isReservedProviderEnvName("TAKOSUMI_RUN_ID")).toBe(true);
  expect(isReservedProviderEnvName("OPENTOFU_PROVIDER_MIRROR")).toBe(true);
  expect(isReservedProviderEnvName("TF_VAR_SECRET")).toBe(true);
});

test("provider env name validation rejects git command-execution hooks", () => {
  // `tofu init` spawns git for git::/ssh:// module sources; these names would
  // let a declared provider variable run an arbitrary command in the
  // credentialed plan/apply phase.
  expect(isReservedProviderEnvName("GIT_SSH_COMMAND")).toBe(true);
  expect(isReservedProviderEnvName("GIT_SSH")).toBe(true);
  expect(isReservedProviderEnvName("GIT_PROXY_COMMAND")).toBe(true);
  expect(isReservedProviderEnvName("GIT_EXTERNAL_DIFF")).toBe(true);
  expect(isReservedProviderEnvName("GIT_PAGER")).toBe(true);
  expect(isReservedProviderEnvName("GIT_EDITOR")).toBe(true);
  expect(isReservedProviderEnvName("GIT_SEQUENCE_EDITOR")).toBe(true);
  expect(isReservedProviderEnvName("GIT_ALLOW_PROTOCOL")).toBe(true);
  expect(isReservedProviderEnvName("GIT_CONFIG_COUNT")).toBe(true);
  expect(isReservedProviderEnvName("GIT_CONFIG_KEY_0")).toBe(true);
  expect(isReservedProviderEnvName("GIT_CONFIG_VALUE_0")).toBe(true);
  expect(isReservedProviderEnvName("GIT_CONFIG_GLOBAL")).toBe(true);
  // Runner-owned base command env stays runner-owned.
  expect(isReservedProviderEnvName("GIT_TERMINAL_PROMPT")).toBe(true);
  expect(isReservedProviderEnvName("GIT_SSL_CAINFO")).toBe(true);
  expect(isReservedProviderEnvName("REQUESTS_CA_BUNDLE")).toBe(true);
  // Ordinary provider variables that merely start with GIT are unaffected.
  expect(isReservedProviderEnvName("GITLAB_TOKEN")).toBe(false);
  expect(isReservedProviderEnvName("GITHUB_TOKEN")).toBe(false);
});
