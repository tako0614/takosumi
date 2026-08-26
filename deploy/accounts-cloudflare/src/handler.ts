import {
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  type TakosumiSubject,
  type TakosumiAccountsPatScope,
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
  type D1AccountsSchemaMode,
  handleAuthProvidersRequest,
  type JsonWebKeySet,
  type OidcClientAuthMethod,
  type OidcClientRegistration,
  rejectDisallowedPresentedSession,
  resolveSessionHashSaltConfig,
  type PasskeyHttpOptions,
  type PatWorkspaceMembershipReader,
  signEs256Jwt,
  type UpstreamOAuthOptions,
  upstreamOAuthOptionsFromEnvironment,
  type LoginEmailAllowlist,
  type InterfaceOAuthActivityValidator,
  resolveD1AccountsSchemaMode,
  resolveTakosumiMobileOidcClientId,
} from "@takosjp/takosumi-accounts-service";
import {
  isAccountsApiPath,
  isWorkerLocalPath,
  isWorkerReadinessPath,
} from "./routes.ts";
import { checkPlatformBindings } from "./bindings-check.ts";
import { ensureAccountsD1WorkerSchema } from "./d1-schema-gate.ts";

export interface CloudflareWorkerEnv {
  readonly [name: string]: unknown;
  readonly TAKOSUMI_ACCOUNTS_DB: D1Database;
  /**
   * `predeployed` keeps schema DDL off the request/cold-start path. Operators
   * must run and verify the accounts migration lane before enabling it.
   * Self-host/bootstrap environments retain the idempotent default.
   */
  readonly TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE?: D1AccountsSchemaMode;
  // Cloudflare Static Assets binding for the bundled dashboard SPA
  // (dashboard → dist). Present when the wrangler `[assets]` block is
  // configured; absent in API-only deploys/tests.
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_SUBJECT?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENTS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_REDIRECT_URIS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD?: string;
  readonly TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES?: string;
  /** Exact public PKCE client advertised by `/.well-known/takosumi`. */
  readonly TAKOSUMI_MOBILE_OIDC_CLIENT_ID?: string;
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
  /** `open` | `closed`. `closed` requires a non-empty login email allowlist. */
  readonly TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS?: string;
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
  /**
   * Narrow, read-only Workspace membership authority for the PAT self view.
   * This is deliberately separate from the lazy full Control composition.
   */
  readonly patWorkspaceMembershipReader?: (
    env: TEnv,
  ) => PatWorkspaceMembershipReader | undefined;
  /** Explicit extension-contributed PAT scopes for self-service creation. */
  readonly personalAccessTokenSelfServiceScopes?: (
    env: TEnv,
  ) => readonly TakosumiAccountsPatScope[];
}

interface CachedAccountsHandler {
  readonly promise: Promise<AccountsHandler>;
  settled: boolean;
}

interface CachedAccountsHandlerResult {
  readonly handler: AccountsHandler;
  readonly initializationWaitMs?: number;
}

const handlers = new WeakMap<CloudflareWorkerEnv, CachedAccountsHandler>();
const identityHandlers = new WeakMap<
  CloudflareWorkerEnv,
  CachedAccountsHandler
