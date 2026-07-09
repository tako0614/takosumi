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
/**
 * Base path of the accounts Capsule projection surface.
 *
 * This is a distribution-internal/supporting account-plane projection, not the
 * Takosumi deploy-control Capsule resource served at `/api/v1/capsules`.
 * It exists so installed services can receive identity metadata, billing usage
 * endpoints, export handoff, and service-token projections from the account
 * plane without competing with the public `/api/v1` control API or
 * reintroducing an app-store vocabulary.
 */
const TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTIONS_BASE_PATH =
  "/v1/capsule-projections";
export const TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTION_PLAN_RUNS_PATH = `${TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTIONS_BASE_PATH}/plan-runs`;
export const TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTIONS_PATH =
  TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTIONS_BASE_PATH;
export const TAKOSUMI_ACCOUNTS_CAPSULE_EXPORT_BUNDLE_KIND =
  "takosumi.accounts.capsule-export-bundle@v1";

export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC =
  "takosumi.identity.oidc";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT =
  "takosumi.billing.usage";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP =
  "takosumi.deployment.outputs";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT =
  "takosumi.events.webhook";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_CONTROL_API =
  "takosumi.control.api";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY =
  "takosumi.ai.gateway";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_PROVIDER_COMPAT_CLOUDFLARE_WORKERS =
  "takosumi.provider_compat.cloudflare_workers";

export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC =
  "identity.oidc";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE =
  "billing.usage";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_DEPLOYMENT_OUTPUTS =
  "deployment.outputs";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_EVENTS_WEBHOOK =
  "events.webhook";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_CONTROL_API = "control.api";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_MODEL = "ai.model";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AI_EMBEDDING_MODEL =
  "ai.embedding_model";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_PROTOCOL_MCP_SERVER =
  "protocol.mcp.server";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_STORAGE_FILESYSTEM =
  "storage.filesystem";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_STORAGE_OBJECT =
  "storage.object";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_SOURCE_REPOSITORY =
  "source.repository";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_SOURCE_GIT_SMART_HTTP =
  "source.git.smart_http";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AUTOMATION_AGENT_RUNTIME =
  "automation.agent_runtime";
export const TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_AUTOMATION_TOOL_PROVIDER =
  "automation.tool_provider";

export const TAKOSUMI_ACCOUNTS_PAT_SCOPES = ["read", "write", "admin"] as const;

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
  workspaceId?: string;
  expires_at?: string;
  expiresAt?: string;
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

export function takosumiAccountsCapsulePlanRunsPath(): string {
  return TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTION_PLAN_RUNS_PATH;
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

export function takosumiAccountsCapsulePath(capsuleId: string): string {
  return `${TAKOSUMI_ACCOUNTS_CAPSULE_PROJECTIONS_PATH}/${pathSegment(
    capsuleId,
    "capsuleId",
  )}`;
}

export function takosumiAccountsCapsuleStatusPath(capsuleId: string): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/status`;
}

export function takosumiAccountsCapsuleRevisionsPath(
  capsuleId: string,
): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/revisions`;
}

export function takosumiAccountsCapsuleRevisionPlanRunsPath(
  capsuleId: string,
): string {
  return `${takosumiAccountsCapsuleRevisionsPath(capsuleId)}/plan-runs`;
}

export function takosumiAccountsCapsuleRollbackPath(capsuleId: string): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/rollback`;
}

export function takosumiAccountsCapsuleMaterializePath(
  capsuleId: string,
): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/materialize`;
}

export function takosumiAccountsCapsuleExportPath(capsuleId: string): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/export`;
}

export function takosumiAccountsCapsuleExportOperationPath(
  capsuleId: string,
  operationId: string,
): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/exports/${pathSegment(
    operationId,
    "operationId",
  )}`;
}

export function takosumiAccountsCapsuleExportDownloadPath(
  capsuleId: string,
  operationId: string,
): string {
  return `${takosumiAccountsCapsuleExportOperationPath(
    capsuleId,
    operationId,
  )}/download`;
}

export function takosumiAccountsCapsuleEventsPath(capsuleId: string): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/events`;
}

export function takosumiAccountsCapsuleServiceRotateTokenPath(
  capsuleId: string,
  serviceId: string,
): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/services/${pathSegment(
    serviceId,
    "serviceId",
  )}/rotate-token`;
}

export function takosumiAccountsCapsuleBillingUsageReportsPath(
  capsuleId: string,
): string {
  return `${takosumiAccountsCapsulePath(capsuleId)}/billing/usage-reports`;
}

export type TakosumiSubject = `tsub_${string}`;

export type TakosumiCapsuleProjectionStatus =
  "installing" | "ready" | "failed" | "suspended" | "exported";

export type TakosumiCapsuleProjectionMode =
  "shared-cell" | "dedicated" | "self-hosted";

export interface TakosumiAccountsConfig {
  issuer?: string;
}

/**
 * A single sign-in method as reported by `GET /v1/auth/providers`. `id` is the
 * upstream provider id (`"google"`, a custom OIDC provider id) or
 * `"passkey"`; `enabled` reflects whether the operator has configured it on
 * this worker. Never carries credentials — only the id + flag the sign-in
 * screen needs to enable/disable its button.
 */
export interface TakosumiAccountsAuthProvider {
  readonly id: string;
  readonly enabled: boolean;
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
  /** Link to public docs describing the identity surface. */
  service_documentation: string;
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

/**
 * Deterministic JSON serialization: object keys sorted, arrays preserved,
 * scalars via `JSON.stringify`, `undefined`/missing collapsed to `null`. The
 * account-plane server hashes the same canonical form when it verifies a
 * client-issued permission digest, so this lives in the contract and both
 * sides import it (no drift between client and server encoders).
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** `sha256:<lowercase-hex>` digest of a UTF-8 string. */
export async function sha256HexText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export interface TakosumiAccountsCapsuleMaterializeDigestInput {
  readonly capsuleId: string;
  readonly mode: "dedicated";
  readonly region: string;
  readonly plan: Record<string, unknown>;
  readonly cutover: Record<string, unknown>;
}

/**
 * Canonical `confirm.permissionDigest` for an installation materialize
 * (dedicated-cell promotion). The materialize endpoint recomputes this exact
 * digest and rejects the request unless it byte-matches, so the dashboard and
 * the server must derive it from this single function.
 */
export function takosumiAccountsCapsuleMaterializeDigest(
  input: TakosumiAccountsCapsuleMaterializeDigestInput,
): Promise<string> {
  return sha256HexText(
    canonicalJson({
      operation: "materialize",
      capsuleId: input.capsuleId,
      mode: input.mode,
      region: input.region,
      plan: input.plan,
      cutover: input.cutover,
    }),
  );
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
    service_documentation: "https://takosumi.com/docs/identity",
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name"],
  };
}
