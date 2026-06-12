import { expect, test } from "bun:test";

import { cfProxySigningSecretsFromEnv } from "./bootstrap.ts";

// CFPROXY-DUAL-KEY: the cf-proxy signing key is a DEDICATED secret with two
// accepted keys (primary + rotation), decoupled from the deploy-control bearer.
// These cover the env-sourcing rules that bootstrap threads into the control
// plane (primary -> plan_resolution) and into the edge proxy (accepted set).

test("cfProxySigningSecretsFromEnv: dedicated secret is the primary", () => {
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_CF_PROXY_SIGNING_SECRET: "primary",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "bearer",
    }),
  ).toEqual(["primary"]);
});

test("cfProxySigningSecretsFromEnv: dedicated + previous accepted, primary first", () => {
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_CF_PROXY_SIGNING_SECRET: "primary",
      TAKOSUMI_CF_PROXY_SIGNING_SECRET_PREVIOUS: "previous",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "bearer",
    }),
  ).toEqual(["primary", "previous"]);
});

test("cfProxySigningSecretsFromEnv: missing dedicated secret falls back to the bearer (one release)", () => {
  // The deprecated fallback keeps existing operator configs (bearer only) from
  // hard-breaking on upgrade; the bearer stands in as the primary.
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "bearer",
    }),
  ).toEqual(["bearer"]);
});

test("cfProxySigningSecretsFromEnv: the bearer is NOT mixed into the accepted set once a dedicated secret is set", () => {
  // Decoupling: rotating the bearer must not silently break signatures, and the
  // bearer must not silently keep signing once the operator moved to the
  // dedicated secret.
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_CF_PROXY_SIGNING_SECRET: "primary",
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: "primary",
    }),
  ).toEqual(["primary"]);
});

test("cfProxySigningSecretsFromEnv: duplicate primary/previous collapse; blanks dropped", () => {
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_CF_PROXY_SIGNING_SECRET: " same ",
      TAKOSUMI_CF_PROXY_SIGNING_SECRET_PREVIOUS: "same",
    }),
  ).toEqual(["same"]);
  expect(
    cfProxySigningSecretsFromEnv({
      TAKOSUMI_CF_PROXY_SIGNING_SECRET: "  ",
      TAKOSUMI_CF_PROXY_SIGNING_SECRET_PREVIOUS: "  ",
    }),
  ).toEqual([]);
});

test("cfProxySigningSecretsFromEnv: nothing configured -> empty (proxy disabled, fail closed)", () => {
  expect(cfProxySigningSecretsFromEnv({})).toEqual([]);
});
