import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import type { ProviderCredentialOwnership } from "./connections.ts";

export const PROVIDERS_PATH = `${INTERNAL_V1_PREFIX}/providers` as const;
export const PROVIDER_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/providers/${encodeURIComponent(id)}`;

export type ProviderCredentialHelper =
  | "cloudflare_api_token"
  | "cloudflare_oauth"
  | "aws_assume_role"
  | "gcp_oauth_bootstrap"
  | "gcp_service_account_impersonation"
  | "generic_env";

export interface ProviderCatalogEntry {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly helpers: readonly ProviderCredentialHelper[];
  readonly ownershipOptions: readonly ProviderCredentialOwnership[];
  readonly allowedResources: readonly string[];
  readonly allowedDataSources: readonly string[];
  readonly policyPackId: string;
  readonly costEstimatorId?: string;
  readonly docsUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderCatalogEntryResponse {
  readonly provider: ProviderCatalogEntry;
}

export interface ListProviderCatalogEntriesResponse {
  readonly providers: readonly ProviderCatalogEntry[];
}
