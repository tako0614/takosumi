/**
 * Provider-neutral credential driver ports.
 *
 * Core owns credential state, secret opening, phase admission, and audit
 * evidence. A host composition injects the executable drivers selected for its
 * installed Provider Credential Recipes and Source transports. Core never
 * imports a provider registry or a provider implementation.
 */
import type {
  ConnectionScopeHints,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  MintResponse,
  SourceGitConnectionKind,
} from "takosumi-contract/sources";
import type {
  CredentialDriverFetch,
  CredentialRecipeDriverRunContext,
  CredentialRecipeIssuedRunCredential,
  CredentialRecipeRunCredentialRequest,
} from "takosumi-contract/credential-recipe-host";
export {
  credentialRecipeDriverKey,
  type CredentialDriverFetch,
  type CredentialRecipeDriverContext,
  type CredentialRecipeDriverMintResult,
  type CredentialRecipeDriverRegistry,
  type CredentialRecipeDriverRunContext,
  type CredentialRecipeIssuedRunCredential,
  type CredentialRecipeIssueRunCredential,
  type CredentialRecipeRunCredentialRequest,
  type CredentialRecipeRuntimeDriver,
} from "takosumi-contract/credential-recipe-host";

/**
 * Internal signer port installed by the OSS host. Vault supplies the canonical
 * connection and Run; a provider driver never receives this wider callback.
 */
export type CredentialRecipeRunCredentialIssuer = (input: {
  readonly connection: ProviderConnection;
  readonly run: CredentialRecipeDriverRunContext;
  readonly request: {
    readonly audience: string;
    readonly scopes: readonly string[];
    readonly ttlSeconds?: number;
  };
}) => Promise<CredentialRecipeIssuedRunCredential>;

export interface SourceCredentialRegistrationInput {
  readonly kind: SourceGitConnectionKind;
  readonly scopeHints?: ConnectionScopeHints;
  readonly values: Readonly<Record<string, string>>;
}

export type SourceCredentialRegistrationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly detail: string };

export interface SourceCredentialDriverInput {
  readonly connection: ProviderConnection;
  readonly values: Readonly<Record<string, string>>;
  /** Exact Source URL receiving the credential for this one mint. */
  readonly sourceUrl?: string;
  readonly fetch: CredentialDriverFetch;
  readonly now: () => Date;
}

export interface SourceCredentialVerifyResult {
  readonly ok: boolean;
  readonly detail?: string;
}

export type SourceCredentialVerifyDriver = (
  input: SourceCredentialDriverInput,
) => Promise<SourceCredentialVerifyResult>;

/**
 * Trusted Source transport contribution.
 *
 * The driver validates its own opaque settings and credential names, verifies
 * already-opened values, and materializes only runner-bound secret output.
 */
export interface SourceCredentialRuntimeDriver {
  validateRegistration(
    input: SourceCredentialRegistrationInput,
  ): SourceCredentialRegistrationResult;
  verify: SourceCredentialVerifyDriver;
  mint(
    input: SourceCredentialDriverInput,
  ): MintResponse | Promise<MintResponse>;
}

export type SourceCredentialDriverRegistry = Readonly<
  Partial<Record<SourceGitConnectionKind, SourceCredentialRuntimeDriver>>
>;
