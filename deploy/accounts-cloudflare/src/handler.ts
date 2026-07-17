import {
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  type TakosumiSubject,
} from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsHandler,
  type AccountsJsonWebKey,
  authProviderConfigurationInvalidResponse,
  createAccountsHandler,
  createEphemeralAccountsHandler,
  type ControlPlaneOperations,
  D1AccountsStore,
  type D1Database,
  handleAuthProvidersRequest,
  type JsonWebKeySet,
  type OidcClientAuthMethod,
  type OidcClientRegistration,
  registerSessionHashSaltConfig,
  type PasskeyHttpOptions,
  signEs256Jwt,
  type UpstreamOAuthOptions,
  upstreamOAuthOptionsFromEnvironment,
  type LoginEmailAllowlist,
  type InterfaceOAuthActivityValidator,
} from "@takosjp/takosumi-accounts-service";
import { isAccountsApiPath, isWorkerLocalPath } from "./routes.ts";
import { checkPlatformBindings } from "./bindings-check.ts";

export interface CloudflareWorkerEnv {
  readonly [name: string]: unknown;
  readonly TAKOSUMI_ACCOUNTS_DB: D1Database;
  // Cloudflare Static Assets binding for the bundled dashboard SPA
  // (dashboard → dist). Present when the wrangler `[assets]` block is
  // configured; absent in API-only deploys/tests.
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN?: string;
  readonly TAKOSUMI_ACCOUNTS_SUBJECT?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENTS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_REDIRECT_URIS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD?: string;
  readonly TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES?: string;
  readonly TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK?: string;
  readonly TAKOSUMI_ACCOUNTS_ES256_KEY_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS?: string;
  readonly TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNT_SESSION_HASH_SALT?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_SESSION_TTL_MS?: string;
  readonly TAKOSUMI_ACCOUNTS_SUBJECT_SECRET?: string;
  /** Non-secret JSON array of explicit upstream provider descriptors. */
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS?: string;
  readonly TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST?: string;
  readonly TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED?: string;
  /**
   * Shared platform-worker load-shedding knob used by the scheduled deploy-control
   * source poller. Optional and intentionally not part of the required accounts
   * binding set.
   */
  readonly TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH?: string;
  readonly TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN?: string;
  readonly TAKOSUMI_ACCOUNTS_PRIVACY_RETENTION_POLICY_REF?: string;
  readonly TAKOSUMI_AI_GATEWAY_DEFAULT_MODEL?: string;
  readonly TAKOSUMI_AI_GATEWAY_PROFILES?: string;
  readonly LOCAL_SUBSTRATE_TEST_BED?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID?: string;
}

export interface CloudflareWorkerHandler<
  TEnv extends CloudflareWorkerEnv = CloudflareWorkerEnv,
> {
  fetch(request: Request, env: TEnv): Promise<Response>;
}

export interface CreateCloudflareWorkerOptions<
  TEnv extends CloudflareWorkerEnv = CloudflareWorkerEnv,
> {
  /**
   * In-process control-plane operations facade backing the session-authed
   * `/api/v1/*` account-plane routes the dashboard SPA calls (M10). The
   * platform worker passes the embedded deploy-control service's typed
   * `operations` facade here; it structurally satisfies {@link
   * ControlPlaneOperations}. When omitted the control routes 503 after the
   * session gate.
   */
  readonly controlPlaneOperations?: (
    env: TEnv,
  ) => Promise<ControlPlaneOperations | undefined>;
}

const handlers = new WeakMap<CloudflareWorkerEnv, Promise<AccountsHandler>>();
const identityHandlers = new WeakMap<
  CloudflareWorkerEnv,
  Promise<AccountsHandler>
>();

type Es256PrivateJwk = JsonWebKey & {
  readonly kid?: string;
  readonly x?: string;
  readonly y?: string;
};

export function createCloudflareWorker<
  TEnv extends CloudflareWorkerEnv = CloudflareWorkerEnv,
