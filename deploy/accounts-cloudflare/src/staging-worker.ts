import { createCloudflareWorker, type CloudflareWorkerEnv } from "./handler.ts";
import { ensureAccountsD1WorkerSchema } from "./d1-schema-gate.ts";
import { createInProcessDeployControlSeam } from "../../../worker/src/deploy_control_seam.ts";
import type { CloudflareWorkerEnv as ControlEnv } from "../../../worker/src/bindings.ts";
import { verifyD1OpenTofuLedgerSchemaPredeployed } from "../../../worker/src/d1_opentofu_store.ts";
import { assertControlD1MaintenanceInactive } from "../../../worker/src/d1_schema_maintenance.ts";
import { D1AccountsStore } from "../../../accounts/service/src/d1-store.ts";
import { createIdentityMergeRetryService, type IdentityMergeRetryService } from "../../../accounts/service/src/identity-merge-retry.ts";
import type { IdentityMergeReconciler } from "../../../accounts/service/src/identity-merge.ts";
import type { IdentityMergeOperation } from "../../../accounts/service/src/identity-state.ts";
import type { CredentialUnlinkReconciler } from "../../../accounts/service/src/identity-unlink-state.ts";
import type { WorkspaceBillingEnrollmentPort } from "../../../accounts/service/src/workspace-billing-bootstrap.ts";
import { handleStagingLoginPortal } from "./staging-login-portal.ts";
import {
  AUTH_STAGING_CLIENTS,
  AUTH_STAGING_ISSUER,
  AUTH_STAGING_RETRY_CRON,
  assertAuthStagingVariables,
  assertAuthStagingUpstreams,
} from "./staging-target.ts";

type AuthEnv = CloudflareWorkerEnv & ControlEnv;
type AccountsWorker = ReturnType<typeof createCloudflareWorker<AuthEnv>>;
export interface AuthStagingOwnerPorts {
  readonly identityMergeReconciler?: IdentityMergeReconciler;
  readonly assertOwnerReadiness?: (operation?: IdentityMergeOperation) => Promise<boolean>;
  readonly credentialUnlinkReconciler?: CredentialUnlinkReconciler;
  readonly workspaceBillingEnrollment?: WorkspaceBillingEnrollmentPort;
}
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
  /** Trusted source composition, never configured from browser JSON. Missing
   * real owner readiness refuses merge consent before reservation. */
  readonly ownerPorts?: (env: AuthEnv) => AuthStagingOwnerPorts | undefined;
  readonly retryService?: (env: AuthEnv) => IdentityMergeRetryService;
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
  const owners = new WeakMap<AuthEnv, AuthStagingOwnerPorts>();
  const ownerPorts = (env: AuthEnv) => {
    let ports = owners.get(env);
    if (!ports) { ports = dependencies.ownerPorts?.(env) ?? {}; owners.set(env,ports); }
    return ports;
  };
  const retryServices = new WeakMap<AuthEnv, IdentityMergeRetryService>();
  const retryService = (env: AuthEnv): IdentityMergeRetryService => {
    let service = retryServices.get(env);
    if (!service) {
      const ports = ownerPorts(env);
      service = dependencies.retryService?.(env) ?? createIdentityMergeRetryService({
        store:new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB,{schemaMode:"predeployed",sessionHashSalt:env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT!}),
        reconciler:ports.identityMergeReconciler,assertOwnerReadiness:ports.assertOwnerReadiness,
        stage:{environment:String(env.TAKOSUMI_ENVIRONMENT),issuerOrigin:String(env.TAKOSUMI_ACCOUNTS_ISSUER),hostedSessionPolicy:env.TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY==="true",accountsSchemaHead:5,accountsSchemaMode:String(env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE)},
      });
      retryServices.set(env,service);
    }
    return service;
  };
  const accounts = dependencies.accounts ?? createCloudflareWorker<AuthEnv>({
    controlPlaneOperations: controlOperations,
    identityMergeReconciler:(env)=>ownerPorts(env).identityMergeReconciler,
    identityMergeRetry:retryService,
    credentialUnlinkReconciler:(env)=>ownerPorts(env).credentialUnlinkReconciler,
    workspaceBillingEnrollment:(env)=>ownerPorts(env).workspaceBillingEnrollment,
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
      } else if (url.pathname === "/sign-in" || issuerPath(url.pathname)) {
        try {
          await schemaFor(env);
          response = url.pathname === "/sign-in"
            ? (await handleStagingLoginPortal({request,issuer:AUTH_STAGING_ISSUER,accountsHandler:(providerRequest)=>accounts.fetch(providerRequest,env,context)}))!
            : await accounts.fetch(request, env, context);
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
    async scheduled(event: {cron:string}, env: AuthEnv): Promise<void> {
      // A scheduled event has no browser URL; target and environment guards
      // therefore run independently before any schema/store/owner work.
      if (event.cron !== AUTH_STAGING_RETRY_CRON) return;
      try {
        assertAuthStagingVariables(env);
        if (REQUIRED_BINDINGS.some((name)=>env[name]===null||env[name]===undefined) ||
          [...REQUIRED_SECRETS,...assertAuthStagingUpstreams(env.TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS)].some((name)=>typeof env[name]!=="string"||!(env[name] as string).trim())) return;
        await schemaFor(env);
        const result = await retryService(env).runBatch();
        console.info(JSON.stringify({event:"auth_staging_merge_retry",status:result.status,scanned:result.scanned,activated:result.activated,pending:result.pending,recoveryRequired:result.recoveryRequired,conflicts:result.conflicts,failed:result.failed}));
      } catch {
        console.info(JSON.stringify({event:"auth_staging_merge_retry",status:"unavailable"}));
      }
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
