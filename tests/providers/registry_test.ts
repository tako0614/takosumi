import { expect, test } from "bun:test";

import {
  GUIDED_PROVIDER_SETUPS,
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  REFERENCE_CREDENTIAL_RECIPE_DRIVERS,
  buildGuidedConnectionRequest,
  credentialRecipeDriverKey,
  guidedProviderSetupForAddress,
  installableCredentialRecipes,
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

test("reference composition advertises pre-run modes only with a mint driver", () => {
  for (const recipe of REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes) {
    for (const [authMode, mode] of Object.entries(recipe.authModes)) {
      if (!mode.preRun) continue;
      expect(
        typeof REFERENCE_CREDENTIAL_RECIPE_DRIVERS[
          credentialRecipeDriverKey({ id: recipe.id, authMode })
        ]?.mint,
        `${recipe.id}/${authMode}`,
      ).toBe("function");
    }
  }

  const aws = REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
    (recipe) => recipe.id === "aws",
  );
  const google = REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
    (recipe) => recipe.id === "google",
  );
  expect(aws?.authModes.assume_role).toBeDefined();
  expect(google?.authModes.impersonation).toBeUndefined();
  expect(google?.authModes.oauth).toBeDefined();
  expect(google?.authModes.service_account_file).toBeDefined();
  expect(
    REFERENCE_CREDENTIAL_RECIPE_DRIVERS[
      credentialRecipeDriverKey({
        id: "google",
        authMode: "service_account_file",
      })
    ],
  ).toBeUndefined();
});

test("pre-run filtering is structural and does not encode provider ids", () => {
  const installed = installableCredentialRecipes(
    [
      {
        id: "operator-defined",
        displayName: "Operator-defined",
        terraformSource: "*",
        authModes: {
          static: { env: { TOKEN: { from: "secret" } } },
          implemented_exchange: {
            preRun: { type: "opaque_exchange" },
          },
          missing_exchange: {
            preRun: { type: "another_opaque_exchange" },
          },
        },
      },
    ],
    {
      [credentialRecipeDriverKey({
        id: "operator-defined",
        authMode: "implemented_exchange",
      })]: {
        async mint(input) {
          return {
            env: input.values,
            evidence: input.staticEvidence(),
          };
        },
      },
    },
  );

  expect(Object.keys(installed[0]?.authModes ?? {})).toEqual([
    "static",
    "implemented_exchange",
  ]);
});

test("unimplemented pre-run guided setup is not installed", () => {
  expect(() =>
    buildGuidedConnectionRequest("google-impersonation", {
      workspaceId: "workspace_1",
      values: {},
    }),
  ).toThrow("guided connection setup google-impersonation is not installed");
});
