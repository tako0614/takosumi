import {
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  normalizeIssuer,
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
  type IdentityMergeReconciler,
  type IdentityMergeRetryCapability,
  type CredentialUnlinkReconciler,
  createWorkspaceBillingBootstrapResolver,
  type WorkspaceBillingEnrollmentPort,
  resolveD1AccountsSchemaMode,
  composeTakosumiMobileOidcClients,
  parseTakosumiMobileBuiltinClientSetting,
  parseInstalledAppDelegationSources,
  parseTrustedNativeClientsEnv,
  parseWorkspaceMutationsFrozen,
  parseAppOwnershipMutationsFrozen,
} from "@takosjp/takosumi-accounts-service";
import {
  isAccountsApiPath,
  isWorkerLocalPath,
  isWorkerReadinessPath,
} from "./routes.ts";
import { checkPlatformBindings } from "./bindings-check.ts";
import {
  RUNTIME_BINDING_DERIVATION_KEY_ENV,
  resolveRuntimeBindingDerivationKey,
  runtimeBindingDerivationMode,
} from "../../../core/domains/deploy-control/runtime_binding_derivation_key.ts";
import { ensureAccountsD1WorkerSchema } from "./d1-schema-gate.ts";
import {
  createSharedAccountWorkspaceDirectory,
  type SharedAccountWorkspaceDirectory,
  type SharedWorkspaceBillingResolver,
} from "../../../accounts/service/src/shared-account-workspace.ts";
import { createRequestPhaseDiagnostics, measureRequestPhaseOperation } from "../../../accounts/service/src/request-phase-diagnostics.ts";
import {
  createAccountsFinancialControlSource,
  createAccountsFinancialSource,
  FinancialSourceUnavailable,
  type AccountsFinancialEventEvidenceOptions,
  type AccountsFinancialSourceOptions,
} from "../../../accounts/service/src/financial-source.ts";
import {
  financialSourceRef,
  parseFinancialSourceRegistration,
  type FinancialSourceRegistration,
} from "../../../accounts/service/src/financial-source-contract.ts";
import { WorkspaceFinancialSourceService } from "../../../core/domains/workspaces/financial-source.ts";

export interface CloudflareWorkerEnv {
  readonly [name: string]: unknown;
  readonly TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS?: string;
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
  /** Explicit opt-in; protected D1 must be migrated and verified before use. */
  readonly TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY?: string;
  readonly TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY?: string;
  /** Defaults to frozen; set false/off/0 only for an explicit rollback. */
  readonly TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN?: string;
  /** JSON array of `{ url, path }` repositories whose installed app may delegate. */
  readonly TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES?: string;
  readonly TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS?: string;
  /** `frozen` | `enabled` (default): app member and ownership-transfer writes. */
  readonly TAKOSUMI_APP_OWNERSHIP_MUTATIONS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_ID?: string;
  readonly TAKOSUMI_ACCOUNTS_REDIRECT_URIS?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_SECRET?: string;
  readonly TAKOSUMI_ACCOUNTS_CLIENT_AUTH_METHOD?: string;
  readonly TAKOSUMI_ACCOUNTS_ALLOWED_SCOPES?: string;
  /** Exact public PKCE client advertised by `/.well-known/takosumi`. */
  readonly TAKOSUMI_MOBILE_OIDC_CLIENT_ID?: string;
  /**
   * `true`/`false`: register the built-in public `takosumi-mobile` client.
   * Defaults to on, except under the shared hosted session policy.
   */
  readonly TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT?: string;
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
  fetch(
    request: Request,
    env: TEnv,
    context?: AccountsWorkerExecutionContext,
  ): Promise<Response>;
  /** In-process named caller only. No request route invokes this resolver. */
  resolvePrivateFinancialSource?(env: TEnv): Promise<PrivateAccountsFinancialSourceFacade>;
}

interface AccountsWorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Private, unmounted source-origin assembly. Its observer receives only
 * captured existing Accounts/Control producer methods. This is not a wire.
 * Presence of this hook is never evidence
 * of a genuine issuer, a selected Financial peer, or M dispatch authority. */
export type PrivateAccountsFinancialSourceFacade = Pick<
  ReturnType<typeof createAccountsFinancialSource>,
  "prepareFinancialIdentityProofSource" |
    "preparePendingFinancialSourceOriginals" |
    "loadFinancialSourceEventEvidence" |
    "prove" |
    "loadFinancialIdentityProof" |
    "verifyCurrentFinancialIdentityProof" |
    "flush"
> & {readonly control: PrivateAccountsFinancialControlFacade};

export type PrivateAccountsFinancialControlFacade = Pick<
  ReturnType<typeof createAccountsFinancialControlSource>,
  "prepareInitialFinancialControlSourceOriginal" |
    "prepareHistoricalFinancialControlSourceOriginals" |
    "prepareOriginalFinancialControlSource" |
    "loadFinancialSourceEventEvidence" |
    "flush"
>;

type PrivateFinancialControlOptions = Parameters<typeof createAccountsFinancialControlSource>[0];

export interface PrivateAccountsFinancialControlInputs {
  readonly receivers: NonNullable<PrivateFinancialControlOptions["receivers"]>;
  readonly eventEvidence: NonNullable<PrivateFinancialControlOptions["eventEvidence"]>;
  readonly genesisCoverage?: PrivateFinancialControlOptions["genesisCoverage"];
}

export interface PrivateAccountsFinancialSourceInputs {
  readonly registration: FinancialSourceRegistration;
  readonly challenges: NonNullable<AccountsFinancialSourceOptions["challenges"]>;
  readonly eventEvidence: AccountsFinancialEventEvidenceOptions;
  /** Optional only to retain the original preparation-only composition. Proof
   * and flush retain the actual producer's complete-receiver checks. */
  readonly receivers?: NonNullable<AccountsFinancialSourceOptions["receivers"]>;
  /** Independent C registration, callbacks and expiry clock. The service itself
   * is always obtained from the handler's canonical Control resolver. */
  readonly control?: PrivateAccountsFinancialControlInputs;
}

type RegisteredHeadReadRequest = Parameters<
  NonNullable<AccountsFinancialEventEvidenceOptions["registeredHeads"]>["readRegisteredHead"]
