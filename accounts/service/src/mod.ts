import {
  type AccountsJsonWebKey,
  buildOidcDiscoveryDocument,
  type JsonWebKeySet,
  normalizeIssuer,
  TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH,
  TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH,
  TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH,
  TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH,
  TAKOSUMI_ACCOUNTS_INTROSPECT_PATH,
  TAKOSUMI_ACCOUNTS_JWKS_PATH,
  TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH,
  TAKOSUMI_ACCOUNTS_REVOKE_PATH,
  TAKOSUMI_ACCOUNTS_TOKEN_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
  TAKOSUMI_ACCOUNTS_USERINFO_PATH,
} from "@takosjp/takosumi-accounts-contract";

export type {
  AccountsJsonWebKey,
  JsonWebKeySet,
} from "@takosjp/takosumi-accounts-contract";

export {
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH,
  TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH,
  TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH,
} from "@takosjp/takosumi-accounts-contract";

import type { AccountsInstallationExportBundle } from "./export-bundle.ts";
import type {
  ServiceBindingMaterialKind,
  ServiceBindingMaterialRecord,
  InstallationRecord,
} from "./ledger.ts";
import {
  type AccountsStore,
  InMemoryAccountsStore,
  type OidcClientAuthMethod,
} from "./store.ts";
import type { SharedCellRuntimeAllocator } from "./runtime.ts";
import type { UpstreamOAuthProvider } from "./upstream.ts";
import {
  handleCreateAppInstallation,
  handleDownloadAppInstallationExport,
  handlePlanAppInstallationDeployment,
  handleGetAppInstallationExportOperation,
  handleReportInstallationBillingUsage,
  handleRequestAppInstallationExport,
  handleRequestAppInstallationMaterialize,
  handleUninstallAppInstallation,
  handleUpdateAppInstallationRevision,
  handleUpdateAppInstallationStatus,
} from "./installation-lifecycle-routes.ts";
import {
  handleGetAppInstallation,
  handleListAppInstallations,
  handleListInstallationEvents,
} from "./installation-routes.ts";
import { signEs256Jwt } from "./jwt.ts";
import {
  handlePasskeyAuthenticateComplete,
  handlePasskeyAuthenticateOptions,
  handlePasskeyRegisterComplete,
  handlePasskeyRegisterOptions,
} from "./passkey-routes.ts";
import {
  handleCreatePersonalAccessToken,
  handleListPersonalAccessTokens,
  handleRevokePersonalAccessToken,
} from "./pat-routes.ts";
import {
  handleCompletePrivacyRequest,
  handleCreatePrivacyRequest,
  handleGetPrivacyRequest,
  handleListPrivacyRequests,
  matchPrivacyRequestRoute,
} from "./privacy-routes.ts";
import {
  handleAuthorize,
  handleIntrospect,
  handleRevoke,
  handleToken,
  handleUserInfo,
} from "./oidc-routes.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  stringValue,
} from "./http-helpers.ts";
import { constantTimeEqual } from "./encoding.ts";
import {
  extractAccountSessionId,
  handleAccountSessionMeDelete,
  handleAccountSessionMeGet,
  requireAccountSession,
  TAKOSUMI_ACCOUNTS_SESSION_ME_PATH,
} from "./account-session.ts";
import {
  type LoginEmailAllowlist,
  rejectDisallowedPresentedSession,
} from "./login-email-allowlist.ts";
import { handleConsumeLaunchToken } from "./installation-routes-internal.ts";
import {
  handleAuthProvidersRequest,
  handleUpstreamAuthorizeRequest,
  handleUpstreamCallbackRequest,
  upstreamOAuthNotConfigured,
} from "./upstream-oauth-routes.ts";
export {
  handleAuthProvidersRequest,
  isRetiredUpstreamOAuthProviderId,
} from "./upstream-oauth-routes.ts";
import {
  type InstallationRoute,
  matchAccountTokenRevokeRoute,
  matchInstallationRoute,
} from "./route-matchers.ts";
import {
  handleInstallationPlanRunFacade,
  type DeployControlFacadeOptions,
} from "./deploy-control-facade.ts";
import {
  type ControlPlaneOperations,
  handleControlRoute,
  isControlRoutePath,
} from "./control-routes.ts";
import { maybeEnsurePersonalSpaceForSession } from "./control-personal-space.ts";
import {
  isServiceGraphMaterialResolveContext,
  resolveTakosumiServiceGraphMaterial,
  TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVE_PATH,
} from "./service-graph-material-resolver.ts";
import {
  platformAccessBlocked,
  type PlatformAccessPolicy,
  platformGuardedInstallationMutation,
} from "./platform-access-policy.ts";
import {
  requireAppInstallationAccountAccess,
  requireAppInstallationCreateWriteAccess,
  requireInstallationPlanRunWriteAccess,
} from "./installation-auth.ts";

export {
  requestDeploymentApply,
  requestDeploymentPlanRun,
  requestInstallationApply,
  requestInstallationPlanRun,
  requestRollback,
} from "./deploy-control-facade.ts";
export type {
  DeployControlOperations,
  DeployControlFacadeOptions,
} from "./deploy-control-facade.ts";
export type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
} from "./control-routes.ts";
export type { LoginEmailAllowlist } from "./login-email-allowlist.ts";
export { createOpenPlatformAccessPolicy } from "./platform-access-policy.ts";
export type {
  PlatformAccessPolicy,
  PlatformReadinessReportForOpenAccess,
} from "./platform-access-policy.ts";

