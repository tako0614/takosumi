import { expect, test } from "bun:test";

import {
  GUIDED_PROVIDER_SETUPS,
  guidedProviderSetupForAddress,
  guidedProviderSetupForConnectionKind,
} from "../../providers/registry.ts";
import { createDefaultRunnerProfiles } from "../../core/domains/deploy-control/runner_profiles.ts";

test("every guided provider setup record has a unique id and provider address", () => {
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const p of GUIDED_PROVIDER_SETUPS) {
    expect(ids.has(p.id)).toBe(false);
    ids.add(p.id);
    expect(p.providerAddresses.length).toBeGreaterThan(0);
    for (const a of p.providerAddresses) {
      expect(addresses.has(a)).toBe(false);
      addresses.add(a);
    }
  }
});

test("guided setup lookup resolves fully-qualified, short, and local provider forms", () => {
  expect(
    guidedProviderSetupForAddress("registry.opentofu.org/cloudflare/cloudflare")
      ?.id,
  ).toBe("cloudflare");
  expect(guidedProviderSetupForAddress("cloudflare/cloudflare")?.id).toBe(
    "cloudflare",
  );
  expect(guidedProviderSetupForAddress("cloudflare")?.id).toBe("cloudflare");
  expect(guidedProviderSetupForAddress("hashicorp/aws")?.id).toBe("aws");
  expect(guidedProviderSetupForAddress("hashicorp/google-beta")?.id).toBe(
    "gcp",
  );
  expect(guidedProviderSetupForAddress("hetznercloud/hcloud")?.id).toBe(
    "hcloud",
  );
  expect(guidedProviderSetupForAddress("vultr/vultr")?.id).toBe("vultr");
  expect(guidedProviderSetupForAddress("scaleway/scaleway")?.id).toBe(
    "scaleway",
  );
  expect(
    guidedProviderSetupForAddress("terraform-provider-openstack/openstack")?.id,
  ).toBe("openstack");
  expect(guidedProviderSetupForAddress("nonexistent/provider")).toBeUndefined();
});

test("guided setup lookup maps each driver kind to its setup", () => {
  expect(guidedProviderSetupForConnectionKind("cloudflare_api_token")?.id).toBe(
    "cloudflare",
  );
  expect(guidedProviderSetupForConnectionKind("aws_assume_role")?.id).toBe(
    "aws",
  );
  expect(
    guidedProviderSetupForConnectionKind("gcp_service_account_json")?.id,
  ).toBe("gcp");
  expect(
    guidedProviderSetupForConnectionKind("gcp_service_account_impersonation")
      ?.id,
  ).toBe("gcp");
});

test("guided setup metadata does not ship operator-account hosting redirects", () => {
  expect(GUIDED_PROVIDER_SETUPS.some((p) => "hosting" in p)).toBe(false);
});

test("guided setup metadata does not select runner profiles", () => {
  for (const provider of GUIDED_PROVIDER_SETUPS) {
    expect("runnerProfileId" in provider).toBe(false);
    expect("network" in provider).toBe(false);
  }
  expect(createDefaultRunnerProfiles(1)).toHaveLength(1);
  expect(createDefaultRunnerProfiles(1)[0]?.allowedProviders).toEqual(["*"]);
});
