/**
 * Guided provider setup metadata.
 *
 * Known providers have optional guided Credential Recipe metadata. This
 * registry is not an execution allowlist: unknown providers use the same
 * OpenTofu runner and generic env/file Provider Connections.
 *
 * This file is the leaf of the dependency graph: it imports only the public
 * contract types, so `core`, `worker`, `rootgen`, and the deploy targets can all
 * depend on the registry without a cycle.
 */
import type {
  ProviderConnection,
  ConnectionScopeHints,
  CreateConnectionFile,
  CreateConnectionRequest,
} from "takosumi-contract/connections";
import type { MintedFile } from "takosumi-contract/sources";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

export interface GuidedProviderSetup {
  /** Stable setup id. */
  readonly id: string;
  readonly displayName: string;
  /** Fully-qualified OpenTofu provider sources covered by this setup helper. */
  readonly providerAddresses: readonly string[];
  /** Credential env names declared by this setup's installed recipe. */
  readonly credentialEnvNames: readonly string[];
}

export interface CredentialRecipeDriverContext {
  readonly connection: ProviderConnection;
  readonly values: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
  readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now: () => Date;
  readonly staticEvidence: () => ProviderCredentialMintEvidence;
}

export interface CredentialRecipeDriverMintResult {
  readonly env: Readonly<Record<string, string>>;
  readonly files?: readonly MintedFile[];
  readonly evidence: ProviderCredentialMintEvidence;
}

/** Runtime driver selected only by the explicit `recipeId/authMode` key. */
export interface CredentialRecipeRuntimeDriver {
  verify?(input: CredentialRecipeDriverContext): Promise<{
    readonly ok: boolean;
    readonly detail?: string;
  }>;
  mint?(
    input: CredentialRecipeDriverContext,
  ): Promise<CredentialRecipeDriverMintResult>;
}

export type CredentialRecipeDriverRegistry = Readonly<
  Record<string, CredentialRecipeRuntimeDriver>
>;

export function credentialRecipeDriverKey(recipe: {
  readonly id: string;
  readonly authMode: string;
}): string {
  return `${recipe.id}/${recipe.authMode}`;
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

export interface ConnectionOAuthTokenResponseInput {
  /** Opaque token endpoint response. Core never interprets vendor fields. */
  readonly tokenResponse: Readonly<Record<string, unknown>>;
  readonly helperId: string;
  readonly clientId: string;
  readonly clientSecret?: string;
}

/**
 * Provider-owned conversion from a vendor token response to the opaque values
 * stored in a normal Provider Connection. This is an internal executable
 * descriptor, not a serialized public DSL: provider-specific token shapes and
 * credential formats must not become branches in Core.
 */
export type ConnectionOAuthTokenResponseMapper = (
  input: ConnectionOAuthTokenResponseInput,
) => Readonly<Record<string, string>>;

/**
 * OAuth setup descriptor owned by a provider package. The core OAuth engine
 * handles state, redirects and token exchange; the provider package owns the
 * vendor response mapping.
 */
export interface ConnectionOAuthDescriptor {
  readonly id: string;
  readonly providerSource: string;
  readonly credentialRecipe: {
    readonly id: string;
    readonly authMode: string;
    readonly secretPartition: string;
  };
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly authorizationParams?: Readonly<Record<string, string>>;
  readonly mapTokenResponse: ConnectionOAuthTokenResponseMapper;
}
