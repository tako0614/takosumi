import { expect, test } from "bun:test";

import {
  allowedEnvNamesForProvider,
  cloudFamilyForProvider,
  PROVIDER_CREDENTIAL_ENV_RULES,
  providerEnvRule,
  requiredEnvGroupsForProvider,
  requiredEnvGroupsSatisfied,
} from "./provider-env-rules.ts";

test("providerEnvRule resolves short name and registry-path forms", () => {
  const byShort = providerEnvRule("cloudflare");
  const byPath = providerEnvRule("registry.opentofu.org/cloudflare/cloudflare");
  const byBarePath = providerEnvRule("cloudflare/cloudflare");
  expect(byShort).toBeDefined();
  expect(byShort).toBe(byPath!);
  expect(byShort).toBe(byBarePath!);
  expect(providerEnvRule("unknown-provider")).toBeUndefined();
  expect(providerEnvRule("")).toBeUndefined();
});

test("allowedEnvNamesForProvider returns the sorted env-name set", () => {
  const names = allowedEnvNamesForProvider("cloudflare");
  expect(names).toContain("CLOUDFLARE_API_TOKEN");
  expect(names).toContain("CF_API_TOKEN");
  expect([...names]).toEqual([...names].sort());
  expect(allowedEnvNamesForProvider("unknown")).toEqual([]);
});

test("cloudFamilyForProvider maps providers to partitions, falling back to local-adapters", () => {
  expect(cloudFamilyForProvider("cloudflare")).toBe("cloudflare");
  expect(cloudFamilyForProvider("aws")).toBe("aws");
  expect(cloudFamilyForProvider("google")).toBe("gcp");
  expect(cloudFamilyForProvider("kubernetes")).toBe("k8s");
  expect(cloudFamilyForProvider("github")).toBe("local-adapters");
  expect(cloudFamilyForProvider("totally-unknown")).toBe("local-adapters");
});

test("requiredEnvGroupsSatisfied honors the provider required groups", () => {
  // cloudflare: any one of these single-name groups suffices.
  expect(requiredEnvGroupsSatisfied("cloudflare", ["CLOUDFLARE_API_TOKEN"])).toBe(true);
  expect(requiredEnvGroupsSatisfied("cloudflare", ["CF_API_TOKEN"])).toBe(true);
  // ...but only an account id (no token) is NOT enough.
  expect(requiredEnvGroupsSatisfied("cloudflare", ["CLOUDFLARE_ACCOUNT_ID"])).toBe(false);
  // legacy key+email group must be complete.
  expect(requiredEnvGroupsSatisfied("cloudflare", ["CLOUDFLARE_API_KEY"])).toBe(false);
  expect(
    requiredEnvGroupsSatisfied("cloudflare", ["CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"]),
  ).toBe(true);
  // aws needs both halves of a key pair.
  expect(requiredEnvGroupsSatisfied("aws", ["AWS_ACCESS_KEY_ID"])).toBe(false);
  expect(
    requiredEnvGroupsSatisfied("aws", ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]),
  ).toBe(true);
  // unknown providers are never satisfied.
  expect(requiredEnvGroupsSatisfied("unknown", ["X"])).toBe(false);
});

test("requiredEnvGroupsForProvider exposes the groups for error messaging", () => {
  const groups = requiredEnvGroupsForProvider("cloudflare");
  expect(groups).toContainEqual(["CLOUDFLARE_API_TOKEN"]);
  expect(requiredEnvGroupsForProvider("unknown")).toEqual([]);
});

test("every rule's envNames superset includes all required-group members", () => {
  for (const rule of PROVIDER_CREDENTIAL_ENV_RULES) {
    const allowed = new Set(rule.envNames);
    for (const group of rule.requiredGroups) {
      for (const name of group) {
        expect(allowed.has(name)).toBe(true);
      }
    }
  }
});
