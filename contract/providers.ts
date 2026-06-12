import { INTERNAL_V1_PREFIX } from "./api-surface.ts";

export const PROVIDERS_PATH = `${INTERNAL_V1_PREFIX}/providers` as const;
export const PROVIDER_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/providers/${encodeURIComponent(id)}`;

export type ProviderCredentialSource =
  | "takosumi_managed"
  | "user_env_set";

export type ProviderCredentialHelper =
  | "cloudflare_api_token"
  | "cloudflare_oauth"
  | "aws_assume_role"
  | "gcp_oauth_bootstrap"
  | "gcp_service_account_impersonation"
  | "generic_env";

export interface ProviderTemplate {
  readonly id: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly recommendedEnvNames: readonly string[];
  readonly helpers: readonly ProviderCredentialHelper[];
  readonly credentialSources: readonly ProviderCredentialSource[];
  readonly takosumiManagedAvailable: boolean;
  readonly allowedResources: readonly string[];
  readonly allowedDataSources: readonly string[];
  readonly policyPackId: string;
  readonly costEstimatorId?: string;
  readonly docsUrl?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ProviderTemplateResponse {
  readonly provider: ProviderTemplate;
}

export interface ListProviderTemplatesResponse {
  readonly providers: readonly ProviderTemplate[];
}
