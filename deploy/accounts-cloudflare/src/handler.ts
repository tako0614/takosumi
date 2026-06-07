import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import {
  type AccountsHandler,
  type AccountsJsonWebKey,
  type AppInstallationExportWorker,
  createAccountsHandler,
  createEphemeralAccountsHandler,
  type ControlPlaneOperations,
  createOpenManagedOfferingAccessPolicy,
  customOidcOAuthProvider,
  D1AccountsStore,
  type D1Database,
  type DeployControlOperations,
  githubOAuthProvider,
  googleOAuthProvider,
  type JsonWebKeySet,
  type ManagedOfferingAccessPolicy,
  type OidcClientAuthMethod,
  type OidcClientRegistration,
  type PasskeyHttpOptions,
  signEs256Jwt,
  type StripeBillingOptions,
  type UpstreamOAuthClientRegistration,
  type UpstreamOAuthOptions,
  type WorkloadPlatformServiceResolverHttpOptions,
} from "@takosjp/takosumi-accounts-service";
import { parseInstallLink } from "takosumi-contract/install-link";
import { evaluateSourceUrl } from "../../../src/service/domains/sources/url-policy.ts";
import { isAccountsApiPath, isWorkerLocalPath } from "./routes.ts";

export interface CloudflareWorkerEnv {
  readonly [name: string]: unknown;
  readonly TAKOSUMI_ACCOUNTS_DB: D1Database;
  // Cloudflare Static Assets binding for the bundled dashboard SPA
  // (packages/dashboard-ui → .output/public). Present when the wrangler
  // `[assets]` block is configured; absent in API-only deploys/tests.
  readonly ASSETS?: { fetch(request: Request): Promise<Response> };
  readonly TAKOSUMI_ACCOUNTS_EXPORTS?: R2Bucket;
  readonly TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL?: string;
  readonly TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS?: string;
  readonly TAKOSUMI_ACCOUNTS_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_SUBJECT?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENTS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_REDIRECT_URIS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD?: string;
  readonly TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK?: string;
  readonly TAKOSUMI_ACCOUNTS_ES256_KEY_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_API_BASE?: string;
  readonly TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_TOLERANCE_SECONDS?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_RP_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_RP_NAME?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_ORIGIN?: string;
  readonly TAKOSUMI_ACCOUNTS_PASSKEY_SESSION_TTL_MS?: string;
  readonly TAKOSUMI_ACCOUNTS_SUBJECT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_REDIRECT_URI?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_SCOPES?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_AUTHORIZATION_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_TOKEN_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_USERINFO_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_REDIRECT_URI?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_SCOPES?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_AUTHORIZATION_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_TOKEN_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_USERINFO_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SUBJECT_CLAIM?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI?: string;
  readonly TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SCOPES?: string;
  readonly TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS?: string;
  readonly TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST?: string;
  readonly TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_EVIDENCE_REF?: string;
  readonly TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_APPROVAL_REF?: string;
  readonly TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_PUBLIC_SUMMARY?: string;
  readonly TAKOSUMI_PRODUCTION_HARDENING_GATE?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF?: string;
  readonly TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF?: string;
  readonly TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST?: string;
  readonly TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL?: string;
  readonly TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_TOKEN?: string;
  // Shared deploy-control bearer for the in-process transport; must match the
  // embedded deploy-control service's `TAKOSUMI_DEPLOY_CONTROL_TOKEN` gate.
  readonly TAKOSUMI_DEPLOY_CONTROL_TOKEN?: string;
  readonly TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN?: string;
  readonly TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICES_INTERNAL_URL?: string;
  readonly TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL?: string;
  readonly LOCAL_SUBSTRATE_TEST_BED?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_SESSION_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_ACCOUNT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_LOCAL_DEV_SPACE_ID?: string;
}

export interface CloudflareWorkerHandler {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response>;
}