>(
  options: CreateCloudflareWorkerOptions<TEnv> = {},
): CloudflareWorkerHandler<TEnv> {
  return {
    async fetch(request: Request, env: TEnv): Promise<Response> {
      const url = new URL(request.url);
      if (isWorkerLocalPath(url.pathname)) {
        return Response.json({
          ok: true,
          provider: "cloudflare",
          service: "takosumi-accounts",
          persistence: "d1+r2",
        });
      }
      // Readiness self-check (operator first-run aid): validate that the
      // required durable bindings exist and name any that are missing, so a
      // misconfigured deploy fails loudly here instead of deep in the run
      // pipeline. Presence-only (no D1/R2/DO I/O), so it stays cheap.
      if (url.pathname === "/readyz") {
        const check = checkPlatformBindings(
          env as unknown as Record<string, unknown>,
        );
        if (!check.ok) {
          console.error(
            "platform_bindings_missing",
            JSON.stringify({ missing: check.missing }),
          );
          return Response.json(
            { ok: false, missing: check.missing },
            { status: 503 },
          );
        }
        return Response.json({ ok: true });
      }
      // Non-API paths = the dashboard SPA, served from this Worker's static
      // assets (deep links fall back to index.html via not_found_handling).
      // API namespaces, and any deploy without the ASSETS binding, fall
      // through to the accounts handler below.
      if (
        env.ASSETS &&
        (request.method === "GET" || request.method === "HEAD") &&
        !isAccountsApiPath(url.pathname)
      ) {
        const assetResponse = await env.ASSETS.fetch(request);
        if (isDashboardAssetPath(url.pathname)) {
          return dashboardAssetResponse(assetResponse, request.method);
        }
        return withDashboardDocumentCsp(assetResponse);
      }
      if (url.pathname === TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH) {
        if (request.method !== "GET") {
          return Response.json(
            { error: "method_not_allowed" },
            { status: 405, headers: { allow: "GET" } },
          );
        }
        try {
          return handleAuthProvidersRequest({
            upstreamOAuth: parseUpstreamOAuthForProviderList(env),
            passkeys: parsePasskeysForProviderList(env),
          });
        } catch {
          // Discovery is public and must not reveal which endpoint, binding,
          // or secret reference made the operator configuration invalid.
          console.warn("auth_provider_configuration_invalid");
          return authProviderConfigurationInvalidResponse();
        }
      }
      try {
        const handler = await cachedAccountsHandler(
          env,
          options,
          usesIdentityOnlyAccountsHandler(url.pathname),
        );
        return await handler(request);
      } catch (error) {
        return Response.json(
          {
            error: "worker_configuration_error",
            error_description:
              error instanceof Error ? error.message : String(error),
          },
          { status: 500 },
        );
      }
    },
  };
}

function parseUpstreamOAuthForProviderList(
  env: CloudflareWorkerEnv,
): UpstreamOAuthOptions | undefined {
  return parseUpstreamOAuth(env);
}

