/**
 * Bun + Postgres entry point for Takosumi Accounts.
 *
 * Substrate-neutral reference distribution: the same accounts handler
 * that ships in the Cloudflare Workers scaffold (`deploy/accounts-cloudflare/`)
 * runs here against a `PostgresAccountsStore` and Bun. Use this when
 * self-hosting on a VM, container, or k8s pod instead of Cloudflare.
 *
 * Run with `bun deploy/node-postgres/src/server.ts`.
 */
import type {
  AccountsHandler,
  AccountsJsonWebKey,
  ControlPlaneOperations,
  JsonWebKeySet,
} from "@takosjp/takosumi-accounts-service";
import {
  createAccountsHandler,
  createEphemeralAccountsHandler,
  PostgresAccountsStore,
  signEs256Jwt,
} from "@takosjp/takosumi-accounts-service";
import {
  type NodeAccountsServerConfig,
  type NodeAccountsStableOidcConfig,
  parseEnv,
} from "./handler.ts";
import { buildComposedApp } from "./composed-app.ts";
import { createPostgresPool, wrapPool, wrapServiceSqlClient, type PgPool } from "./postgres-runtime.ts";
import { startCapsuleUninstallFinalizer } from "./capsule-uninstall-finalizer.ts";
import {
  type OwnNotificationDispatcherLoop,
  startOwnNotificationDispatcher,
} from "./own-notification-dispatcher.ts";
import { planOwnNotification } from "../../../core/domains/notifications/own_notifications.ts";
import { startSourceRetirementSweeper } from "./source-retirement-sweeper.ts";
import { resolveStaticAssetsDir } from "./static-assets.ts";
import { isSecretKey, redactString } from "takosumi-contract/redaction";


type Es256PrivateJwk = JsonWebKey & {
  readonly kid?: string;
  readonly x?: string;
  readonly y?: string;
};

const healthzPath = "/healthz";
const healthzTimeoutMs = 1000;