export interface CreateCloudflareWorkerOptions {
  /**
   * In-process deploy-control transport. When supplied, the deploy-control proxy
   * seam (`deployControl.fetch`) is routed to this fetch instead of an HTTP URL,
   * so the deploy-control plane runs in-process and owns no public route. The
   * unified Takos worker passes the embedded deploy-control service's
   * `app.fetch` here.
   */
  readonly deployControlFetch?: (env: CloudflareWorkerEnv) => typeof fetch;
  /**
   * In-process deploy-control typed operations. When supplied, the proxy calls
   * these contract-DTO operations directly instead of building a synthetic
   * Request and dialing it back through the embedded router in the same worker:
   * no self-issued Bearer handshake, no JSON serialize/parse round-trip. The
   * unified Takos worker passes the embedded service's typed `operations` facade
   * here. `deployControlFetch` remains as the fallback transport (and the only
   * transport for a genuine remote deploy-control origin).
   */
  readonly deployControlOperations?: (
    env: CloudflareWorkerEnv,
  ) => Promise<DeployControlOperations | undefined>;
  /**
   * In-process control-plane operations facade backing the session-authed
   * `/v1/control/*` account-plane routes the dashboard SPA calls (M10). The
   * platform worker passes the embedded deploy-control service's typed
   * `operations` facade here; it structurally satisfies {@link
   * ControlPlaneOperations}. When omitted the control routes 503 after the
   * session gate.
   */
  readonly controlPlaneOperations?: (
    env: CloudflareWorkerEnv,
  ) => Promise<ControlPlaneOperations | undefined>;
}

export interface R2Bucket {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
    options?: R2PutOptions,
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBody | null>;
}

export interface R2PutOptions {
  readonly httpMetadata?: {
    readonly contentType?: string;
    readonly contentEncoding?: string;
  };
  readonly customMetadata?: Record<string, string>;
}

export interface R2ObjectBody {
  readonly body: ReadableStream<Uint8Array>;
  readonly httpMetadata?: {
    readonly contentType?: string;
    readonly contentEncoding?: string;
  };
  readonly customMetadata?: Record<string, string>;
  writeHttpMetadata?(headers: Headers): void;
}

const handlers = new WeakMap<CloudflareWorkerEnv, Promise<AccountsHandler>>();
const r2ExportDownloadPrefix = "/__takosumi/exports/";
const defaultExportDownloadTtlMs = 24 * 60 * 60 * 1000;

type Es256PrivateJwk = JsonWebKey & {
  readonly kid?: string;
  readonly x?: string;
  readonly y?: string;
};

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions = {},
): CloudflareWorkerHandler {
  return {
    async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
      const url = new URL(request.url);
      if (isWorkerLocalPath(url.pathname)) {
        return Response.json({
          ok: true,
          provider: "cloudflare",
          service: "takosumi-accounts",
          persistence: "d1+r2",
        });
      }
      const exportDownload = await maybeHandleR2ExportDownload(request, env);
      if (exportDownload) return exportDownload;
      // External install link (Core Specification §12 / §30). Parses the
      // `?source=git::…` packed form or the simple `?git=&ref=&path=` form,
      // validates the resolved Git URL against the canonical Source URL policy,
      // and 302-redirects once to the dashboard SPA install flow with the
      // validated params re-encoded. The normalized URL carries an internal
      // marker so the second fetch falls through to ASSETS instead of looping.
      const installLink = maybeHandleInstallLink(request, url);
      if (installLink) return installLink;
      // Non-API paths = the dashboard SPA, served from this Worker's static
      // assets (deep links fall back to index.html via not_found_handling).
      // API namespaces, and any deploy without the ASSETS binding, fall
      // through to the accounts handler below.
      if (
        env.ASSETS &&
        (request.method === "GET" || request.method === "HEAD") &&
        !isAccountsApiPath(url.pathname)
      ) {
        return await env.ASSETS.fetch(request);
      }
      try {
        const handler = await cachedAccountsHandler(env, options);
        return await handler(request);
      } catch (error) {
        return Response.json({
          error: "worker_configuration_error",
          error_description: error instanceof Error
            ? error.message
            : String(error),
        }, { status: 500 });
      }
    },
  };
}

