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
  MintedFile,
  MintResponse,
  SourceGitConnectionKind,
} from "takosumi-contract/sources";
import type { ProviderCredentialMintEvidence } from "takosumi-contract/security";

export type CredentialDriverFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface CredentialRecipeDriverContext {
  readonly connection: ProviderConnection;
  readonly values: Readonly<Record<string, string>>;
  readonly files: readonly MintedFile[];
  readonly fetch: CredentialDriverFetch;
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