function maskString(input: string): string {
  return redactString(input);
}
function maskValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return maskString(value);
  if (typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: maskString(value.message),
      stack: value.stack ? maskString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.map(maskValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) ? "[REDACTED]" : maskValue(v);
  }
  return out;
}
function structuredLog(
  level: "info" | "error",
  msg: string,
  fields?: Record<string, unknown>,
): void {
  const entry = {
    level,
    msg: maskString(msg),
    ts: new Date().toISOString(),
    service: "takosumi-accounts-node",
    ...(fields ? (maskValue(fields) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

/**
 * Operator-supplied overrides forwarded into the embedded service via
 * {@link buildComposedApp}. The published reference distribution passes none
 * (so `main()` behaves exactly as before); a composer that wants to attach
 * a durable SQL ledger — e.g. the local-substrate `cloud` wrapper — supplies
 * it here without duplicating the
 * pool / store / accounts-handler / serve plumbing.
 */
export interface ComposedServerOverrides {
  readonly backupStateObjectReader?: Parameters<typeof buildComposedApp>[0]["backupStateObjectReader"];
  readonly sqlClient?: Parameters<typeof buildComposedApp>[0]["sqlClient"];
  readonly privateRunFiles?: Parameters<typeof buildComposedApp>[0]["privateRunFiles"];
  readonly opentofuControlStore?: Parameters<
    typeof buildComposedApp
  >[0]["opentofuControlStore"];
  readonly opentofuRunner?: Parameters<
    typeof buildComposedApp
  >[0]["opentofuRunner"];
  readonly opentofuRunnerExecutors?: Parameters<
    typeof buildComposedApp
  >[0]["opentofuRunnerExecutors"];
  readonly runnerProfiles?: Parameters<
    typeof buildComposedApp
  >[0]["runnerProfiles"];
  readonly executionEvidenceAuthority?: Parameters<
    typeof buildComposedApp
  >[0]["executionEvidenceAuthority"];
  readonly defaultRunnerProfileId?: Parameters<
    typeof buildComposedApp
  >[0]["defaultRunnerProfileId"];
  readonly credentialRecipes?: Parameters<
    typeof buildComposedApp
  >[0]["credentialRecipes"];
  readonly operatorInstallConfigs?: Parameters<
    typeof buildComposedApp
  >[0]["operatorInstallConfigs"];
  readonly credentialRecipeDrivers?: Parameters<
    typeof buildComposedApp
  >[0]["credentialRecipeDrivers"];
  readonly operatorProviderConnections?: Parameters<
    typeof buildComposedApp
  >[0]["operatorProviderConnections"];
  readonly runCredentialIssuer?: Parameters<
    typeof buildComposedApp
  >[0]["runCredentialIssuer"];
  readonly allowOperatorScopedProviderConnections?: Parameters<
    typeof buildComposedApp
  >[0]["allowOperatorScopedProviderConnections"];
  readonly createRuntimeInputOidcClientSource?: Parameters<
    typeof buildComposedApp
  >[0]["createRuntimeInputOidcClientSource"];
  readonly runtimeBindingDerivationKey?: Parameters<
    typeof buildComposedApp
  >[0]["runtimeBindingDerivationKey"];
}

/**
 * Build and serve the one composed app this distribution runs: embed the
 * Takosumi service (`createTakosumiService`) and extend it with the Takosumi Accounts
 * surfaces. healthz runs ahead of the service + accounts fallback via
 * `preHandle`. Blocks on `serveOnAnyRuntime`.
 */
export async function buildComposedServer(
  overrides: ComposedServerOverrides = {},
): Promise<void> {
  const env = readEnv();
  const config = parseEnv(env);
  const pool = createPostgresPool(config, env);
  const queryClient = wrapPool(pool);
  const store = new PostgresAccountsStore(queryClient);
  const staticAssets = await resolveStaticAssetsDir(readEnv());
  if (!staticAssets) {
    // The server-HTML dashboard was removed, so a missing SPA build means the
    // dashboard UI is simply absent (non-API GETs fall through to a JSON 404).
    // Surface it loudly rather than silently degrading to API-only.
    structuredLog(
      "error",
      "dashboard SPA build not found; static asset serving disabled (set TAKOSUMI_ACCOUNTS_STATIC_DIR or build dashboard)",
      { event: "assets.resolution.failed" },
    );
  }

  // A notified Activity event is delivered right after it is stored; the
  // dispatcher loop only catches up (TASK-0119 own notifications).
  let ownNotifications: OwnNotificationDispatcherLoop | undefined;
  const { app, operations } = await buildComposedApp({
    config,
    store,
    onActivityRecorded: (event, context) => {
      if (ownNotifications && planOwnNotification(event, context)) {
        void ownNotifications.deliverNow(event, context);
      }
    },
    productDiscovery: {
      oidcIssuer: config.issuer,
      mobileOidcClientId: config.mobileOidcClientId,
    },
    createAccountsHandler: (controlPlaneOperations, options) =>
      buildAccountsHandler(
        config,
        store,
        controlPlaneOperations,
        options.workspaceMutationsFrozen,
      ),
    preHandle: (req) => preHandleNonServiceRequest(req, pool),
    ...(staticAssets ? { staticAssets } : {}),
    ...(overrides.opentofuRunner
      ? { opentofuRunner: overrides.opentofuRunner }
      : {}),
    ...(overrides.opentofuRunnerExecutors
      ? { opentofuRunnerExecutors: overrides.opentofuRunnerExecutors }
      : {}),
    ...(overrides.runnerProfiles
      ? { runnerProfiles: overrides.runnerProfiles }
      : {}),
    ...(overrides.executionEvidenceAuthority
      ? { executionEvidenceAuthority: overrides.executionEvidenceAuthority }
      : {}),
    ...(overrides.defaultRunnerProfileId
      ? { defaultRunnerProfileId: overrides.defaultRunnerProfileId }
      : {}),
    ...(overrides.credentialRecipes !== undefined
      ? { credentialRecipes: overrides.credentialRecipes }
      : {}),
    ...(overrides.operatorInstallConfigs !== undefined
      ? { operatorInstallConfigs: overrides.operatorInstallConfigs }
      : {}),
    ...(overrides.credentialRecipeDrivers !== undefined
      ? { credentialRecipeDrivers: overrides.credentialRecipeDrivers }
      : {}),
    ...(overrides.operatorProviderConnections !== undefined
      ? {
          operatorProviderConnections: overrides.operatorProviderConnections,
        }
      : {}),
    ...(overrides.runCredentialIssuer !== undefined
      ? { runCredentialIssuer: overrides.runCredentialIssuer }
      : {}),
    ...(overrides.allowOperatorScopedProviderConnections !== undefined
      ? {
          allowOperatorScopedProviderConnections:
            overrides.allowOperatorScopedProviderConnections,
        }
      : {}),
    ...(overrides.createRuntimeInputOidcClientSource
      ? {
          createRuntimeInputOidcClientSource:
            overrides.createRuntimeInputOidcClientSource,
        }
      : {}),
    ...(overrides.runtimeBindingDerivationKey !== undefined
      ? { runtimeBindingDerivationKey: overrides.runtimeBindingDerivationKey }
      : {}),
    sqlClient: overrides.sqlClient ?? wrapServiceSqlClient(pool),
    ...(overrides.backupStateObjectReader
      ? { backupStateObjectReader: overrides.backupStateObjectReader }
      : {}),
    ...(overrides.privateRunFiles
      ? { privateRunFiles: overrides.privateRunFiles }
      : {}),
    ...(overrides.opentofuControlStore !== undefined
      ? { opentofuControlStore: overrides.opentofuControlStore }
      : {}),
  });

  startCapsuleUninstallFinalizer({ operations, log: structuredLog });
  ownNotifications = startOwnNotificationDispatcher({
    operations,
    store,
    env,
    issuer: config.issuer,
    log: structuredLog,
  });
  startSourceRetirementSweeper({ operations, log: structuredLog,
    enabled: process.env.TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED !== "0" });

  const port = config.port;
  const hostname = config.bindHost;
  structuredLog("info", "listening", {
    event: "server.listening",
    hostname,
    port,
  });
  await serveOnAnyRuntime((req) => app.fetch(req), { port, hostname });
}

async function main(): Promise<void> {
  await buildComposedServer();
}

/**
 * Pre-service request handling shared by the composed app. Returns a health
 * response to short-circuit, or `undefined` to fall through to the embedded
 * service app + accounts fallback.
 */
async function preHandleNonServiceRequest(
  req: Request,
  pool: PgPool,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname === healthzPath) {
    return await handleHealthz(pool);
  }
  return undefined;
}

async function buildAccountsHandler(
  config: NodeAccountsServerConfig,
  store: PostgresAccountsStore,
  controlPlaneOperations?: ControlPlaneOperations,
  workspaceMutationsFrozen = true,
): Promise<AccountsHandler> {
  const commonOptions = {
    issuer: config.issuer,
    store,
    ...(config.clients ? { clients: config.clients } : {}),
    ...(config.loginEmailAllowlist
      ? { loginEmailAllowlist: config.loginEmailAllowlist }
      : {}),
    ...(config.passkeys ? { passkeys: config.passkeys } : {}),
    ...(config.upstreamOAuth ? { upstreamOAuth: config.upstreamOAuth } : {}),
    ...(controlPlaneOperations ? { controlPlaneOperations } : {}),
    workspaceMutationsFrozen,
    ...(config.appOwnershipMutationsFrozen ? { appOwnershipMutationsFrozen: true } : {}),
    ...(config.legacyWorkspaceSunset
      ? { legacyWorkspaceSunset: config.legacyWorkspaceSunset }
      : {}),
    ...(config.installedAppDelegationSources?.length
      ? { installedAppDelegationSources: config.installedAppDelegationSources }
      : {}),
    ...(config.trustedNativeClients
      ? { trustedNativeClients: config.trustedNativeClients }
      : {}),
    ...(config.activityCursorSealer
      ? { activityCursorSealer: config.activityCursorSealer }
      : {}),
    ...(config.privacyOperationsToken
      ? { privacyOperationsToken: config.privacyOperationsToken }
      : {}),
    ...(config.privacyRetentionPolicyRef
      ? { privacyRetentionPolicyRef: config.privacyRetentionPolicyRef }
      : {}),
    ...(config.notificationPushers
      ? { notificationPushers: config.notificationPushers }
      : {}),
  };
  const stableOidc = await buildStableOidc(config.stableOidc);
  if (stableOidc) {
    return createAccountsHandler({
      ...commonOptions,
      jwks: stableOidc.jwks,
      oidcFlow: stableOidc.oidcFlow,
    });
  }
  return await createEphemeralAccountsHandler({
    ...commonOptions,
    ...(config.subject ? { subject: config.subject } : {}),
  });
}

async function buildStableOidc(
  options: NodeAccountsStableOidcConfig | undefined,
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
    }
  | undefined
> {
  if (!options) return undefined;
  const parsed = JSON.parse(options.privateJwkJson) as Es256PrivateJwk;
  const kid = options.keyId ?? parsed.kid ?? "takosumi-node-postgres-accounts";
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    parsed,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  if (!parsed.x || !parsed.y) {
    throw new TypeError(
      "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK must include public x/y coordinates",
    );
  }
  const publicJwk: AccountsJsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: parsed.x,
    y: parsed.y,
    kid,
    use: "sig",
    alg: "ES256",
  };
  const previousPublicJwks = parsePreviousPublicJwks(
    options.previousPublicJwksJson,
    "TAKOSUMI_ACCOUNTS_ES256_PREVIOUS_PUBLIC_JWKS",
    kid,
  );
  return {
    jwks: { keys: [publicJwk, ...previousPublicJwks] },
    oidcFlow: {
      subject: options.subject ?? "tsub_node_postgres_seed",
      pairwiseSubjectSecret: options.oidcPairwiseSubjectSecret,
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
    const kid = optionalJwkString(entry.kid);
    const kty = optionalJwkString(entry.kty);
    const crv = optionalJwkString(entry.crv);
    const x = optionalJwkString(entry.x);
    const y = optionalJwkString(entry.y);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalJwkString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function handleHealthz(pool: PgPool): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), healthzTimeoutMs);
  try {
    await runPoolPing(pool, controller.signal);
    return new Response(JSON.stringify({ ok: true, database: "ok" }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({
        ok: false,
        database: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function runPoolPing(pool: PgPool, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new Error("/healthz: aborted before query started");
  }
  const queryPromise = pool.query("SELECT 1", []);
  const abortPromise = new Promise<never>((_, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("/healthz: postgres query timed out")),
      { once: true },
    );
  });
  await Promise.race([queryPromise, abortPromise]);
}

interface ServerConfig {
  port: number;
  hostname: string;
}

async function serveOnAnyRuntime(
  handler: (req: Request) => Promise<Response> | Response,
  options: ServerConfig,
): Promise<void> {
  const bunGlobal = (
    globalThis as {
      Bun?: {
        serve: (opts: ServerConfig & { fetch: typeof handler }) => unknown;
      };
    }
  ).Bun;
  if (bunGlobal?.serve) {
    bunGlobal.serve({ ...options, fetch: handler });
    return;
  }
  // Node fallback for tests and external embedders that do not run Bun.
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(","));
    }
    const method = req.method ?? "GET";
    const body =
      method !== "GET" && method !== "HEAD"
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              req.on("data", (chunk: Uint8Array) => controller.enqueue(chunk));
              req.on("end", () => controller.close());
              req.on("error", (err: Error) => controller.error(err));
            },
          })
        : null;
    try {
      const requestInit = { method, headers, body } as RequestInit & {
        duplex?: "half";
      };
      if (body) requestInit.duplex = "half";
      const response = await handler(new Request(url, requestInit));
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (!response.body) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      res.end();
    } catch (error) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({ error: "internal_error", message: String(error) }),
      );
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(options.port, options.hostname, () => resolve()),
  );
}

function readEnv(): Record<string, string | undefined> {
  const proc = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process;
  if (proc?.env) return proc.env;
  return {};
}


if (import.meta.main || isNodeMain()) {
  main().catch((error: unknown) => {
    structuredLog("error", "fatal", {
      event: "server.fatal",
      error: error instanceof Error ? error : { message: String(error) },
    });
    const proc = (globalThis as { process?: { exit(code: number): void } })
      .process;
    if (proc?.exit) proc.exit(1);
    else throw error;
  });
}

function isNodeMain(): boolean {
  // Heuristic for Node ESM entry points where `import.meta.main` is
  // unavailable. The bundle wrapper sets `process.env.TAKOSUMI_ACCOUNTS_MAIN=1`.
  const proc = (
    globalThis as { process?: { env: Record<string, string | undefined> } }
  ).process;
  return proc?.env?.TAKOSUMI_ACCOUNTS_MAIN === "1";
}