>[0];
type CredentialContextReadRequest = Parameters<
  NonNullable<AccountsFinancialEventEvidenceOptions["keyCustody"]>["readCredentialContext"]
>[0];

/** Code-selected in-process construction only. These actual same-module
 * functions/readers are not source qualification or a serialized capability. */
interface PrivateAccountsFinancialSourceConstruction {
  readonly createAccountsFinancialControlSource: typeof createAccountsFinancialControlSource;
  readonly FinancialSourceUnavailable: typeof FinancialSourceUnavailable;
  readonly core: Readonly<Pick<WorkspaceFinancialSourceService,
    "captureFinancialSourceSnapshot" | "assertFinancialSourceSnapshotCurrent" | "readEnrollmentOriginal">>;
}

export interface PrivateAccountsFinancialSourceOrigin<TEnv extends CloudflareWorkerEnv> {
  /** Supplied by the same canonical Control composition, never a copied facade. */
  readonly coreFinancialSource: (env: TEnv) => Promise<WorkspaceFinancialSourceService | undefined>;
  /** An owner-captured original C0/registration/key/head/clock set, not request data. */
  readonly inputs?: (
    env: TEnv,
    construction: PrivateAccountsFinancialSourceConstruction,
  ) => Promise<PrivateAccountsFinancialSourceInputs | undefined>;
  /** No store, env, configuration, token, or dispatch capability crosses this seam. */
  readonly observe?: (source: PrivateAccountsFinancialSourceFacade) => void | Promise<void>;
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
  /** @internal Explicit source preparation only; absent complete inputs remain off. */
  readonly privateFinancialSourceOrigin?: PrivateAccountsFinancialSourceOrigin<TEnv>;
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
  /** Immutable Workspace -> Organization lookup owned by the configured host. */
  readonly sharedWorkspaceBillingResolver?: (
    env: TEnv,
  ) => SharedWorkspaceBillingResolver | undefined;
  /** Configured authenticated financial owner; source never invents an ACK. */
  readonly workspaceBillingEnrollment?: (
    env: TEnv,
  ) => WorkspaceBillingEnrollmentPort | undefined;
  /** Owner ACK custody is explicit; credentials cannot synthesize this port. */
  readonly identityMergeReconciler?: (
    env: TEnv,
  ) => IdentityMergeReconciler | undefined;
  /** The same real service that the owning composition schedules. */
  readonly identityMergeRetry?: (
    env: TEnv,
  ) => IdentityMergeRetryCapability | undefined;
  readonly credentialUnlinkReconciler?: (
    env: TEnv,
  ) => CredentialUnlinkReconciler | undefined;
}

interface CachedAccountsHandler {
  readonly startedAtMs: number;
  readonly waiters: Set<AccountsHandlerWaiter>;
  initialization: Promise<void>;
  abandoned?: boolean;
  outcome?:
    | { readonly status: "fulfilled"; readonly handler: AccountsHandler }
    | {
        readonly status: "rejected";
        readonly error: unknown;
        readonly retryAtMs: number;
      };
}