async function cachedAccountsHandler(
  env: CloudflareWorkerEnv,
  options: CreateCloudflareWorkerOptions,
): Promise<AccountsHandler> {
  let handler = handlers.get(env);
  if (!handler) {
    handler = buildAccountsHandler(env, options);
    handlers.set(env, handler);
  }
  return await handler;
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
const EXPECTED_D1_SCHEMA_VERSION = 0;

async function buildAccountsHandler(
  env: CloudflareWorkerEnv,
  options: CreateCloudflareWorkerOptions,
): Promise<AccountsHandler> {
  if (!env.TAKOSUMI_ACCOUNTS_DB) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
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
  const clients = parseClients(env);
  const deployControlOperations = await options.deployControlOperations?.(env);
  const controlPlaneOperations = await options.controlPlaneOperations?.(env);
  const commonOptions = {
    issuer,
    clients,
    store,
    stripeBilling: parseStripeBilling(env),
    upstreamOAuth: parseUpstreamOAuth(env),
    passkeys: parsePasskeys(env),
    managedOfferingAccess: parseManagedOfferingAccess(env),
    deployControl: parseDeployControl(
      env,
      options.deployControlFetch?.(env),
      deployControlOperations,
    ),
    ...(controlPlaneOperations ? { controlPlaneOperations } : {}),
    workloadPlatformServices: parseWorkloadPlatformServices(env),
    exportWorker: parseR2ExportWorker(env, issuer),
    exportDownloadSigningSecret: optionalString(
      env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET,
    ),
  };
  const stableOidc = await parseStableOidcFlow(env);
  if (stableOidc) {
    return createAccountsHandler({
      ...commonOptions,
      jwks: stableOidc.jwks,
      oidcFlow: stableOidc.oidcFlow,
      launchTokens: stableOidc.launchTokens,
    });
  }
  return await createEphemeralAccountsHandler({
    ...commonOptions,
    subject: optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT),
  });
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
// `packages/cli/src/cli-accounts-db.ts`'s `D1_SCHEMA_MIGRATIONS_TABLE_SQL`).
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
  const accountId =
    optionalString(env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_ACCOUNT_ID) ??
      "acct_local";
  const spaceId = optionalString(env.TAKOSUMI_ACCOUNTS_LOCAL_DEV_SPACE_ID) ??
    "space_local";
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
  await store.saveLedgerAccount({
    accountId,
    legalOwnerSubject: subject,
    createdAt: now,
    updatedAt: now,
  });
  await store.saveSpace({
    spaceId,
    accountId,
    kind: "personal",
    displayName: "Local substrate",
    createdAt: now,
    updatedAt: now,
  });
}

function localTakosumiSubject(value: string): TakosumiSubject {
  if (value.startsWith("tsub_")) return value as TakosumiSubject;
  throw new TypeError(
    "TAKOSUMI_ACCOUNTS_LOCAL_DEV_SUBJECT must start with tsub_",
  );
}

async function parseStableOidcFlow(
  env: CloudflareWorkerEnv,
): Promise<
  | {
    readonly jwks: JsonWebKeySet;
    readonly oidcFlow: {
      readonly subject: string;
      readonly pairwiseSubjectSecret: string;
      readonly issueIdToken: (
        claims: Record<string, unknown>,
      ) => Promise<string>;
    };
    readonly launchTokens: {
      readonly pairwiseSubjectSecret: string;
    };
  }
  | undefined