export * from "./subject.ts";
export * from "./store.ts";
export * from "./upstream.ts";
export * from "./passkey.ts";
export * from "./identity.ts";
export * from "./jwt.ts";
// `ledger.ts` re-export is intentionally selective: the v1 contract reset
// (Wave 6) removed `RuntimeBindingRecord` / `ServiceBindingMaterialRecord` / `ServiceGrantMaterialRecord`
// / `InstallationEventRecord` / `AppInstallationLedgerStore` from the public
// surface. They remain `@internal` to `accounts-service` for ledger storage
// only and are not re-exported from the package barrel.
export {
  APP_INSTALLATION_STATUS_TRANSITIONS,
  assertValidServiceBindingMaterialDeclaration,
  assertValidServiceBindingMaterialRecord,
  assertValidServiceGrantMaterialRecord,
  buildInstallationEvent,
  canTransitionAppInstallationStatus,
  isServiceBindingMaterialKind,
  isServiceGrantMaterialCapability,
  isValidBindingName,
  transitionAppInstallationStatus,
  validateServiceBindingMaterialDeclaration,
  validateServiceBindingMaterialRecord,
  validateServiceGrantMaterialRecord,
  verifyInstallationEventHashChain,
} from "./ledger.ts";
export type {
  ServiceBindingMaterialKind,
  ServiceGrantMaterialCapability,
  AppInstallationMode,
  AppInstallationStatus,
  InstallationRecord,
  LedgerAccountRecord,
  SpaceKind,
  SpaceRecord,
  ValidationIssue,
} from "./ledger.ts";
export * from "./runtime.ts";
export * from "./export-bundle.ts";
export * from "./export-download-url.ts";
export * from "./service-graph-material-resolver.ts";
export * from "./postgres-store.ts";
export * from "./d1-store.ts";
export {
  registerSessionHashSaltConfig,
  resolveSessionHashSalt,
} from "./session-hash-salt.ts";
export type { PasskeyChallengeIntent } from "./passkey-challenge-store.ts";

export type AccountsHandler = (request: Request) => Promise<Response>;

export const TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER =
  "x-takosumi-materialize-drill-token";
export const TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER =
  "x-takosumi-privacy-operations-token";

export interface AccountsHandlerOptions {
  issuer?: string;
  jwks?: JsonWebKeySet;
  clients?: readonly OidcClientRegistration[];
  store?: AccountsStore;
  oidcFlow?: OidcAuthorizationCodeFlow;
  upstreamOAuth?: UpstreamOAuthOptions;
  passkeys?: PasskeyHttpOptions;
  launchTokens?: LaunchTokenOptions;
  deployControl?: DeployControlFacadeOptions;
  /**
   * In-process deploy-control operations facade backing the session-authed
   * `/api/v1/*` account-plane routes the dashboard SPA calls (M10). The
   * platform worker passes its wired `TakosumiOperations` here; it structurally
   * satisfies {@link ControlPlaneOperations}. When omitted the control routes
   * respond 503 after the session gate.
   */
  controlPlaneOperations?: ControlPlaneOperations;
  bindingMaterializer?: ServiceBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
  materializeWorker?: AppInstallationMaterializeWorker;
  exportWorker?: AppInstallationExportWorker;
  platformAccess?: PlatformAccessPolicy;
  loginEmailAllowlist?: LoginEmailAllowlist;
  serviceGraphMaterialResolver?: ServiceGraphMaterialResolverHttpOptions;
  /**
   * Operator-only token that lets the dedicated-materialize readiness drill
   * request materialization while hosted platform access is still closed. This
   * bypasses only the launch-readiness gate; account session, Installation
   * ownership, idempotency, cost acknowledgement, and permission digest checks
   * still run normally.
   */
  materializeDrillToken?: string;
  /**
   * Operator-only token for marking privacy export/delete requests complete.
   * Customers may create/read their own requests with their account session,
   * but completion is support/operator evidence and must not be writable by
   * the customer whose data is being handled.
   */
  privacyOperationsToken?: string;
  /**
   * HMAC secret used to sign installation export download redirects. When
   * omitted the handler falls back to the
   * `TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` env var; if both are
   * missing the download route responds 503 `feature_unavailable` rather
   * than emit unsigned URLs to tenant-scoped artifacts.
   */
  exportDownloadSigningSecret?: string | Uint8Array;
}

export interface EphemeralAccountsHandlerOptions {
  issuer?: string;
  subject?: string;
  keyId?: string;
  clients?: readonly OidcClientRegistration[];
  store?: AccountsStore;
  upstreamOAuth?: UpstreamOAuthOptions;
  passkeys?: PasskeyHttpOptions;
  launchTokens?: EphemeralLaunchTokenOptions;
  deployControl?: DeployControlFacadeOptions;
  controlPlaneOperations?: ControlPlaneOperations;
  bindingMaterializer?: ServiceBindingMaterializer;
  sharedCellRuntime?: SharedCellRuntimeAllocator;
  materializeWorker?: AppInstallationMaterializeWorker;
  exportWorker?: AppInstallationExportWorker;
  platformAccess?: PlatformAccessPolicy;
  loginEmailAllowlist?: LoginEmailAllowlist;
  serviceGraphMaterialResolver?: ServiceGraphMaterialResolverHttpOptions;
  privacyOperationsToken?: string;
  exportDownloadSigningSecret?: string | Uint8Array;
  /**
   * Escape hatch for the fail-closed ephemeral-key guard. The ephemeral
   * handler generates a fresh per-process ECDSA signing keypair, which is
   * unsafe for any real (https) issuer: on Cloudflare each isolate generates
   * its own keypair (so an id_token signed by isolate A fails verification
   * against the /jwks key served by isolate B), and on node-postgres every
   * process restart / additional replica rotates the key and invalidates all
   * live id_tokens. By default `createEphemeralAccountsHandler` therefore
   * hard-fails when the issuer is https (mirroring the
   * `TAKOSUMI_ACCOUNTS_ISSUER` hard-fail), pointing the operator at
   * `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` + the two pairwise secrets.
   *
   * Set this to `true` ONLY where the ephemeral key is deliberate even though
   * the issuer is https-style — e.g. tests and local-substrate / LAN dev
   * running under Pebble TLS on `*.takosumi.test`. Production wiring must
   * provide a stable JWK instead of setting this flag.
   */
  allowEphemeralKeyOnHttpsIssuer?: boolean;
}

