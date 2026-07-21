/**
 * Accounts OIDC is a same-origin identity-material surface for installed
 * services and operator-managed sign-in flows. Do not present it as a generic
 * public login/consent platform unless a full client registry and consent UX
 * are wired.
 */
export const TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH =
  "/.well-known/openid-configuration";
export const TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH = "/oauth/authorize";
export const TAKOSUMI_ACCOUNTS_TOKEN_PATH = "/oauth/token";
export const TAKOSUMI_ACCOUNTS_JWKS_PATH = "/oauth/jwks";
export const TAKOSUMI_ACCOUNTS_USERINFO_PATH = "/oauth/userinfo";
export const TAKOSUMI_ACCOUNTS_REVOKE_PATH = "/oauth/revoke";
export const TAKOSUMI_ACCOUNTS_INTROSPECT_PATH = "/oauth/introspect";
export const TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH = "/v1/account/tokens";
export const TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH = "/v1/privacy/requests";
export const TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH =
  "/v1/auth/upstream/authorize";
export const TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH =
  "/v1/auth/upstream/callback";
/**
 * Public, unauthenticated read of which sign-in methods the operator has
 * actually configured for this worker. The sign-in screen reads this so it can
 * render only the enabled provider buttons instead of letting a user click a
 * button that the backend would answer with 503 (operator never set the
 * upstream OAuth env vars). It exposes provider ids + enabled flags only — no
 * client ids, secrets, redirect URIs, or any other configuration value.
 */
export const TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH = "/v1/auth/providers";
export const TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH =
  "/v1/auth/passkeys/register/options";
export const TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH =
  "/v1/auth/passkeys/register/complete";
export const TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH =
  "/v1/auth/passkeys/authenticate/options";
export const TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH =
  "/v1/auth/passkeys/authenticate/complete";
export const TAKOSUMI_ACCOUNTS_PAT_SCOPES = ["read", "write", "admin"] as const;

export const TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES = [
  "capsules:read",
  "capsules:write",
] as const;

/**
 * Scopes a Capsule-registered OIDC client must be granted to keep acting on the
 * control plane for the signed-in account after the browser flow ends. A
 * Capsule that only identifies the user needs `openid profile email`; one that
 * delegates Workspace/Capsule operations (the Takos distribution worker) needs
 * this full set, so its `installExperience` must declare it explicitly —
 * `allowedScopes` is a hard cap and authorize answers `invalid_scope` for
 * anything outside it.
 */
export const TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  ...TAKOSUMI_ACCOUNTS_CAPSULE_OAUTH_SCOPES,
] as const;

export type TakosumiAccountsPatScope =
  (typeof TAKOSUMI_ACCOUNTS_PAT_SCOPES)[number];