> {
  const rawJwk = optionalString(env.TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK);
  if (!rawJwk) return undefined;
  const privateJwk = JSON.parse(rawJwk) as Es256PrivateJwk;
  const kid = optionalString(env.TAKOSUMI_ACCOUNTS_ES256_KEY_ID) ??
    optionalString(privateJwk.kid) ??
    "takosumi-accounts-cloudflare-accounts";
  const pairwiseSubjectSecret = optionalString(
    env.TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET,
  );
  const launchPairwiseSubjectSecret = optionalString(
    env.TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET,
  );
  if (!pairwiseSubjectSecret || !launchPairwiseSubjectSecret) {
    throw new TypeError(
      "Stable OIDC signing requires TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET and TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET",
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
  return {
    jwks: { keys: [publicJwk] },
    oidcFlow: {
      subject: optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT) ??
        "tsub_cloudflare_seed",
      pairwiseSubjectSecret,
      issueIdToken: (claims) =>
        signEs256Jwt({
          header: { alg: "ES256", typ: "JWT", kid },
          claims,
          privateKey,
        }),
    },
    launchTokens: {
      pairwiseSubjectSecret: launchPairwiseSubjectSecret,
    },
  };
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

function parseClients(
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
  return [{
    clientId,
    redirectUris,
    clientSecret: optionalString(env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET),
    tokenEndpointAuthMethod: parseClientAuthMethod(
      env.TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD,
    ),
  }];
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
  return {
    clientId,
    redirectUris,
    clientSecret: optionalString(value.clientSecret),
    tokenEndpointAuthMethod: parseClientAuthMethod(
      optionalString(value.tokenEndpointAuthMethod),
    ),
  };
}

function parseClientAuthMethod(
  value: string | undefined,
): OidcClientAuthMethod | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  if (
    raw !== "client_secret_basic" && raw !== "client_secret_post" &&
    raw !== "none"
  ) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD must be one of: client_secret_basic, client_secret_post, none",
    );
  }
  return raw;
}

function parseStripeBilling(
  env: CloudflareWorkerEnv,
): StripeBillingOptions | undefined {
  const secretKey = optionalString(env.TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY);
  const webhookSecret = optionalString(
    env.TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET,
  );
  const stripeApiBase = optionalString(env.TAKOSUMI_ACCOUNTS_STRIPE_API_BASE);
  const webhookToleranceSeconds = optionalInteger(
    env.TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  );
  if (!secretKey && !webhookSecret && !stripeApiBase) return undefined;
  if (!secretKey || !webhookSecret) {
    throw new TypeError(
      "Stripe billing requires TAKOSUMI_ACCOUNTS_STRIPE_SECRET_KEY and TAKOSUMI_ACCOUNTS_STRIPE_WEBHOOK_SECRET",
    );
  }
  return {
    secretKey,
    webhookSecret,
    stripeApiBase,
    webhookToleranceSeconds,
  };
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
  const providers: UpstreamOAuthClientRegistration[] = [];
  const github = parseBuiltinUpstreamProvider(env, "GITHUB");
  if (github) {
    providers.push({
      ...github,
      provider: githubOAuthProvider(
        parseBuiltinProviderOverrides(env, "GITHUB"),
      ),
    });
  }
  const google = parseBuiltinUpstreamProvider(env, "GOOGLE");
  if (google) {
    providers.push({
      ...google,
      provider: googleOAuthProvider(
        parseBuiltinProviderOverrides(env, "GOOGLE"),
      ),
    });
  }
  const oidc = parseCustomOidcUpstreamProvider(env);
  if (oidc) providers.push(oidc);

  const subjectSecret = optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT_SECRET);
  const sessionTtlMs = optionalInteger(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_SESSION_TTL_MS,
  );
  if (!subjectSecret && providers.length === 0 && sessionTtlMs === undefined) {
    return undefined;
  }
  if (!subjectSecret || providers.length === 0) {
    throw new TypeError(
      "Upstream OAuth requires TAKOSUMI_ACCOUNTS_SUBJECT_SECRET and at least one upstream provider client",
    );
  }
  return { subjectSecret, providers, sessionTtlMs };
}