export interface ServiceGraphMaterialResolverHttpOptions {
  readonly token: string;
  readonly billingPortalUrl?: string;
  readonly internalUrl?: string;
  readonly allowDeployControlInstallations?: boolean;
}

export interface AccountsServerOptions extends AccountsHandlerOptions {
  hostname?: string;
  port?: number;
}

export interface OidcAuthorizationCodeFlow {
  subject: string;
  pairwiseSubjectSecret?: string | Uint8Array | CryptoKey;
  issueIdToken: (claims: Record<string, unknown>) => Promise<string>;
}

export interface OidcClientRegistration {
  clientId: string;
  redirectUris: readonly string[];
  clientSecret?: string;
  tokenEndpointAuthMethod?: OidcClientAuthMethod;
}

export interface ServiceBindingMaterializerInput {
  installation: InstallationRecord;
  binding: ServiceBindingMaterialRecord;
  declaration?: Record<string, unknown>;
  issuer: string;
}

export interface ServiceBindingMaterializationResult {
  configRef: string;
  secretRefs?: readonly string[];
  env?: Record<string, string>;
}

export type ServiceBindingMaterializer = (
  input: ServiceBindingMaterializerInput,
) =>
  | ServiceBindingMaterializationResult
  | undefined
  | Promise<ServiceBindingMaterializationResult | undefined>;

export interface AppInstallationMaterializeRequest {
  readonly mode: "dedicated";
  readonly region: string;
  readonly plan: Record<string, unknown>;
  readonly cutover: Record<string, unknown>;
  readonly confirm: {
    readonly costAck: true;
    readonly permissionDigest: string;
  };
}

export interface AppInstallationMaterializeWorkerInput {
  readonly installation: InstallationRecord;
  readonly operationId: string;
  readonly request: AppInstallationMaterializeRequest;
  readonly preserve: Record<string, unknown>;
  readonly preserveDigest: string;
}

export interface AppInstallationMaterializeWorkerResult {
  readonly runtimeTarget: {
    readonly runtimeTargetId?: string;
    readonly targetType?: "dedicated";
    readonly targetId: string;
  };
  readonly continuity: AppInstallationMaterializeContinuityEvidence;
  readonly preserveDigest?: string;
  readonly reason?: string;
}

interface AppInstallationConfirmRecord {
  readonly permissionDigest: string;
  readonly costAck: boolean;
  readonly approvalRequired?: boolean;
  readonly expiresAt?: string;
}

export interface AppInstallationMaterializeContinuityEvidence {
  readonly sourceDataNamespace: string | null;
  readonly oidcClient: Record<string, unknown> | null;
  readonly preservedServiceBindings: readonly {
    readonly name: string;
    readonly kind: ServiceBindingMaterialKind;
    readonly configRef: string;
    readonly secretRefs: readonly string[];
  }[];
  readonly cutover: {
    readonly fromTargetId: string | null;
    readonly toTargetId: string;
    readonly ready: boolean;
    readonly strategy?: string;
  };
}

export type AppInstallationMaterializeWorker = (
  input: AppInstallationMaterializeWorkerInput,
) =>
  | AppInstallationMaterializeWorkerResult
  | Promise<AppInstallationMaterializeWorkerResult>;

export interface AppInstallationExportRequest {
  readonly includeData: boolean;
  readonly format: "bundle";
  readonly encryption: {
    readonly method: "none" | "age";
    readonly recipients: readonly string[];
  };
  readonly scope: Record<string, unknown>;
}

export interface AppInstallationExportWorkerInput {
  readonly installation: InstallationRecord;
  readonly operationId: string;
  readonly request: AppInstallationExportRequest;
  readonly bundle: AccountsInstallationExportBundle;
}

export interface AppInstallationExportWorkerResult {
  readonly downloadUrl: string;
  readonly downloadExpiresAt?: string;
  readonly archiveDigest?: string;
}

export type AppInstallationExportWorker = (
  input: AppInstallationExportWorkerInput,
) =>
  | AppInstallationExportWorkerResult
  | Promise<AppInstallationExportWorkerResult>;

export interface UpstreamOAuthOptions {
  subjectSecret: string | Uint8Array | CryptoKey;
  providers: readonly UpstreamOAuthClientRegistration[];
  fetch?: typeof fetch;
  sessionTtlMs?: number;
}

export interface UpstreamOAuthClientRegistration {
  providerId: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes?: readonly string[];
  provider?: UpstreamOAuthProvider;
}

export interface PasskeyHttpOptions {
  rpId: string;
  rpName: string;
  origin: string;
  sessionTtlMs?: number;
}

export interface LaunchTokenOptions {
  issuer?: string;
  pairwiseSubjectSecret?: string | Uint8Array | CryptoKey;
}