function parseUpstreamOAuthFailClosed(
  env: CloudflareWorkerEnv,
): UpstreamOAuthOptions | undefined {
  try {
    return parseUpstreamOAuth(env);
  } catch (error) {
    console.warn(
      "auth_providers_upstream_oauth_disabled",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

function parsePasskeysForProviderList(
  env: CloudflareWorkerEnv,
): PasskeyHttpOptions | undefined {
  return parsePasskeys(env);
}

function parsePasskeysFailClosed(
  env: CloudflareWorkerEnv,
): PasskeyHttpOptions | undefined {
  try {
    return parsePasskeys(env);
  } catch (error) {
    console.warn(
      "auth_providers_passkeys_disabled",
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

export function parseLoginEmailAllowlist(
  env: CloudflareWorkerEnv,
  _issuer: string,
): LoginEmailAllowlist | undefined {
  const configured = optionalString(
    env.TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST,
  );
  if (configured?.trim() === "*") return undefined;
  const emails = configured !== undefined ? splitList(configured) : [];
  if (emails.length === 0) return undefined;
  return {
    emails,
    requireVerifiedEmail:
      optionalBooleanString(
        env.TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED,
      ) ?? true,
  };
}

/** Whether at least one usable upstream OAuth/OIDC registration is mounted. */
export function accountsExternalLoginConfigured(
  env: CloudflareWorkerEnv,
): boolean {
  try {
    return (parseUpstreamOAuth(env)?.providers.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function cachedAccountsHandler<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  options: CreateCloudflareWorkerOptions<TEnv>,
  identityOnly = false,
): Promise<AccountsHandler> {
  const cache = identityOnly ? identityHandlers : handlers;
  let handler = cache.get(env);
  if (!handler) {
    handler = observeAccountsHandlerInitialization(
      buildAccountsHandler(env, options, identityOnly),
      identityOnly ? "identity" : "control",
    );
    cache.set(env, handler);
  }
  return await handler;
}

async function observeAccountsHandlerInitialization(
  handler: Promise<AccountsHandler>,
  mode: "identity" | "control",
): Promise<AccountsHandler> {
  const timer = setTimeout(() => {
    console.warn(
      JSON.stringify({
        event: "accounts_handler_initialization_slow",
        mode,
        thresholdMs: 2_000,
      }),
    );
  }, 2_000);
  try {
    return await handler;
  } finally {
    clearTimeout(timer);
  }
}

function usesIdentityOnlyAccountsHandler(pathname: string): boolean {
  if (
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  ) {
    return true;
  }
  return false;
}

// D1 schema version expected by the deployed code. The baseline
// version (0) matches the initial `D1_ACCOUNTS_STORE_INIT_SQL` `CREATE TABLE
// IF NOT EXISTS` statements that `D1AccountsStore.initialize()` runs. Bump
// this when a real migration is added to the migration runner
// (`@takosjp/takosumi-accounts-service`). The Worker refuses to serve
// account-plane traffic when the D1 database reports a newer version (Worker
// is behind the schema) or an older version (database is behind the Worker)
// so operators don't silently run a schema that does not match the service.
// See `README.md` → "D1 schema migration" for the runner workflow.
const EXPECTED_D1_SCHEMA_VERSION = 2;

async function buildAccountsHandler<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  options: CreateCloudflareWorkerOptions<TEnv>,
  identityOnly = false,
): Promise<AccountsHandler> {
  if (!env.TAKOSUMI_ACCOUNTS_DB) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
  configureSessionHashSalt(env);
  const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB);
  await store.initialize();
  await ensureD1SchemaVersion(env.TAKOSUMI_ACCOUNTS_DB);
  await seedLocalSubstrateAccount(store, env);
  // TAKOSUMI_ACCOUNTS_ISSUER must be explicitly set. We deliberately do NOT
  // fall back to the first request URL: caching that as the issuer poisons
  // every later request (the OIDC discovery doc would report whichever host
  // first hit the Worker), which can be a privately-routed staging host or
  // even an attacker-controlled host before DNS verification completes.
  // See README "Production env vars" for the required configuration.
  const issuerEnv = optionalString(env.TAKOSUMI_ACCOUNTS_ISSUER);
  if (!issuerEnv) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ISSUER must be set for the Cloudflare Worker (no fallback to request URL)",
    );
  }
  const issuer = issuerEnv;
  const clients = parseConfiguredOidcClients(env);
  const controlPlaneOperations = identityOnly
    ? undefined
    : await options.controlPlaneOperations?.(env);
  // Keep ordinary identity requests on the lightweight handler. Canonical
  // Core is resolved lazily only when an Interface OAuth token is actually
  // presented to UserInfo/introspection.
  const interfaceOAuthActivityValidator: InterfaceOAuthActivityValidator | undefined =
    options.controlPlaneOperations
      ? async (evidence) => {
          const operations = await options.controlPlaneOperations?.(env);
          return (
            (await operations?.interfaces?.validatePrincipalOAuth2TokenEvidence(
              evidence,
            )) === true
          );
        }
      : undefined;
  const managedPublicBaseDomain = optionalString(
    env.TAKOSUMI_MANAGED_PUBLIC_BASE_DOMAIN,
  );
  const commonOptions = {
    issuer,
    clients,
    store,
    upstreamOAuth: parseUpstreamOAuthFailClosed(env),
    passkeys: parsePasskeysFailClosed(env),
    loginEmailAllowlist: parseLoginEmailAllowlist(env, issuer),
    ...(controlPlaneOperations ? { controlPlaneOperations } : {}),
    ...(interfaceOAuthActivityValidator
      ? { interfaceOAuthActivityValidator }
      : {}),
    ...(managedPublicBaseDomain ? { managedPublicBaseDomain } : {}),
    privacyOperationsToken: optionalString(
      env.TAKOSUMI_ACCOUNTS_PRIVACY_OPERATIONS_TOKEN,
    ),
    privacyRetentionPolicyRef: optionalString(
      env.TAKOSUMI_ACCOUNTS_PRIVACY_RETENTION_POLICY_REF,
    ),
  };
  const stableOidc = await parseStableOidcFlow(env);
  if (stableOidc) {
    return createAccountsHandler({
      ...commonOptions,
      jwks: stableOidc.jwks,
      oidcFlow: stableOidc.oidcFlow,
    });
  }
  return await createEphemeralAccountsHandler({
    ...commonOptions,
    subject: optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT),
  });
}

function configureSessionHashSalt(env: CloudflareWorkerEnv): void {
  const salt = optionalString(env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT);
  if (salt) {
    registerSessionHashSaltConfig({ salt });
    return;
  }
  if (optionalString(env.LOCAL_SUBSTRATE_TEST_BED) === "1") {
    registerSessionHashSaltConfig({ allowDevFallback: true });
    return;
  }
  throw new TypeError(
    "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT must be set for the Cloudflare Worker account session store",
  );
}

interface SchemaMigrationRow {
  readonly version: number;
}

// Verify the D1 database has been migrated up to the version this Worker
// expects. We create the bookkeeping table on first contact (so a brand-new
// D1 database isn't rejected) but we never silently advance the recorded
// version; the migration runner in
// `@takosjp/takosumi-accounts-service` (CLI `accounts migrate-d1`) must
// do that. A drifted version fails fast with a clear pointer to the runner
// so operators don't run a service against a stale schema. The check uses
// the D1 binding directly so we don't depend on a private API of
// D1AccountsStore.
//
// The table name + column shape MUST match the runner's
// `takosumi_accounts_schema_migrations` ledger (see
// `cli/src/cli-accounts-db.ts`'s `D1_SCHEMA_MIGRATIONS_TABLE_SQL`).
// The runner records `(version, name, applied_at)` rows; this Worker reads
// only `version` from that same table so a `migrate-d1` run is visible to
// the version gate. Keeping the names in lockstep is what makes the
// fail-closed gate satisfiable by the documented runner.
async function ensureD1SchemaVersion(
  db: CloudflareWorkerEnv["TAKOSUMI_ACCOUNTS_DB"],
): Promise<void> {
  // D1 `exec()` runs one statement per line; keep this single-line. Mirrors
  // `D1_SCHEMA_MIGRATIONS_TABLE_SQL` in the CLI migrate-d1 runner so the
  // table the Worker reads is exactly the table the runner writes.
  await db.exec(
    "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);",
  );
  const row = await db
    .prepare(
      "SELECT version FROM takosumi_accounts_schema_migrations ORDER BY version DESC LIMIT 1",
    )
    .first<SchemaMigrationRow>();
  const currentVersion = row?.version ?? 0;
  if (currentVersion > EXPECTED_D1_SCHEMA_VERSION) {
    console.error(
      `D1 schema_migrations.version=${currentVersion} is newer than this Worker expects (${EXPECTED_D1_SCHEMA_VERSION}). Roll forward the Worker or roll back the migration.`,
    );
    throw new TypeError(
      `D1 schema version ${currentVersion} is newer than this Worker (expected ${EXPECTED_D1_SCHEMA_VERSION}); see README "D1 schema migration" for the migration runner workflow`,
    );
  }
  if (currentVersion < EXPECTED_D1_SCHEMA_VERSION) {
    console.error(
      `D1 schema_migrations.version=${currentVersion} is behind expected ${EXPECTED_D1_SCHEMA_VERSION}; run the takosumi accounts D1 migration runner before serving traffic.`,
    );
    throw new TypeError(
      `D1 schema version ${currentVersion} is behind this Worker (expected ${EXPECTED_D1_SCHEMA_VERSION}); run \`bun run cli -- accounts migrate-d1\` or the equivalent migration runner before serving account-plane traffic`,
    );
  }
}

async function seedLocalSubstrateAccount(
  store: D1AccountsStore,
  env: CloudflareWorkerEnv,
): Promise<void> {
  if (optionalString(env.LOCAL_SUBSTRATE_TEST_BED) !== "1") return;
  const now = Date.now();
  const subject = localTakosumiSubject(
    optionalString(env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT) ??
      optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT) ??
      "tsub_takosumi_local",
  );
  const sessionId =
    optionalString(env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID) ??
    "sess_local_substrate";
  await store.saveAccount({
    subject,
    displayName: "Local Substrate",
    email: "local-substrate@takosumi.test",
    createdAt: now,
    updatedAt: now,
  });
  await store.saveAccountSession({
    sessionId,
    subject,
    createdAt: now,
    expiresAt: now + 1000 * 60 * 60 * 24 * 30,
  });
}

function localTakosumiSubject(value: string): TakosumiSubject {
  if (value.startsWith("tsub_")) return value as TakosumiSubject;
  throw new TypeError(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT must start with tsub_",
  );
}

async function parseStableOidcFlow(env: CloudflareWorkerEnv): Promise<
  | {
      readonly jwks: JsonWebKeySet;
      readonly oidcFlow: {
        readonly subject: string;
        readonly pairwiseSubjectSecret: string;
        readonly issueIdToken: (
          claims: Record<string, unknown>,
        ) => Promise<string>;
      };
    }
  | undefined
> {
  const rawJwk = optionalString(env.TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK);
  if (!rawJwk) return undefined;
  const privateJwk = JSON.parse(rawJwk) as Es256PrivateJwk;
  const kid =
    optionalString(env.TAKOSUMI_ACCOUNTS_ES256_KEY_ID) ??
    optionalString(privateJwk.kid) ??
    "takosumi-accounts-cloudflare-accounts";
  const pairwiseSubjectSecret = optionalString(
    env.TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET,
  );
  if (!pairwiseSubjectSecret) {
    throw new TypeError(
      "Stable OIDC signing requires TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
    );
  }
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const publicJwk = publicJwkFromPrivate(privateJwk, kid);
  const previousPublicJwks = parsePreviousPublicJwks(
    optionalString(env.TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS),
    "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS",
    kid,
  );
  return {
    jwks: { keys: [publicJwk, ...previousPublicJwks] },
    oidcFlow: {
      subject:
        optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT) ?? "tsub_cloudflare_seed",
      pairwiseSubjectSecret,
      issueIdToken: (claims) =>
        signEs256Jwt({
          header: { alg: "ES256", typ: "JWT", kid },
          claims,
          privateKey,
        }),
    },
  };
}

function parsePreviousPublicJwks(
  raw: string | undefined,
  label: string,
  activeKid: string,
): AccountsJsonWebKey[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  const keys = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.keys)
      ? parsed.keys
      : null;
  if (!keys) {
    throw new TypeError(`${label} must be a JWK Set object or JWK array`);
  }
  const seen = new Set([activeKid]);
  return keys.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`${label}.keys[${index}] must be an object`);
    }
    if ("d" in entry) {
      throw new TypeError(`${label}.keys[${index}] must be public only`);
    }
    const kid = optionalString(entry.kid);
    const kty = optionalString(entry.kty);
    const crv = optionalString(entry.crv);
    const x = optionalString(entry.x);
    const y = optionalString(entry.y);
    if (!kid || !kty || !crv || !x || !y) {
      throw new TypeError(
        `${label}.keys[${index}] requires kid, kty, crv, x, and y`,
      );
    }
    if (kty !== "EC" || crv !== "P-256") {
      throw new TypeError(
        `${label}.keys[${index}] must be an ES256 public JWK`,
      );
    }
    if (seen.has(kid)) {
      throw new TypeError(`${label}.keys[${index}] duplicates kid ${kid}`);
    }
    seen.add(kid);
    return {
      kty: "EC",
      crv: "P-256",
      x,
      y,
      kid,
      use: "sig",
      alg: "ES256",
    };
  });
}

