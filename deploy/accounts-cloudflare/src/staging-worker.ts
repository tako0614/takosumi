import { createCloudflareWorker, type PrivateAccountsFinancialSourceFacade, type PrivateAccountsFinancialSourceOrigin } from "./handler.ts";
import { FinancialSourceUnavailable } from "../../../accounts/service/src/financial-source.ts";
import { createIdentityMergeRetryService, type IdentityMergeRetryService, type IdentityMergeRetryRuntimeContext } from "../../../accounts/service/src/identity-merge-retry.ts";
import { handleStagingLoginPortal } from "./staging-login-portal.ts";
import { createStagingIdentityPortal } from "./staging-identity-portal.ts";
import {
  AUTH_STAGING_CLIENTS,
  AUTH_STAGING_CONTROL_SECRETS,
  AUTH_STAGING_ISSUER,
  AUTH_STAGING_RETRY_CRON,
  assertAuthStagingVariables,
  assertAuthStagingUpstreams,
} from "./staging-target.ts";

import { authStagingOwnerBundle, authStagingControlOperations, type AuthStagingOwnerPorts, type AuthStagingEnv as AuthEnv } from "./staging-owner-bundle.ts";
import { verifyAuthStagingOwnerSchema } from "./staging-owner-bundle.ts";
export type { AuthStagingOwnerPorts } from "./staging-owner-bundle.ts";
type AccountsWorker = ReturnType<typeof createCloudflareWorker<AuthEnv>>;
export type AuthStagingPrivateProofOwner = Readonly<{
  assertReady(env: AuthEnv): Promise<void>;
  resolve(env: AuthEnv): Promise<PrivateAccountsFinancialSourceFacade>;
}>;
const privateProofOwners = new WeakMap<object, AuthStagingPrivateProofOwner>();
const REQUIRED_BINDINGS = [
  "TAKOSUMI_ACCOUNTS_DB", "TAKOSUMI_CONTROL_DB", "R2_ARTIFACTS", "R2_SOURCE",
  "R2_STATE", "R2_BACKUPS", "COORDINATION", "RUN_OWNER", "RUNNER",
  "TAKOSUMI_VERSION_METADATA",
] as const;
const REQUIRED_SECRETS = [
  "TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK", "TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET",
  "TAKOSUMI_ACCOUNT_SESSION_HASH_SALT", ...AUTH_STAGING_CLIENTS.map((client) => client.clientSecretEnv),
  ...AUTH_STAGING_CONTROL_SECRETS,
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
  /** Private A/C source-method publication only. The actual HTTP Accounts store
   * and canonical Control instances are retained by handler.ts, not supplied
   * by the observer. Existing source receiver/expiry-clock callbacks are
   * captured there; genuine qualification is still an owning responsibility.
   * The observer cannot dispatch before named resolution has completed.
   * No Financial M constructor, command custody or dispatch is installed here. */
  readonly financialSourceOrigin?: Pick<PrivateAccountsFinancialSourceOrigin<AuthEnv>, "inputs" | "observe">;
} = {}) {
  const sourceInputs = dependencies.financialSourceOrigin?.inputs;
  const sourceObserver = dependencies.financialSourceOrigin?.observe;
  const verifySchema = dependencies.verifySchema ?? verifyAuthStagingOwnerSchema;
  const suppliedAccounts = dependencies.accounts;
  // D1 work cannot be forcibly cancelled. Keep at most one pending read-only
  // verification per env; a timed-out caller never starts a parallel attempt.
  const schemaAttempts = new WeakMap<AuthEnv, Promise<void>>();
  const schemaFor = (env: AuthEnv): Promise<void> => {
    const existing = schemaAttempts.get(env);
    if (existing) return existing;
    const verification = Promise.resolve().then(() => verifySchema(env));
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
  const sources = new WeakMap<AuthEnv, AuthStagingOwnerPorts>();
  const ownerBundle = (env: AuthEnv) => {
    let source = sources.get(env);
    if (!source) {
      source = dependencies.ownerPorts?.(env);
      if (source) sources.set(env, source);
    }
    return authStagingOwnerBundle(env, source);
  };
  const ownerPorts = (env: AuthEnv) => ownerBundle(env).ports;
  const controlOperations = (env: AuthEnv) => {
    ownerBundle(env);
    return authStagingControlOperations(env);
  };
  const runtimeContext = (env: AuthEnv): IdentityMergeRetryRuntimeContext | undefined => {
    const metadata = env.TAKOSUMI_VERSION_METADATA;
    const digest = ownerPorts(env).retryAuthorityContextDigest;
    const version = metadata && typeof metadata === "object" && "id" in metadata ? metadata.id : undefined;
    if (typeof version !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(version) ||
      typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) return undefined;
    return {workerVersion:version,authorityContextDigest:digest};
  };
  const retryServices = new WeakMap<AuthEnv, IdentityMergeRetryService>();
  const retryService = (env: AuthEnv): IdentityMergeRetryService => {
    let service = retryServices.get(env);
    if (!service) {
      const ports = ownerPorts(env);
      service = dependencies.retryService?.(env) ?? createIdentityMergeRetryService({
        runtimeContext:runtimeContext(env),
        store:ownerBundle(env).store,
        reconciler:ports.identityMergeReconciler,assertOwnerReadiness:ports.assertOwnerReadiness,
        stage:{environment:String(env.TAKOSUMI_ENVIRONMENT),issuerOrigin:String(env.TAKOSUMI_ACCOUNTS_ISSUER),hostedSessionPolicy:env.TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY==="true",accountsSchemaHead:5,accountsSchemaMode:String(env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE)},
      });
      retryServices.set(env,service);
    }
    return service;
  };
  const accounts = suppliedAccounts ?? createCloudflareWorker<AuthEnv>({
    controlPlaneOperations: controlOperations,
    // This exact cached operations instance owns the canonical Core Workspace
    // service. ownerBundle(env).store is a different AccountsStore instance and
    // must never stand in for the HTTP handler's actual D1 store.
    privateFinancialSourceOrigin: {
      coreFinancialSource: async (env) => (await authStagingControlOperations(env)).workspaces.financialSource,
      ...(sourceInputs ? {inputs: sourceInputs} : {}),
      ...(sourceObserver ? {observe: sourceObserver} : {}),
    },
    identityMergeReconciler:(env)=>ownerPorts(env).identityMergeReconciler,
    identityMergeRetry:retryService,
    credentialUnlinkReconciler:(env)=>ownerPorts(env).credentialUnlinkReconciler,
    workspaceBillingEnrollment:(env)=>ownerPorts(env).workspaceBillingEnrollment,
  });
  const sourceResolver = accounts.resolvePrivateFinancialSource;
  const worker = {
    // Explicit in-process named caller only. A supplied mock Accounts worker
    // cannot qualify the actual HTTP D1 store captured by the default worker.
    async resolvePrivateFinancialSource(env: AuthEnv): Promise<PrivateAccountsFinancialSourceFacade> {
      const owner = privateProofOwners.get(worker);
      if (!owner) throw new FinancialSourceUnavailable("source_unavailable");
      return await owner.resolve(env);
    },
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
      } else if (/^\/identity-merges\/imrg_[a-f0-9-]{36}\/contexts$/u.test(url.pathname)) {
        try {
          await schemaFor(env);
          response = await createStagingIdentityPortal({
            issuer: AUTH_STAGING_ISSUER,
            accountsHandler: (portalRequest) => accounts.fetch(portalRequest, env, context),
          })(request) ?? Response.json({ error: "not_found" }, { status: 404 });
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
        const context = runtimeContext(env);
        // Configuration readback is not an execution heartbeat. Only this
        // guarded, real scheduled closure supplies the trusted invocation.
        const result = await retryService(env).runBatch(context ? {kind:"scheduled",...context} : undefined);
        console.info(JSON.stringify({event:"auth_staging_merge_retry",status:result.status,scanned:result.scanned,activated:result.activated,pending:result.pending,recoveryRequired:result.recoveryRequired,conflicts:result.conflicts,failed:result.failed}));
      } catch {
        console.info(JSON.stringify({event:"auth_staging_merge_retry",status:"unavailable"}));
      }
    },
  };
  if (suppliedAccounts === undefined) {
    privateProofOwners.set(worker, Object.freeze({
      async assertReady(env: AuthEnv): Promise<void> {
        assertAuthStagingVariables(env);
        await schemaFor(env);
      },
      async resolve(env: AuthEnv): Promise<PrivateAccountsFinancialSourceFacade> {
        if (!sourceResolver) throw new FinancialSourceUnavailable("source_unavailable");
        return await sourceResolver.call(accounts, env);
      },
    }));
  }
  return worker;
}

/** Return the owner only for the original object created by this factory. */
export function privateAccountsFinancialProofOwner(worker: object): AuthStagingPrivateProofOwner | undefined {
  return privateProofOwners.get(worker);
}

export type AuthStagingWorker = ReturnType<typeof createAuthStagingWorker>;

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