export interface EphemeralLaunchTokenOptions {
  /**
   * Reserved for future ephemeral launch-token configuration.
   * Opaque launch tokens do not require signing keys.
   */
  _reserved?: never;
}

export const TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_SUFFIX = "/launch-token";

const emptyJwks: JsonWebKeySet = { keys: [] };

export async function createEphemeralAccountsHandler(
  options: EphemeralAccountsHandlerOptions = {},
): Promise<AccountsHandler> {
  const issuer = normalizeIssuer(options.issuer);
  // Fail closed: a per-process ephemeral signing key cannot back a real
  // (https, non-localhost) issuer — it breaks id_token verification on
  // restart and under horizontal scale (per-isolate keys on Cloudflare,
  // per-replica/per-restart keys on node-postgres). Mirror the
  // TAKOSUMI_ACCOUNTS_ISSUER hard-fail rather than silently shipping a
  // 200-OK-but-broken OIDC issuer. Localhost / plain-http dev issuers stay
  // ephemeral, and the explicit opt-out keeps deliberate https-style dev/test
  // (e.g. local-substrate under Pebble TLS) green.
  if (
    !options.allowEphemeralKeyOnHttpsIssuer &&
    isEphemeralKeyUnsafeIssuer(issuer)
  ) {
    throw new TypeError(
      `refusing to boot an https issuer (${issuer}) on an ephemeral OIDC ` +
        `signing key: the per-process key breaks id_token verification on ` +
        `restart and under horizontal scale. Set ` +
        `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK + ` +
        `TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET + ` +
        `TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET for a stable signing ` +
        `key, or pass allowEphemeralKeyOnHttpsIssuer:true for deliberate ` +
        `dev/test issuers.`,
    );
  }
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const keyId = options.keyId ?? `takosumi-dev-${crypto.randomUUID()}`;
  const publicJwk = (await crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey,
  )) as AccountsJsonWebKey;
  return createAccountsHandler({
    issuer,
    clients: options.clients,
    store: options.store,
    upstreamOAuth: options.upstreamOAuth,
    passkeys: options.passkeys,
    deployControl: options.deployControl,
    controlPlaneOperations: options.controlPlaneOperations,
    bindingMaterializer: options.bindingMaterializer,
    sharedCellRuntime: options.sharedCellRuntime,
    materializeWorker: options.materializeWorker,
    exportWorker: options.exportWorker,
    platformAccess: options.platformAccess ?? {
      status: "closed",
    },
    loginEmailAllowlist: options.loginEmailAllowlist,
    serviceGraphMaterialResolver: options.serviceGraphMaterialResolver,
    privacyOperationsToken: options.privacyOperationsToken,
    exportDownloadSigningSecret: options.exportDownloadSigningSecret,
    launchTokens: {
      pairwiseSubjectSecret: `takosumi-dev-launch-pairwise:${
        options.subject ?? keyId
      }`,
    },
    jwks: {
      keys: [
        {
          ...publicJwk,
          kid: keyId,
          use: "sig",
          alg: "ES256",
        },
      ],
    },
    oidcFlow: {
      subject: options.subject ?? "tsub_dev_seed",
      pairwiseSubjectSecret: `takosumi-dev-pairwise:${
        options.subject ?? keyId
      }`,
      issueIdToken: (claims) =>
        signEs256Jwt({
          header: {
            alg: "ES256",
            typ: "JWT",
            kid: keyId,
          },
          claims,
          privateKey: keyPair.privateKey,
        }),
    },
  });
}

