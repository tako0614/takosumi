/**
 * Example issuer URL for the takosumi reference distribution.
 * Override with operator-selected issuer hostname; this constant is for
 * documentation / test scaffolding only and must not be treated as a
 * production default.
 */
export const TAKOSUMI_ACCOUNTS_EXAMPLE_ISSUER =
  "https://accounts.takosumi.com";
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
export const TAKOSUMI_ACCOUNTS_INSTALLATION_EXPORT_BUNDLE_KIND =
  "takosumi.accounts.installation-export-bundle@v1";

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