function parseBuiltinProviderOverrides(
  env: CloudflareWorkerEnv,
  provider: "GITHUB" | "GOOGLE",
): {
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userInfoEndpoint?: string;
} {
  const prefix = `TAKOSUMI_ACCOUNTS_UPSTREAM_${provider}_`;
  return {
    issuer: optionalString(env[`${prefix}ISSUER`]),
    authorizationEndpoint: optionalString(
      env[`${prefix}AUTHORIZATION_ENDPOINT`],
    ),
    tokenEndpoint: optionalString(env[`${prefix}TOKEN_ENDPOINT`]),
    userInfoEndpoint: optionalString(env[`${prefix}USERINFO_ENDPOINT`]),
  };
}

function parseBuiltinUpstreamProvider(
  env: CloudflareWorkerEnv,
  provider: "GITHUB" | "GOOGLE",
): Omit<UpstreamOAuthClientRegistration, "provider"> | undefined {
  const prefix = `TAKOSUMI_ACCOUNTS_UPSTREAM_${provider}_`;
  const clientId = optionalString(env[`${prefix}CLIENT_ID`]);
  const clientSecret = optionalString(env[`${prefix}CLIENT_SECRET`]);
  const redirectUri = optionalString(env[`${prefix}REDIRECT_URI`]);
  const scopes = splitList(env[`${prefix}SCOPES`]);
  if (!clientId && !clientSecret && !redirectUri && scopes.length === 0) {
    return undefined;
  }
  if (!clientId || !redirectUri) {
    throw new TypeError(
      `${prefix}CLIENT_ID and ${prefix}REDIRECT_URI are required when configuring ${provider.toLowerCase()} upstream OAuth`,
    );
  }
  return {
    providerId: provider.toLowerCase(),
    clientId,
    clientSecret,
    redirectUri,
    scopes: scopes.length > 0 ? scopes : undefined,
  };
}

function parseCustomOidcUpstreamProvider(
  env: CloudflareWorkerEnv,
): UpstreamOAuthClientRegistration | undefined {
  const providerId = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_PROVIDER_ID,
  );
  const issuer = optionalString(env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_ISSUER);
  const authorizationEndpoint = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_AUTHORIZATION_ENDPOINT,
  );
  const tokenEndpoint = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_TOKEN_ENDPOINT,
  );
  const userInfoEndpoint = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_USERINFO_ENDPOINT,
  );
  const clientId = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_ID,
  );
  const clientSecret = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_CLIENT_SECRET,
  );
  const redirectUri = optionalString(
    env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_REDIRECT_URI,
  );
  const scopes = splitList(env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SCOPES);
  const configured = Boolean(
    providerId || issuer || authorizationEndpoint || tokenEndpoint ||
      userInfoEndpoint || clientId || clientSecret || redirectUri ||
      scopes.length > 0,
  );
  if (!configured) return undefined;
  if (
    !providerId || !issuer || !authorizationEndpoint || !tokenEndpoint ||
    !userInfoEndpoint || !clientId || !redirectUri
  ) {
    throw new TypeError(
      "Custom upstream OIDC requires provider id, issuer, endpoints, client id, and redirect uri",
    );
  }
  return {
    providerId,
    clientId,
    clientSecret,
    redirectUri,
    scopes: scopes.length > 0 ? scopes : undefined,
    provider: customOidcOAuthProvider({
      id: providerId,
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      userInfoEndpoint,
      defaultScopes: scopes.length > 0 ? scopes : undefined,
      subjectClaim: optionalString(
        env.TAKOSUMI_ACCOUNTS_UPSTREAM_OIDC_SUBJECT_CLAIM,
      ),
    }),
  };
}

// Synthetic absolute base for the in-process deploy-control transport. The proxy
// only uses this to build `new URL(path, url)`; the actual transport is the
// injected `fetch`, so the host part is never dialed.
const IN_PROCESS_DEPLOY_CONTROL_BASE = "https://deploy-control.internal/";