interface AccountsHandlerWaiter {
  readonly resolve: (handler: AccountsHandler) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface CachedAccountsHandlerResult {
  readonly handler: AccountsHandler;
  readonly initializationWaitMs?: number;
}

const ACCOUNTS_HANDLER_INIT_DEADLINE_MS = 5_000;
// Rotate only on demand, so an abandoned request cannot cause a retry loop.
const ACCOUNTS_HANDLER_INIT_MAX_AGE_MS = 30_000;
const ACCOUNTS_HANDLER_INIT_FAILURE_BACKOFF_MS = 1_000;
// Per env and identity/control cache: three displaced flights plus one current.
const ACCOUNTS_HANDLER_INIT_MAX_ABANDONED = 3;
// Saturated callers may join the current flight, with bounded timer retention.
const ACCOUNTS_HANDLER_INIT_MAX_CAPACITY_WAITERS = 32;

class AccountsHandlerInitializationTimeoutError extends Error {
  constructor(readonly initializationWaitMs: number) {
    super("accounts handler initialization timed out");
    this.name = "TimeoutError";
  }
}

const handlers = new WeakMap<CloudflareWorkerEnv, CachedAccountsHandler>();
const identityHandlers = new WeakMap<
  CloudflareWorkerEnv,
  CachedAccountsHandler
>();
interface AbandonedAccountsHandlerCounts {
  identity: number;
  control: number;
  identityTotal: number;
  controlTotal: number;
}
const abandonedAccountsHandlerCounts = new WeakMap<
  CloudflareWorkerEnv,
  AbandonedAccountsHandlerCounts
>();
const controlPlaneOperationsByEnv = new WeakMap<
  CloudflareWorkerEnv,
  Promise<ControlPlaneOperations | undefined>
>();
interface PrivateFinancialSourceSlot { active: boolean }
interface PrivateFinancialSourceRecord {
  readonly owner: object;
  readonly resolve: () => Promise<PrivateAccountsFinancialSourceFacade>;
}
// A second full-handler build for one env revokes the prior private facade and
// cannot silently replace its Accounts store, Control service or origin inputs.
const privateFinancialSourceSlots = new WeakMap<CloudflareWorkerEnv, PrivateFinancialSourceSlot>();
const privateFinancialSourceByHandler = new WeakMap<AccountsHandler, PrivateFinancialSourceRecord>();
const PRIVATE_FINANCIAL_SOURCE_RESOLUTION_DEADLINE_MS = 5_000;

type CapturedPrivateFinancialSourceOrigin<TEnv extends CloudflareWorkerEnv> =
  Readonly<PrivateAccountsFinancialSourceOrigin<TEnv>>;

function nextPrivateFinancialSourceSlot(env: CloudflareWorkerEnv): PrivateFinancialSourceSlot {
  const prior = privateFinancialSourceSlots.get(env);
  if (prior) prior.active = false;
  const slot = { active: prior === undefined };
  privateFinancialSourceSlots.set(env, slot);
  return slot;
}

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
  // Capture the private functions at worker construction. Changing the options
  // object after a request begins cannot substitute the source origin.
  const requestedOrigin = options.privateFinancialSourceOrigin;
  const privateOrigin = requestedOrigin && Object.freeze({
    coreFinancialSource: requestedOrigin.coreFinancialSource,
    inputs: requestedOrigin.inputs,
    observe: requestedOrigin.observe,
  });
  const phaseDiagnostics = new WeakMap<
    TEnv,
    ReturnType<typeof createRequestPhaseDiagnostics>
  >();
  return {
    async resolvePrivateFinancialSource(env: TEnv): Promise<PrivateAccountsFinancialSourceFacade> {
      try {
        if (!privateOrigin) throw new FinancialSourceUnavailable("source_unavailable");
        // This may initialize the ordinary HTTP handler, but it never creates
        // a second store. Optional source callbacks run only after that handler
        // and its actual D1 store have been captured.
        const cached = await cachedAccountsHandler(env, options, false, undefined, privateOrigin);
        const record = privateFinancialSourceByHandler.get(cached.handler);
        if (record?.owner !== privateOrigin) throw new FinancialSourceUnavailable("source_unavailable");
        return await record.resolve();
      } catch {
        throw new FinancialSourceUnavailable("source_unavailable");
      }
    },
    async fetch(
      request: Request,
      env: TEnv,
      context?: AccountsWorkerExecutionContext,
    ): Promise<Response> {
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
        // The runtime-binding derivation key is not a required binding: a
        // composition without one is on the sealed lane, which is a legitimate
        // mode. It is only legitimate when it is DECLARED, though — the defect
        // this closes is a lane that switched itself silently — so readiness
        // names the mode, and a key that is present but unusable is a refusal
        // rather than a silent downgrade.
        const derivation = resolveRuntimeBindingDerivationKey(
          (env as unknown as Record<string, unknown>)[
            RUNTIME_BINDING_DERIVATION_KEY_ENV
          ],
        );
        if (!check.ok || derivation.status === "invalid") {
          const invalid =
            derivation.status === "invalid"
              ? [`${RUNTIME_BINDING_DERIVATION_KEY_ENV}: ${derivation.why}`]
              : [];
          console.error(
            "platform_bindings_missing",
            JSON.stringify({ missing: check.missing, invalid }),
          );
          return Response.json(
            { ok: false, missing: check.missing, invalid },
            { status: 503 },
          );
        }
        return Response.json({
          ok: true,
          runtimeBindingDerivation: runtimeBindingDerivationMode(derivation),
        });
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
        let diagnosticFactory = phaseDiagnostics.get(env);
        if (!diagnosticFactory) {
          diagnosticFactory = createRequestPhaseDiagnostics({
            environment: optionalString(env.TAKOSUMI_ENVIRONMENT),
            enabled: env.TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS,
          });
          phaseDiagnostics.set(env, diagnosticFactory);
        }
        const diagnostics = diagnosticFactory.forRequest(request);
        const cached = await diagnostics.measure("accounts_init", () =>
          cachedAccountsHandler(
            env,
            options,
            usesIdentityOnlyAccountsHandler(url.pathname),
            context,
            privateOrigin,
          ),
        );
        initializationTiming = cached;
        const response = await cached.handler(request);
        return appendAccountsHandlerInitializationTiming(
          response,
          initializationTiming,
        );
      } catch (error) {
        const initializationWaitMs =
          error instanceof AccountsHandlerInitializationTimeoutError
            ? error.initializationWaitMs
            : undefined;
        return appendAccountsHandlerInitializationTiming(
          Response.json(
            error instanceof AccountsHandlerInitializationTimeoutError
              ? {
                  error: "accounts_handler_initialization_unavailable",
                  error_description: "Accounts is temporarily unavailable.",
                }
              : {
                  error: "worker_configuration_error",
                  error_description:
                    error instanceof Error ? error.message : String(error),
                },
            error instanceof AccountsHandlerInitializationTimeoutError
              ? {
                  status: 503,
                  headers: { "cache-control": "no-store", "retry-after": "1" },
                }
              : { status: 500 },
          ),
          initializationWaitMs === undefined
            ? initializationTiming
            : { initializationWaitMs },
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
  context?: AccountsWorkerExecutionContext,
  privateOrigin?: CapturedPrivateFinancialSourceOrigin<TEnv>,
): Promise<CachedAccountsHandlerResult> {
  const cache = identityOnly ? identityHandlers : handlers;
  let cached = cache.get(env);
  const waitStartedAt = nowMs();
  let atAbandonmentCapacity = false;
  if (cached?.outcome?.status === "rejected" &&
    waitStartedAt >= cached.outcome.retryAtMs) {
    // This decision and installation of the replacement run without an await.
    // Concurrent callers therefore join exactly one current initialization.
    cache.delete(env);
    cached = undefined;
  } else if (
    cached &&
    !cached.outcome &&
    waitStartedAt - cached.startedAtMs >= ACCOUNTS_HANDLER_INIT_MAX_AGE_MS
  ) {
    const abandonedInits = getAbandonedAccountsHandlerCount(env, identityOnly);
    if (abandonedInits >= ACCOUNTS_HANDLER_INIT_MAX_ABANDONED) {
      atAbandonmentCapacity = true;
      const waiterCapacityReached =
        cached.waiters.size >= ACCOUNTS_HANDLER_INIT_MAX_CAPACITY_WAITERS;
      console.warn(
        JSON.stringify({
          event: waiterCapacityReached
            ? "accounts_handler_initialization_unavailable"
            : "accounts_handler_initialization_capacity_wait",
          mode: identityOnly ? "identity" : "control",
          stage: "abandonment_capacity",
          outcome: waiterCapacityReached ? "waiter_capacity" : "waiting",
          count: 1,
          activeWaiters: cached.waiters.size,
          maxWaiters: ACCOUNTS_HANDLER_INIT_MAX_CAPACITY_WAITERS,
          timeoutMs: ACCOUNTS_HANDLER_INIT_DEADLINE_MS,
          abandonedInits,
          abandonedInitsTotal: getAbandonedAccountsHandlerTotal(env, identityOnly),
          maxAbandonedInits: ACCOUNTS_HANDLER_INIT_MAX_ABANDONED,
        }),
      );
      if (waiterCapacityReached) {
        context?.waitUntil(cached.initialization);
        throw new AccountsHandlerInitializationTimeoutError(0);
      }
      // Join only the current attempt. An obsolete settlement never wakes a
      // caller or starts more I/O; a later request may use the released slot.
    } else {
      cached.abandoned = true;
      const counts = updateAbandonedAccountsHandlerCount(
        env,
        identityOnly,
        1,
      );
      console.warn(
        JSON.stringify({
          event: "accounts_handler_initialization_abandoned",
          mode: identityOnly ? "identity" : "control",
          ...counts,
          maxAbandonedInits: ACCOUNTS_HANDLER_INIT_MAX_ABANDONED,
        }),
      );
      cache.delete(env);
      cached = undefined;
    }
  }
  if (!cached) {
    cached = {
      startedAtMs: waitStartedAt,
      waiters: new Set(),
      initialization: Promise.resolve(),
    };
    cache.set(env, cached);
    const attempt = cached;
    const promise = observeAccountsHandlerInitialization(
      buildAccountsHandler(env, options, identityOnly, privateOrigin),
      identityOnly ? "identity" : "control",
    );
    const settle = (
      outcome: NonNullable<CachedAccountsHandler["outcome"]>,
    ): void => {
      // Obsolete work is still observed, but cannot dispatch old waiters or
      // publish a handler/error into the replacement. Its waiters time out.
      if (cache.get(env) !== attempt) {
        if (attempt.abandoned) {
          attempt.abandoned = false;
          const counts = updateAbandonedAccountsHandlerCount(
            env,
            identityOnly,
            -1,
          );
          console.warn(
            JSON.stringify({
              event: "accounts_handler_abandoned_initialization_settled",
              mode: identityOnly ? "identity" : "control",
              ...counts,
              maxAbandonedInits: ACCOUNTS_HANDLER_INIT_MAX_ABANDONED,
            }),
          );
        }
        return;
      }
      attempt.outcome = outcome;
      for (const waiter of attempt.waiters) {
        clearTimeout(waiter.timer);
        if (outcome.status === "fulfilled") waiter.resolve(outcome.handler);
        else waiter.reject(outcome.error);
      }
      attempt.waiters.clear();
    };
    // The retained initializer has exactly one settlement observer. Timed-out
    // requests remove their waiters without attaching reactions to this promise.
    attempt.initialization = promise.then(
      (handler) => settle({ status: "fulfilled", handler }),
      (error) => settle({
        status: "rejected",
        error,
        retryAtMs: nowMs() + ACCOUNTS_HANDLER_INIT_FAILURE_BACKOFF_MS,
      }),
    );
  }
  if (cached.outcome?.status === "fulfilled") {
    return { handler: cached.outcome.handler };
  }
  if (cached.outcome?.status === "rejected") throw cached.outcome.error;
  // Keep D1/schema work alive after a request's independent deadline returns
  // 503. Expiry also handles work canceled after the runtime's background limit.
  context?.waitUntil(cached.initialization);
  const handler = await new Promise<AccountsHandler>((resolve, reject) => {
    const waiter: AccountsHandlerWaiter = {
      resolve,
      reject,
      timer: setTimeout(() => {
        cached!.waiters.delete(waiter);
        const initializationWaitMs = nowMs() - waitStartedAt;
        console.warn(
          JSON.stringify({
            event: "accounts_handler_initialization_unavailable",
            mode: identityOnly ? "identity" : "control",
            stage: atAbandonmentCapacity ? "abandonment_capacity" : "await_handler",
            ...(atAbandonmentCapacity ? {
              outcome: "timeout",
              count: 1,
              abandonedInits: getAbandonedAccountsHandlerCount(env, identityOnly),
              maxWaiters: ACCOUNTS_HANDLER_INIT_MAX_CAPACITY_WAITERS,
            } : {}),
            timeoutMs: ACCOUNTS_HANDLER_INIT_DEADLINE_MS,
            elapsedMs: initializationWaitMs,
            errorName: "TimeoutError",
            activeWaiters: cached!.waiters.size,
          }),
        );
        reject(
          new AccountsHandlerInitializationTimeoutError(initializationWaitMs),
        );
      }, ACCOUNTS_HANDLER_INIT_DEADLINE_MS),
    };
    cached!.waiters.add(waiter);
  });
  if (atAbandonmentCapacity) {
    console.warn(JSON.stringify({
      event: "accounts_handler_initialization_capacity_wait",
      mode: identityOnly ? "identity" : "control",
      stage: "abandonment_capacity",
      outcome: "fulfilled",
      count: 1,
      elapsedMs: nowMs() - waitStartedAt,
    }));
  }
  return { handler, initializationWaitMs: nowMs() - waitStartedAt };
}

function getAbandonedAccountsHandlerCount(
  env: CloudflareWorkerEnv,
  identityOnly: boolean,
): number {
  const counts = abandonedAccountsHandlerCounts.get(env);
  return counts?.[identityOnly ? "identity" : "control"] ?? 0;
}

function updateAbandonedAccountsHandlerCount(
  env: CloudflareWorkerEnv,
  identityOnly: boolean,
  delta: 1 | -1,
): { readonly abandonedInits: number; readonly abandonedInitsTotal: number } {
  let counts = abandonedAccountsHandlerCounts.get(env);
  if (!counts) {
    counts = { identity: 0, control: 0, identityTotal: 0, controlTotal: 0 };
    abandonedAccountsHandlerCounts.set(env, counts);
  }
  const mode = identityOnly ? "identity" : "control";
  counts[mode] += delta;
  const totalMode = identityOnly ? "identityTotal" : "controlTotal";
  if (delta === 1) counts[totalMode] += 1;
  return {
    abandonedInits: counts[mode],
    abandonedInitsTotal: counts[totalMode],
  };
}

function getAbandonedAccountsHandlerTotal(
  env: CloudflareWorkerEnv,
  identityOnly: boolean,
): number {
  const counts = abandonedAccountsHandlerCounts.get(env);
  return counts?.[identityOnly ? "identityTotal" : "controlTotal"] ?? 0;
}

function appendAccountsHandlerInitializationTiming(
  response: Response,
  timing: Pick<CachedAccountsHandlerResult, "initializationWaitMs"> | undefined,
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

function capturePrivateFinancialConstruction(core: WorkspaceFinancialSourceService): {
  readonly construction: PrivateAccountsFinancialSourceConstruction;
  readonly assertReaderIdentity: () => void;
} {
  // Inspect data slots without invoking a replaced getter. The Root bridge and
  // actual C factory must capture the same functions on this exact instance.
  const readSlot = (key: keyof PrivateAccountsFinancialSourceConstruction["core"]): unknown => {
    let owner: object | null = core;
    while (owner !== null) {
      const slot = Object.getOwnPropertyDescriptor(owner, key);
      if (slot) return "value" in slot ? slot.value : undefined;
      owner = Object.getPrototypeOf(owner);
    }
    return undefined;
  };
  const capture = readSlot("captureFinancialSourceSnapshot") as WorkspaceFinancialSourceService["captureFinancialSourceSnapshot"];
  const assertCurrent = readSlot("assertFinancialSourceSnapshotCurrent") as WorkspaceFinancialSourceService["assertFinancialSourceSnapshotCurrent"];
  const readOriginal = readSlot("readEnrollmentOriginal") as WorkspaceFinancialSourceService["readEnrollmentOriginal"];
  const assertReaderIdentity = () => {
    if (typeof capture !== "function" || typeof assertCurrent !== "function" || typeof readOriginal !== "function" ||
        readSlot("captureFinancialSourceSnapshot") !== capture ||
        readSlot("assertFinancialSourceSnapshotCurrent") !== assertCurrent ||
        readSlot("readEnrollmentOriginal") !== readOriginal)
      throw new FinancialSourceUnavailable("source_unavailable");
  };
  assertReaderIdentity();
  return Object.freeze({
    assertReaderIdentity,
    construction: Object.freeze({
      createAccountsFinancialControlSource,
      FinancialSourceUnavailable,
      core: Object.freeze<PrivateAccountsFinancialSourceConstruction["core"]>({
        captureFinancialSourceSnapshot: (value) => Reflect.apply(capture, core, [value]),
        assertFinancialSourceSnapshotCurrent: (value) => Reflect.apply(assertCurrent, core, [value]),
        readEnrollmentOriginal: (value) => Reflect.apply(readOriginal, core, [value]),
      }),
    }),
  });
}

function capturePrivateFinancialEventEvidence(selected: AccountsFinancialEventEvidenceOptions): {
  readonly eventEvidence: AccountsFinancialEventEvidenceOptions;
  readonly now: NonNullable<AccountsFinancialSourceOptions["now"]>;
} {
  const heads = selected.registeredHeads, readHead = heads?.readRegisteredHead;
  const custody = selected.keyCustody, readCredential = custody?.readCredentialContext;
  const clock = selected.clock, readClock = clock?.nowMilliseconds;
  const sourceCredentialRef = selected.sourceCredentialRef;
  const sourceSchemaRef = selected.sourceSchemaRef;
  const receiverRef = selected.receiverRef;
  const targetRef = selected.targetRef;
  const receiverSchemaRef = selected.receiverSchemaRef;
  const clockPolicyRef = clock?.policyRef;
  if (!heads || !custody || !clock || typeof readHead !== "function" ||
      typeof readCredential !== "function" || typeof readClock !== "function" ||
      ![sourceCredentialRef, sourceSchemaRef, receiverRef, targetRef,
        receiverSchemaRef].every(financialSourceRef) || !financialSourceRef(clockPolicyRef))
    throw new FinancialSourceUnavailable("source_unavailable");
  const now = () => Reflect.apply(readClock, clock, []);
  return Object.freeze({
    now,
    eventEvidence: Object.freeze({
      sourceCredentialRef, sourceSchemaRef, receiverRef, targetRef, receiverSchemaRef,
      registeredHeads: Object.freeze({
        readRegisteredHead: async (request: RegisteredHeadReadRequest) =>
          await Reflect.apply(readHead, heads, [request]),
      }),
      keyCustody: Object.freeze({
        readCredentialContext: async (request: CredentialContextReadRequest) =>
          await Reflect.apply(readCredential, custody, [request]),
      }),
      clock: Object.freeze({policyRef: clockPolicyRef, nowMilliseconds: now}),
    }),
  });
}

function capturePrivateFinancialReceivers(
  values: AccountsFinancialSourceOptions["receivers"],
): AccountsFinancialSourceOptions["receivers"] {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 8)
    throw new FinancialSourceUnavailable("source_unavailable");
  type Receiver = NonNullable<AccountsFinancialSourceOptions["receivers"]>[number];
  const captured: Receiver[] = [];
  const seen = new Set<string>();
  for (const receiver of values) {
    const receiverRef = receiver?.receiverRef, targetRef = receiver?.targetRef;
    const read = receiver?.read, deliver = receiver?.deliver;
    if (!financialSourceRef(receiverRef) || !financialSourceRef(targetRef) ||
        typeof read !== "function" || typeof deliver !== "function" || seen.has(receiverRef))
      throw new FinancialSourceUnavailable("source_unavailable");
    seen.add(receiverRef);
    captured.push(Object.freeze<Receiver>({
      receiverRef, targetRef,
      read: async (materialization) => await Reflect.apply(read, receiver, [materialization]),
      deliver: async (materialization) => await Reflect.apply(deliver, receiver, [materialization]),
    }));
  }
  return Object.freeze(captured);
}

async function installPrivateFinancialSourceOrigin<TEnv extends CloudflareWorkerEnv>(input: {
  readonly env: TEnv;
  readonly slot: PrivateFinancialSourceSlot;
  readonly origin: CapturedPrivateFinancialSourceOrigin<TEnv>;
  readonly store: D1AccountsStore;
  readonly issuer: string;
  readonly clients: readonly OidcClientRegistration[] | undefined;
}): Promise<PrivateAccountsFinancialSourceFacade> {
  const {env, slot, origin, store, issuer, clients} = input;
  const isCurrent = () => slot.active && privateFinancialSourceSlots.get(env) === slot;
  // The staging owner currently supplies only the real Core resolver. Without
  // its separate fixed C0/registration/key/head/clock source this stays OFF.
  if (origin.inputs === undefined && origin.observe === undefined)
    throw new FinancialSourceUnavailable("source_unavailable");
  try {
    if (typeof origin.inputs !== "function" || typeof origin.observe !== "function" ||
        typeof origin.coreFinancialSource !== "function" || !clients || !isCurrent())
      throw new FinancialSourceUnavailable("source_unavailable");
    // Resolve the canonical instance before the owner constructs its private
    // G reader. This captures construction only; owner inputs must not dispatch.
    const core = await Reflect.apply(origin.coreFinancialSource, origin, [env]);
    if (!isCurrent() || !(core instanceof WorkspaceFinancialSourceService))
      throw new FinancialSourceUnavailable("source_unavailable");
    const capturedConstruction = capturePrivateFinancialConstruction(core);
    const supplied = await Reflect.apply(origin.inputs, origin, [env, capturedConstruction.construction]);
    capturedConstruction.assertReaderIdentity();
    if (!isCurrent() || !supplied || !supplied.challenges || !supplied.eventEvidence)
      throw new FinancialSourceUnavailable("source_unavailable");
    const registration = parseFinancialSourceRegistration(structuredClone(supplied.registration));
    const challengeOwner = supplied.challenges;
    const readChallenge = challengeOwner.read;
    const selected = capturePrivateFinancialEventEvidence(supplied.eventEvidence);
    const receivers = capturePrivateFinancialReceivers(supplied.receivers);
    const controlInput = supplied.control;
    let selectedControl: {
      readonly eventEvidence: NonNullable<PrivateFinancialControlOptions["eventEvidence"]>;
      readonly receivers: NonNullable<PrivateFinancialControlOptions["receivers"]>;
      readonly now: NonNullable<PrivateFinancialControlOptions["now"]>;
      readonly genesisCoverage?: PrivateFinancialControlOptions["genesisCoverage"];
    } | undefined;
    if (controlInput !== undefined) {
      if (!controlInput.eventEvidence || !controlInput.receivers)
        throw new FinancialSourceUnavailable("source_unavailable");
      const selectedEvidence = capturePrivateFinancialEventEvidence(controlInput.eventEvidence);
      const controlRegistration = parseFinancialSourceRegistration(structuredClone(controlInput.eventEvidence.registration));
      const controlReceivers = capturePrivateFinancialReceivers(controlInput.receivers);
      if (!controlReceivers || !controlRegistration.receivers.some((peer) =>
        peer.receiverRef === selectedEvidence.eventEvidence.receiverRef && peer.targetRef === selectedEvidence.eventEvidence.targetRef))
        throw new FinancialSourceUnavailable("source_unavailable");
      selectedControl = Object.freeze({
        eventEvidence: Object.freeze({...selectedEvidence.eventEvidence, registration: controlRegistration}),
        receivers: controlReceivers,
        now: selectedEvidence.now,
        ...(controlInput.genesisCoverage === undefined ? {} : {genesisCoverage: controlInput.genesisCoverage}),
      });
    }
    if (typeof readChallenge !== "function" ||
        !registration.receivers.some((peer) => peer.receiverRef === selected.eventEvidence.receiverRef && peer.targetRef === selected.eventEvidence.targetRef))
      throw new FinancialSourceUnavailable("source_unavailable");
    // Capture the callable and its original receiver before the next await.
    // Later mutation of the supplied option objects cannot swap bindings.
    const challenges: NonNullable<AccountsFinancialSourceOptions["challenges"]> = Object.freeze({
      read: async (ref: string) => await Reflect.apply(readChallenge, challengeOwner, [ref]),
    });
    // Core's actual Control original has an independent registration/full key.
    // Accounts registration must never be projected into Control event evidence.
    // A and C consume the captured expiry-clock callbacks through their existing
    // now options. No anchoredClock/default or policy string proves that those
    // callbacks have genuine Root/Financial clock custody.
    capturedConstruction.assertReaderIdentity();
    const control = createAccountsFinancialControlSource({service: core, ...selectedControl});
    const producer = createAccountsFinancialSource({
      store, issuer: normalizeIssuer(issuer), clients, registration, challenges, control,
      eventEvidence: selected.eventEvidence, receivers, now: selected.now,
    });
    let published = false;
    const through = async <T>(work: () => Promise<T>): Promise<T> => {
      if (!published || !isCurrent()) throw new FinancialSourceUnavailable("source_unavailable");
      const result = await work();
      if (!isCurrent()) throw new FinancialSourceUnavailable("source_unavailable");
      return result;
    };
    // C methods were not part of the original preparation-only inputs. Opting
    // into this private projection requires its own captured constructor ports;
    // their presence does not prove genuine origin/peer/clock qualification.
    const throughControl = async <T>(work: () => Promise<T>): Promise<T> => {
      if (!selectedControl) throw new FinancialSourceUnavailable("source_unavailable");
      return through(work);
    };
    const controlFacade = Object.freeze<PrivateAccountsFinancialControlFacade>({
      prepareInitialFinancialControlSourceOriginal: (value) =>
        throughControl(() => control.prepareInitialFinancialControlSourceOriginal(value)),
      prepareHistoricalFinancialControlSourceOriginals: (value) =>
        throughControl(() => control.prepareHistoricalFinancialControlSourceOriginals(value)),
      prepareOriginalFinancialControlSource: (value) =>
        throughControl(() => control.prepareOriginalFinancialControlSource(value)),
      loadFinancialSourceEventEvidence: (value) =>
        throughControl(() => control.loadFinancialSourceEventEvidence(value)),
      flush: (value) => throughControl(() => control.flush(value)),
    });
    const facade = Object.freeze<PrivateAccountsFinancialSourceFacade>({
      prepareFinancialIdentityProofSource: (value) =>
        through(() => producer.prepareFinancialIdentityProofSource(value)),
      preparePendingFinancialSourceOriginals: (value) =>
        through(() => producer.preparePendingFinancialSourceOriginals(value)),
      loadFinancialSourceEventEvidence: (value) =>
        through(() => producer.loadFinancialSourceEventEvidence(value)),
      // Fresh/current proof uses the explicitly captured C constructor too;
      // preparation-only inputs must not promote its legacy default clock.
      prove: (value) => throughControl(() => producer.prove(value)),
      loadFinancialIdentityProof: (value) =>
        through(() => producer.loadFinancialIdentityProof(value)),
      verifyCurrentFinancialIdentityProof: (value) =>
        throughControl(() => producer.verifyCurrentFinancialIdentityProof(value)),
      flush: (value) => through(() => producer.flush(value)),
      control: controlFacade,
    });
    await Reflect.apply(origin.observe, origin, [facade]);
    if (!isCurrent()) throw new FinancialSourceUnavailable("source_unavailable");
    published = true;
    return facade;
  } catch {
    slot.active = false;
    // The outer Accounts init response includes an error description. Never
    // echo a private callback/credential-reader exception into that response.
    throw new FinancialSourceUnavailable("source_unavailable");
  }
}

function privateFinancialSourceRecord<TEnv extends CloudflareWorkerEnv>(input: {
  readonly env: TEnv;
  readonly slot: PrivateFinancialSourceSlot;
  readonly origin: CapturedPrivateFinancialSourceOrigin<TEnv>;
  readonly store: D1AccountsStore;
  readonly issuer: string;
  readonly clients: readonly OidcClientRegistration[] | undefined;
}): PrivateFinancialSourceRecord {
  let flight: Promise<PrivateAccountsFinancialSourceFacade> | undefined;
  return {
    owner: input.origin,
    resolve: () => {
      if (!input.slot.active || privateFinancialSourceSlots.get(input.env) !== input.slot)
        return Promise.reject(new FinancialSourceUnavailable("source_unavailable"));
      if (!flight) {
        // One supervised source-only flight per actual handler. A stuck owner
        // callback cannot delay HTTP and cannot publish after this deadline.
        const operation = installPrivateFinancialSourceOrigin(input);
        flight = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            input.slot.active = false;
            reject(new FinancialSourceUnavailable("source_unavailable"));
          }, PRIVATE_FINANCIAL_SOURCE_RESOLUTION_DEADLINE_MS);
          void operation.then(
            (facade) => {
              clearTimeout(timer);
              if (input.slot.active) resolve(facade);
              else reject(new FinancialSourceUnavailable("source_unavailable"));
            },
            () => {
              clearTimeout(timer);
              input.slot.active = false;
              reject(new FinancialSourceUnavailable("source_unavailable"));
            },
          );
        });
      }
      return flight;
    },
  };
}

