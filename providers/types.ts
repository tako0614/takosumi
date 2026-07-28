/**
 * Guided provider setup metadata.
 *
 * Known providers have optional guided Credential Recipe metadata. This
 * registry is not an execution allowlist: unknown providers use the same
 * OpenTofu runner and generic env/file Provider Connections.
 *
 * Provider packages implement the provider-neutral ports owned by Core. Core
 * never imports this provider package; host composition selects the concrete
 * contributions.
 */
import type {
  ConnectionScopeHints,
  CreateConnectionFile,
  CreateConnectionRequest,
} from "takosumi-contract/connections";
export {
  credentialRecipeDriverKey,
  type CredentialRecipeDriverContext,
  type CredentialRecipeDriverMintResult,
  type CredentialRecipeDriverRegistry,
  type CredentialRecipeRuntimeDriver,
  type SourceCredentialDriverRegistry,
  type SourceCredentialRuntimeDriver,
} from "../core/adapters/vault/driver_ports.ts";
export type {
  ConnectionOAuthDescriptor,
  ConnectionOAuthTokenResponseInput,
  ConnectionOAuthTokenResponseMapper,
} from "../core/api/connection_oauth_ports.ts";

export interface GuidedProviderSetup {
  /** Stable setup id. */
  readonly id: string;
  readonly displayName: string;
  /** Fully-qualified OpenTofu provider sources covered by this setup helper. */
  readonly providerAddresses: readonly string[];
  /** Credential env names declared by this setup's installed recipe. */
  readonly credentialEnvNames: readonly string[];
}

/** Provider-neutral input accepted by an explicitly selected guided setup. */
export interface GuidedConnectionInput {
  readonly provider?: string;
  readonly workspaceId?: string;
  readonly displayName?: string;
  readonly scope?: "operator" | "workspace";
  readonly scopeHints?: ConnectionScopeHints;
  readonly expiresAt?: string;
  readonly values: Readonly<Record<string, string>>;
  readonly files?: readonly CreateConnectionFile[];
}

export type GuidedConnectionRequestBuilder = (
  input: GuidedConnectionInput,
) => CreateConnectionRequest;

export class GuidedConnectionSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuidedConnectionSetupError";
  }
}