function publicJwkFromPrivate(
  privateJwk: Es256PrivateJwk,
  kid: string,
): AccountsJsonWebKey {
  if (!privateJwk.x || !privateJwk.y) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK must include public x/y coordinates",
    );
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: privateJwk.x,
    y: privateJwk.y,
    kid,
    use: "sig",
    alg: "ES256",
  };
}

export function parseConfiguredOidcClients(
  env: CloudflareWorkerEnv,
): readonly OidcClientRegistration[] | undefined {
  const rawClients = optionalString(env.TAKOSUMI_ACCOUNTS_CLIENTS);
  if (rawClients) {
    const value = JSON.parse(rawClients);
    if (!Array.isArray(value)) {
      throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS must be a JSON array");
    }
    return value.map(parseClientRecord);
  }

  const clientId = optionalString(env.TAKOSUMI_ACCOUNTS_CLIENT_ID);
  const redirectUris = splitList(env.TAKOSUMI_ACCOUNTS_REDIRECT_URIS);
  if (!clientId && redirectUris.length === 0) return undefined;
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_ID and TAKOSUMI_ACCOUNTS_REDIRECT_URIS must be set together",
    );
  }
  const clientSecret = optionalString(env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET);
  const tokenEndpointAuthMethod = parseClientAuthMethod(
    env.TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD,
  );
  const allowedScopes = splitList(env.TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES);
  return [
    {
      clientId,
      redirectUris,
      ...(allowedScopes.length > 0 ? { allowedScopes } : {}),
      clientSecret,
      tokenEndpointAuthMethod,
    },
  ];
}