async function buildAccountsHandler<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  options: CreateCloudflareWorkerOptions<TEnv>,
  identityOnly = false,
  privateOrigin?: CapturedPrivateFinancialSourceOrigin<TEnv>,
): Promise<AccountsHandler> {
  // No identity-only request, later request, or abandoned initializer can
  // publish a new private source over an earlier source for the same env.
  const sourceSlot = identityOnly ? undefined : nextPrivateFinancialSourceSlot(env);
  if (!env.TAKOSUMI_ACCOUNTS_DB) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_DB D1 binding is required");
  }
  const schemaMode = accountsD1SchemaMode(env);
  const hostedSessionPolicy = parseHostedSessionPolicy(env);
  if (hostedSessionPolicy && schemaMode !== "predeployed") {
    throw new TypeError("Shared hosted Accounts requires predeployed schema mode; migrate and verify the protected ledger separately");
  }
  const sessionHashSalt = resolveCloudflareSessionHashSalt(env);
  const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
    schemaMode,
    sessionHashSalt,
  });
  if (schemaMode === "bootstrap") {
    await store.initialize();
  }
  const schemaEvidence = await ensureAccountsD1WorkerSchema(env.TAKOSUMI_ACCOUNTS_DB);
  if (hostedSessionPolicy && schemaEvidence.headVersion !== 5) {
    throw new TypeError("Shared hosted Accounts requires the exact verified v5 schema closure");
  }
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
  // The private financial source keeps reading only operator-configured
  // clients; the built-in native client is an Accounts sign-in concern.
  const configuredClients = parseConfiguredOidcClients(env);
  const { clients } = configuredOidcClientsWithTakosumiMobile(env);
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
    ...(hostedSessionPolicy ? { hostedSessionPolicy: true } : {}),
    workspaceMutationsFrozen: parseWorkspaceMutationsFrozen(
      env.TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN,
    ),
    appOwnershipMutationsFrozen: parseAppOwnershipMutationsFrozen(
      env.TAKOSUMI_APP_OWNERSHIP_MUTATIONS,
    ),
    installedAppDelegationSources: parseInstalledAppDelegationSources(
      env.TAKOSUMI_ACCOUNTS_DELEGATED_APP_SOURCES,
    ),
    trustedNativeClients: parseTrustedNativeClientsEnv(
      env.TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS,
    ),
    ...(hostedSessionPolicy && options.identityMergeReconciler
      ? { identityMergeReconciler: options.identityMergeReconciler(env) }
      : {}),
    ...(hostedSessionPolicy && options.identityMergeRetry
      ? { identityMergeRetry: options.identityMergeRetry(env) }
      : {}),
    ...(hostedSessionPolicy && options.credentialUnlinkReconciler
      ? { credentialUnlinkReconciler: options.credentialUnlinkReconciler(env) }
      : {}),
    ...(hostedSessionPolicy && options.controlPlaneOperations
      ? { sharedAccountWorkspaceDirectory: lazySharedAccountWorkspaceDirectory(env, store, options) }
      : {}),
    requestPhaseDiagnostics: {
      environment: optionalString(env.TAKOSUMI_ENVIRONMENT),
      enabled: env.TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS,
    },
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
  let handler: AccountsHandler;
  if (stableOidc) {
    handler = createAccountsHandler({
      ...commonOptions,
      jwks: stableOidc.jwks,
      oidcFlow: stableOidc.oidcFlow,
    });
  } else {
    handler = await createEphemeralAccountsHandler({
      ...commonOptions,
      subject: optionalString(env.TAKOSUMI_ACCOUNTS_SUBJECT),
    });
  }
  if (sourceSlot && privateOrigin) {
    privateFinancialSourceByHandler.set(handler, privateFinancialSourceRecord({
      env, slot: sourceSlot, origin: privateOrigin, store,
      issuer, clients: configuredClients,
    }));
  }
  return handler;
}

