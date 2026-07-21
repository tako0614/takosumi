/**
 * Env parsing for the Bun + Postgres Takosumi Accounts reference
 * distribution. Mirrors the Cloudflare worker handler's env shape so
 * operators can move secrets between the two substrates by renaming
 * env vars only.
 */
import type {
  LoginEmailAllowlist,
  OidcClientRegistration,
  PasskeyHttpOptions,
  UpstreamOAuthOptions,
} from "@takosjp/takosumi-accounts-service";
import { upstreamOAuthOptionsFromEnvironment } from "@takosjp/takosumi-accounts-service";
import { resolveTakosumiMobileOidcClientId } from "@takosjp/takosumi-accounts-service";

export interface NodeAccountsStableOidcConfig {
  readonly privateJwkJson: string;
  readonly keyId?: string;
  readonly previousPublicJwksJson?: string;
  readonly subject?: string;
  readonly oidcPairwiseSubjectSecret: string;
}

export interface NodeAccountsServerConfig {
  /**
   * Bind interface for the in-process Bun listener (e.g. `0.0.0.0`).
   * This is the local listener address Caddy reverse-proxies to; it is
   * **not** the public hostname users dial. The public hostname lives in
   * Caddyfile.example via `TAKOSUMI_ACCOUNTS_PUBLIC_HOSTNAME`.
   */
  readonly bindHost: string;
  readonly port: number;
  readonly issuer: string;
  readonly managedPublicBaseDomain: string | undefined;
  readonly databaseUrl: string;
  readonly clients: readonly OidcClientRegistration[] | undefined;
  readonly mobileOidcClientId: string | undefined;
  readonly loginEmailAllowlist: LoginEmailAllowlist | undefined;
  readonly passkeys: PasskeyHttpOptions | undefined;
  readonly upstreamOAuth: UpstreamOAuthOptions | undefined;
  readonly stableOidc: NodeAccountsStableOidcConfig | undefined;
  readonly privacyOperationsToken: string | undefined;
  readonly privacyRetentionPolicyRef: string | undefined;
  readonly subject: string | undefined;
}

export function parseEnv(
  env: Record<string, string | undefined>,
): NodeAccountsServerConfig {
  const databaseUrl = required(env, "TAKOSUMI_ACCOUNTS_DATABASE_URL");
  const issuer =
    optional(env, "TAKOSUMI_ACCOUNTS_ISSUER") ??
    `http://${optional(env, "HOST") ?? "localhost"}:${parseIntOr(
      env.PORT,
      8787,
    )}`;
  const clients = parseClients(env);
  return {
    bindHost: optional(env, "TAKOSUMI_ACCOUNTS_BIND_HOST") ?? "0.0.0.0",
    port: parseIntOr(env.PORT ?? env.TAKOSUMI_ACCOUNTS_PORT, 8787),
    issuer,
    managedPublicBaseDomain: optional(
      env,
      "TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN",
    ),
    databaseUrl,
    clients,
    mobileOidcClientId: resolveTakosumiMobileOidcClientId({
      configuredClientId: optional(env, "TAKOSUMI_MOBILE_OIDC_CLIENT_ID"),
      clients,
    }),
    loginEmailAllowlist: parseLoginEmailAllowlist(env, issuer),
    passkeys: parsePasskeys(env),
    upstreamOAuth: parseUpstreamOAuth(env),
    stableOidc: parseStableOidc(env),
    privacyOperationsToken: optional(
      env,
      "TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN",
    ),
    privacyRetentionPolicyRef: optional(
      env,
      "TAKOSUMI_ACCOUNTS_PRIVACY_RETENTION_POLICY_REF",
    ),
    subject: optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT"),
  };
}

function parseClients(
  env: Record<string, string | undefined>,
): readonly OidcClientRegistration[] | undefined {
  const raw = optional(env, "TAKOSUMI_ACCOUNTS_CLIENTS");
  if (raw) {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) {
      throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS must be a JSON array");
    }
    return value.map(parseClientRecord);
  }
  const clientId = optional(env, "TAKOSUMI_ACCOUNTS_CLIENT_ID");
  const redirectUris = splitList(env.TAKOSUMI_ACCOUNTS_REDIRECT_URIS);
  if (!clientId && redirectUris.length === 0) return undefined;
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_ID and TAKOSUMI_ACCOUNTS_REDIRECT_URIS must be set together",
    );
  }
  const allowedScopes = splitList(env.TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES);
  const clientSecret = optional(env, "TAKOSUMI_ACCOUNTS_CLIENT_SECRET");
  const tokenEndpointAuthMethod = parseClientAuthMethod(
    env.TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD,
  );
  return [
    {
      clientId,
      redirectUris,
      ...(allowedScopes.length > 0 ? { allowedScopes } : {}),
      ...(clientSecret ? { clientSecret } : {}),
      ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    },
  ];
}