>();
const controlPlaneOperationsByEnv = new WeakMap<
  CloudflareWorkerEnv,
  Promise<ControlPlaneOperations | undefined>
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
      if (isWorkerReadinessPath(url.pathname)) {
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
        return await withDashboardDocumentCsp(assetResponse, url.pathname);
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
      let initializationTiming: CachedAccountsHandlerResult | undefined;
      try {
        const cached = await cachedAccountsHandler(
          env,
          options,
          usesIdentityOnlyAccountsHandler(url.pathname),
        );
        initializationTiming = cached;
        const response = await cached.handler(request);
        return appendAccountsHandlerInitializationTiming(
          response,
          initializationTiming,
        );
      } catch (error) {
        return appendAccountsHandlerInitializationTiming(
          Response.json(
            {
              error: "worker_configuration_error",
              error_description:
                error instanceof Error ? error.message : String(error),
            },
            { status: 500 },
          ),
          initializationTiming,
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
  const emails = configured?.trim() === "*" ? [] : splitList(configured ?? "");
  assertPlatformAccessMatchesAllowlist(env, emails.length);
  if (emails.length === 0) return undefined;
  return {
    emails,
    requireVerifiedEmail:
      optionalBooleanString(
        env.TAKOSUMI_ACCOUNTS_LOGIN_EMAIL_ALLOWLIST_REQUIRE_VERIFIED,
      ) ?? true,
  };
}

/**
 * Apply the Cloudflare deployment's login-email policy to one credential that
 * the caller has already classified as an Accounts browser session.
 *
 * The caller owns credential extraction and precedence. In particular, it
 * must not pass a PAT or OAuth access token through this session-only port.
 * Invalid configuration or storage evidence rejects the promise and is a
 * terminal enforcement failure; callers must never continue bootstrap work
 * after such a rejection.
 */
export async function rejectDisallowedCloudflarePresentedSession(input: {
  readonly request: Request;
  readonly env: CloudflareWorkerEnv;
  readonly sessionCredential: string | null;
}): Promise<Response | undefined> {
  const sessionCredential = input.sessionCredential;
  if (!sessionCredential) return undefined;
  const allowlist = parseLoginEmailAllowlist(
    input.env,
    new URL(input.request.url).origin,
  );
  if (!allowlist) return undefined;
  if (!input.env.TAKOSUMI_ACCOUNTS_DB) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
  const sessionHashSalt = resolveCloudflareSessionHashSalt(input.env);
  const store = new D1AccountsStore(input.env.TAKOSUMI_ACCOUNTS_DB, {
    schemaMode: "predeployed",
    sessionHashSalt,
  });
  return await rejectDisallowedPresentedSession({
    request: input.request,
    store,
    credential: sessionCredential,
    allowlist,
    secureCookie: true,
  });
}

/**
 * `closed` is an operator promise that this deployment does not accept new
 * sign-ins, and it is recorded as such in every release attestation. Nothing
 * else enforces it: the login email allowlist is the only gate, and an unset,
 * empty, or `"*"` allowlist lets upstream OAuth auto-provision an account for
 * anyone. Refuse to compose the handler rather than serve an open deployment
 * that reports itself as closed.
 */
function assertPlatformAccessMatchesAllowlist(
  env: CloudflareWorkerEnv,
  allowlistedEmailCount: number,
): void {
  const access = optionalString(
    env.TAKOSUMI_ACCOUNTS_PLATFORM_ACCESS,
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
): Promise<CachedAccountsHandlerResult> {
  const cache = identityOnly ? identityHandlers : handlers;
  let cached = cache.get(env);
  const waitsForInitialization = cached === undefined || !cached.settled;
  const waitStartedAt = waitsForInitialization ? nowMs() : undefined;
  if (!cached) {
    const promise = observeAccountsHandlerInitialization(
      buildAccountsHandler(env, options, identityOnly),
      identityOnly ? "identity" : "control",
    );
    cached = {
      promise,
      settled: false,
    };
    cache.set(env, cached);
    void promise.then(
      () => {
        cached!.settled = true;
      },
      () => {
        cached!.settled = true;
      },
    );
  }
  const handler = await cached.promise;
  if (waitStartedAt === undefined) return { handler };
  return {
    handler,
    initializationWaitMs: nowMs() - waitStartedAt,
  };
}

function appendAccountsHandlerInitializationTiming(
  response: Response,
  timing: CachedAccountsHandlerResult | undefined,
): Response {
  if (timing?.initializationWaitMs === undefined) return response;
  const metrics = [
    `tk_accounts_init;dur=${formatTimingDuration(timing.initializationWaitMs)}`,
  ];
  const headers = new Headers(response.headers);
  const existing = headers.get("Server-Timing");
  const value = metrics.join(", ");
  headers.set("Server-Timing", existing ? `${existing}, ${value}` : value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function formatTimingDuration(durationMs: number): string {
  return Math.max(0, durationMs).toFixed(1);
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
  // These OAuth endpoints can carry a Capsule-owned dynamic client or token.
  // Every mint/use operation must therefore revalidate the live Capsule,
  // InstallConfig and Workspace grant against canonical Core. Routing any of
  // them through the identity-only cache makes a valid dynamic grant look
  // inactive because that handler intentionally has no Control operations.
  if (
    pathname === "/oauth/authorize" ||
    pathname === "/oauth/token" ||
    pathname === "/oauth/userinfo" ||
    pathname === "/oauth/introspect"
  ) {
    return false;
  }
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

async function buildAccountsHandler<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  options: CreateCloudflareWorkerOptions<TEnv>,
  identityOnly = false,
): Promise<AccountsHandler> {
  if (!env.TAKOSUMI_ACCOUNTS_DB) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
  const schemaMode = accountsD1SchemaMode(env);
  const sessionHashSalt = resolveCloudflareSessionHashSalt(env);
  const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
    schemaMode,
    sessionHashSalt,
  });
  if (schemaMode === "bootstrap") {
    await store.initialize();
  }
  await ensureAccountsD1WorkerSchema(env.TAKOSUMI_ACCOUNTS_DB);
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
  // Keep ordinary identity requests on the lightweight handler. Canonical
  // Core is resolved lazily only when an Interface OAuth token is actually
  // presented to UserInfo/introspection.
  const interfaceOAuthActivityValidator:
    InterfaceOAuthActivityValidator | undefined = options.controlPlaneOperations
    ? async (evidence) => {
        const operations = await options.controlPlaneOperations?.(env);
        return (
          (await operations?.interfaces?.validatePrincipalOAuth2TokenEvidence(
            evidence,
          )) === true
        );
      }
    : undefined;
  const commonOptions = {
    issuer,
    clients,
    store,
    patWorkspaceMembershipReader:
      options.patWorkspaceMembershipReader?.(env),
    personalAccessTokenSelfServiceScopes:
      options.personalAccessTokenSelfServiceScopes?.(env),
    upstreamOAuth: parseUpstreamOAuthFailClosed(env),
    passkeys: parsePasskeysFailClosed(env),
    loginEmailAllowlist: parseLoginEmailAllowlist(env, issuer),
    ...(!identityOnly && options.controlPlaneOperations
      ? {
          resolveControlPlaneOperations: () =>
            cachedControlPlaneOperations(env, options),
        }
      : {}),
    ...(interfaceOAuthActivityValidator
      ? { interfaceOAuthActivityValidator }
      : {}),
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

function cachedControlPlaneOperations<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  options: CreateCloudflareWorkerOptions<TEnv>,
): Promise<ControlPlaneOperations | undefined> {
  const cached = controlPlaneOperationsByEnv.get(env);
  if (cached) return cached;
  const attempt = options.controlPlaneOperations!(env).catch(
    (error: unknown) => {
      if (controlPlaneOperationsByEnv.get(env) === attempt) {
        controlPlaneOperationsByEnv.delete(env);
      }
      throw error;
    },
  );
  controlPlaneOperationsByEnv.set(env, attempt);
  return attempt;
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function resolveCloudflareSessionHashSalt(env: CloudflareWorkerEnv): string {
  const resolved = resolveSessionHashSaltConfig({
    salt: optionalString(env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT),
    allowDevFallback: optionalString(env.LOCAL_SUBSTRATE_TEST_BED) === "1",
  });
  if (resolved) return resolved;
  throw new TypeError(
    "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT must be set for the Cloudflare Worker account session store",
  );
}

function accountsD1SchemaMode(
  env: Pick<CloudflareWorkerEnv, "TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE">,
): D1AccountsSchemaMode {
  return resolveD1AccountsSchemaMode(env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE);
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
  const sessionId = optionalString(env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID);
  await store.saveAccount({
    subject,
    displayName: "Local Substrate",
    email: "local-substrate@takosumi.test",
    createdAt: now,
    updatedAt: now,
  });
  // No hard-coded fallback: this session id is a bearer that reaches the real
  // OpenTofu runner, and the test bed's ingress can be published on a LAN. A
  // built-in literal would be a credential every reader of this repo holds, so
  // an unset id seeds the fixture account with no replayable session
  // (scripts/up.sh generates one per bring-up).
  if (!sessionId) return;
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
    const clients = value.map(parseClientRecord);
    const confidentialClientId = optionalString(
      env.TAKOSUMI_ACCOUNTS_CLIENT_ID,
    );
    const confidentialClientSecret = optionalString(
      env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET,
    );
    const confidentialAuthMethod = parseClientAuthMethod(
      env.TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD,
    );
    if (
      confidentialClientId === undefined &&
      (confidentialClientSecret !== undefined ||
        confidentialAuthMethod !== undefined)
    ) {
      throw new TypeError(
        "TAKOSUMI_ACCOUNTS_CLIENT_ID must select the multi-client entry receiving the confidential client secret",
      );
    }
    if (confidentialClientId === undefined) return clients;
    const selected = clients.find(
      (client) => client.clientId === confidentialClientId,
    );
    if (!selected) {
      throw new TypeError(
        "TAKOSUMI_ACCOUNTS_CLIENT_ID must name an exact TAKOSUMI_ACCOUNTS_CLIENTS entry",
      );
    }
    return clients.map((client) =>
      client.clientId === confidentialClientId
        ? {
            ...client,
            ...(confidentialClientSecret !== undefined
              ? { clientSecret: confidentialClientSecret }
              : {}),
            ...(confidentialAuthMethod !== undefined
              ? { tokenEndpointAuthMethod: confidentialAuthMethod }
              : {}),
          }
        : client,
    );
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

export function configuredTakosumiMobileOidcClientId(
  env: CloudflareWorkerEnv,
): string | undefined {
  const configuredClientId = optionalString(env.TAKOSUMI_MOBILE_OIDC_CLIENT_ID);
  if (!configuredClientId) return undefined;
  return resolveTakosumiMobileOidcClientId({
    configuredClientId,
    clients: parseConfiguredOidcClients(env),
  });
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
  return pathname === "/favicon.ico" || pathname.startsWith("/assets/");
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

/** The hosted docs are a prerendered VitePress site whose bootstrap runs from
 * inline <script> elements (appearance, platform class, and the build's page
 * hash map). The SPA policy has no inline allowance, so those elements were
 * blocked and the docs app booted without its site data. */
function isDocsDocumentPath(pathname: string): boolean {
  return pathname === "/docs" || pathname.startsWith("/docs/");
}

const INLINE_SCRIPT_PATTERN =
  /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function base64FromBytes(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Derives the exact `'sha256-…'` source expressions for a document's inline
 * scripts. Hashing the served bytes keeps the policy correct for every future
 * docs build: a hard-coded list would silently rot the next time the page hash
 * map changes, which is the failure this replaces. */
async function inlineScriptHashes(html: string): Promise<readonly string[]> {
  const hashes = new Set<string>();
  for (const match of html.matchAll(INLINE_SCRIPT_PATTERN)) {
    const source = match[1] ?? "";
    if (source.trim() === "") continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    hashes.add(`'sha256-${base64FromBytes(digest)}'`);
  }
  return [...hashes];
}

function cspWithInlineScriptHashes(hashes: readonly string[]): string {
  if (hashes.length === 0) return DASHBOARD_CSP;
  return DASHBOARD_CSP.replace(
    "script-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`,
  );
}

/** Attach a Content-Security-Policy to the SPA HTML document so a
 * javascript:/data: href or injected inline script fails closed. Prerendered
 * docs additionally allow exactly the inline scripts they actually ship, by
 * hash — never `unsafe-inline`, which would reopen the whole origin. */
async function withDashboardDocumentCsp(
  response: Response,
  pathname: string,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) return response;
  if (!isDocsDocumentPath(pathname)) {
    const headers = new Headers(response.headers);
    headers.set("content-security-policy", DASHBOARD_CSP);
    headers.set("referrer-policy", "no-referrer");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const html = await response.text();
  const headers = new Headers(response.headers);
  headers.set(
    "content-security-policy",
    cspWithInlineScriptHashes(await inlineScriptHashes(html)),
  );
  headers.set("referrer-policy", "no-referrer");
  return new Response(html, {
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