/** Resolve common Control only for directory operations, never identity probes. */
function lazySharedAccountWorkspaceDirectory<TEnv extends CloudflareWorkerEnv>(
  env: TEnv,
  store: D1AccountsStore,
  options: CreateCloudflareWorkerOptions<TEnv>,
): SharedAccountWorkspaceDirectory {
  let initialized: Promise<SharedAccountWorkspaceDirectory> | undefined;
  const resolve = (): Promise<SharedAccountWorkspaceDirectory> => {
    if (initialized) return initialized;
    const attempt = cachedControlPlaneOperations(env, options).then((operations) => {
      if (!operations) throw new TypeError("Shared Workspace authority is unavailable");
      return createSharedAccountWorkspaceDirectory({
        store,
        operations,
        workspaceMutationsFrozen: parseWorkspaceMutationsFrozen(
          env.TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN,
        ),
        resolveWorkspaceBilling: optionalString(env.TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY)
          ? createWorkspaceBillingBootstrapResolver({operations,billingAuthority:optionalString(env.TAKOSUMI_ACCOUNTS_WORKSPACE_BILLING_AUTHORITY)!,enrollment:options.workspaceBillingEnrollment?.(env)})
          : options.sharedWorkspaceBillingResolver?.(env),
      });
    }).catch((error: unknown) => {
      if (initialized === attempt) initialized = undefined;
      throw error;
    });
    initialized = attempt;
    return attempt;
  };
  return {
    bootstrap: async (session) => (await resolve()).bootstrap(session),
    menu: async (session, input) => (await resolve()).menu(session, input),
    choose: async (session, workspaceId) => (await resolve()).choose(session, workspaceId),
    create: async (session, input) => (await resolve()).create(session, input),
    billingOrganization: async (session, workspaceId, diagnostics) => {
      const directory = await measureRequestPhaseOperation(diagnostics, "shared_workspace_control_resolve", resolve);
      return directory.billingOrganization(session, workspaceId, diagnostics);
    },
  };
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
    const clients = value.map((record) => parseClientRecord(record, env));
    if (new Set(clients.map((client) => client.clientId)).size !== clients.length) {
      throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS clientId values must be unique");
    }
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
    if (selected.profile === "shared-account" && (confidentialClientSecret !== undefined || confidentialAuthMethod !== undefined)) {
      throw new TypeError("Shared hosted OIDC client bindings cannot be overridden by global client credentials");
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

/**
 * Static OIDC clients plus the Takosumi Mobile client. The built-in public
 * `takosumi-mobile` client is on by default so any instance accepts Takosumi
 * Mobile without manual registration. The shared hosted session policy keeps it
 * off unless the operator enables it, because that profile has no settled
 * control-plane credential path for native clients yet (ADR 0025/0026).
 */
export function configuredOidcClientsWithTakosumiMobile(
  env: CloudflareWorkerEnv,
): {
  readonly clients: readonly OidcClientRegistration[] | undefined;
  readonly mobileOidcClientId: string | undefined;
} {
  return composeTakosumiMobileOidcClients({
    configuredClientId: optionalString(env.TAKOSUMI_MOBILE_OIDC_CLIENT_ID),
    builtinClient: takosumiMobileBuiltinClientEnabled(env),
    clients: parseConfiguredOidcClients(env),
  });
}

/**
 * The built-in client is on by default. Under the shared hosted session policy
 * it stays off and cannot be turned on yet: its tokens would be ordinary
 * account-wide credentials outside that profile's identity-generation, fence
 * and global-logout model (ADR 0025/0026 open question).
 */
function takosumiMobileBuiltinClientEnabled(env: CloudflareWorkerEnv): boolean {
  const hosted = parseHostedSessionPolicy(env);
  const enabled = parseTakosumiMobileBuiltinClientSetting(
    env.TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT,
    !hosted,
  );
  if (hosted && enabled) {
    throw new TypeError(
      "TAKOSUMI_MOBILE_OIDC_BUILTIN_CLIENT cannot be enabled under the shared hosted session policy",
    );
  }
  return enabled;
}

export function configuredTakosumiMobileOidcClientId(
  env: CloudflareWorkerEnv,
): string | undefined {
  // Discovery reads the operator client list only when a Takosumi Mobile
  // client can exist, as before the built-in client.
  if (
    !optionalString(env.TAKOSUMI_MOBILE_OIDC_CLIENT_ID) &&
    !takosumiMobileBuiltinClientEnabled(env)
  ) {
    return undefined;
  }
  return configuredOidcClientsWithTakosumiMobile(env).mobileOidcClientId;
}

function parseClientRecord(value: unknown, env: CloudflareWorkerEnv): OidcClientRegistration {
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
  const profile = value.profile;
  if (profile !== undefined && profile !== "shared-account") {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS profile is unsupported");
  }
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS enabled must be boolean");
  }
  const secretEnv = optionalString(value.clientSecretEnv);
  if (secretEnv && !/^[A-Z][A-Z0-9_]*$/.test(secretEnv)) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS clientSecretEnv must name a secret binding");
  }
  if (secretEnv && value.clientSecret !== undefined) {
    throw new TypeError("TAKOSUMI_ACCOUNTS_CLIENTS secret binding and inline secret cannot both be supplied");
  }
  if (profile === "shared-account" && (!secretEnv || value.clientSecret !== undefined)) {
    throw new TypeError("Shared hosted OIDC clients require a separate clientSecretEnv binding");
  }
  const clientSecret = secretEnv ? optionalString(env[secretEnv]) : optionalString(value.clientSecret);
  if (secretEnv && !clientSecret) {
    throw new TypeError("An OIDC client secret binding is unavailable");
  }
  const tokenEndpointAuthMethod = parseClientAuthMethod(
    optionalString(value.tokenEndpointAuthMethod),
  );
  const allowedScopes = parseClientAllowedScopes(value.allowedScopes);
  return {
    clientId,
    redirectUris,
    ...(profile === "shared-account" ? { profile, enabled: value.enabled === true } : {}),
    ...(allowedScopes ? { allowedScopes } : {}),
    clientSecret,
    tokenEndpointAuthMethod,
  };
}

export function parseHostedSessionPolicy(env: CloudflareWorkerEnv): boolean {
  const raw = env.TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY;
  if (raw === undefined || raw === "false") return false;
  if (raw === "true") return true;
  throw new TypeError("TAKOSUMI_ACCOUNTS_HOSTED_SESSION_POLICY must be true or false");
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