function parseDeployControl(
  env: CloudflareWorkerEnv,
  deployControlFetch?: typeof fetch,
  deployControlOperations?: DeployControlOperations,
): {
  url: string;
  token?: string;
  fetch?: typeof fetch;
  operations?: DeployControlOperations;
} | undefined {
  // In-process transport (unified single-worker deployment): the deploy-control
  // plane runs in this same worker. When the host injects the typed `operations`
  // facade the proxy calls the controller directly (no Bearer handshake, no JSON
  // round-trip); the injected fetch remains a fallback transport. The bearer
  // (still threaded for the fetch fallback) must match the embedded service's
  // `TAKOSUMI_DEPLOY_CONTROL_TOKEN` (which gates `authorizeDeployControl`), so we
  // read that shared secret here and pass a syntactically valid synthetic base.
  if (deployControlFetch || deployControlOperations) {
    const token = optionalString(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN) ??
      optionalString(env.TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_TOKEN);
    const url = optionalString(env.TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL) ??
      IN_PROCESS_DEPLOY_CONTROL_BASE;
    return {
      url,
      ...(token ? { token } : {}),
      ...(deployControlFetch ? { fetch: deployControlFetch } : {}),
      ...(deployControlOperations ? { operations: deployControlOperations } : {}),
    };
  }
  const url = optionalString(env.TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL);
  if (!url) return undefined;
  const token = optionalString(env.TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_TOKEN);
  return token ? { url, token } : { url };
}

function parseWorkloadPlatformServices(
  env: CloudflareWorkerEnv,
): WorkloadPlatformServiceResolverHttpOptions | undefined {
  const token = optionalString(
    env.TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN,
  );
  if (!token) return undefined;
  const billingPortalUrl = optionalString(
    env.TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL,
  );
  const internalUrl = optionalString(
    env.TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICES_INTERNAL_URL,
  );
  return {
    token,
    ...(billingPortalUrl ? { billingPortalUrl } : {}),
    ...(internalUrl ? { internalUrl } : {}),
  };
}

function parseR2ExportWorker(
  env: CloudflareWorkerEnv,
  issuer: string,
): AppInstallationExportWorker | undefined {
  const bucket = env.TAKOSUMI_ACCOUNTS_EXPORTS;
  const secret = optionalString(env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET);
  const baseUrl = optionalString(
    env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL,
  ) ?? issuer;
  const ttlMs = optionalInteger(
    env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS,
  ) ?? defaultExportDownloadTtlMs;
  const configured = Boolean(
    bucket || secret ||
      optionalString(env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL) ||
      optionalString(env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS),
  );
  if (!configured) return undefined;
  if (!bucket) {
    throw new TypeError(
      "R2 export worker requires TAKOSUMI_ACCOUNTS_EXPORTS binding",
    );
  }
  if (!secret) {
    throw new TypeError(
      "R2 export worker requires TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
    );
  }
  if (ttlMs <= 0) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_TTL_MS must be greater than zero",
    );
  }
  return createR2InstallationExportWorker({
    bucket,
    downloadBaseUrl: validateHttpUrl(
      baseUrl,
      "TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL",
    ),
    downloadSecret: secret,
    ttlMs,
  });
}

