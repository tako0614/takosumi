/**
 * Provider credential resolver contract.
 *
 * ProviderEnv is the internal resolver record used by the runner/vault path.
 * Customer-facing APIs expose Provider Connections. Network rewriting and
 * managed-resource compatibility belong to Takosumi Cloud and are not part of
 * the OSS resolver contract.
 */

import { INTERNAL_V1_PREFIX } from "./api-surface.ts";
import type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderConnectionSet,
  ListProviderConnectionsResponse,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderCredentialOwnership,
} from "./connections.ts";
export { PROVIDER_CREDENTIAL_OWNERSHIPS } from "./connections.ts";

export const PROVIDER_ENVS_PATH =
  `${INTERNAL_V1_PREFIX}/provider-envs` as const;
export const PROVIDER_ENV_PATH = (id: string): string =>
  `${INTERNAL_V1_PREFIX}/provider-envs/${encodeURIComponent(id)}`;

export const PROVIDER_ENV_MATERIALIZATIONS = [
  "oauth",
  "secret",
] as const;

export type ProviderEnvMaterialization =
  (typeof PROVIDER_ENV_MATERIALIZATIONS)[number];

export function isProviderEnvMaterialization(
  value: unknown,
): value is ProviderEnvMaterialization {
  return (
    typeof value === "string" &&
    PROVIDER_ENV_MATERIALIZATIONS.includes(value as ProviderEnvMaterialization)
  );
}

export const PROVIDER_ENV_STATUSES = [
  "ready",
  "needs_setup",
  "expired",
  "blocked",
] as const;

export type ProviderEnvStatus = (typeof PROVIDER_ENV_STATUSES)[number];

export type {
  InstallationProviderConnectionBinding,
  InstallationProviderConnectionBindings,
  InstallationProviderConnectionSet,
  ListProviderConnectionsResponse,
  ProviderConnection,
  ProviderConnectionStatus,
  ProviderCredentialOwnership,
};

export interface ProviderEnv {
  readonly id: string;
  readonly spaceId?: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly materialization: ProviderEnvMaterialization;
  readonly status: ProviderEnvStatus;
  readonly requiredEnvNames: readonly string[];
  readonly secretRef?: string;
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type PublicProviderEnv = Omit<ProviderEnv, "secretRef">;

export interface ProviderEnvResponse {
  readonly providerEnv: PublicProviderEnv;
}

export interface ListProviderEnvsResponse {
  readonly providerEnvs: readonly PublicProviderEnv[];
}

export interface PutProviderEnvRequest {
  readonly spaceId?: string;
  readonly providerSource: string;
  readonly displayName: string;
  readonly materialization: ProviderEnvMaterialization;
  readonly status?: ProviderEnvStatus;
  readonly requiredEnvNames?: readonly string[];
  readonly secretRef?: string;
  readonly expiresAt?: string;
}

/** Internal per-Installation provider resolver binding. */
export interface InstallationProviderEnvBinding {
  readonly provider: string;
  readonly alias?: string;
  readonly envId: string;
  readonly region?: string;
}

export type InstallationProviderEnvBindings =
  readonly InstallationProviderEnvBinding[];

/** One binding set per (installation, environment). */
export interface InstallationProviderEnvBindingSet {
  readonly id: string;
  readonly spaceId: string;
  readonly installationId: string;
  readonly environment: string;
  readonly bindings: InstallationProviderEnvBindings;
  readonly createdAt: string;
  readonly updatedAt: string;
}