export interface TakosumiAccountsPatMetadata {
  id: string;
  subject: TakosumiSubject;
  name: string;
  prefix: string;
  scopes: readonly TakosumiAccountsPatScope[];
  workspace_id?: string;
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface TakosumiAccountsCreatePatRequest {
  name: string;
  scopes: readonly TakosumiAccountsPatScope[];
  workspace_id?: string;
  expires_at?: string;
}

export interface TakosumiAccountsCreatePatResponse {
  token: string;
  token_record: TakosumiAccountsPatMetadata;
}

export interface TakosumiAccountsListPatsResponse {
  tokens: readonly TakosumiAccountsPatMetadata[];
  next_cursor: string | null;
}

export interface TakosumiAccountsRevokePatResponse {
  token: TakosumiAccountsPatMetadata;
}

export type TakosumiAccountsPrivacyRequestKind = "export" | "delete";
export type TakosumiAccountsPrivacyRequestStatus =
  | "received"
  | "processing"
  | "exported"
  | "login_disabled"
  | "deleted"
  | "rejected";

export interface TakosumiAccountsPrivacyRequest {
  request_id: string;
  subject: TakosumiSubject;
  kind: TakosumiAccountsPrivacyRequestKind;
  status: TakosumiAccountsPrivacyRequestStatus;
  retention_record_id: string;
  policy_ref: string;
  request_summary?: string;
  export_ref?: string;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TakosumiAccountsCreatePrivacyRequestRequest {
  kind: TakosumiAccountsPrivacyRequestKind;
  request_summary?: string;
}

export interface TakosumiAccountsCompletePrivacyRequestRequest {
  status: Extract<
    TakosumiAccountsPrivacyRequestStatus,
    "exported" | "login_disabled" | "deleted" | "rejected"
  >;
  export_ref?: string;
  request_summary?: string;
}

export interface TakosumiAccountsPrivacyRequestResponse {
  request: TakosumiAccountsPrivacyRequest;
}

export interface TakosumiAccountsListPrivacyRequestsResponse {
  requests: readonly TakosumiAccountsPrivacyRequest[];
}

export function takosumiAccountsAccountTokenRevokePath(
  tokenId: string,
): string {
  return `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}/${pathSegment(
    tokenId,
    "tokenId",
  )}/revoke`;
}

export function takosumiAccountsPrivacyRequestPath(requestId: string): string {
  return `${TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH}/${pathSegment(
    requestId,
    "requestId",
  )}`;
}

export function takosumiAccountsPrivacyRequestCompletePath(
  requestId: string,
): string {
  return `${takosumiAccountsPrivacyRequestPath(requestId)}/complete`;
}

export type TakosumiSubject = `tsub_${string}`;

export interface TakosumiAccountsConfig {
  issuer?: string;
  /** Optional operator-selected documentation URL advertised by discovery. */
  serviceDocumentation?: string;
}

/**
 * A single sign-in method as reported by `GET /v1/auth/providers`. `id` is the
 * upstream provider id (for example `"company-oidc"`) or
 * `"passkey"`; `enabled` reflects whether the operator has configured it on
 * this worker. Current servers always publish `label` and `protocol`, so
 * clients never infer presentation or behavior from a provider id. Never carries client
 * identifiers, credentials, endpoints, or redirect URIs.
 */
export interface TakosumiAccountsAuthProvider {
  readonly id: string;
  readonly enabled: boolean;
  /** Operator-provided, non-secret display label. */
  readonly label: string;
  /** Open protocol token such as `oidc`, `oauth2`, or `webauthn`. */
  readonly protocol: string;
}

/** Body of `GET /v1/auth/providers`. */
export interface TakosumiAccountsAuthProvidersResponse {
  readonly providers: readonly TakosumiAccountsAuthProvider[];
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint: string;
  revocation_endpoint: string;
  introspection_endpoint: string;
  response_types_supported: readonly ["code"];
  response_modes_supported: readonly ["query", "fragment"];
  grant_types_supported: readonly ["authorization_code", "refresh_token"];
  subject_types_supported: readonly ["pairwise"];
  id_token_signing_alg_values_supported: readonly ["ES256"];
  token_endpoint_auth_methods_supported: readonly [
    "client_secret_basic",
    "client_secret_post",
    "none",
  ];
  /** PKCE is mandatory; only the S256 transformation is accepted. */
  code_challenge_methods_supported: readonly ["S256"];
  /** Request object parameters are not supported. */
  request_parameter_supported: false;
  /** Request URI parameters are not supported. */
  request_uri_parameter_supported: false;
  /** Claims parameter is not supported. */
  claims_parameter_supported: false;
  /** Operator-selected link describing this identity surface. */
  service_documentation?: string;
  scopes_supported: readonly string[];
  claims_supported: readonly string[];
}

export interface AccountsJsonWebKey {
  readonly kty: string;
  readonly kid?: string;
  readonly use?: string;
  readonly alg?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly [claim: string]: unknown;
}

export interface JsonWebKeySet {
  keys: readonly AccountsJsonWebKey[];
}

function pathSegment(value: string, name: string): string {
  if (value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return encodeURIComponent(value);
}

export function normalizeIssuer(issuer?: string): string {
  if (issuer === undefined || issuer === "") {
    throw new TypeError(
      "operator-selected issuer required: pass an explicit issuer URL " +
        "(no implicit takosumi default)",
    );
  }
  const parsed = new URL(issuer);
  if (parsed.search || parsed.hash) {
    throw new TypeError(
      "Takosumi Accounts issuer must not include query or fragment components",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/$/, "");
}

export function buildOidcDiscoveryDocument(
  config: TakosumiAccountsConfig = {},
): OidcDiscoveryDocument {
  const issuer = normalizeIssuer(config.issuer);
  return {
    issuer,
    authorization_endpoint: `${issuer}${TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TAKOSUMI_ACCOUNTS_TOKEN_PATH}`,
    jwks_uri: `${issuer}${TAKOSUMI_ACCOUNTS_JWKS_PATH}`,
    userinfo_endpoint: `${issuer}${TAKOSUMI_ACCOUNTS_USERINFO_PATH}`,
    revocation_endpoint: `${issuer}${TAKOSUMI_ACCOUNTS_REVOKE_PATH}`,
    introspection_endpoint: `${issuer}${TAKOSUMI_ACCOUNTS_INTROSPECT_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "fragment"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    subject_types_supported: ["pairwise"],
    id_token_signing_alg_values_supported: ["ES256"],
    token_endpoint_auth_methods_supported: [
      "client_secret_basic",
      "client_secret_post",
      "none",
    ],
    code_challenge_methods_supported: ["S256"],
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    claims_parameter_supported: false,
    ...(config.serviceDocumentation
      ? { service_documentation: config.serviceDocumentation }
      : {}),
    scopes_supported: [...TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name"],
  };
}
