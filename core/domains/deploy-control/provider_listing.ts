/**
 * Read-only Provider listing, computed from the provider registry +
 * env-name rules + built-in Credential Recipe ids. There is no stored Provider
 * Catalog: `GET /providers` is served from this projection so the dashboard
 * create-connection picker has a data source. It is NOT a provider allowlist —
 * arbitrary providers run through a generic-env Provider Connection.
 */
import type { ProviderListing } from "takosumi-contract/providers";
import {
  allowedEnvNamesForProvider,
  canonicalProviderSource,
  requiredEnvGroupsForProvider,
} from "takosumi-contract/provider-env-rules";
import { PROVIDER_RUNTIMES } from "@takosumi/providers";

/**
 * Provider id -> built-in Credential Recipe ids (the recipe yaml ids under
 * `recipes/providers/`). Every provider also supports the `generic-env` recipe.
 */
const PROVIDER_RECIPE_IDS: Readonly<Record<string, readonly string[]>> = {
  cloudflare: ["cloudflare"],
  aws: ["aws", "s3-compatible"],
  gcp: ["google"],
  azure: ["azurerm"],
  kubernetes: ["kubernetes", "helm"],
  github: ["github"],
  digitalocean: ["digitalocean"],
  hcloud: ["hcloud"],
  vultr: ["vultr"],
  scaleway: ["scaleway"],
  openstack: ["openstack"],
};

export function computeProviderListings(): readonly ProviderListing[] {
  return PROVIDER_RUNTIMES.map((runtime) => {
    const address = runtime.providerAddresses[0] ?? runtime.id;
    const recipeIds = PROVIDER_RECIPE_IDS[runtime.id] ?? [];
    return {
      id: runtime.id,
      providerSource: canonicalProviderSource(address),
      displayName: runtime.displayName,
      recommendedEnvNames: allowedEnvNamesForProvider(address),
      requiredEnvGroups: requiredEnvGroupsForProvider(address),
      genericEnvSupported: true,
      connectionKinds: runtime.connectionKinds,
      credentialRecipeIds: [...recipeIds, "generic-env"],
      allowedResources: [],
      allowedDataSources: [],
    } satisfies ProviderListing;
  });
}
