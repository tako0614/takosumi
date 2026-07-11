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
  AppCapsuleExportWorker,
  DeployControlFacadeOptions,
  JsonWebKeySet,
  PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import {
  createAccountsHandler,
  createEphemeralAccountsHandler,
  PostgresAccountsStore,
  signEs256Jwt,
  signExportDownloadUrl,
  verifyExportDownloadUrl,
} from "@takosjp/takosumi-accounts-service";
import {
  createHttpDirectoryCapsuleExportArchiveUploader,
  createMetadataOnlyCapsuleExportWorker,
} from "../../../accounts/service/src/export-archive.ts";
import pgModule from "pg";
import {
  type NodeAccountsExportDownloadConfig,
  type NodeAccountsServerConfig,
  type NodeAccountsStableOidcConfig,
  parseEnv,
} from "./handler.ts";
import { buildComposedApp } from "./composed-app.ts";
import { resolveStaticAssetsDir } from "./static-assets.ts";

interface PgPoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statement_timeout?: number;
  ssl?: false | { rejectUnauthorized: boolean; ca?: string };
}

interface PgQueryResult {
  rows: unknown[];
  rowCount?: number;
}

interface PgPoolClient {
  query(sql: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}

interface PgPool {
  query(sql: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

type PgPoolConstructor = new (cfg: PgPoolConfig) => PgPool;
type ServiceSqlClient = NonNullable<
  Parameters<typeof buildComposedApp>[0]["sqlClient"]
>;
type ServiceSqlParameters = Parameters<ServiceSqlClient["query"]>[1];
type ServiceSqlTransaction = Parameters<
  NonNullable<ServiceSqlClient["transaction"]>
>[0] extends (transaction: infer T) => unknown
  ? T
  : never;

type Es256PrivateJwk = JsonWebKey & {
  readonly kid?: string;
  readonly x?: string;
  readonly y?: string;
};

const healthzPath = "/healthz";
const healthzTimeoutMs = 1000;

/**
 * Minimal structured logger with PII masking for the node-postgres
 * entry point. Inlined per F26 scope (extraction to a shared package
 * is tracked as a follow-up).
 */
const SENSITIVE_KEY_RE =
  /password|secret|token|apikey|api_key|credential|private|cookie|authorization/i;
const SENSITIVE_STRING_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern:
      /\beyJ[A-Za-z0-9_-]{1,2048}\.eyJ[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,512}/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    pattern: /\b(Bearer|token)\s+([A-Za-z0-9_.\-+/=]{16,512})/gi,
    replacement: "$1 [redacted]",
  },
  {
    pattern: /\bsk_live_[A-Za-z0-9]{16,256}/g,
    replacement: "[REDACTED_STRIPE_LIVE]",
  },
  {
    pattern: /\bsk_test_[A-Za-z0-9]{16,256}/g,
    replacement: "[REDACTED_STRIPE_TEST]",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}/g, replacement: "[REDACTED_AWS_ACCESS_KEY]" },
];
function maskString(input: string): string {
  let r = input;
  for (const { pattern, replacement } of SENSITIVE_STRING_PATTERNS) {
    r = r.replace(pattern, replacement);
  }
  return r;
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
    out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : maskValue(v);
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
 * native adapter implementation bindings or a durable SQL ledger — e.g. the
 * local-substrate `cloud` wrapper — supplies them here without duplicating the
 * pool / store / accounts-handler / serve plumbing.
 */
export interface ComposedServerOverrides {
  readonly implementations?: Parameters<
    typeof buildComposedApp
  >[0]["implementations"];
  readonly sqlClient?: Parameters<typeof buildComposedApp>[0]["sqlClient"];
  readonly opentofuRunner?: Parameters<
    typeof buildComposedApp
  >[0]["opentofuRunner"];
  readonly writeSourceArchive?: Parameters<
    typeof buildComposedApp
  >[0]["writeSourceArchive"];
  readonly runnerProfiles?: Parameters<
    typeof buildComposedApp
  >[0]["runnerProfiles"];
  readonly defaultRunnerProfileId?: Parameters<
    typeof buildComposedApp
  >[0]["defaultRunnerProfileId"];
  readonly managedVanityHostnameSlotsPerOwner?: Parameters<
    typeof buildComposedApp
  >[0]["managedVanityHostnameSlotsPerOwner"];
}

/**
 * Build and serve the one composed app this distribution runs: embed the
 * Takosumi service (`createTakosumiService`) and extend it with the Takosumi Accounts
 * surfaces. healthz + signed export downloads run ahead of the service +
 * accounts fallback via `preHandle`. Blocks on `serveOnAnyRuntime`.
 */
export async function buildComposedServer(
  overrides: ComposedServerOverrides = {},
): Promise<void> {
  const env = readEnv();
  const config = parseEnv(env);
  const envManagedVanityHostnameSlotsPerOwner = nonNegativeInteger(
    env.TAKOSUMI_MANAGED_VANITY_HOST_SLOTS_PER_OWNER,
  );
  const managedVanityHostnameSlotsPerOwner =
    overrides.managedVanityHostnameSlotsPerOwner ??
    envManagedVanityHostnameSlotsPerOwner;
  const pool = createPostgresPool(config);
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

  const { app } = await buildComposedApp({
    config,
    store,
    createAccountsHandler: (deployControl, controlPlaneOperations) =>
      buildAccountsHandler(
        config,
        store,
        deployControl,
        controlPlaneOperations,
      ),
    preHandle: (req) =>
      preHandleNonServiceRequest(req, pool, config.exportDownload),
    ...(staticAssets ? { staticAssets } : {}),
    ...(overrides.implementations
      ? { implementations: overrides.implementations }
      : {}),
    ...(overrides.opentofuRunner
      ? { opentofuRunner: overrides.opentofuRunner }
      : {}),
    ...(overrides.writeSourceArchive
      ? { writeSourceArchive: overrides.writeSourceArchive }
      : {}),
    ...(overrides.runnerProfiles
      ? { runnerProfiles: overrides.runnerProfiles }
      : {}),
    ...(overrides.defaultRunnerProfileId
      ? { defaultRunnerProfileId: overrides.defaultRunnerProfileId }
      : {}),
    ...(managedVanityHostnameSlotsPerOwner !== undefined
      ? {
          managedVanityHostnameSlotsPerOwner,
        }
      : {}),
    sqlClient: overrides.sqlClient ?? wrapServiceSqlClient(pool),
  });

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
 * Pre-service request handling shared by the composed app: `/healthz` and signed
 * installation export downloads. Returns a `Response` to short-circuit, or
 * `undefined` to fall through to the embedded service app + accounts fallback.
 */
async function preHandleNonServiceRequest(
  req: Request,
  pool: PgPool,
  exportDownload: NodeAccountsExportDownloadConfig | undefined,
): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (url.pathname === healthzPath) {
    return await handleHealthz(pool);
  }
  return await maybeHandleExportDownload(req, exportDownload);
}

async function buildAccountsHandler(
  config: NodeAccountsServerConfig,
  store: PostgresAccountsStore,
  deployControl?: DeployControlFacadeOptions,
  controlPlaneOperations?: ControlPlaneOperations,
): Promise<AccountsHandler> {
  const exportWorker = buildExportWorker(config.exportDownload);
  const commonOptions = {
    issuer: config.issuer,
    store,
    ...(config.managedPublicBaseDomain
      ? { managedPublicBaseDomain: config.managedPublicBaseDomain }
      : {}),
    ...(config.clients ? { clients: config.clients } : {}),
    platformAccess: config.platformAccess,
    ...(config.runtimeProjectionMaterialResolver
      ? {
          runtimeProjectionMaterialResolver:
            config.runtimeProjectionMaterialResolver,
        }
      : {}),
    ...(config.loginEmailAllowlist
      ? { loginEmailAllowlist: config.loginEmailAllowlist }
      : {}),
    ...(config.passkeys ? { passkeys: config.passkeys } : {}),
    ...(config.upstreamOAuth ? { upstreamOAuth: config.upstreamOAuth } : {}),
    ...(deployControl ? { deployControl } : {}),
    ...(controlPlaneOperations ? { controlPlaneOperations } : {}),
    ...(exportWorker ? { exportWorker } : {}),
    ...(config.privacyOperationsToken
      ? { privacyOperationsToken: config.privacyOperationsToken }
      : {}),
  };
  const stableOidc = await buildStableOidc(config.stableOidc);
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
    ...(config.subject ? { subject: config.subject } : {}),
  });
}