export function createR2InstallationExportWorker(options: {
  readonly bucket: R2Bucket;
  readonly downloadBaseUrl: string;
  readonly downloadSecret: string;
  readonly ttlMs?: number;
  readonly now?: () => Date;
}): AppInstallationExportWorker {
  const ttlMs = options.ttlMs ?? defaultExportDownloadTtlMs;
  return async (input) => {
    if (input.request.includeData) {
      throw new Error(
        "Cloudflare R2 metadata export does not include tenant data; use a substrate export worker for data-bearing export",
      );
    }
    if (input.request.encryption.method !== "none") {
      throw new Error(
        "Cloudflare R2 metadata export does not support archive encryption; use a substrate export worker for encrypted archives",
      );
    }

    const now = options.now?.() ?? new Date();
    const downloadExpiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const objectKey = r2ExportObjectKey(
      input.installation.installationId,
      input.operationId,
    );
    const document = {
      kind: "takosumi.accounts.cloudflare-r2-installation-export@v1",
      version: "v1",
      exportedAt: now.toISOString(),
      operationId: input.operationId,
      request: input.request,
      bundle: input.bundle,
    };
    await options.bucket.put(
      objectKey,
      `${JSON.stringify(document, null, 2)}\n`,
      {
        httpMetadata: { contentType: "application/json; charset=utf-8" },
        customMetadata: {
          installationId: input.installation.installationId,
          accountId: input.installation.accountId,
          spaceId: input.installation.spaceId,
          operationId: input.operationId,
          format: input.request.format,
          encryption: input.request.encryption.method,
          dataIncluded: "false",
        },
      },
    );
    return {
      downloadUrl: await signedR2ExportDownloadUrl({
        baseUrl: options.downloadBaseUrl,
        objectKey,
        expiresAtMs: new Date(downloadExpiresAt).getTime(),
        secret: options.downloadSecret,
      }),
      downloadExpiresAt,
    };
  };
}

/**
 * External install link (Core Specification §12 / §30): `GET /install`.
 *
 * Parses both link forms via the contract `parseInstallLink`, validates the
 * resolved Git URL against the canonical Source URL policy
 * ({@link evaluateSourceUrl} — https/ssh only, no embedded credentials, no
 * `file://`), and on success 302-redirects once to the dashboard SPA install
 * flow `/install?git=<url>&ref=<ref>&path=<path>&takosumiInstall=1` with the
 * validated params re-encoded. The marker is internal and makes the normalized
 * dashboard URL fall through to ASSETS on the next request. A malformed link or
 * a policy-rejected URL returns 400 JSON. Returns `undefined` for any path other
 * than `/install`, for plain `/install`, and for already-normalized dashboard
 * URLs so the caller falls through to the rest of the worker surface.
 */
function maybeHandleInstallLink(
  request: Request,
  url: URL,
): Response | undefined {
  if (url.pathname !== "/install") return undefined;
  if (url.search.length === 0 || url.searchParams.get("takosumiInstall") === "1") {
    return undefined;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const target = parseInstallLink(url);
  if (!target) {
    return Response.json(
      {
        error: "invalid_install_link",
        error_description:
          "expected ?source=git::<url> or ?git=<url>&ref=<ref>&path=<path>",
      },
      { status: 400 },
    );
  }
  const policy = evaluateSourceUrl(target.url);
  if (!policy.ok) {
    return Response.json(
      {
        error: "invalid_install_source_url",
        error_description: `source url rejected by policy: ${policy.reason}`,
      },
      { status: 400 },
    );
  }
  const params = new URLSearchParams();
  params.set("git", target.url);
  if (target.ref.length > 0) params.set("ref", target.ref);
  if (target.path.length > 0 && target.path !== ".") {
    params.set("path", target.path);
  }
  params.set("takosumiInstall", "1");
  // Redirect into the SPA path route so the dashboard owns the install flow UI.
  const location = `/install?${params.toString()}`;
  return new Response(null, { status: 302, headers: { location } });
}

async function maybeHandleR2ExportDownload(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(r2ExportDownloadPrefix)) return undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const bucket = env.TAKOSUMI_ACCOUNTS_EXPORTS;
  const secret = optionalString(env.TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET);
  if (!bucket || !secret) {
    return Response.json({
      error: "worker_configuration_error",
      error_description:
        "R2 export downloads require TAKOSUMI_ACCOUNTS_EXPORTS and TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET",
    }, { status: 500 });
  }
  const encodedKey = url.pathname.slice(r2ExportDownloadPrefix.length);
  const decodedKey = safeDecodeURIComponent(encodedKey);
  if (!decodedKey.ok) {
    return Response.json({ error: "invalid_export_download_url" }, {
      status: 400,
    });
  }
  const objectKey = decodedKey.value;
  const expiresRaw = url.searchParams.get("expires") ?? "";
  const signature = url.searchParams.get("sig") ?? "";
  const expiresAtMs = Number(expiresRaw);
  if (
    !objectKey || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0 ||
    !signature
  ) {
    return Response.json({ error: "invalid_export_download_url" }, {
      status: 400,
    });
  }
  if (Date.now() > expiresAtMs) {
    return Response.json({ error: "export_download_expired" }, {
      status: 410,
    });
  }
  const expectedSignature = await r2ExportDownloadSignature({
    objectKey,
    expiresAtMs,
    secret,
  });
  if (!constantTimeEqual(signature, expectedSignature)) {
    return Response.json({ error: "invalid_export_download_signature" }, {
      status: 403,
    });
  }
  const object = await bucket.get(objectKey);
  if (!object) {
    return Response.json({ error: "export_artifact_not_found" }, {
      status: 404,
    });
  }
  const headers = new Headers({
    "cache-control": "private, max-age=0, no-store",
    "x-content-type-options": "nosniff",
  });
  object.writeHttpMetadata?.(headers);
  if (!headers.has("content-type")) {
    headers.set(
      "content-type",
      object.httpMetadata?.contentType ?? "application/octet-stream",
    );
  }
  return new Response(request.method === "HEAD" ? null : object.body, {
    headers,
  });
}