function parseClientRecord(value: unknown): OidcClientRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS entries must be objects");
  }
  const record = value as Record<string, unknown>;
  const clientId = typeof record.clientId === "string" ? record.clientId : "";
  const redirectUris = Array.isArray(record.redirectUris)
    ? record.redirectUris.filter(
        (uri): uri is string => typeof uri === "string",
      )
    : [];
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS entries require clientId and redirectUris",
    );
  }
  const allowedScopes = parseClientAllowedScopes(record.allowedScopes);
  const tokenEndpointAuthMethod = parseClientAuthMethod(
    record.tokenEndpointAuthMethod,
  );
  return {
    clientId,
    redirectUris,
    ...(allowedScopes ? { allowedScopes } : {}),
    ...(typeof record.clientSecret === "string"
      ? { clientSecret: record.clientSecret }
      : {}),
    ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
  };
}

function parseClientAllowedScopes(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS allowedScopes must be a non-empty string array",
    );
  }
  const scopes = value.map((scope) =>
    typeof scope === "string" ? scope.trim() : "",
  );
  if (scopes.some((scope) => !scope || /\s/u.test(scope))) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS allowedScopes entries must be individual scope tokens",
    );
  }
  return [...new Set(scopes)];
}

function parseClientAuthMethod(
  value: unknown,
): "client_secret_basic" | "client_secret_post" | "none" | undefined {
  const method = typeof value === "string" ? value.trim() : "";
  if (!method) return undefined;
  if (
    method !== "client_secret_basic" &&
    method !== "client_secret_post" &&
    method !== "none"
  ) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD must be one of: client_secret_basic, client_secret_post, none",
    );
  }
  return method;
}

function parseLoginEmailAllowlist(
  env: Record<string, string | undefined>,
  _issuer: string,
): LoginEmailAllowlist | undefined {
  const configured = optional(env, "TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST");
  const emails = configured?.trim() === "*" ? [] : splitList(configured);
  assertPlatformAccessMatchesAllowlist(env, emails.length);
  if (emails.length === 0) return undefined;
  return {
    emails,
    requireVerifiedEmail: !(
      optional(
        env,
        "TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED",
      )?.toLowerCase() === "false"
    ),
  };
}

/**
 * `closed` is an operator promise that this deployment does not accept new
 * sign-ins. The login email allowlist is its only enforcement, and an unset,
 * empty, or `"*"` allowlist lets upstream OAuth auto-provision an account for
 * anyone. Refuse to compose the handler instead of serving an open deployment
 * that reports itself as closed.
 */
function assertPlatformAccessMatchesAllowlist(
  env: Record<string, string | undefined>,
  allowlistedEmailCount: number,
): void {
  const access = optional(
    env,
    "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS",
  )?.toLowerCase();
  if (access === undefined || access === "open") return;
  if (access !== "closed") {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS must be one of: open, closed",
    );
  }
  if (allowlistedEmailCount > 0) return;
  throw new TypeError(
    "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS=closed requires a non-empty " +
      "TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST; set the allowlist or declare " +
      "TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS=open",
  );
}

function parsePasskeys(
  env: Record<string, string | undefined>,
): PasskeyHttpOptions | undefined {
  const rpId = optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID");
  const rpName = optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME");
  const origin =
    optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN") ??
    optional(env, "TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN");
  const sessionTtlMs = parsePasskeyTtlMs(env);
  if (!rpId && !rpName && !origin && sessionTtlMs === undefined) {
    return undefined;
  }
  if (!rpId || !rpName || !origin) {
    throw new TypeError(
      "Passkeys require TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID, TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME, and TAKOSUMI_ACCOUNTS_PASSKEY_RP_ORIGIN",
    );
  }
  return {
    rpId,
    rpName,
    origin,
    ...(sessionTtlMs !== undefined ? { sessionTtlMs } : {}),
  };
}

function parsePasskeyTtlMs(
  env: Record<string, string | undefined>,
): number | undefined {
  const ttlSeconds = optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_PASSKEY_TTL_SECONDS",
  );
  if (ttlSeconds !== undefined) return ttlSeconds * 1000;
  return optionalNonNegativeInteger(
    env,
    "TAKOSUMI_ACCOUNTS_PASSKEY_SESSION_TTL_MS",
  );
}

function parseUpstreamOAuth(
  env: Record<string, string | undefined>,
): UpstreamOAuthOptions | undefined {
  return upstreamOAuthOptionsFromEnvironment(env);
}

function parseStableOidc(
  env: Record<string, string | undefined>,
): NodeAccountsStableOidcConfig | undefined {
  const privateJwkJson = optional(env, "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK");
  if (!privateJwkJson) return undefined;
  const oidcPairwiseSubjectSecret = optional(
    env,
    "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
  );
  if (!oidcPairwiseSubjectSecret) {
    throw new TypeError(
      "Stable OIDC signing requires TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    );
  }
  const keyId = optional(env, "TAKOSUMI_ACCOUNTS_ES256_KEY_ID");
  const previousPublicJwksJson = optional(
    env,
    "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS",
  );
  const subject = optional(env, "TAKOSUMI_ACCOUNTS_SUBJECT");
  return {
    privateJwkJson,
    ...(keyId ? { keyId } : {}),
    ...(previousPublicJwksJson ? { previousPublicJwksJson } : {}),
    ...(subject ? { subject } : {}),
    oidcPairwiseSubjectSecret,
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new TypeError(`missing required env var: ${name}`);
  return value;
}

function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const value = env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function bool(env: Record<string, string | undefined>, name: string): boolean {
  const value = optional(env, name)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNonNegativeInteger(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = optional(env, name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

function splitList(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\s]+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}
