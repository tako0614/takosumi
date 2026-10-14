import { createCloudflareWorker, type CloudflareWorkerEnv } from "./handler.ts";
import { ensureAccountsD1WorkerSchema } from "./d1-schema-gate.ts";
import { createInProcessDeployControlSeam } from "../../../worker/src/deploy_control_seam.ts";
import type { CloudflareWorkerEnv as ControlEnv } from "../../../worker/src/bindings.ts";
import { verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../worker/src/d1_opentofu_store.ts";
import { assertControlD1MaintenanceInactive } from "../../../worker/src/d1_schema_maintenance.ts";
import {
  AUTH_STAGING_CLIENTS,
  AUTH_STAGING_ISSUER,
  assertAuthStagingVariables,
  assertAuthStagingUpstreams,
} from "./staging-target.ts";

type AuthEnv = CloudflareWorkerEnv & ControlEnv;
type AccountsWorker = ReturnType<typeof createCloudflareWorker<AuthEnv>>;
const seams = new WeakMap<AuthEnv, ReturnType<typeof createInProcessDeployControlSeam>>();

function controlOperations(env: AuthEnv) {
  let seam = seams.get(env);
  if (!seam) {
    seam = createInProcessDeployControlSeam(env);
    seams.set(env, seam);
  }
  return seam.operations();
}

const REQUIRED_BINDINGS = [
  "TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB", "R2_ARTIFACTS", "R2_SOURCE",
  "R2_STATE", "R2_BACKUPS", "COORDINATION", "RUN_OWNER", "RUNNER",
  "TAKOSUMI_VERSION_METADATA",
] as const;
const REQUIRED_SECRETS = [
  "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
  "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", ...AUTH_STAGING_CLIENTS.map((client) => client.clientSecretEnv),
] as const;

/** Only the account/identity facade; never mount product or internal Core APIs. */
function issuerPath(path: string): boolean {
  return path === "/.well-known/openid-configuration" ||
    path === "/oauth" || path.startsWith("/oauth/") ||
    path === "/api/v1/auth" || path.startsWith("/api/v1/auth/") ||
    path === "/api/v1/account" || path.startsWith("/api/v1/account/");
}

export function createAuthStagingWorker(dependencies: {
  readonly accounts?: AccountsWorker;
  readonly verifySchema?: (env: AuthEnv) => Promise<void>;
} = {}) {
  // D1 work cannot be forcibly cancelled. Keep at most one pending read-only
  // verification per env; a timed-out caller never starts a parallel attempt.
  const schemaAttempts = new WeakMap<AuthEnv, Promise<void>>();
  const schemaFor = (env: AuthEnv): Promise<void> => {
    const existing = schemaAttempts.get(env);
    if (existing) return existing;
    const verification = Promise.resolve().then(() => (dependencies.verifySchema ?? verifySchema)(env));
    const attempt = withReadinessDeadline(verification);
    schemaAttempts.set(env, attempt);
    // After the shared deadline expires, reuse that rejection until the real
    // D1 flight settles. New callers neither allocate another timer nor attach
    // another subscriber to a permanently pending native operation.
    void attempt.catch(() => {});
    void verification.then(() => {
      if (schemaAttempts.get(env) === attempt) schemaAttempts.delete(env);
    }, () => {
      if (schemaAttempts.get(env) === attempt) schemaAttempts.delete(env);
    });
    return attempt;
  };
  const accounts = dependencies.accounts ?? createCloudflareWorker<AuthEnv>({
    controlPlaneOperations: controlOperations,
  });
  return {
    async fetch(request: Request, env: AuthEnv, context?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
      const url = new URL(request.url);
      if (url.origin !== AUTH_STAGING_ISSUER ||
          (request.headers.has("host") && request.headers.get("host") !== url.host)) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      try {
        assertAuthStagingVariables(env);
        if (REQUIRED_BINDINGS.some((name) => env[name] === null || env[name] === undefined) ||
            [...REQUIRED_SECRETS, ...assertAuthStagingUpstreams(env.TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS)].some((name) => typeof env[name] !== "string" || !(env[name] as string).trim())) {
          throw new Error("auth_staging_bindings_unavailable");
        }
      } catch {
        return Response.json({ error: "auth_staging_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
      }
      let response: Response;
      if (url.pathname === "/healthz" || url.pathname === "/") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
        response = Response.json({ service: "takosumi-auth-staging", issuer: AUTH_STAGING_ISSUER });
      } else if (url.pathname === "/readyz") {
        if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
        try {
          await schemaFor(env);
          response = Response.json({ ok: true, accountsSchemaHead: 5, control: "canonical-predeployed" });
        } catch {
          response = Response.json({ error: "auth_staging_unavailable" }, { status: 503 });
        }
      } else if (issuerPath(url.pathname)) {
        try {
          await schemaFor(env);
          response = await accounts.fetch(request, env, context);
        } catch {
          response = Response.json({ error: "auth_staging_unavailable" }, { status: 503 });
        }
      } else {
        response = Response.json({ error: "not_found" }, { status: 404 });
      }
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      const metadata = env.TAKOSUMI_VERSION_METADATA;
      if (typeof metadata === "object" && metadata !== null && "id" in metadata && typeof metadata.id === "string") {
        headers.set("x-takosumi-worker-version", metadata.id);
      }
      return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
    },
  };
}

async function verifySchema(env: AuthEnv): Promise<void> {
  const evidence = await ensureAccountsD1WorkerSchema(env.TAKOSUMI_ACCOUNTS_DB);
  // The reviewed migration owner supplies v5. A v4-only build fails closed.
  if (Number(evidence.headVersion) !== 5) throw new Error("auth_staging_schema_invalid");
  await verifyD1OpenTofuLedgerSchemaPredeployed(env.TAKOSUMI_CONTROL_DB);
  await assertControlD1MaintenanceInactive(env.TAKOSUMI_CONTROL_DB);
}

async function withReadinessDeadline(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("auth_staging_readiness_timeout")), 5_000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "GET, HEAD", "cache-control": "no-store" } });
}