function parseClientRecord(value: unknown): OidcClientRegistration {
  if (!isRecord(value)) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS entries must be objects");
  }
  const clientId = optionalString(value.clientId);
  const redirectUris = Array.isArray(value.redirectUris)
    ? value.redirectUris.filter((uri): uri is string => typeof uri === "string")
    : [];
  if (!clientId || redirectUris.length === 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS entries require clientId and redirectUris",
    );
  }
  const clientSecret = optionalString(value.clientSecret);
  const tokenEndpointAuthMethod = parseClientAuthMethod(
    optionalString(value.tokenEndpointAuthMethod),
  );
  const allowedScopes = parseClientAllowedScopes(value.allowedScopes);
  return {
    clientId,
    redirectUris,
    ...(allowedScopes ? { allowedScopes } : {}),
    clientSecret,
    tokenEndpointAuthMethod,
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
  const scopes = value.map((scope) => optionalString(scope));
  if (scopes.some((scope) => !scope || /\s/u.test(scope))) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENTS allowedScopes entries must be individual scope tokens",
    );
  }
  return [...new Set(scopes as string[])];
}

function parseClientAuthMethod(
  value: string | undefined,
): OidcClientAuthMethod | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  if (
    raw !== "client_secret_basic" &&
    raw !== "client_secret_post" &&
    raw !== "none"
  ) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD must be one of: client_secret_basic, client_secret_post, none",
    );
  }
  return raw;
}