export function createAccountsHandler(
  options: AccountsHandlerOptions = {},
): AccountsHandler {
  const issuer = normalizeIssuer(options.issuer);
  const discovery = buildOidcDiscoveryDocument({ issuer });
  const jwks = options.jwks ?? emptyJwks;
  const clients = new Map(
    (options.clients ?? []).map((client) => [client.clientId, client]),
  );
  const store = options.store ?? new InMemoryAccountsStore();
  const isProductionIssuer = isHttpsIssuer(issuer);
  const loginEmailAllowlist = options.loginEmailAllowlist;

  // Per-isolate rate limiters. Each entry maps client IP to a sliding window
  // of recent request timestamps. These limiters guard the abuse-prone OIDC
  // and installation surfaces so a single bad actor cannot trivially exhaust
  // the issuer. Per-isolate state means a Workers deployment with multiple
  // isolates only enforces the budget locally; operators MUST add an
  // edge-level rate limiter (Cloudflare WAF / Caddy rate_limit / etc.) for
  // production-grade protection. The defaults below are conservative
  // best-effort guards, NOT a substitute for edge-side limiting.
  const authorizeLimiter = createInMemoryRateLimiter(60);
  const tokenLimiter = createInMemoryRateLimiter(120);
  const accountTokensLimiter = createInMemoryRateLimiter(10);
  const installationsLimiter = createInMemoryRateLimiter(30);
  const launchConsumeLimiter = createInMemoryRateLimiter(30);

  const inner = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      if (!isGetOrHead(request)) return methodNotAllowed("GET, HEAD");
      return json({ ok: true, service: "takosumi-accounts" });
    }

    if (
      url.pathname === TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVE_PATH
    ) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.serviceGraphMaterialResolver) {
        return errorJson("not_found", "not found", 404);
      }
      const authBlocked = requireServiceGraphMaterialResolverAccess({
        request,
        token: options.serviceGraphMaterialResolver.token,
      });
      if (authBlocked) return authBlocked;
      const body = await readJsonObject(request);
      if (!isServiceGraphMaterialResolveContext(body)) {
        return errorJson(
          "invalid_request",
          "request body must contain installationId plus sourceRef or kind",
          400,
        );
      }
      const material = await resolveTakosumiServiceGraphMaterial({
        store,
        issuer,
        internalUrl: options.serviceGraphMaterialResolver.internalUrl,
        billingPortalUrl: options.serviceGraphMaterialResolver.billingPortalUrl,
        allowDeployControlInstallations:
          options.serviceGraphMaterialResolver.allowDeployControlInstallations,
        context: body,
      });
      if (Array.isArray(material)) {
        return json({ materials: material });
      }
      if (!material) {
        return errorJson(
          "platform_service_not_found",
          "platform service not found",
          404,
        );
      }
      return json({ material });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_OIDC_DISCOVERY_PATH) {
      if (!isGetOrHead(request)) return methodNotAllowed("GET, HEAD");
      return json(discovery);
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_JWKS_PATH) {
      if (!isGetOrHead(request)) return methodNotAllowed("GET, HEAD");
      return json(jwks);
    }

    if (!isLoginAllowlistBypassPath(url.pathname)) {
      const rejectedSession = await rejectDisallowedPresentedSession({
        request,
        store,
        sessionId: extractAccountSessionId(request),
        allowlist: loginEmailAllowlist,
        secureCookie: isProductionIssuer,
      });
      if (rejectedSession) return rejectedSession;
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_AUTHORIZE_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (!options.oidcFlow) return reservedOidcEndpoint();
      const limited = authorizeLimiter.consume(request);
      if (limited) return limited;
      return await handleAuthorize({
        request,
        url,
        flow: options.oidcFlow,
        clients,
        store,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_TOKEN_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.oidcFlow) return reservedOidcEndpoint();
      const limited = tokenLimiter.consume(request);
      if (limited) return limited;
      return await handleToken({
        issuer,
        request,
        store,
        flow: options.oidcFlow,
        clients,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_USERINFO_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await handleUserInfo({ request, store });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_REVOKE_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleRevoke({ request, store, clients });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_INTROSPECT_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleIntrospect({ issuer, request, store, clients });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_SESSION_ME_PATH) {
      if (request.method === "GET") {
        // First-login personal-Space hook (spec §4). The dashboard hits this
        // route first after sign-in; fire-and-forget the idempotent ensure so
        // a personal Space exists without coupling it to the OAuth seam. Never
        // awaited on the response path: a failure here must not affect the
        // session read. `request.clone()` keeps the body/headers intact for the
        // response handler (this is a GET, so only headers).
        void maybeEnsurePersonalSpaceForSession({
          request: request.clone(),
          store,
          operations: options.controlPlaneOperations,
        });
        return await handleAccountSessionMeGet({ request, store });
      }
      if (request.method === "DELETE") {
        return await handleAccountSessionMeDelete({
          request,
          store,
          secureCookie: isProductionIssuer,
        });
      }
      return methodNotAllowed("DELETE, GET");
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_ACCOUNT_TOKENS_PATH) {
      if (request.method === "GET") {
        return await handleListPersonalAccessTokens({ request, url, store });
      }
      if (request.method === "POST") {
        const limited = accountTokensLimiter.consume(request);
        if (limited) return limited;
        return await handleCreatePersonalAccessToken({ request, store });
      }
      return methodNotAllowed("GET, POST");
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH) {
      const session = await requireAccountSession({
        request: request.clone(),
        store,
      });
      if (!session.ok) return session.response;
      if (request.method === "GET") {
        return await handleListPrivacyRequests({
          store,
          subject: session.subject,
        });
      }
      if (request.method === "POST") {
        return await handleCreatePrivacyRequest({
          request,
          store,
          subject: session.subject,
        });
      }
      return methodNotAllowed("GET, POST");
    }

    const privacyRequestRoute = matchPrivacyRequestRoute(
      url.pathname,
      TAKOSUMI_ACCOUNTS_PRIVACY_REQUESTS_PATH,
    );
    if (privacyRequestRoute) {
      if (!privacyRequestRoute.action && request.method === "GET") {
        const session = await requireAccountSession({
          request: request.clone(),
          store,
        });
        if (!session.ok) return session.response;
        return await handleGetPrivacyRequest({
          request,
          store,
          subject: session.subject,
          requestId: privacyRequestRoute.requestId,
        });
      }
      if (
        privacyRequestRoute.action === "complete" &&
        request.method === "POST"
      ) {
        const tokenBlocked = requirePrivacyOperationsAccess({
          request,
          token: options.privacyOperationsToken,
        });
        if (tokenBlocked) return tokenBlocked;
        return await handleCompletePrivacyRequest({
          request,
          store,
          requestId: privacyRequestRoute.requestId,
        });
      }
      return methodNotAllowed(
        privacyRequestRoute.action === "complete" ? "POST" : "GET",
      );
    }

    const accountTokenRevokeRoute = matchAccountTokenRevokeRoute(url.pathname);
    if (accountTokenRevokeRoute) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await handleRevokePersonalAccessToken({
        tokenId: accountTokenRevokeRoute.tokenId,
        request,
        store,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      // Deliberately not gated on `options.upstreamOAuth`: this route reports
      // which sign-in methods are configured (so the sign-in screen can disable
      // the rest) and must answer even when nothing is configured.
      return handleAuthProvidersRequest({
        upstreamOAuth: options.upstreamOAuth,
        passkeys: options.passkeys,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (!options.upstreamOAuth) return upstreamOAuthNotConfigured();
      return handleUpstreamAuthorizeRequest({
        url,
        upstreamOAuth: options.upstreamOAuth,
        secureCookie: isProductionIssuer,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      if (!options.upstreamOAuth) return upstreamOAuthNotConfigured();
      return await handleUpstreamCallbackRequest({
        request,
        url,
        store,
        upstreamOAuth: options.upstreamOAuth,
        secureCookie: isProductionIssuer,
        loginEmailAllowlist,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_OPTIONS_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.passkeys) return passkeysNotConfigured();
      return await handlePasskeyRegisterOptions({
        request,
        store,
        passkeys: options.passkeys,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_PASSKEY_REGISTER_COMPLETE_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.passkeys) return passkeysNotConfigured();
      return await handlePasskeyRegisterComplete({
        request,
        store,
        passkeys: options.passkeys,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.passkeys) return passkeysNotConfigured();
      return await handlePasskeyAuthenticateOptions({
        request,
        store,
        passkeys: options.passkeys,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      if (!options.passkeys) return passkeysNotConfigured();
      return await handlePasskeyAuthenticateComplete({
        request,
        store,
        passkeys: options.passkeys,
        secureCookie: isProductionIssuer,
        loginEmailAllowlist,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_INSTALLATION_PLAN_RUNS_PATH) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const authBlocked = await requireInstallationPlanRunWriteAccess({
        request: request.clone(),
        store,
      });
      if (authBlocked) return authBlocked;
      if (!options.deployControl) {
        return errorJson(
          "feature_unavailable",
          "Installation PlanRun is temporarily unavailable.",
          503,
        );
      }
      return await handleInstallationPlanRunFacade({
        request,
        deployControl: options.deployControl,
      });
    }

    if (url.pathname === TAKOSUMI_ACCOUNTS_INSTALLATIONS_PATH) {
      if (request.method === "POST") {
        const limited = installationsLimiter.consume(request);
        if (limited) return limited;
        const authBlocked = await requireAppInstallationCreateWriteAccess({
          request: request.clone(),
          store,
        });
        if (authBlocked) return authBlocked;
        return await handleCreateAppInstallation({
          request,
          store,
          issuer,
          deployControl: options.deployControl,
          launchTokens: options.launchTokens,
          bindingMaterializer: options.bindingMaterializer,
          sharedCellRuntime: options.sharedCellRuntime,
        });
      }
      if (request.method === "GET") {
        return await handleListAppInstallations({ request, url, store });
      }
      return methodNotAllowed("GET, POST");
    }

    const installationRoute = matchInstallationRoute(url.pathname);
    if (installationRoute) {
      const materializeDrillAllowed =
        installationRoute.kind === "materialize" &&
        request.method === "POST" &&
        materializeDrillAccessAllowed({
          request,
          token: options.materializeDrillToken,
        });
      if (
        platformGuardedInstallationMutation(
          installationRoute.kind,
          request.method,
        ) &&
        !materializeDrillAllowed
      ) {
        const blocked = platformAccessBlocked(options.platformAccess);
        if (blocked) return blocked;
      }
      const accountAccess = installationRouteAccountAccess(
        installationRoute,
        request.method,
      );
      if (accountAccess) {
        const authBlocked = await requireAppInstallationAccountAccess({
          request,
          store,
          installationId: installationRoute.installationId,
          scope: accountAccess,
        });
        if (authBlocked) return authBlocked;
      }
      if (
        installationRoute.kind === "installation" &&
        request.method === "GET"
      ) {
        return await handleGetAppInstallation({
          installationId: installationRoute.installationId,
          request,
          store,
        });
      }
      if (
        installationRoute.kind === "installation" &&
        request.method === "DELETE"
      ) {
        return await handleUninstallAppInstallation({
          installationId: installationRoute.installationId,
          request,
          store,
        });
      }
      if (installationRoute.kind === "status" && request.method === "PATCH") {
        const authBlocked = await requireAppInstallationAccountAccess({
          request,
          store,
          installationId: installationRoute.installationId,
          scope: "write",
        });
        if (authBlocked) return authBlocked;
        return await handleUpdateAppInstallationStatus({
          installationId: installationRoute.installationId,
          request,
          store,
        });
      }
      if (
        installationRoute.kind === "deployment-plan-run" &&
        request.method === "POST"
      ) {
        return await handlePlanAppInstallationDeployment({
          installationId: installationRoute.installationId,
          request,
          store,
          deployControl: options.deployControl,
        });
      }
      if (
        installationRoute.kind === "deployment" &&
        request.method === "POST"
      ) {
        return await handleUpdateAppInstallationRevision({
          installationId: installationRoute.installationId,
          operation: "deployment",
          request,
          store,
          deployControl: options.deployControl,
        });
      }
      if (installationRoute.kind === "rollback" && request.method === "POST") {
        return await handleUpdateAppInstallationRevision({
          installationId: installationRoute.installationId,
          operation: "rollback",
          request,
          store,
          deployControl: options.deployControl,
        });
      }
      if (
        installationRoute.kind === "materialize" &&
        request.method === "POST"
      ) {
        return await handleRequestAppInstallationMaterialize({
          installationId: installationRoute.installationId,
          request,
          store,
          materializeWorker: options.materializeWorker,
        });
      }
      if (installationRoute.kind === "export" && request.method === "POST") {
        return await handleRequestAppInstallationExport({
          installationId: installationRoute.installationId,
          request,
          store,
          exportWorker: options.exportWorker,
        });
      }
      if (
        installationRoute.kind === "export-operation" &&
        request.method === "GET"
      ) {
        return await handleGetAppInstallationExportOperation({
          installationId: installationRoute.installationId,
          operationId: installationRoute.operationId,
          store,
        });
      }
      if (
        installationRoute.kind === "export-download" &&
        request.method === "GET"
      ) {
        return await handleDownloadAppInstallationExport({
          installationId: installationRoute.installationId,
          operationId: installationRoute.operationId,
          store,
          exportDownloadSigningSecret: options.exportDownloadSigningSecret,
        });
      }
      if (installationRoute.kind === "events" && request.method === "GET") {
        return await handleListInstallationEvents({
          installationId: installationRoute.installationId,
          request,
          url,
          store,
        });
      }
      if (
        installationRoute.kind === "billing-usage-reports" &&
        request.method === "POST"
      ) {
        return await handleReportInstallationBillingUsage({
          installationId: installationRoute.installationId,
          request,
          store,
        });
      }
      if (
        installationRoute.kind === "launch-token-consume" &&
        request.method === "POST"
      ) {
        const limited = launchConsumeLimiter.consume(request);
        if (limited) return limited;
        return await handleConsumeLaunchToken({
          installationId: installationRoute.installationId,
          request,
          store,
        });
      }
      return methodNotAllowed("DELETE, GET, PATCH, POST");
    }

    // Account-plane session-authed deploy-control surface. Owns the edge-public
    // `/api/v1/*` namespace the dashboard SPA calls same-origin with its account
    // session (NOT the operator deploy-control bearer). Dispatched here before
    // the generic 404; `handleControlRoute` returns `undefined` only for paths
    // it does not own.
    if (isControlRoutePath(url.pathname)) {
      const controlResponse = await handleControlRoute({
        request,
        url,
        store,
        operations: options.controlPlaneOperations,
        sharedCellRuntime: options.sharedCellRuntime,
      });
      if (controlResponse) return controlResponse;
    }

    return errorJson("not_found", "not found", 404, request);
  };

  return async (request: Request): Promise<Response> => {
    const response = await inner(request);
    return withSecurityHeaders(response, isProductionIssuer);
  };
}

const HSTS_HEADER_VALUE = "max-age=31536000; includeSubDomains; preload";

function isHttpsIssuer(issuer: string): boolean {
  try {
    return new URL(issuer).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True when the issuer is one for which a per-process ephemeral OIDC signing
 * key would be unsafe (id_token verification breaks on restart / horizontal
 * scale). Any https issuer qualifies; plain-http localhost dev does not. This
 * mirrors the protocol classification already used for HSTS / secure-cookie
 * decisions, so a deployment that is "production enough" to emit HSTS is also
 * "production enough" to require a stable signing key. Deliberate https-style
 * dev/test issuers opt out via `allowEphemeralKeyOnHttpsIssuer`.
 */
function isEphemeralKeyUnsafeIssuer(issuer: string): boolean {
  return isHttpsIssuer(issuer);
}

/**
 * Apply baseline browser-facing security headers to every accounts-service
 * response. These are not added by callers (server runtimes, edge proxies) so the
 * service must own them.
 *
 * HSTS is only emitted when the configured issuer is HTTPS, since adding it
 * on plaintext development handlers would be harmful.
 */
function withSecurityHeaders(
  response: Response,
  productionIssuer: boolean,
): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("x-content-type-options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("x-frame-options")) {
    headers.set("X-Frame-Options", "DENY");
  }
  if (!headers.has("referrer-policy")) {
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  }
  if (productionIssuer && !headers.has("strict-transport-security")) {
    headers.set("Strict-Transport-Security", HSTS_HEADER_VALUE);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Generic HTTP server handle. The accounts-service is substrate-neutral:
 * the same handler runs on Bun (`Bun.serve`), Node (`http.createServer`),
 * Cloudflare Workers (`export default { fetch }`), or any other Web-standard
 * fetch runtime. `startAccountsServer` wires the Bun path; other runtimes can
 * wire their own server and pass `createAccountsHandler` directly.
 */
export interface AccountsServerHandle {
  shutdown(): Promise<void>;
  readonly finished: Promise<void>;
}

export function startAccountsServer(
  options: AccountsServerOptions = {},
): AccountsServerHandle {
  const bunGlobal = (
    globalThis as {
      Bun?: {
        serve: (options: {
          hostname?: string;
          port?: number;
          fetch: (request: Request) => Promise<Response> | Response;
        }) => { stop(closeActive?: boolean): void };
      };
    }
  ).Bun;
  if (!bunGlobal?.serve) {
    throw new TypeError(
      "startAccountsServer requires Bun; use createAccountsHandler with a runtime-specific server on Node / Workers",
    );
  }
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = bunGlobal.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 8787,
    fetch: createAccountsHandler(options),
  });
  return {
    shutdown: async () => {
      server.stop(true);
      finish();
    },
    finished,
  };
}

function isGetOrHead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function isLoginAllowlistBypassPath(pathname: string): boolean {
  return (
    pathname === TAKOSUMI_ACCOUNTS_AUTH_PROVIDERS_PATH ||
    pathname === TAKOSUMI_ACCOUNTS_UPSTREAM_AUTHORIZE_PATH ||
    pathname === TAKOSUMI_ACCOUNTS_UPSTREAM_CALLBACK_PATH ||
    pathname === TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_OPTIONS_PATH ||
    pathname === TAKOSUMI_ACCOUNTS_PASSKEY_AUTHENTICATE_COMPLETE_PATH
  );
}

interface InMemoryRateLimiter {
  /**
   * Record a request from the request's client and, if the per-minute budget
   * is exceeded, return a 429 response with `Retry-After`. Returns
   * `undefined` when the request is within budget.
   */
  consume(request: Request): Response | undefined;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_TRACKED_CLIENTS = 4096;

/**
 * Create a simple in-isolate per-IP sliding-window rate limiter.
 *
 * Budget enforcement is best-effort: state lives only in the current
 * isolate (Workers) or process (Bun / Node), so a Workers deployment with
 * many isolates only enforces the budget locally. Operators MUST add an
 * edge-level limiter (Cloudflare WAF, Caddy `rate_limit`, etc.) on top of
 * this for production-grade protection. The limiter exists to make abuse
 * of the abuse-prone OIDC / installation routes obviously expensive from a
 * single source rather than to be a definitive defense.
 *
 * @param maxPerMinute Maximum requests per client IP in any 60 s window.
 */
function createInMemoryRateLimiter(maxPerMinute: number): InMemoryRateLimiter {
  const windows = new Map<string, number[]>();
  return {
    consume(request: Request): Response | undefined {
      const clientId = clientIpFromRequest(request);
      const now = Date.now();
      const cutoff = now - RATE_LIMIT_WINDOW_MS;
      const previous = windows.get(clientId) ?? [];
      const recent: number[] = [];
      for (const ts of previous) {
        if (ts > cutoff) recent.push(ts);
      }
      if (recent.length >= maxPerMinute) {
        // Keep the oldest timestamp around so Retry-After reflects the time
        // until the earliest in-window request ages out.
        windows.set(clientId, recent);
        evictIfNeeded(windows);
        const oldest = recent[0] ?? now;
        const retryAfterMs = Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest));
        const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return errorJson(
          "rate_limited",
          `rate limit exceeded (${maxPerMinute}/min per source)`,
          429,
          undefined,
          { "retry-after": `${retryAfterSeconds}` },
        );
      }
      recent.push(now);
      windows.set(clientId, recent);
      evictIfNeeded(windows);
      return undefined;
    },
  };
}

function evictIfNeeded(windows: Map<string, number[]>): void {
  if (windows.size <= RATE_LIMIT_MAX_TRACKED_CLIENTS) return;
  // Drop the oldest tracked entry (insertion order). Bounded memory under
  // worst-case adversarial inflow.
  const oldestKey = windows.keys().next().value;
  if (oldestKey !== undefined) windows.delete(oldestKey);
}

/**
 * Identify the client for rate-limiting. Prefers explicit forwarded headers
 * because the handler typically sits behind an edge proxy (Cloudflare /
 * Caddy), and falls back to the URL hostname when no forwarded header is
 * available. The intent is "per-source bucket", not "trust this string".
 */
function clientIpFromRequest(request: Request): string {
  const forwarded =
    request.headers.get("cf-connecting-ip") ?? request.headers.get("x-real-ip");
  if (forwarded) return forwarded.trim();
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return new URL(request.url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function reservedOidcEndpoint(): Response {
  return errorJson(
    "feature_unavailable",
    "Sign-in is temporarily unavailable.",
    503,
  );
}

function passkeysNotConfigured(): Response {
  return errorJson(
    "feature_unavailable",
    "Passkeys are temporarily unavailable.",
    503,
  );
}

function requireServiceGraphMaterialResolverAccess(input: {
  request: Request;
  token: string;
}): Response | undefined {
  // Constant-time comparison of the static shared-secret bearer token, matching
  // every other auth check in this service. Passing the full header to
  // constantTimeEqual is safe: it XOR-folds the length difference with no early
  // length short-circuit, so it does not leak a per-byte timing side channel.
  const header = input.request.headers.get("authorization") ?? "";
  if (constantTimeEqual(header, `Bearer ${input.token}`)) {
    return undefined;
  }
  return errorJson(
    "unauthorized",
    "service graph material resolver token is required",
    401,
    undefined,
    { "www-authenticate": "Bearer" },
  );
}

function materializeDrillAccessAllowed(input: {
  request: Request;
  token: string | undefined;
}): boolean {
  if (!input.token) return false;
  const header =
    input.request.headers.get(TAKOSUMI_MATERIALIZE_DRILL_TOKEN_HEADER) ?? "";
  return constantTimeEqual(header, input.token);
}

function requirePrivacyOperationsAccess(input: {
  request: Request;
  token: string | undefined;
}): Response | undefined {
  if (!input.token) {
    return errorJson(
      "feature_unavailable",
      "Privacy operations are temporarily unavailable.",
      503,
    );
  }
  const header =
    input.request.headers.get(TAKOSUMI_PRIVACY_OPERATIONS_TOKEN_HEADER) ?? "";
  if (constantTimeEqual(header, input.token)) return undefined;
  return errorJson(
    "unauthorized",
    "privacy operations token is required",
    401,
    undefined,
  );
}

function installationRouteAccountAccess(
  route: InstallationRoute,
  method: string,
): "read" | "write" | undefined {
  if (route.kind === "billing-usage-reports") return undefined;
  if (route.kind === "installation") {
    if (method === "DELETE") return "write";
    return undefined;
  }
  if (
    (route.kind === "deployment" ||
      route.kind === "deployment-plan-run" ||
      route.kind === "rollback" ||
      route.kind === "materialize" ||
      route.kind === "export") &&
    method === "POST"
  ) {
    return "write";
  }
  if (
    (route.kind === "events" ||
      route.kind === "export-operation" ||
      route.kind === "export-download") &&
    method === "GET"
  ) {
    return "read";
  }
  return undefined;
}
