export const TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH =
  "/.well-known/openid-configuration";
export const TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH = "/oauth/authorize";
export const TAKOSUMI_ACCOUNTS_TOKEN_PATH = "/oauth/token";
export const TAKOSUMI_ACCOUNTS_JWKS_PATH = "/oauth/jwks";
export const TAKOSUMI_ACCOUNTS_USERINFO_PATH = "/oauth/userinfo";
export const TAKOSUMI_ACCOUNTS_REVOKE_PATH = "/oauth/revoke";
export const TAKOSUMI_ACCOUNTS_INTROSPECT_PATH = "/oauth/introspect";
export const TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH = "/v1/account/tokens";
export const TAKOSUMI_ACCOUNTS_STRIPE_CHECKOUT_PATH =
  "/v1/billing/stripe/checkout";
export const TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_PATH =
  "/v1/billing/stripe/webhook";
export const TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH =
  "/v1/auth/upstream/authorize";
export const TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH =
  "/v1/auth/upstream/callback";
export const TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH =
  "/v1/auth/passkeys/register/options";
export const TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH =
  "/v1/auth/passkeys/register/complete";
export const TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH =
  "/v1/auth/passkeys/authenticate/options";
export const TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH =
  "/v1/auth/passkeys/authenticate/complete";
export const TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH =
  "/v1/installations/plan-runs";
export const TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH = "/v1/installations";
export const TAKOSUMI_ACCOUNTS_INSTALLATIONS_IMPORT_PATH =
  "/v1/installations/import";
export const TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICES_PATH =
  "/v1/workload-services";
export const TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND =
  "takosumi.accounts.installation-export-bundle@v1";

export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC =
  "identity.primary.oidc";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT =
  "billing.primary.default";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP =
  "deployment.outputs.http";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT =
  "events.webhook.default";
export const TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE =
  "takosumi.control.space";

export const TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1 =
  "identity.oidc@v1";
export const TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1 =
  "billing.port@v1";
export const TAKOSUMI_ACCOUNTS_MATERIAL_DEPLOYMENT_OUTPUTS_HTTP_V1 =
  "deployment.outputs.http@v1";
export const TAKOSUMI_ACCOUNTS_MATERIAL_EVENTS_WEBHOOK_V1 =
  "events.webhook@v1";
export const TAKOSUMI_ACCOUNTS_MATERIAL_TAKOSUMI_CONTROL_V1 =
  "takosumi.control@v1";

export const TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICE_IDS = [
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_DEPLOYMENT_OUTPUTS_HTTP,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_EVENTS_WEBHOOK_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_TAKOSUMI_CONTROL_SPACE,
] as const;

export type TakosumiAccountsWorkloadServiceId =
  typeof TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICE_IDS[number];

export type TakosumiAccountsWorkloadServiceStatus =
  | "ready"
  | "not_configured"
  | "unavailable";

export interface TakosumiAccountsWorkloadServiceDescriptor {
  readonly id: TakosumiAccountsWorkloadServiceId;
  readonly material_kind: string;
  readonly title: string;
  readonly description: string;
  readonly secret_backed: boolean;
}

export interface TakosumiAccountsWorkloadServiceProjection {
  readonly id: TakosumiAccountsWorkloadServiceId;
  readonly material_kind: string;
  readonly status: TakosumiAccountsWorkloadServiceStatus;
  readonly endpoint?: string;
  readonly material?: Record<string, unknown>;
  readonly secret_ref?: string;
  readonly token_expires_at?: string;
  readonly rotate_token_url?: string;
}

export interface TakosumiAccountsListWorkloadServicesResponse {
  readonly services: readonly TakosumiAccountsWorkloadServiceDescriptor[];
}

export interface TakosumiAccountsListInstallationServicesResponse {
  readonly installation_id: string;
  readonly services: readonly TakosumiAccountsWorkloadServiceProjection[];
}

export interface TakosumiAccountsRotateInstallationServiceTokenResponse {
  readonly token: string;
  readonly token_type: "Bearer";
  readonly expires_at: string;
  readonly service: TakosumiAccountsWorkloadServiceProjection;
}

export const TAKOSUMI_ACCOUNTS_PAT_SCOPES = [
  "read",
  "write",
  "admin",
] as const;

export type TakosumiAccountsPatScope =
  typeof TAKOSUMI_ACCOUNTS_PAT_SCOPES[number];