function parsePasskeys(
  env: CloudflareWorkerEnv,
): PasskeyHttpOptions | undefined {
  const rpId = optionalString(env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID);
  const rpName = optionalString(env.TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME);
  const origin = optionalString(env.TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN);
  const sessionTtlMs = optionalInteger(
    env.TAKOSUMI_ACCOUNTS_PASSKEY_SESSION_TTL_MS,
  );
  if (!rpId && !rpName && !origin) return undefined;
  if (!rpId || !rpName || !origin) {
    throw new TypeError(
      "Passkeys require TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID, TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME, and TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN",
    );
  }
  return { rpId, rpName, origin, sessionTtlMs };
}

function parseUpstreamOAuth(
  env: CloudflareWorkerEnv,
): UpstreamOAuthOptions | undefined {
  return upstreamOAuthOptionsFromEnvironment(env);
}

function isDashboardAssetPath(pathname: string): boolean {
  return (
    pathname === "/favicon.ico" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/opentofu/providers/")
  );
}

const DASHBOARD_CSP =
  "default-src 'self'; " +
  "script-src 'self' https://static.cloudflareinsights.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' https:; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'; " +
  "form-action 'self'";

/** Attach a Content-Security-Policy to the SPA HTML document so a
 * javascript:/data: href or injected inline script fails closed. */
function withDashboardDocumentCsp(response: Response): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", DASHBOARD_CSP);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function dashboardAssetResponse(response: Response, method: string): Response {
  const contentType = response.headers.get("content-type") ?? "";
  if (
    response.status === 200 &&
    contentType.toLowerCase().includes("text/html")
  ) {
    return new Response(method === "HEAD" ? null : "asset not found", {
      status: 404,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }
  return response;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`expected a non-negative integer, received ${raw}`);
  }
  return parsed;
}

function optionalBooleanString(value: unknown): boolean | undefined {
  const raw = optionalString(value)?.toLowerCase();
  if (raw === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new TypeError(`expected a boolean string, received ${raw}`);
}

function splitList(value: unknown): readonly string[] {
  return (optionalString(value) ?? "")
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
