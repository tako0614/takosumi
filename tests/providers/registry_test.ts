import { expect, test } from "bun:test";

import {
  PROVIDER_RUNTIMES,
  gatewayCoverageForProvider,
  providerForAddress,
  providerForConnectionKind,
  supportedGatewayResourceTypesForProvider,
} from "../../providers/registry.ts";
import { createDefaultRunnerProfiles } from "../../core/domains/deploy-control/runner_profiles.ts";

test("every provider runtime has a unique id, runner profile id, and provider address", () => {
  const ids = new Set<string>();
  const profileIds = new Set<string>();
  const addresses = new Set<string>();
  for (const p of PROVIDER_RUNTIMES) {
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
  expect(
    providerForAddress("registry.opentofu.org/cloudflare/cloudflare")?.id,
  ).toBe("cloudflare");
  expect(providerForAddress("cloudflare/cloudflare")?.id).toBe("cloudflare");
  expect(providerForAddress("cloudflare")?.id).toBe("cloudflare");
  expect(providerForAddress("hashicorp/aws")?.id).toBe("aws");
  expect(providerForAddress("hashicorp/google-beta")?.id).toBe("gcp");
  expect(providerForAddress("hetznercloud/hcloud")?.id).toBe("hcloud");
  expect(providerForAddress("vultr/vultr")?.id).toBe("vultr");
  expect(providerForAddress("scaleway/scaleway")?.id).toBe("scaleway");
  expect(providerForAddress("terraform-provider-openstack/openstack")?.id).toBe(
    "openstack",
  );
  expect(providerForAddress("nonexistent/provider")).toBeUndefined();
});

test("providerForConnectionKind maps each driver kind to its provider", () => {
  expect(providerForConnectionKind("cloudflare_api_token")?.id).toBe(
    "cloudflare",
  );
  expect(providerForConnectionKind("aws_assume_role")?.id).toBe("aws");
  expect(providerForConnectionKind("gcp_service_account_json")?.id).toBe("gcp");
  expect(
    providerForConnectionKind("gcp_service_account_impersonation")?.id,
  ).toBe("gcp");
});

test("OSS provider runtime registry does not ship operator-account hosting redirects", () => {
  expect(PROVIDER_RUNTIMES.some((p) => "hosting" in p)).toBe(false);
});

test("OSS provider runtime registry does not advertise gateway coverage", () => {
  expect(gatewayCoverageForProvider("cloudflare")).toEqual([]);
  expect(supportedGatewayResourceTypesForProvider("cloudflare")).toEqual([]);
});

test("each provider's runnerProfileId matches a seeded runner profile, and the profile network policy comes from the registry", () => {
  const profiles = new Map(
    createDefaultRunnerProfiles(1).map((p) => [p.id, p]),
  );
  for (const provider of PROVIDER_RUNTIMES) {
    const profile = profiles.get(provider.runnerProfileId);
    expect(profile).toBeDefined();
    expect(profile!.networkPolicy).toEqual(provider.network);
    expect(profile!.allowedProviders).toEqual(
      expect.arrayContaining([...provider.providerAddresses]),
    );
  }
});