export interface TakosumiAccountsPatMetadata {
  id: string;
  subject: TakosumiSubject;
  name: string;
  prefix: string;
  scopes: readonly TakosumiAccountsPatScope[];
  created_at: string;
  expires_at?: string;
  revoked_at?: string;
  last_used_at?: string;
}

export interface TakosumiAccountsCreatePatRequest {
  name: string;
  scopes: readonly TakosumiAccountsPatScope[];
  expires_at?: string;
  expiresAt?: string;
}

export interface TakosumiAccountsCreatePatResponse {
  token: string;
  token_record: TakosumiAccountsPatMetadata;
}

export interface TakosumiAccountsListPatsResponse {
  tokens: readonly TakosumiAccountsPatMetadata[];
}

export interface TakosumiAccountsRevokePatResponse {
  token: TakosumiAccountsPatMetadata;
}

export function takosumiAccountsInstallationPlanRunsPath(): string {
  return TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH;
}

export function takosumiAccountsAccountTokenRevokePath(
  tokenId: string,
): string {
  return `${TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH}/${
    pathSegment(tokenId, "tokenId")
  }/revoke`;
}

export function takosumiAccountsInstallationPath(
  installationId: string,
): string {
  return `${TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH}/${
    pathSegment(installationId, "installationId")
  }`;
}

export function takosumiAccountsInstallationsImportPath(): string {
  return TAKOSUMI_ACCOUNTS_INSTALLATIONS_IMPORT_PATH;
}

export function takosumiAccountsWorkloadServicesPath(): string {
  return TAKOSUMI_ACCOUNTS_WORKLOAD_SERVICES_PATH;
}

export function takosumiAccountsInstallationStatusPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/status`;
}

export function takosumiAccountsInstallationDeploymentsPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/deployments`;
}

export function takosumiAccountsInstallationDeploymentPlanRunsPath(
  installationId: string,
): string {
  return `${
   takosumiAccountsInstallationDeploymentsPath(installationId)
  }/plan-runs`;
}

export function takosumiAccountsInstallationRollbackPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/rollback`;
}

export function takosumiAccountsInstallationMaterializePath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/materialize`;
}

export function takosumiAccountsInstallationExportPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/export`;
}

export function takosumiAccountsInstallationExportOperationPath(
  installationId: string,
  operationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/exports/${
    pathSegment(operationId, "operationId")
  }`;
}

export function takosumiAccountsInstallationExportDownloadPath(
  installationId: string,
  operationId: string,
): string {
  return `${
   takosumiAccountsInstallationExportOperationPath(
      installationId,
      operationId,
    )
  }/download`;
}

export function takosumiAccountsInstallationEventsPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/events`;
}

export function takosumiAccountsInstallationEventsIngestPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationEventsPath(installationId)}/ingest`;
}

export function takosumiAccountsInstallationServicesPath(
  installationId: string,
): string {
  return `${takosumiAccountsInstallationPath(installationId)}/services`;
}

export function takosumiAccountsInstallationServiceRotateTokenPath(
  installationId: string,
  serviceId: string,
): string {
  return `${takosumiAccountsInstallationServicesPath(installationId)}/${
    pathSegment(serviceId, "serviceId")
  }/rotate-token`;
}

export function takosumiAccountsInstallationBillingUsageReportsPath(
  installationId: string,
): string {
  return `${
   takosumiAccountsInstallationPath(installationId)
  }/billing/usage-reports`;
}

export type TakosumiSubject = `tsub_${string}`;

export type TakosumiAppInstallationStatus =
  | "installing"
  | "ready"
  | "failed"
  | "suspended"
  | "exported";

export type TakosumiAppInstallationMode =
  | "shared-cell"
  | "dedicated"
  | "self-hosted";

export interface TakosumiAccountsConfig {
  issuer?: string;
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

export function normalizeIssuer(
  issuer?: string,
): string {
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
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value ?? null);
}

/** `sha256:<lowercase-hex>` digest of a UTF-8 string. */
export async function sha256HexText(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}

export interface TakosumiAccountsInstallationMaterializeDigestInput {
  readonly installationId: string;
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
export function takosumiAccountsInstallationMaterializeDigest(
  input: TakosumiAccountsInstallationMaterializeDigestInput,
): Promise<string> {
  return sha256HexText(canonicalJson({
    operation: "materialize",
    installationId: input.installationId,
    mode: input.mode,
    region: input.region,
    plan: input.plan,
    cutover: input.cutover,
  }));
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
