// AUTO-GENERATED FROM spec/contexts/kinds/v1/oidc.jsonld — DO NOT EDIT.
// Run `deno task spec:generate-ts` to refresh.

export interface OidcSpec {
  /** Absolute redirect paths (must start with `/`). */
  readonly redirectPaths: readonly string[];
  /** OIDC / OAuth2 scopes requested (e.g. `openid`, `email`). */
  readonly scopes: readonly string[];
}

export interface OidcOutputs {
  /** Takosumi Accounts issuer URL. */
  readonly OIDC_ISSUER_URL: string;
  /** Installation-scoped client id. */
  readonly OIDC_CLIENT_ID: string;
  /** Installation-scoped client secret (secret-bearing). */
  readonly OIDC_CLIENT_SECRET: string;
  /** Comma-separated full redirect URI list. */
  readonly OIDC_REDIRECT_URIS: string;
}

export type OidcCapability =
  | "authorization-code-pkce"
  | "client-credentials"
  | "refresh-token"
  | "id-token-signing";

export const OIDC_CAPABILITIES: readonly OidcCapability[] = [
  "authorization-code-pkce",
  "client-credentials",
  "refresh-token",
  "id-token-signing",
];

export const OIDC_OUTPUT_FIELDS: readonly string[] = [
  "OIDC_ISSUER_URL",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_REDIRECT_URIS",
];

export const OIDC_KIND_ID = "oidc";
export const OIDC_KIND_VERSION = "v1";
export const OIDC_DESCRIPTION =
  "Per-Installation OIDC client issued by Takosumi Accounts.";