function safeDecodeURIComponent(
  value: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false } {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false };
  }
}

function r2ExportObjectKey(
  installationId: string,
  operationId: string,
): string {
  return [
    "installation-exports",
    objectKeySegment(installationId),
    objectKeySegment(operationId),
    "takos-export.json",
  ].join("/");
}

function objectKeySegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._=-]/g, "_");
  return segment.length > 0 ? segment : "unknown";
}

async function signedR2ExportDownloadUrl(input: {
  readonly baseUrl: string;
  readonly objectKey: string;
  readonly expiresAtMs: number;
  readonly secret: string;
}): Promise<string> {
  const url = new URL(
    `${r2ExportDownloadPrefix}${encodeURIComponent(input.objectKey)}`,
    input.baseUrl,
  );
  url.searchParams.set("expires", String(input.expiresAtMs));
  url.searchParams.set(
    "sig",
    await r2ExportDownloadSignature(input),
  );
  return url.toString();
}

async function r2ExportDownloadSignature(input: {
  readonly objectKey: string;
  readonly expiresAtMs: number;
  readonly secret: string;
}): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${input.objectKey}\n${input.expiresAtMs}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function validateHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${label} must be an absolute HTTP URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError(`${label} must be an HTTP(S) URL`);
  }
  return url.toString();
}

function parseManagedOfferingAccess(
  env: CloudflareWorkerEnv,
): ManagedOfferingAccessPolicy {
  const status = optionalString(
    env.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS,
  ) ?? "closed";
  if (status === "closed") return { status: "closed" };
  if (status !== "open") {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS must be one of: closed, open",
    );
  }
  const issuerRaw = optionalString(env.TAKOSUMI_ACCOUNTS_ISSUER);
  if (!issuerRaw) {
    throw new TypeError(
      "Open managed offering access requires TAKOSUMI_ACCOUNTS_ISSUER",
    );
  }
  validateHttpUrl(issuerRaw, "TAKOSUMI_ACCOUNTS_ISSUER");
  const evidenceDigest = optionalString(
    env.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST,
  );
  if (!evidenceDigest) {
    throw new TypeError(
      "Open managed offering access requires TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_READINESS_DIGEST",
    );
  }
  return createOpenManagedOfferingAccessPolicy({
    evidenceRef: optionalString(
      env.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_EVIDENCE_REF,
    ),
    approvalRef: optionalString(
      env.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_APPROVAL_REF,
    ),
    publicSummary: optionalString(
      env.TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_PUBLIC_SUMMARY,
    ),
  }, {
    ready: true,
    evidenceDigest,
  });
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

function splitList(value: unknown): readonly string[] {
  return (optionalString(value) ?? "")
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
