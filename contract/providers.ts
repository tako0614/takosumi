import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import type { ProviderConnectionKind } from "./connections.ts";

export const PROVIDERS_PATH = `${INTERNAL_V1_PREFIX}/providers` as const;
export const PROVIDER_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/providers/${encodeURIComponent(id)}`;

/**
 * Read-only Provider listing, computed at request time from the provider
 * registry (`providers/registry.ts` PROVIDER_RUNTIMES), the built-in Credential
 * Recipes (`recipes/providers/`), and the env-name rules
 * (`contract/provider-env-rules.ts`). There is no stored Provider Catalog: this
 * is the data source the dashboard create-connection picker reads. It is NOT a
 * provider allowlist — arbitrary providers run through a generic-env Provider
 * Connection.
 */
export interface ProviderListing {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly requiredEnvGroups: readonly (readonly string[])[];
  readonly genericEnvSupported: boolean;
  readonly connectionKinds: readonly ProviderConnectionKind[];
  readonly credentialRecipeIds: readonly string[];
  readonly allowedResources: readonly string[];
  readonly allowedDataSources: readonly string[];
  readonly docsUrl?: string;
}

export interface ProviderListingResponse {
  readonly provider: ProviderListing;
}

export interface ListProvidersResponse {
  readonly providers: readonly ProviderListing[];
}
