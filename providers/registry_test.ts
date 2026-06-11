import { expect, test } from "bun:test";

import {
  MANAGED_PROVIDERS,
  providerById,
  providerForAddress,
  providerForConnectionKind,
} from "./registry.ts";
import { createDefaultRunnerProfiles } from "../src/service/domains/deploy-control/runner_profiles.ts";

test("every managed provider has a unique id, runner profile id, and provider address", () => {
  const ids = new Set<string>();
  const profileIds = new Set<string>();
  const addresses = new Set<string>();
  for (const p of MANAGED_PROVIDERS) {
    expect(ids.has(p.id)).toBe(false);
    ids.add(p.id);
    expect(profileIds.has(p.runnerProfileId)).toBe(false);
    profileIds.add(p.runnerProfileId);
    expect(p.providerAddresses.length).toBeGreaterThan(0);
    for (const a of p.providerAddresses) {
      expect(addresses.has(a)).toBe(false);
      addresses.add(a);
    }
  }
});

test("providerForAddress resolves fully-qualified, short, and local provider forms", () => {
  expect(providerForAddress("registry.opentofu.org/cloudflare/cloudflare")?.id).toBe(
    "cloudflare",
  );
  expect(providerForAddress("cloudflare/cloudflare")?.id).toBe("cloudflare");
  expect(providerForAddress("cloudflare")?.id).toBe("cloudflare");
  expect(providerForAddress("hashicorp/aws")?.id).toBe("aws");
  expect(providerForAddress("nonexistent/provider")).toBeUndefined();
});

test("providerForConnectionKind maps each driver kind to its provider", () => {
  expect(providerForConnectionKind("cloudflare_api_token")?.id).toBe("cloudflare");
  expect(providerForConnectionKind("aws_assume_role")?.id).toBe("aws");
  expect(providerForConnectionKind("gcp_service_account_impersonation")?.id).toBe(
    "gcp",
  );
});

test("only cloudflare ships an operator-account hosting redirect (cf-proxy + WfP)", () => {
  const hosting = MANAGED_PROVIDERS.filter((p) => p.hosting);
  expect(hosting.map((p) => p.id)).toEqual(["cloudflare"]);
  expect(providerById("cloudflare")?.hosting?.dispatchNamespace).toBe(
    "takosumi-tenants",
  );
});

test("each provider's runnerProfileId matches a seeded runner profile, and the profile network policy comes from the registry", () => {
  const profiles = new Map(
    createDefaultRunnerProfiles(1).map((p) => [p.id, p]),
  );
  for (const provider of MANAGED_PROVIDERS) {
    const profile = profiles.get(provider.runnerProfileId);
    expect(profile).toBeDefined();
    expect(profile!.networkPolicy).toEqual(provider.network);
    expect(profile!.allowedProviders).toEqual(
      expect.arrayContaining([...provider.providerAddresses]),
    );
  }
});