/**
 * Build the metadata-only filesystem installation export worker that
 * mirrors the Cloudflare profile's R2-backed export worker. The
 * Node-Postgres reference distribution writes the export archive to
 * `outputDirectory` and embeds an HMAC-signed `<baseUrl>/<archive-filename>`
 * URL (with `tk_exp` + `tk_sig` query params) in the operation response.
 *
 * The signing secret (`TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET`) is wired
 * through here so download URLs are signed and time-limited, matching the
 * Cloudflare profile rather than emitting guessable unsigned URLs. The
 * in-process `/_export-downloads/...` route (see `maybeHandleExportDownload`)
 * verifies the signature and expiry before serving the file, so the
 * signature is enforced fail-closed even though operators may also place a
 * static server (Caddy / nginx) in front for caching.
 */
function buildExportWorker(
  config: NodeAccountsExportDownloadConfig | undefined,
): AppCapsuleExportWorker | undefined {
  if (!config) return undefined;
  // The base uploader copies the archive into `outputDirectory` and returns
  // an unsigned `<baseUrl>/<objectKey>` URL; we then HMAC-sign it.
  const baseUploader = createHttpDirectoryCapsuleExportArchiveUploader({
    downloadBaseUrl: config.baseUrl,
    outputDirectory: config.outputDirectory,
  });
  return createMetadataOnlyCapsuleExportWorker({
    outputDirectory: config.outputDirectory,
    downloadBaseUrl: config.baseUrl,
    ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
    uploader: async (input) => {
      const result = await baseUploader(input);
      const signed = await signExportDownloadUrl(result.downloadUrl, {
        secret: config.secret,
        ...(config.ttlMs !== undefined ? { ttlMs: config.ttlMs } : {}),
      });
      return {
        downloadUrl: signed.url,
        // Use the signature's own expiry so the embedded `downloadExpiresAt`
        // matches the `tk_exp` the verifier enforces.
        downloadExpiresAt: signed.expiresAt,
      };
    },
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
      readonly launchTokens: { readonly pairwiseSubjectSecret: string };
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
    launchTokens: {
      pairwiseSubjectSecret: options.launchTokenPairwiseSecret,
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

/**
 * Serve a signed installation export download, verifying the HMAC signature
 * and expiry before reading the archive off disk. Mirrors the Cloudflare
 * profile's `maybeHandleR2ExportDownload`: a request that does not carry a
 * valid `tk_sig` for the (URL, `tk_exp`) tuple is refused fail-closed.
 *
 * Activates only when export downloads are configured AND the request path
 * is under the configured `baseUrl` path (i.e. `baseUrl` points at this
 * server rather than at an external static server). The served file is
 * resolved by basename inside `outputDirectory`, so a traversal attempt
 * cannot escape the export directory.
 */
async function maybeHandleExportDownload(
  req: Request,
  config: NodeAccountsExportDownloadConfig | undefined,
): Promise<Response | undefined> {
  if (!config) return undefined;
  const url = new URL(req.url);
  let basePath: string;
  try {
    basePath = new URL(config.baseUrl).pathname;
  } catch {
    return undefined;
  }
  if (!basePath.endsWith("/")) basePath = `${basePath}/`;
  if (!url.pathname.startsWith(basePath)) return undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const verdict = await verifyExportDownloadUrl(req.url, {
    secret: config.secret,
  });
  if (!verdict.ok) {
    // Mirror the Cloudflare handler's status mapping: a malformed/absent
    // signature is a client error (400), a wrong signature is forbidden
    // (403), and an expired-but-well-formed URL is gone (410).
    if (verdict.reason === "expired") {
      return Response.json(
        { error: "export_download_expired" },
        {
          status: 410,
        },
      );
    }
    if (verdict.reason === "missing") {
      return Response.json(
        { error: "invalid_export_download_url" },
        {
          status: 400,
        },
      );
    }
    return Response.json(
      { error: "invalid_export_download_signature" },
      {
        status: 403,
      },
    );
  }
  // Resolve the file by basename only so a `..`/absolute path in the request
  // cannot escape the export output directory.
  const requestedName = posixBasename(decodeURIComponent(url.pathname));
  if (
    !requestedName ||
    requestedName === "." ||
    requestedName === ".." ||
    requestedName.includes("/") ||
    requestedName.includes("\\")
  ) {
    return Response.json(
      { error: "invalid_export_download_url" },
      {
        status: 400,
      },
    );
  }
  const dir = config.outputDirectory.endsWith("/")
    ? config.outputDirectory.slice(0, -1)
    : config.outputDirectory;
  const filePath = `${dir}/${requestedName}`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return Response.json(
      { error: "export_artifact_not_found" },
      {
        status: 404,
      },
    );
  }
  const headers = new Headers({
    "content-type": "application/zstd",
    "cache-control": "private, max-age=0, no-store",
    "x-content-type-options": "nosniff",
  });
  if (requestedName.endsWith(".age")) headers.set("content-encoding", "age");
  if (req.method === "HEAD") {
    return new Response(null, { headers });
  }
  return new Response(file.stream(), { headers });
}

/** Last path segment of a URL pathname (POSIX-style, no node:path dep). */
function posixBasename(pathname: string): string {
  const segments = pathname.split("/");
  return segments[segments.length - 1] ?? "";
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

function nonNegativeInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function resolvePoolCtor(): PgPoolConstructor {
  const pg = pgModule as unknown as {
    default?: { Pool?: PgPoolConstructor };
    Pool?: PgPoolConstructor;
  };
  const candidate = pg.default?.Pool ?? pg.Pool;
  if (!candidate) throw new Error("npm:pg Pool export missing");
  return candidate;
}

function createPostgresPool(config: NodeAccountsServerConfig): PgPool {
  const env = readEnv();
  const PoolCtor = resolvePoolCtor();
  const cfg: PgPoolConfig = {
    connectionString: config.databaseUrl,
    max: parsePoolSize(env),
    idleTimeoutMillis:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_IDLE_TIMEOUT_MS") ?? 30000,
    connectionTimeoutMillis:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_CONNECT_TIMEOUT_MS") ?? 5000,
    statement_timeout:
      parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_STATEMENT_TIMEOUT_MS") ?? 30000,
    ssl: parseSslConfig(env),
  };
  return new PoolCtor(cfg);
}

function wrapPool(pool: PgPool): PostgresQueryClient {
  return {
    async queryObject<T>(
      sql: string,
      args: readonly unknown[] = [],
    ): Promise<{ rows: T[] }> {
      const result = await pool.query(sql, args);
      return { rows: result.rows as T[] };
    },
  };
}

function wrapServiceSqlClient(pool: PgPool): ServiceSqlClient {
  const runQuery = async <Row extends Record<string, unknown>>(
    runner: Pick<PgPool, "query">,
    sql: string,
    parameters?: ServiceSqlParameters,
  ): Promise<{ rows: readonly Row[]; rowCount: number }> => {
    if (parameters !== undefined && !Array.isArray(parameters)) {
      throw new TypeError(
        "node-postgres service SQL adapter expects positional parameters",
      );
    }
    const result = await runner.query(sql, parameters as readonly unknown[]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  };
  return {
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      parameters?: ServiceSqlParameters,
    ): Promise<{ rows: readonly Row[]; rowCount: number }> {
      return await runQuery<Row>(pool, sql, parameters);
    },
    // Interactive transaction over a pinned connection: BEGIN / COMMIT, with a
    // best-effort ROLLBACK on any throw, mirroring core/index.ts. Atomic
    // ledger commits (commitAppliedDeployment) run their whole write set here so
    // a mid-sequence failure rolls back instead of leaving torn state.
    async transaction<T>(
      fn: (transaction: ServiceSqlTransaction) => T | Promise<T>,
    ): Promise<T> {
      const conn = await pool.connect();
      // The pinned-connection handle is itself a transaction. A nested
      // transaction(fn) runs fn against the same connection — the ledger commit
      // never nests, so flat re-entry is the correct (no savepoint) behavior.
      const tx: ServiceSqlTransaction = {
        query: (sql, parameters) => runQuery(conn, sql, parameters),
        transaction: (nested) => Promise.resolve(nested(tx)),
      };
      try {
        await conn.query("begin");
        const value = await fn(tx);
        await conn.query("commit");
        return value;
      } catch (error) {
        await conn.query("rollback").catch(() => {});
        throw error;
      } finally {
        conn.release();
      }
    },
  };
}

function parsePoolSize(env: Record<string, string | undefined>): number {
  return parseInteger(env, "TAKOSUMI_ACCOUNTS_PG_POOL_MAX") ?? 20;
}

function parseInteger(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${raw}`);
  }
  return parsed;
}

/**
 * Read TAKOSUMI_ACCOUNTS_PG_SSL_MODE (`disable` | `require` | `verify-ca`
 * | `verify-full`) plus optional TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT and
 * return a `pg`-style ssl option. Defaults to `disable` for backwards
 * compatibility with the docker-compose stack where Postgres runs on the
 * same network.
 */
function parseSslConfig(
  env: Record<string, string | undefined>,
): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode =
    env.TAKOSUMI_ACCOUNTS_PG_SSL_MODE?.trim().toLowerCase() ?? "disable";
  if (mode === "" || mode === "disable" || mode === "off") return false;
  const ca = env.TAKOSUMI_ACCOUNTS_PG_SSL_ROOT_CERT?.trim();
  if (mode === "require") {
    return ca
      ? { rejectUnauthorized: false, ca }
      : { rejectUnauthorized: false };
  }
  if (mode === "verify-ca" || mode === "verify-full") {
    return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
  }
  throw new TypeError(
    `TAKOSUMI_ACCOUNTS_PG_SSL_MODE must be one of disable|require|verify-ca|verify-full, got ${mode}`,
  );
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
