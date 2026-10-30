import { runSourceMaintenanceSchedule } from "../../worker/src/source_maintenance_schedule.ts";
import {
  attachInvocationWaitUntil,
  runOwnNotificationDispatch,
} from "../../worker/src/own_notification_dispatch.ts";
// Operator-deployed Takosumi platform worker composition.
//
// This single worker hosts the accounts plane (bare-origin OIDC issuer +
// dashboard SPA) and the OpenTofu-native deploy-control plane in one process.
// The accounts handler owns the public HTTP surface and serves the dashboard SPA
// from its built-in ASSETS fallback (non-API GET/HEAD). Public `/api` control
// routes are still the current compatibility surface. Public Takosumi wording
// maps that surface to Workspace / Project / Capsule / Source /
// ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
// StateVersion / Output / Runner / AuditEvent / Backup. Historical schema
// translation stays confined to the storage migration layer. This platform worker reaches the
// deploy-control implementation in-process through the typed `operations` seam
// injected below. There is no separate control-plane worker.
// The two Durable Object classes (coordination leases/alarms + the OpenTofu
// Container runner) are re-exported so the wrangler bindings/migrations can
// name them.

import {
  type CloudflareWorkerEnv as AccountsCloudflareWorkerEnv,
  accountsExternalLoginConfigured,
  configuredTakosumiMobileOidcClientId,
  createCloudflareWorker,
  rejectDisallowedCloudflarePresentedSession,
} from "../accounts-cloudflare/src/handler.ts";
import type { ActivityRecorder } from "../../core/domains/activity/mod.ts";
import {
  activityCursorSealerFromEnv,
  D1AccountsStore,
  handleAuthenticatedControlRoute,
  parseAppOwnershipMutationsFrozen,
  resolveD1AccountsSchemaMode,
  runRefreshChainRetention,
  trustedNativeClientsFromEnv,
  type ActivityCursorSealer,
  type ControlPlaneOperations,
  type RefreshChainRetentionRunResult,
} from "@takosjp/takosumi-accounts-service";
import {
  CONTROL_DISPATCH_RESOURCE_KEYS,
  controlInventoryResourceKey,
  isRunGetReadRequest,
} from "../../accounts/service/src/control-routes.ts";
import {
  runGetWithinDeadline,
  type RunReadWaiter,
} from "../../accounts/service/src/control/run-read-deadline.ts";
import {
  createRequestPhaseDiagnostics,
  measureRequestPhaseOperation,
} from "../../accounts/service/src/request-phase-diagnostics.ts";
import type { AccountsStore } from "../../accounts/service/src/store.ts";
import {
  interfaceApiRouteTemplate,
  LEGACY_WORKSPACE_ROUTE_METRIC,
  legacyWorkspaceClientFamily,
  legacyWorkspaceMetricTags,
  LegacyWorkspaceRouteCounter,
  legacyWorkspaceUseMetricTags,
  parseLegacyWorkspaceSunset,
  reportLegacyWorkspaceRoute,
  withLegacyWorkspaceDeprecation,
  type LegacyWorkspaceCredential,
  type LegacyWorkspaceSelector,
  type LegacyWorkspaceUse,
} from "../../accounts/service/src/legacy-workspace-telemetry.ts";
import type { RunStreamTiming } from "../../accounts/service/src/control/shared.ts";
import {
  TAKOSUMI_ACCOUNTS_EXTENSION_SELF_SERVICE_PAT_SCOPES,
  type TakosumiAccountsPatScope,
} from "@takosjp/takosumi-accounts-contract";
import {
  measureServerTiming,
  type ServerTimingBucket,
} from "../../accounts/service/src/server-timing.ts";
import {
  type CloudflareWorkerEnv as DeployControlEnv,
  createInProcessDeployControlSeam,
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
} from "../../worker/src/handler.ts";
import { cachedDeployControlService } from "../../worker/src/deploy_control_seam.ts";
import { privateRunFilesCompositionFor } from "../../worker/src/private_run_files_composition.ts";
import { PRIVATE_RUN_FILE_HTTP_PATH } from "../../core/api/private_run_file_routes.ts";
import {
  authenticateSharedAuthRequest,
  handleSharedAuthRouteRequest,
  handleSharedAuthAccountBoundaryRequest,
  resolveSharedAuthWorkspace,
  sharedAuthUnavailableResponse,
  sharedAuthConfigured,
  sharedAuthRequestFailure,
  type SharedAuthEnvironment,
} from "../../worker/src/shared_auth_rpc.ts";
import { createCloudflareD1OpenTofuControlStore } from "../../worker/src/d1_opentofu_store.ts";
import { handleSourceOwnershipMigrationOperatorRequest } from "../../worker/src/source_ownership_migration_operator.ts";
import { fenceControlDatabase } from "./fenced-control-database.ts";
import { handlePlatformBrowserBillingRequest } from "./browser-billing.ts";
import { createCloudflareD1PatWorkspaceMembershipReader } from "./pat-workspace-membership-reader.ts";
import type {
  CapsuleExecutionAuthorityResolver,
  OpenTofuControlStore,
} from "../../core/domains/deploy-control/store.ts";
import { recordWorkerMetric } from "../../worker/src/metrics.ts";
import {
  type CapsuleSweepOperations,
  type CapsuleSweepResult,
  sweepCapsules,
} from "../../worker/src/scheduled/drift.ts";
import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import { TAKOSUMI_METRICS_PATH } from "../../core/api/metrics_routes.ts";
import {
  DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE,
  type ProviderConnection,
} from "@takosumi/internal/deploy-control-api";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
} from "takosumi-contract/capabilities";
import {
  API_V1_PREFIX,
  INTERNAL_V1_PREFIX,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
  isInternalV1Path,
  isRetiredV1Path,
} from "takosumi-contract/api-surface";
import type {
  ActorContext,
  Interface,
  InterfaceBinding,
} from "takosumi-contract";
import type { ExecutionContext as HonoExecutionContext } from "hono";
import {
  MCP_SERVER_INVOKE_PERMISSION,
} from "takosumi-contract";
import type {
  WorkspaceMember,
  WorkspaceRole,
} from "takosumi-contract/workspaces";
import type { AppRole } from "takosumi-contract/app-access";
import {
  encodeActorContext,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
} from "takosumi-contract/internal/rpc";
import type { BillingSettings } from "takosumi-contract/billing";
import {
  hasLegacyManagedProviderScopeHints,
  isWorkspaceBindableOperatorConnection,
} from "takosumi-contract/connections";
import { canonicalProviderSource } from "takosumi-contract/provider-env-rules";
import {
  isRunCredentialToken,
  runCredentialTokenSecret,
  verifyRunCredentialToken,
} from "../../core/shared/run_credential_tokens.ts";
import {
  resolveCanonicalCapsuleRunCredentialContext,
  type CapsuleRunCredentialLedger,
} from "../../core/domains/deploy-control/run_credential_context.ts";
import type { TakosumiOperations } from "../../core/bootstrap.ts";
import { structuredErrorReason } from "../../core/domains/deploy-control/errors.ts";
import {
  OpenTofuControllerError,
  RUN_HEARTBEAT_STALE_MS,
} from "../../core/domains/deploy-control/mod.ts";
import {
  isPlatformExtensionCatalogPath,
  isPlatformExtensionContributionsPath,
  matchPlatformExtensionRoute,
  pathIsUnderBase,
  platformExtensionRoutes,
  platformExtensionSelfServicePatScopes,
  resolvePlatformExtensionRequestScopeRoute,
  type PlatformExtensionAuthenticatedContext,
  type PlatformExtensionAuthenticatedHandler,
  type PlatformExtensionRoute,
  type PlatformExtensionContribution,
} from "./platform_extensions.ts";
import {
  TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  normalizePublicStoreEndpoint,
  type CreateTakosumiDiscoveryOptions,
  type TakosumiOperatorCapabilities,
} from "takosumi-contract/capabilities";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run, RunStatus, RunType } from "takosumi-contract/runs";
import { evaluateProductionHardeningGates } from "./production_hardening.ts";
import {
  OPERATOR_CONTROL_MCP_PATH,
  handleOperatorControlMcpRequest,
  operatorControlMcpEnabled,
  type OperatorControlMcpAuthority,
} from "../operator-control-mcp.ts";
import { createOperatorControlMcpAuthority } from "./operator-control-mcp-authority.ts";

// Immediate Takosumi Mobile notifications attach to the invocation that
// records the Activity through the runtime's per-invocation waitUntil
// (TASK-0119), here as in the Hosted entry. A dynamic import, because Bun
// tests import this module and have no `cloudflare:workers`.
void attachInvocationWaitUntil(() => import("cloudflare:workers"));
export {
  isPlatformExtensionCatalogPath,
  isPlatformExtensionContributionsPath,
  matchPlatformExtensionRoute,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
  platformExtensionRoutes,
  platformExtensionSelfServicePatScopes,
  resolvePlatformExtensionRequestScopeRoute,
} from "./platform_extensions.ts";
export type {
  PlatformExtensionAuthenticatedAuthKind,
  PlatformExtensionAuthenticatedContext,
  PlatformExtensionAuthenticatedHandler,
} from "./platform_extensions.ts";
export {
  evaluateProductionHardeningGates,
  platformHardeningContributions,
  type ProductionHardeningCheck,
  type ProductionHardeningContributionResult,
  type ProductionHardeningGateResult,
} from "./production_hardening.ts";
export {
  fenceControlDatabase,
  type FencedControlDatabase,
} from "./fenced-control-database.ts";
export {
  createCloudflareD1WorkspaceBootstrapReader,
  readWorkspaceBootstrapRequest,
  type CloudflareD1WorkspaceBootstrapReaderOptions,
  type PlatformWorkspaceBootstrapFacts,
  type WorkspaceBootstrapReader,
  type WorkspaceBootstrapReadInput,
  type WorkspaceBootstrapReadResult,
} from "./workspace-bootstrap-reader.ts";
export {
  CoordinationObject,
  LocalSubstrateOpenTofuRunnerProxyObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
  rejectDisallowedCloudflarePresentedSession,
};
/**
 * Public host-composition port for exact Workspace/Capsule execution authority.
 * This returns the resolver already wired over the cached service's shared
 * control store; it never creates a second D1 adapter or composes per-item reads.
 */
export async function platformCapsuleExecutionAuthority(
  env: CloudflareWorkerEnv,
): Promise<CapsuleExecutionAuthorityResolver> {
  return (await takosumiOperationsFor(env)).capsuleExecutionAuthority;
}

// In-process deploy-control seam, one cached service per env, shared with the
// unified Takos worker. The accounts deploy-control facade calls the typed
// `operations` facade directly (no Bearer handshake, no JSON round-trip); the
// HTTP `fetch` dispatch into the embedded service's Hono app is kept as a
// transport fallback. The synthetic base host is never dialed.
//
// Keyed by the live env object. Callers reach this seam either with the
// accounts-handler env (the public fetch surface) or directly with the
// deploy-control env (the scheduled/webhook seams); both are the SAME runtime
// object on the platform worker, so the key type is their common object shape.
/**
 * The platform Worker is the single composition root for both the Accounts
 * plane and the OpenTofu control plane.  Model the live binding object as the
 * intersection of those hosts so Accounts-only bindings (notably
 * `TAKOSUMI_ACCOUNTS_DB`) cannot be erased by an unchecked DeployControl cast.
 */
export type CloudflareWorkerEnv = AccountsCloudflareWorkerEnv &
  DeployControlEnv & SharedAuthEnvironment;
type PlatformEnv = CloudflareWorkerEnv;

export interface PlatformExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

const seams = new WeakMap<
  object,
  ReturnType<typeof createInProcessDeployControlSeam>
>();

function deployControlSeam(env: DeployControlEnv) {
  let seam = seams.get(env);
  if (!seam) {
    seam = createInProcessDeployControlSeam(env);
    seams.set(env, seam);
  }
  return seam;
}

/**
 * Dispatch one already-authenticated request through the platform's in-process
 * deploy-control service. This is a host-composition seam, not edge routing:
 * callers must expose only an explicit route subset and must authenticate
 * before calling it. Generic `/internal/v1/*` edge ingress remains disabled by
 * default and this function must never be mounted as a catch-all proxy.
 */
export async function dispatchPlatformDeployControlRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  return await deployControlSeam(env).fetch(request);
}

type PlatformDeployControlSeam = Pick<
  ReturnType<typeof createInProcessDeployControlSeam>,
  "fetch"
>;

export function platformInternalEdgeIngressEnabled(
  env: Pick<
    CloudflareWorkerEnv,
    "LOCAL_SUBSTRATE_TEST_BED" | "TAKOSUMI_EXPOSE_INTERNAL_EDGE"
  >,
): boolean {
  return (
    env.LOCAL_SUBSTRATE_TEST_BED === "1" ||
    env.TAKOSUMI_EXPOSE_INTERNAL_EDGE === "1"
  );
}

function isPlatformCoordinationEdgePath(pathname: string): boolean {
  const prefix = `${INTERNAL_V1_PREFIX}/`;
  if (!pathname.startsWith(prefix)) return false;
  const [segment] = pathname
    .slice(prefix.length)
    .replace(/^\/+/, "")
    .split("/");
  return segment === "coordination";
}

/**
 * Route the local-substrate service host into the embedded deploy-control
 * service without making the internal API part of the public platform edge.
 * Caddy separately denies `/internal/*` on the public app host; this guard also
 * keeps production-safe defaults if the Worker is reached directly.
 */
export async function handlePlatformInternalEdgeRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  seamForEnv: (
    env: CloudflareWorkerEnv,
  ) => PlatformDeployControlSeam = deployControlSeam,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!isInternalV1Path(url.pathname)) return undefined;
  if (
    isPlatformCoordinationEdgePath(url.pathname) ||
    !platformInternalEdgeIngressEnabled(env)
  ) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return await seamForEnv(env).fetch(request);
}

const INTERNAL_PLATFORM_CAPSULE_PREFIX = "/internal/platform/capsules/";
const INTERNAL_PLATFORM_DESTROY_RECOVERY_SUFFIX = "/destroy-recovery";
const PLATFORM_CAPSULE_ID_PATTERN = /^cap_[0-9a-zA-Z]{8,96}$/;

function destroyRecoveryCapsuleIdFromPath(
  pathname: string,
): string | undefined {
  if (!pathname.startsWith(INTERNAL_PLATFORM_CAPSULE_PREFIX)) return undefined;
  if (!pathname.endsWith(INTERNAL_PLATFORM_DESTROY_RECOVERY_SUFFIX)) {
    return undefined;
  }
  const encoded = pathname.slice(
    INTERNAL_PLATFORM_CAPSULE_PREFIX.length,
    pathname.length - INTERNAL_PLATFORM_DESTROY_RECOVERY_SUFFIX.length,
  );
  if (!encoded || encoded.includes("/")) return undefined;
  try {
    const capsuleId = decodeURIComponent(encoded);
    return PLATFORM_CAPSULE_ID_PATTERN.test(capsuleId) ? capsuleId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Exposes one exact operator-only forward-repair action without enabling the
 * generic internal API at the public edge. The embedded Core route remains the
 * authority for snapshot ownership, latest-ref fencing, and destroy planning.
 */
export async function handlePlatformDestroyRecoveryRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  seamForEnv: (
    env: CloudflareWorkerEnv,
  ) => PlatformDeployControlSeam = deployControlSeam,
): Promise<Response | undefined> {
  const capsuleId = destroyRecoveryCapsuleIdFromPath(url.pathname);
  if (!capsuleId) return undefined;
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = requireDeployControlBearer(request, env);
  if (auth) return auth;
  const parsed = await readJsonRecord(request);
  if (!parsed.ok) return parsed.response;
  if (
    Object.keys(parsed.value).length !== 1 ||
    typeof parsed.value.recoverySourceSnapshotId !== "string" ||
    !parsed.value.recoverySourceSnapshotId.trim()
  ) {
    return Response.json(
      {
        error: "invalid_request",
        error_description:
          "body must contain only a non-empty recoverySourceSnapshotId",
      },
      { status: 400 },
    );
  }
  const target = new URL(request.url);
  target.pathname = `${INTERNAL_V1_PREFIX}/capsules/${encodeURIComponent(capsuleId)}/destroy-plan`;
  target.search = "";
  target.hash = "";
  return await seamForEnv(env).fetch(
    new Request(target, {
      method: "POST",
      headers: {
        authorization: request.headers.get("authorization") ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        recoverySourceSnapshotId:
          parsed.value.recoverySourceSnapshotId.trim(),
      }),
    }),
  );
}

async function controlPlaneOperationsFor(
  env: PlatformEnv,
): Promise<ControlPlaneOperations> {
  return await deployControlSeam(env).operations();
}

async function takosumiOperationsFor(
  env: PlatformEnv,
): Promise<TakosumiOperations> {
  return await deployControlSeam(env).operations();
}

const OPERATOR_CONTROL_MCP_ROUTE: PlatformExtensionRoute = Object.freeze({
  id: "operator-control-mcp.v1",
  basePath: OPERATOR_CONTROL_MCP_PATH,
  handlerKey: "builtin:operator-control-mcp.v1",
  authMode: "platform",
  requiredScopes: [MCP_SERVER_INVOKE_PERMISSION],
  capabilities: ["mcp.operator-control.v1"],
});

type OperatorControlMcpSessionVerifier = (
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformExtensionRoute,
) => Promise<PlatformExtensionSessionContext>;

/**
 * Optional built-in adapter route. Every MCP POST performs exact-resource
 * Interface OAuth introspection before the JSON-RPC body is read. The raw
 * bearer is neither forwarded to the public control handlers nor persisted.
 *
 * The token must name the MCP's own app (Capsule evidence); a Workspace it
 * still carries is kept only as a bearer restriction (TASK-0118 P9.1-e).
 */
export async function handlePlatformOperatorControlMcpRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  dependencies: {
    readonly verifySession?: OperatorControlMcpSessionVerifier;
    readonly createAuthority?: (
      session: PlatformExtensionSessionContext & {
        readonly subject: string;
        readonly capsuleId: string;
        readonly workspaceId?: string;
      },
    ) => Promise<OperatorControlMcpAuthority>;
  } = {},
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== OPERATOR_CONTROL_MCP_PATH) return undefined;
  if (!operatorControlMcpEnabled(env)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (request.method !== "POST") {
    return await handleOperatorControlMcpRequest(request, {
      subject: "disabled",
      capsuleId: "disabled",
      dispatchPublicControl: async () =>
        Response.json({ error: "unavailable" }, { status: 503 }),
      app: async () => undefined,
      installPlan: async () => undefined,
      run: async () => undefined,
      installNamespaceId: async () => undefined,
      appPartitions: async () => new Map(),
    });
  }
  const session = await (
    dependencies.verifySession ?? verifyPlatformExtensionSession
  )(request, env, OPERATOR_CONTROL_MCP_ROUTE);
  const subject = safePlatformExtensionSubject(session.subject);
  const workspaceId = safePlatformExtensionContextId(session.workspaceId);
  const capsuleId = safePlatformExtensionContextId(session.capsuleId);
  const interfaceId = safePlatformExtensionContextId(session.interfaceId);
  const interfaceBindingId = safePlatformExtensionContextId(
    session.interfaceBindingId,
  );
  if (
    !session.authenticated ||
    session.authKind !== "interface-oauth-token" ||
    !subject ||
    (session.workspaceId !== undefined && !workspaceId) ||
    !capsuleId ||
    !interfaceId ||
    !interfaceBindingId ||
    typeof session.interfaceResolvedRevision !== "number" ||
    !Number.isSafeInteger(session.interfaceResolvedRevision) ||
    session.interfaceResolvedRevision <= 0 ||
    session.audience !==
      platformExtensionRouteBaseUrl(request, OPERATOR_CONTROL_MCP_ROUTE, env) ||
    session.scopes?.length !== 1 ||
    session.scopes[0] !== MCP_SERVER_INVOKE_PERMISSION
  ) {
    return Response.json(
      { error: "unauthenticated" },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  const exactSession = {
    ...session,
    subject,
    ...(workspaceId ? { workspaceId } : {}),
    capsuleId,
    interfaceId,
    interfaceBindingId,
  };
  const authority = dependencies.createAuthority
    ? await dependencies.createAuthority(exactSession)
    : await createPlatformOperatorControlMcpAuthority(
        request,
        env,
        exactSession,
      );
  return await handleOperatorControlMcpRequest(request, authority);
}

async function createPlatformOperatorControlMcpAuthority(
  request: Request,
  env: CloudflareWorkerEnv,
  session: {
    readonly subject: string;
    readonly capsuleId: string;
    readonly workspaceId?: string;
  },
): Promise<OperatorControlMcpAuthority> {
  const sunset = platformLegacyWorkspaceSunset(env);
  return createOperatorControlMcpAuthority({
    operations: await controlPlaneOperationsFor(env),
    store: new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
      schemaMode: resolveD1AccountsSchemaMode(
        env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE,
      ),
    }),
    session: {
      subject: session.subject,
      capsuleId: session.capsuleId,
      ...(session.workspaceId ? { workspaceId: session.workspaceId } : {}),
    },
    requestUrl: request.url,
    ...(env.TAKOSUMI_ACCOUNTS_ISSUER
      ? { issuer: env.TAKOSUMI_ACCOUNTS_ISSUER }
      : {}),
    ...(sunset ? { legacyWorkspaceSunset: sunset } : {}),
    ...(parseAppOwnershipMutationsFrozen(env.TAKOSUMI_APP_OWNERSHIP_MUTATIONS)
      ? { appOwnershipMutationsFrozen: true }
      : {}),
    trustedNativeClients: trustedNativeClientsFromEnv(
      env.TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS,
    ),
    ...platformActivityCursorSealerOption(env),
  });
}

/**
 * Initialize the provider-neutral control-plane composition for a host wrapper.
 * Optional extensions can use this to ensure their injected factories have
 * received their host ports without importing Core implementation modules.
 */
export async function initializePlatformControlPlane(
  env: object,
): Promise<void> {
  await takosumiOperationsFor(env as PlatformEnv);
}

export interface PlatformInterfaceProjectionRepairResult {
  readonly interfacesScanned: number;
  readonly projected: number;
  readonly failed: number;
  readonly nextCursor?: string;
}

/**
 * Composition-root repair bridge for operator-owned Interface projections.
 * It reads the canonical Interface store and bounds projection calls per
 * invocation. Cloud wrappers persist the opaque cursor in their own
 * routing store; OSS owns neither that cursor nor the projected state.
 */
export async function repairPlatformInterfaceProjections(
  input: {
    readonly cursor?: string;
    readonly limit?: number;
  },
  env: object,
): Promise<PlatformInterfaceProjectionRepairResult> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25));
  const operations = await takosumiOperationsFor(env as PlatformEnv);
  const result = await operations.interfaces.repairProjections({
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit,
  });
  return {
    interfacesScanned: result.scanned,
    projected: result.projected,
    failed: result.failed,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}

function platformExtensionSelfServicePatScopesForAccounts(
  env: CloudflareWorkerEnv,
): readonly TakosumiAccountsPatScope[] {
  try {
    const routes = platformExtensionRoutes(
      env as unknown as { readonly [key: string]: unknown },
    );
    return platformExtensionSelfServicePatScopes(
      routes.filter((route) => platformExtensionRouteConfigured(env, route)),
    ).filter((scope): scope is TakosumiAccountsPatScope =>
      (
        TAKOSUMI_ACCOUNTS_EXTENSION_SELF_SERVICE_PAT_SCOPES as readonly string[]
      ).includes(scope),
    );
  } catch {
    // The platform router fails closed on malformed extension configuration;
    // do not let an invalid descriptor widen the account PAT authority.
    return [];
  }
}

const accountsWorker = createCloudflareWorker<CloudflareWorkerEnv>({
  // The session-authed `/api/v1/*` dashboard surface reads the canonical
  // in-process operations facade adapted to the `ControlPlaneOperations`
  // shape (see `controlPlaneOperationsFor`).
  controlPlaneOperations: (env) => controlPlaneOperationsFor(env),
  // PAT self authority is one bounded Control D1 membership SELECT. It must
  // not initialize the full deploy-control service or run schema/bootstrap —
  // but it must still refuse while an operator holds the maintenance fence, so
  // the binding is fenced once here rather than trusted at each call site.
  patWorkspaceMembershipReader: (env) =>
    createCloudflareD1PatWorkspaceMembershipReader(
      fenceControlDatabase(env.TAKOSUMI_CONTROL_DB),
    ),
  personalAccessTokenSelfServiceScopes: (env) =>
    platformExtensionSelfServicePatScopesForAccounts(env),
});

const platformWorker = {
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
    const sharedIngressFailure = sharedAuthRequestFailure(request, env);
    if (sharedIngressFailure) return sharedIngressFailure;
    const sourceOwnershipMigrationResponse = await handleSourceOwnershipMigrationOperatorRequest(request, env);
    if (sourceOwnershipMigrationResponse) return sourceOwnershipMigrationResponse;
    const privateFilesResponse = await handlePlatformPrivateRunFilesRequest(request, env, context);
    if (privateFilesResponse) return privateFilesResponse;
    const metricsResponse = await handlePlatformMetricsRequest(request, env);
    if (metricsResponse) return metricsResponse;
    const internalEdgeResponse = await handlePlatformInternalEdgeRequest(
      request,
      env,
    );
    if (internalEdgeResponse) return internalEdgeResponse;
    const sharedAuthResponse = await handleSharedAuthRouteRequest(request, env);
    if (sharedAuthResponse) return sharedAuthResponse;
    const sharedAccountBoundaryResponse = await handleSharedAuthAccountBoundaryRequest(request, env);
    if (sharedAccountBoundaryResponse) return sharedAccountBoundaryResponse;
    const sharedSessionResponse = await handlePlatformSharedAuthSessionRequest(request, env);
    if (sharedSessionResponse) return sharedSessionResponse;
    const url = new URL(request.url);
    const destroyRecoveryResponse =
      await handlePlatformDestroyRecoveryRequest(request, url, env);
    if (destroyRecoveryResponse) return destroyRecoveryResponse;
    if (url.pathname === TAKOSUMI_WELL_KNOWN_PATH) {
      if (!platformGetHeadOnlyRequest(request)) {
        return platformGetHeadOnlyMethodNotAllowedResponse();
      }
      return Response.json(
        createTakosumiWellKnownDocument(
          platformDiscoveryOptions(url.origin, env),
        ),
      );
    }
    if (url.pathname === TAKOSUMI_PRODUCT_CAPABILITIES_PATH) {
      if (!platformGetHeadOnlyRequest(request)) {
        return platformGetHeadOnlyMethodNotAllowedResponse();
      }
      return Response.json(
        createTakosumiProductCapabilities(
          platformDiscoveryOptions(url.origin, env),
        ),
      );
    }
    // The former product discovery and Interface paths are retired rather than
    // delegated to Accounts or a configurable extension. This keeps the route
    // cutover fail-closed and prevents an accidental compatibility alias.
    if (
      url.pathname === "/v1/capabilities" ||
      isPlatformLegacyInterfaceApiPath(url.pathname)
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // The legacy `/v1` namespace is reserved wholesale. Fail closed before
    // extension matching, Accounts fallback, or any historical handler can
    // claim a path; only the canonical `/api/v1` surface is public.
    if (isRetiredV1Path(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    // The former hosted-service facade is retired, not an Accounts resource.
    // Keep its whole canonical-looking subtree behind a tombstone before
    // extension auth and Accounts fallback so anonymous and stale bearer
    // callers observe the same 404 and cannot infer a compatibility surface.
    if (
      url.pathname === "/api/v1/hosted" ||
      url.pathname.startsWith("/api/v1/hosted/")
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (url.pathname === "/internal/platform/hardening-gates") {
      return handleHardeningGatesRequest(request, env);
    }
    if (url.pathname === INTERNAL_PLATFORM_RUN_OWNER_PATH) {
      return handlePlatformRunOwnerRequest(request, url, env);
    }
    if (isOperatorBillingPath(url.pathname)) {
      const response = await handleOperatorBillingRequest(
        request,
        url,
        env,
        await controlPlaneOperationsFor(env),
      );
      return response ?? Response.json({ error: "not found" }, { status: 404 });
    }
    // Takoform Host/Resource Shape is not a Takosumi process surface. Tombstone
    // the complete namespace before extension auth or SPA fallback, including
    // requests carrying valid or stale credentials.
    if (isPlatformTakoformHostPath(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const sessionVerifier: PlatformExtensionSessionVerifier = (
      request,
      env,
      route,
    ) =>
      verifyPlatformExtensionSession(request, env, route, context);
    const workspaceAccess: PlatformExtensionWorkspaceAccess = (
      request,
      env,
      workspaceId,
      session,
    ) =>
      platformExtensionSessionCanAccessWorkspace(
        request,
        env,
        workspaceId,
        session,
        context,
      );
    const appAccess: PlatformExtensionAppAccess = (
      request,
      env,
      capsuleId,
      session,
    ) =>
      platformExtensionSessionAppRole(request, env, capsuleId, session, context);
    if (isPlatformExtensionCatalogPath(url.pathname)) {
      return await handlePlatformExtensionCatalogRequest(
        request,
        url,
        env,
        sessionVerifier,
      );
    }
    if (isPlatformExtensionContributionsPath(url.pathname)) {
      return handlePlatformExtensionContributionsRequest(request, url, env);
    }
    // Configured extension routes are composed before ordinary SPA fallback.
    // This keeps an explicitly declared exact external-standard leaf
    // (for example `/.well-known/takoform/v1beta1`) on the same generic
    // handler/auth seam as every other extension, without a Takoform branch.
    // Malformed optional configuration remains unclaimed and cannot take a
    // known core path down with it.
    let extensionRoutes: readonly PlatformExtensionRoute[] = [];
    try {
      extensionRoutes = platformExtensionRoutes(
        env as unknown as { readonly [key: string]: unknown },
      );
    } catch {
      extensionRoutes = [];
    }
    const platformExtensionRoute = matchPlatformExtensionRoute(
      url.pathname,
      extensionRoutes,
    );
    const browserBillingResponse = await handlePlatformBrowserBillingRequest(request, env, platformExtensionRoute);
    // Browser billing still selects a Workspace on every request. It is a
    // stage 9B allow-listed surface with its own closed response and console
    // contract, so it is counted from invocation logs, not marked here.
    if (browserBillingResponse) return browserBillingResponse;
    if (platformExtensionRoute) {
      return await handlePlatformExtensionRouteRequest(
        request,
        env,
        platformExtensionRoute,
        sessionVerifier,
        workspaceAccess,
        appAccess,
      );
    }
    // Generic Interface/InterfaceBinding APIs remain a normal session edge
    // surface on the canonical `/api/v1` prefix.
    if (
      isPlatformInterfaceApiPath(url.pathname)
    ) {
      return await (
        handlePlatformInterfaceApiRequest(
          request,
          env,
          sessionVerifier,
          workspaceAccess,
          context,
        )
      );
    }
    if (url.pathname === OPERATOR_CONTROL_MCP_PATH) {
      return (
        (await handlePlatformOperatorControlMcpRequest(request, env, {
          verifySession: sessionVerifier,
        })) ??
        Response.json({ error: "not found" }, { status: 404 })
      );
    }
    // Source webhook surface (Core Specification §6). This is a NEW top-level
    // prefix the accounts handler does not own; handle it here via the
    // deploy-control service seam BEFORE delegating to the accounts handler.
    if (url.pathname.startsWith("/hooks/sources/")) {
      return await handleSourceWebhook(request, url, env);
    }
    // `/compat` is an explicit profile namespace, never an accounts/dashboard
    // SPA route. An uninstalled or retired profile must fail closed instead of
    // falling through to the accounts worker's HTML fallback.
    if (url.pathname === "/compat" || url.pathname.startsWith("/compat/")) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (isPlatformCoreProcessRoute(request, url)) {
      const service = await cachedDeployControlService(env);
      return service.app.fetch(
        request,
        undefined,
        honoExecutionContext(context),
      );
    }
    if (isPlatformUnknownApiPath(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const sharedControlResponse = await handlePlatformSharedAuthControlRequest(
      request, env,
    );
    if (sharedControlResponse) return sharedControlResponse;
    if (isPlatformReservedMachinePath(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const accountsResponse = withPlatformAssetCacheHeaders(
      request,
      url,
      await accountsWorker.fetch(request, env, context),
    );
    if (isOidcMetricPath(url.pathname)) {
      await schedulePlatformSideEffect(
        recordPlatformOidcMetric(request, url, env, accountsResponse),
        context,
      );
    }
    return accountsResponse;
  },
  // Scheduled cron tick. Source jobs claim persisted hourly/daily start markers
  // from the existing five-minute tick or their dedicated cron expressions.
  // When `TAKOSUMI_AUTO_PLAN_STALE_CAPSULES=1` or
  // `TAKOSUMI_DRIFT_CHECK_ENABLED=1` is set (both default OFF), ALSO runs the
  // per-app sweep: one page of live Capsules, each handled on its own (stale
  // auto-plan, drift check). No Workspace is listed.
  async scheduled(
    event: unknown,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<void> {
    await schedulePlatformSideEffect(
      runScheduledAccountsRefreshChainRetention(env),
      context,
    );
    await schedulePlatformSideEffect(
      runScheduledInterfaceMaterializationIntentDrain(env),
      context,
    );
    await schedulePlatformSideEffect(
      runScheduledCapsuleUninstallFinalize(env),
      context,
    );
    // Takosumi Mobile notifications: enqueue new Activity and send it in the
    // same run, then retry what is due on later runs.
    await schedulePlatformSideEffect(
      runScheduledOwnNotificationDispatch(env),
      context,
    );
    const cron =
      typeof event === "object" && event !== null
        ? Reflect.get(event, "cron")
        : undefined;
    await schedulePlatformSideEffect(runSourceMaintenanceSchedule({
      db: env.TAKOSUMI_CONTROL_DB,
      cron,
      retirementEnabled: env.TAKOSUMI_SOURCE_RETIREMENT_SWEEP_ENABLED !== "0",
      poll: () => runScheduledSourcePoll(env),
      sweep: () => runScheduledSourceRetirement(env),
    }).catch((error: unknown) => {
      console.warn(JSON.stringify({
        event: "source_maintenance_schedule_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }));
    }), context);
    await runScheduledOpenTofuRunRepair(env);
    await runScheduledCapsuleSweep(env);
  },
};

/**
 * Per-isolate coalescing of the legacy Workspace counter: at most one Control
 * D1 write per tag set per minute, written on the leading edge so a use can
 * never leave its tag set at 0 (see `LegacyWorkspaceRouteCounter`).
 */
const platformLegacyWorkspaceRouteCounter = new LegacyWorkspaceRouteCounter();

export default {
  ...platformWorker,
  /**
   * Counts every response marked as a legacy Workspace use (TASK-0118 Phase 9)
   * after it is produced, wherever in the composition it was produced. The
   * metric is best-effort and never changes the response.
   */
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
    const response = await platformWorker.fetch(request, env, context);
    const legacyTags = platformLegacyWorkspaceMetricTags.get(response) ??
      legacyWorkspaceMetricTags(request, response);
    if (legacyTags) {
      const value = platformLegacyWorkspaceRouteCounter.add(
        legacyTags,
        Date.now(),
      );
      if (value !== undefined) {
        await schedulePlatformSideEffect(
          recordPlatformLegacyWorkspaceMetric(env, legacyTags, value).then(
            (recorded) => {
              // A failed write is retried by the next use of the tag set.
              if (!recorded) {
                platformLegacyWorkspaceRouteCounter.restore(legacyTags, value);
              }
            },
          ),
          context,
        );
      }
    }
    return response;
  },
};

/** Only the Core sealed capability authorizes this machine route, never a browser session. */
async function handlePlatformPrivateRunFilesRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  context?: PlatformExecutionContext,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/internal/private-run-files" && !url.pathname.startsWith("/internal/private-run-files/")) return undefined;
  const reject = (status: number, kind: string) => Response.json({ kind }, { status, headers: { "cache-control": "no-store" } });
  try {
    const configuration = privateRunFilesCompositionFor(env);
    if (!configuration) return reject(404, "not_found");
    if (!["read", "commit", "resolve"].some(operation => request.url === `${configuration.endpoint}/${operation}`) || !url.pathname.startsWith(`${PRIVATE_RUN_FILE_HTTP_PATH}/`)) return reject(404, "not_found");
    if (request.method !== "POST") return reject(405, "method_not_allowed");
    if (request.headers.has("origin") || request.headers.has("cookie") || request.headers.has("x-takosumi-account-session")) return reject(403, "authorization_rejected");
    const service = await cachedDeployControlService(env);
    const response = await service.app.fetch(request, undefined, honoExecutionContext(context));
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch {
    return reject(503, "unavailable");
  }
}

const SCHEDULED_INTERFACE_MATERIALIZATION_INTENT_LIMIT = 25;
const SCHEDULED_INTERFACE_MATERIALIZATION_WORK_ITEM_LIMIT = 64;
const SCHEDULED_INTERFACE_MATERIALIZATION_TIME_BUDGET_MS = 20_000;

export type ScheduledInterfaceMaterializationIntentOperations = Pick<
  TakosumiOperations,
  "drainInterfaceMaterializationIntents"
>;

/** One globally oldest-first, bounded recovery slice per owning Worker tick. */
export async function drainInterfaceMaterializationIntents(
  operations: ScheduledInterfaceMaterializationIntentOperations,
): ReturnType<
  ScheduledInterfaceMaterializationIntentOperations["drainInterfaceMaterializationIntents"]
> {
  return await operations.drainInterfaceMaterializationIntents({
    limit: SCHEDULED_INTERFACE_MATERIALIZATION_INTENT_LIMIT,
    maxWorkItems: SCHEDULED_INTERFACE_MATERIALIZATION_WORK_ITEM_LIMIT,
    timeBudgetMs: SCHEDULED_INTERFACE_MATERIALIZATION_TIME_BUDGET_MS,
  });
}

/** One bounded dispatcher pass for the instance's own Web Push notifications. */
async function runScheduledOwnNotificationDispatch(
  env: CloudflareWorkerEnv,
): Promise<void> {
  try {
    await runOwnNotificationDispatch({
      operations: await deployControlSeam(env).operations(),
      store: new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
        schemaMode: resolveD1AccountsSchemaMode(
          env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE,
        ),
      }),
      env: env as unknown as Readonly<Record<string, unknown>>,
      issuer: env.TAKOSUMI_ACCOUNTS_ISSUER,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "own_notification_dispatch_failed",
      errorName: error instanceof Error ? error.name : "unknown",
    }));
  }
}

async function runScheduledInterfaceMaterializationIntentDrain(
  env: DeployControlEnv,
): Promise<void> {
  try {
    const result = await drainInterfaceMaterializationIntents(
      await deployControlSeam(env).operations(),
    );
    console.log(
      JSON.stringify({
        event: "interface_materialization_recovery",
        claimed: result.claimed,
        completed: result.completed,
        progressed: result.progressed,
        workItemsCompleted: result.workItemsCompleted,
        retried: result.retried,
        deadLettered: result.deadLettered,
        leaseLost: result.leaseLost,
      }),
    );
    if (result.deadLettered > 0) {
      console.warn(
        JSON.stringify({
          event: "interface_materialization_dead_letters",
          count: result.deadLettered,
        }),
      );
    }
  } catch (error) {
    // Failure-isolated: the durable pending/lease-expiry state is the retry
    // authority, and one unavailable dependency must not suppress other cron
    // recovery owners on this tick.
    console.warn(
      JSON.stringify({
        event: "interface_materialization_recovery_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

const SCHEDULED_CAPSULE_UNINSTALL_FINALIZE_LIMIT = 10;

export type ScheduledCapsuleUninstallOperations = Pick<
  TakosumiOperations,
  "finalizeDueCapsuleUninstalls"
>;

/** One bounded slice of due two-stage uninstalls per owning Worker tick. */
export async function finalizeScheduledCapsuleUninstalls(
  operations: ScheduledCapsuleUninstallOperations,
): ReturnType<
  ScheduledCapsuleUninstallOperations["finalizeDueCapsuleUninstalls"]
> {
  return await operations.finalizeDueCapsuleUninstalls({
    limit: SCHEDULED_CAPSULE_UNINSTALL_FINALIZE_LIMIT,
  });
}

async function runScheduledCapsuleUninstallFinalize(
  env: DeployControlEnv,
): Promise<void> {
  try {
    const result = await finalizeScheduledCapsuleUninstalls(
      await deployControlSeam(env).operations(),
    );
    console.log(
      JSON.stringify({ event: "capsule_uninstall_finalize", ...result }),
    );
  } catch (error) {
    // Failure-isolated: each Capsule's uninstall request is the durable retry
    // authority, and the next tick resumes from it.
    console.warn(
      JSON.stringify({
        event: "capsule_uninstall_finalize_failed",
        errorName: error instanceof Error ? error.name : "unknown",
      }),
    );
  }
}

export interface ScheduledAccountsRefreshChainRetentionResult extends RefreshChainRetentionRunResult {
  readonly failures: number;
}

/**
 * One failure-isolated, bounded Accounts retention slice per platform cron.
 * Production/predeployed mode never performs request-time DDL; bootstrap mode
 * initializes the local/self-host document tables before the first sweep.
 */
export async function runScheduledAccountsRefreshChainRetention(
  env: Pick<
    CloudflareWorkerEnv,
    "TAKOSUMI_ACCOUNTS_DB" | "TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE"
  >,
): Promise<ScheduledAccountsRefreshChainRetentionResult> {
  const schemaMode = resolveD1AccountsSchemaMode(
    env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE,
  );
  const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, { schemaMode });
  try {
    if (schemaMode !== "predeployed") {
      await store.initialize();
    }
    const result = await runRefreshChainRetention(store, {
      maxRows: 100,
      pageSize: 25,
    });
    console.log(
      JSON.stringify({
        event: "accounts_refresh_chain_retention",
        scanned: result.scanned,
        deleted:
          result.chainLinks +
          result.chainAccessTokens +
          result.revokedRoots +
          result.consumedCodes +
          result.authCodeTokenLinks,
        done: result.done,
      }),
    );
    return { ...result, failures: 0 };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "accounts_refresh_chain_retention_failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return {
      chainLinks: 0,
      chainAccessTokens: 0,
      revokedRoots: 0,
      consumedCodes: 0,
      authCodeTokenLinks: 0,
      scanned: 0,
      pages: 0,
      done: false,
      failures: 1,
    };
  }
}

export async function schedulePlatformSideEffect(
  task: Promise<unknown>,
  context?: PlatformExecutionContext,
): Promise<void> {
  if (context) {
    context.waitUntil(task);
    return;
  }
  await task;
}

function platformDiscoveryOptions(
  origin: string,
  env: CloudflareWorkerEnv,
): CreateTakosumiDiscoveryOptions {
  const extensionDiscovery = platformExtensionDiscovery(env);
  const operatorControlMcp = operatorControlMcpEnabled(env);
  const operator = platformOperatorCapabilities(env);
  const mobileOidcClientId = configuredTakosumiMobileOidcClientId(env);
  const storeEndpoint = normalizePublicStoreEndpoint(env.TAKOSUMI_TCS_STORE_URL);
  const oidcIssuer = env.TAKOSUMI_ACCOUNTS_ISSUER?.trim() || undefined;
  return {
    origin,
    ...(oidcIssuer ? { oidcIssuer } : {}),
    ...(mobileOidcClientId ? { mobileOidcClientId } : {}),
    identity: {
      external_oidc_login: accountsExternalLoginConfigured(env),
    },
    operator,
    extensions: [
      ...new Set([
        ...extensionDiscovery.extensions,
        ...(operatorControlMcp ? ["mcp.operator-control.v1"] : []),
        ...(storeEndpoint ? ["takosumi.tcs-store.v1"] : []),
      ]),
    ],
    endpoints: Object.fromEntries(
      [
        ...Object.entries(extensionDiscovery.endpoints),
        ...(operatorControlMcp
          ? ([["mcp.operator-control.v1", OPERATOR_CONTROL_MCP_PATH]] as const)
          : []),
        ...(storeEndpoint
          ? ([["takosumi.tcs-store.v1", storeEndpoint]] as const)
          : []),
      ].map(([token, path]) => [token, new URL(path, origin).toString()]),
    ),
    interfacesEnabled: platformInterfaceApiEnabled(env),
  };
}

function parseCapabilityTokens(raw: string): readonly string[] {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      return [];
    }
  }
  return raw
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtensionCapabilityTokens(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of parseCapabilityTokens(value.trim())) {
    if (token.trim() === "" || /\s/u.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

export function platformInterfaceApiEnabled(
  env: CloudflareWorkerEnv,
): boolean {
  // Interface ingress requires the in-process deploy-control service and its
  // operator bearer; no retired Resource API is enabled here.
  return Boolean(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN && env.TAKOSUMI_CONTROL_DB);
}

/** Generic Interface/InterfaceBinding ingress; kept independent from Flow-B. */
export function isPlatformInterfaceApiPath(pathname: string): boolean {
  return (
    pathname === "/api/v1/interfaces" ||
    pathname.startsWith("/api/v1/interfaces/")
  );
}

function isPlatformLegacyInterfaceApiPath(pathname: string): boolean {
  return (
    pathname === "/v1/interfaces" || pathname.startsWith("/v1/interfaces/")
  );
}

const RETIRED_TAKOFORM_HOST_API_PREFIX = "/apis/forms.takoform.com";

function isRetiredTakoformHostApiPath(pathname: string): boolean {
  return isPathOrSubpath(pathname, RETIRED_TAKOFORM_HOST_API_PREFIX);
}

function isPathOrSubpath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isPlatformTakoformHostPath(pathname: string): boolean {
  return (
    isPathOrSubpath(pathname, "/.well-known/takoform") ||
    isRetiredTakoformHostApiPath(pathname)
  );
}

function isPlatformInterfaceTokenIssueRequest(request: Request): boolean {
  return (
    request.method === "POST" &&
    /^\/api\/v1\/interfaces\/[^/]+\/token$/u.test(new URL(request.url).pathname)
  );
}

export async function handlePlatformInterfaceApiRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
  context?: PlatformExecutionContext,
  appPartition: PlatformInterfaceAppPartition = platformExtensionSessionAppPartition,
): Promise<Response> {
  const legacyWorkspace: PlatformLegacyWorkspaceObservation = {};
  const response = await handlePlatformInterfaceApiRequestInternal(
    request,
    env,
    sessionVerifier,
    workspaceAccess,
    context,
    legacyWorkspace,
    appPartition,
  );
  return observePlatformLegacyWorkspaceUse(
    request,
    env,
    response,
    legacyWorkspace,
  );
}

/** Shared Interface dispatch. Retired Resource paths fail closed. */
async function handlePlatformInterfaceApiRequestInternal(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
  context?: PlatformExecutionContext,
  legacyWorkspace?: PlatformLegacyWorkspaceObservation,
  appPartition: PlatformInterfaceAppPartition = platformExtensionSessionAppPartition,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const timings: ServerTimingBucket = undefined;
  if (isRetiredV1Path(pathname) || isPlatformTakoformHostPath(pathname)) {
    return appendPlatformInterfaceServerTiming(
      retiredApiNotFoundResponse(),
      timings,
    );
  }
  const enabled = platformInterfaceApiEnabled(env);
  if (!enabled) {
    return appendPlatformInterfaceServerTiming(
      retiredApiNotFoundResponse(),
      timings,
    );
  }
  const hasDeployControlBearer = platformControlHasDeployControlBearer(
    request,
    env,
  );
  if (!hasDeployControlBearer) {
    const authorized = await platformInterfaceExternalRequest(
      request,
      env,
      sessionVerifier,
      workspaceAccess,
      timings,
      legacyWorkspace,
      (appRequest, appEnv, capsuleId, options) =>
        appPartition(appRequest, appEnv, capsuleId, { ...options, ...(context ? { context } : {}) }),
    );
    if (!authorized.ok) {
      return appendPlatformInterfaceServerTiming(authorized.response, timings);
    }
    request = authorized.request;
  } else if (legacyWorkspace) {
    // The operator deploy-control token selects a Workspace only explicitly.
    const selector = await platformDeployControlWorkspaceSelector(request);
    if (selector) {
      markPlatformLegacyWorkspaceUse(legacyWorkspace, {
        surface: "interface_workspace",
        route: interfaceApiRouteTemplate(pathname),
        selector,
      }, { credential: "deploy-control" });
    }
  }
  const service = await cachedDeployControlService(env);
  const response = await measureServerTiming(
    timings,
    "interface-dispatch",
    () =>
      service.app.fetch(
        request,
        undefined,
        honoExecutionContext(context),
      ),
  );
  return appendPlatformInterfaceServerTiming(response, timings);
}

export function appendPlatformInterfaceServerTiming(
  response: Response,
  timings: ServerTimingBucket,
): Response {
  if (!timings || timings.length === 0) return response;

  // Keep this wrapper safe if an extension returns a Cloudflare WebSocket
  // response. Reconstructing a 101 Response would drop its socket.
  const webSocket = (response as unknown as { readonly webSocket?: unknown })
    .webSocket;
  if (response.status === 101 || webSocket !== undefined) return response;

  const headers = new Headers(response.headers);
  const existing = headers.get("Server-Timing");
  const value = timings
    .map(
      ({ name, durationMs }) =>
        `${name};dur=${Math.max(0, durationMs).toFixed(1)}`,
    )
    .join(", ");
  headers.set("Server-Timing", existing ? `${existing}, ${value}` : value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function honoExecutionContext(
  context: PlatformExecutionContext | undefined,
): HonoExecutionContext | undefined {
  // Cloudflare supplies the full ExecutionContext at runtime. The narrower
  // platform type intentionally exposes only waitUntil to application code.
  return context as HonoExecutionContext | undefined;
}

const PLATFORM_CORE_PROCESS_PATHS = new Set([
  "/livez",
  "/capabilities",
  "/openapi.json",
]);

const PLATFORM_RESERVED_MACHINE_PREFIXES = [
  "/__takosumi",
  "/hooks",
  "/metrics",
  "/livez",
  "/capabilities",
  "/openapi.json",
] as const;

function isPlatformCoreProcessRoute(request: Request, url: URL): boolean {
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    PLATFORM_CORE_PROCESS_PATHS.has(url.pathname)
  );
}

function isPlatformReservedMachinePath(pathname: string): boolean {
  return PLATFORM_RESERVED_MACHINE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isPlatformUnknownApiPath(pathname: string): boolean {
  if (pathname === "/api" || pathname === "/api/") return true;
  if (!pathname.startsWith("/api/")) return false;
  // Keep the canonical /api/v1 surface with Accounts. Near-prefix paths such
  // as /api/v1x and /api/v10 are still normal SPA routes, not API paths.
  if (
    pathname === API_V1_PREFIX ||
    pathname.startsWith(`${API_V1_PREFIX}/`)
  ) {
    return false;
  }
  if (pathname.startsWith(API_V1_PREFIX)) return false;
  return true;
}

function platformGetHeadOnlyRequest(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function platformGetHeadOnlyMethodNotAllowedResponse(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: "GET, HEAD" } },
  );
}

function platformControlHasDeployControlBearer(
  request: Request,
  env: CloudflareWorkerEnv,
): boolean {
  const token =
    typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string"
      ? env.TAKOSUMI_DEPLOY_CONTROL_TOKEN
      : undefined;
  const bearer = bearerFromAuthorization(
    request.headers.get("authorization") ?? "",
  );
  return Boolean(token && bearer && constantTimeEqualsString(bearer, token));
}

async function platformInterfaceExternalRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier,
  workspaceAccess: PlatformExtensionWorkspaceAccess,
  timings?: ServerTimingBucket,
  legacyWorkspace?: PlatformLegacyWorkspaceObservation,
  appPartition: PlatformInterfaceAppPartition = platformExtensionSessionAppPartition,
): Promise<
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly response: Response }
> {
  const session = await measureServerTiming(
    timings,
    "session",
    () => sessionVerifier(request, env),
  );
  if (session.unavailable) {
    return { ok: false, response: sharedAuthUnavailableResponse() };
  }
  if (!session.authenticated) {
    return {
      ok: false,
      response: Response.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  const sessionRoleFailure = platformExtensionSessionRoleFailure(session);
  if (sessionRoleFailure) return { ok: false, response: sessionRoleFailure };
  const sessionCsrfFailure = platformExtensionSessionCsrfFailure(
    request,
    env,
    session,
  );
  if (sessionCsrfFailure) {
    return { ok: false, response: sessionCsrfFailure };
  }
  return await platformInterfaceAuthorizedRequest(
    request,
    request,
    env,
    session,
    workspaceAccess,
    timings,
    legacyWorkspace,
    appPartition,
  );
}

async function platformInterfaceAuthorizedRequest(
  request: Request,
  workspaceVerificationRequest: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
  timings?: ServerTimingBucket,
  legacyWorkspace?: PlatformLegacyWorkspaceObservation,
  appPartition: PlatformInterfaceAppPartition = platformExtensionSessionAppPartition,
): Promise<
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly response: Response }
> {
  const sessionRoleFailure = platformExtensionSessionRoleFailure(session);
  if (sessionRoleFailure) return { ok: false, response: sessionRoleFailure };

  const url = new URL(request.url);
  // The session is authenticated from here on, so a later refusal of an
  // explicitly selected Workspace is still a use (TASK-0118 Phase 9).
  const explicitBeforeBody = platformControlRequestWorkspace(request, url, {});
  if (explicitBeforeBody && legacyWorkspace) {
    markPlatformLegacyWorkspaceUse(legacyWorkspace, {
      surface: "interface_workspace",
      route: interfaceApiRouteTemplate(url.pathname),
      selector: explicitBeforeBody.selector,
    }, platformLegacyWorkspaceSessionFacts(session));
  }
  const interfaceAccessFailure = platformInterfaceAccessFailure(request, session);
  if (interfaceAccessFailure) {
    return { ok: false, response: interfaceAccessFailure };
  }

  const materialized = await materializeRequestBody(request);
  if (!materialized.ok) return materialized;
  const body = materialized.bodyText
    ? objectRecord(JSON.parse(materialized.bodyText))
    : {};
  const requested = platformControlRequestWorkspace(request, url, body);
  const requestedWorkspaceId = requested?.workspaceId;
  const workspaceId =
    requestedWorkspaceId ?? safePlatformExtensionContextId(session.workspaceId);
  if (workspaceId && legacyWorkspace) {
    // A body or the credential's own Workspace; the first mark wins.
    markPlatformLegacyWorkspaceUse(legacyWorkspace, {
      surface: "interface_workspace",
      route: interfaceApiRouteTemplate(url.pathname),
      selector: requested?.selector ?? "session",
    }, platformLegacyWorkspaceSessionFacts(session));
  }
  if (!workspaceId) {
    const appScoped = await measureServerTiming(
      timings,
      "app-auth",
      () => platformInterfaceAppScope(workspaceVerificationRequest, url, env, session, appPartition),
    );
    if (!appScoped) {
      return {
        ok: false,
        response: Response.json(
          {
            error: "invalid_request",
            error_description: "workspaceId or capsuleId is required",
          },
          { status: 400 },
        ),
      };
    }
    if (!appScoped.ok) return appScoped;
    return {
      ok: true,
      request: cloneRequestWithBody(materialized, (headers) => {
        headers.set(
          "authorization",
          `Bearer ${String(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN)}`,
        );
        headers.set(
          TAKOSUMI_INTERNAL_ACTOR_HEADER,
          encodeActorContext(
            platformInterfaceActorContext(session, appScoped.workspaceId, request),
          ),
        );
        headers.delete(PLATFORM_EXTENSION_WORKSPACE_ROLE_HEADER);
        for (const header of PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS) {
          if (header !== "authorization") headers.delete(header);
        }
      }),
    };
  }

  const verified = await measureServerTiming(
    timings,
    "workspace-auth",
    () =>
      platformExtensionVerifiedWorkspaceSession(
        workspaceVerificationRequest,
        env,
        session,
        workspaceId,
        workspaceAccess,
        platformInterfaceAccessMode(request, url),
      ),
  );
  if (!verified.ok) return verified;

  return {
    ok: true,
    request: cloneRequestWithBody(materialized, (headers) => {
      headers.set(
        "authorization",
        `Bearer ${String(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN)}`,
      );
      headers.set(
        TAKOSUMI_INTERNAL_ACTOR_HEADER,
        encodeActorContext(
          platformInterfaceActorContext(
            verified.session,
            workspaceId,
            request,
          ),
        ),
      );
      headers.delete(PLATFORM_EXTENSION_WORKSPACE_ROLE_HEADER);
      for (const header of PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS) {
        if (header !== "authorization") headers.delete(header);
      }
    }),
  };
}

/**
 * Workspace-free Interface ingress (TASK-0118 9.1). An installed app's own
 * OAuth token (bound to its app by introspection) acts as a runtime
 * principal without a Workspace: Core then resolves its exact Principal
 * Bindings, which are the only authority, and refuses every mutation. An
 * account session or PAT may list one app's Interfaces (`capsuleId`) after
 * Accounts' ordinary per-app `view` decision; the actor is then scoped to
 * that app's internal partition and Core lists only that app's Interfaces.
 * `undefined` means the request names neither and still needs a Workspace.
 */
async function platformInterfaceAppScope(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  appPartition: PlatformInterfaceAppPartition,
): Promise<
  | { readonly ok: true; readonly workspaceId?: string }
  | { readonly ok: false; readonly response: Response }
  | undefined
> {
  if (
    session.authKind === "oauth-access-token" &&
    safePlatformExtensionContextId(session.capsuleId)
  ) {
    return { ok: true };
  }
  const capsuleId = safePlatformExtensionContextId(
    url.searchParams.get("capsuleId"),
  );
  if (
    !capsuleId ||
    (session.authKind !== "session" &&
      session.authKind !== "personal-access-token") ||
    (request.method !== "GET" && request.method !== "HEAD") ||
    url.pathname !== "/api/v1/interfaces"
  ) {
    return undefined;
  }
  const workspaceId = await appPartition(request, env, capsuleId, {
    ...(session.sharedAccount ? { sharedAccount: true } : {}),
  });
  return workspaceId
    ? { ok: true, workspaceId }
    : {
        ok: false,
        response: Response.json(
          {
            error: "access_denied",
            error_description: "app context is not authorized",
          },
          { status: 403 },
        ),
      };
}

/** The internal partition of an app the session may view, if any. */
export type PlatformInterfaceAppPartition = (
  request: Request,
  env: CloudflareWorkerEnv,
  capsuleId: string,
  options?: {
    readonly context?: PlatformExecutionContext;
    /** A shared-account (Hosted) session, authenticated by the shared RP. */
    readonly sharedAccount?: true;
  },
) => Promise<string | undefined>;

/**
 * Asks Accounts for the app with the caller's own credential: a `200` from
 * `GET /api/v1/capsules/:id` is the ordinary per-app `view` decision
 * (including a PAT's `appIds`), and the Capsule names its partition.
 */
async function platformExtensionSessionAppPartition(
  request: Request,
  env: CloudflareWorkerEnv,
  capsuleId: string,
  options: {
    readonly context?: PlatformExecutionContext;
    readonly sharedAccount?: true;
  } = {},
): Promise<string | undefined> {
  const headers = sessionMirrorHeaders(request);
  if (!headers) return undefined;
  const capsuleRequest = (requestHeaders: Headers) =>
    new Request(
      new URL(`/api/v1/capsules/${encodeURIComponent(capsuleId)}`, request.url),
      { method: "GET", headers: requestHeaders },
    );
  try {
    let response: Response | undefined;
    if (options.sharedAccount) {
      // A shared-account session is not an Accounts session cookie: ask the
      // same shared-auth control dispatch the dashboard uses, which
      // authenticates the shared RP identity and applies the per-app view.
      headers.delete("authorization");
      response = await handlePlatformSharedAuthControlRequest(capsuleRequest(headers), env);
    } else {
      response = await accountsWorker.fetch(capsuleRequest(headers), env, options.context);
    }
    if (!response?.ok) return undefined;
    const body = objectRecord(await response.json().catch(() => undefined));
    const capsule = objectRecord(body.capsule);
    return valueString(capsule.id) === capsuleId
      ? workspaceIdFromCapsuleBody(body)
      : undefined;
  } catch {
    return undefined;
  }
}

function platformInterfaceAccessMode(
  request: Request,
  url: URL,
): "read" | "write" {
  if (request.method === "GET" || request.method === "HEAD") return "read";
  // Token issue invokes an already Ready binding. It does not mutate the
  // Interface or its owner, so delegated read authority remains sufficient.
  if (
    request.method === "POST" &&
    /^\/api\/v1\/interfaces\/[^/]+\/token$/u.test(url.pathname)
  ) {
    return "read";
  }
  return "write";
}

function platformExtensionSessionCsrfFailure(
  request: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
): Response | undefined {
  const readOnly =
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.method === "OPTIONS";
  if (
    readOnly ||
    session.authKind !== "session"
  ) {
    return undefined;
  }
  let issuerOrigin: string;
  try {
    issuerOrigin = new URL(
      session.sharedAccount
        ? env.TAKOSUMI_SHARED_AUTH_ORIGIN ?? ""
        : env.TAKOSUMI_ACCOUNTS_ISSUER ?? request.url,
    ).origin;
  } catch {
    return Response.json({ error: "csrf_check_unavailable" }, { status: 503 });
  }
  return request.headers.get("origin") === issuerOrigin
    ? undefined
    : Response.json({ error: "csrf_failed" }, { status: 403 });
}

/** Browser mirror of the RP identity. No synthetic issuer session is minted. */
export async function handlePlatformSharedAuthSessionRequest(
  request: Request,
  env: SharedAuthEnvironment,
): Promise<Response | undefined> {
  if (new URL(request.url).pathname !== "/api/v1/account/session/me" ||
    !sharedAuthConfigured(env)) return undefined;
  const ingressFailure = sharedAuthRequestFailure(request, env);
  if (ingressFailure) return ingressFailure;
  if (new URL(request.url).origin !== env.TAKOSUMI_SHARED_AUTH_ORIGIN) {
    return Response.json({ error: "not found" }, {
      status: 404, headers: { "cache-control": "no-store" },
    });
  }
  if (request.method === "DELETE") {
    const target = new URL(request.url);
    target.pathname = "/auth/oidc/logout";
    target.search = "";
    return await handleSharedAuthRouteRequest(new Request(target, {
      method: "POST", headers: request.headers,
    }), env);
  }
  if (request.method !== "GET") {
    return Response.json({ error: "method_not_allowed" }, {
      status: 405, headers: { allow: "GET, DELETE", "cache-control": "no-store" },
    });
  }
  const identity = await authenticateSharedAuthRequest(request, env);
  if (identity?.kind === "unavailable") return sharedAuthUnavailableResponse();
  return Response.json(identity?.kind === "authenticated"
    ? { subject: identity.accountId, primaryAccountId: identity.accountId, expiresAt: 0 }
    : { session: null }, { headers: { "cache-control": "no-store" } });
}

/**
 * Shared-profile browser authentication is verified by the private RP, then
 * existing Control handlers read the canonical Workspace/member authority and
 * retain their mutation admission/CAS fences. The profile's access/ID tokens
 * are never forwarded to the product API as credentials.
 */
export async function handlePlatformSharedAuthControlRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  dependencies: {
    readonly store?: AccountsStore;
    readonly resolveOperations?: () => Promise<ControlPlaneOperations>;
    readonly runStreamTiming?: RunStreamTiming;
  } = {},
): Promise<Response | undefined> {
  if (!sharedAuthConfigured(env)) return undefined;
  const url = new URL(request.url);
  const resource = controlInventoryResourceKey(url.pathname);
  if (!resource || !CONTROL_DISPATCH_RESOURCE_KEYS.includes(resource)) return undefined;
  const runRead = isRunGetReadRequest(request);
  const diagnostics = runRead
    ? sharedRunGetPhaseDiagnostics(env).forRequest(request)
    : undefined;
  const handle = async (
    assertActive?: () => void,
    withinRunReadDeadline?: RunReadWaiter,
  ): Promise<Response> => {
    const ingressFailure = sharedAuthRequestFailure(request, env);
    if (ingressFailure) return ingressFailure;
    if (request.headers.has("authorization")) {
      return Response.json({ error: "unauthenticated" }, {
        status: 401, headers: { "cache-control": "no-store" },
      });
    }
    const identity = await measureRequestPhaseOperation(
      diagnostics,
      "control_auth",
      () => authenticateSharedAuthRequest(request, env),
    );
    assertActive?.();
    if (identity?.kind === "unavailable") return sharedAuthUnavailableResponse();
    if (identity?.kind !== "authenticated") {
      return Response.json({ error: "unauthenticated" }, {
        status: 401, headers: { "cache-control": "no-store" },
      });
    }
    const csrfFailure = platformExtensionSessionCsrfFailure(request, env, {
      authenticated: true, authKind: "session", sharedAccount: true,
    });
    if (csrfFailure) return csrfFailure;
    const headers = new Headers(request.headers);
    for (const header of [...headers.keys()]) {
      if (header === "cookie" || header === "authorization" ||
        header === "proxy-authorization" || header.startsWith("x-takosumi-") ||
        header.startsWith("x-auth-")) headers.delete(header);
    }
    const authenticatedRequest = clonePlatformExtensionRequest(request, headers);
    const response = await handleAuthenticatedControlRoute({
      request: authenticatedRequest,
      url,
      store: dependencies.store ?? new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
        schemaMode: resolveD1AccountsSchemaMode(env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE),
      }),
      resolveOperations: dependencies.resolveOperations ?? (() => controlPlaneOperationsFor(env)),
      subject: identity.accountId,
      credential: "session",
      requireCurrentMembership: true,
      entry: "shared_auth",
      ...platformLegacyWorkspaceSunsetOption(env),
      ...(parseAppOwnershipMutationsFrozen(env.TAKOSUMI_APP_OWNERSHIP_MUTATIONS) ? { appOwnershipMutationsFrozen: true } : {}),
      trustedNativeClients: trustedNativeClientsFromEnv(env.TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS),
      ...platformActivityCursorSealerOption(env),
      ...(diagnostics ? { diagnostics } : {}),
      ...(assertActive ? { assertActive } : {}),
      ...(withinRunReadDeadline ? { withinRunReadDeadline } : {}),
      ...(dependencies.runStreamTiming ? { runStreamTiming: dependencies.runStreamTiming } : {}),
      reauthorizeBearer: async () => {
        const current = await authenticateSharedAuthRequest(request, env);
        return current?.kind === "authenticated" && current.accountId === identity.accountId;
      },
    });
    if (!response) return Response.json({ error: "not found" }, { status: 404 });
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  };
  return runRead
    ? await runGetWithinDeadline((assertActive, wait) => handle(assertActive, wait))
    : await handle();
}

const sharedRunGetDiagnosticFactories = new WeakMap<
  CloudflareWorkerEnv,
  ReturnType<typeof createRequestPhaseDiagnostics>
>();

function sharedRunGetPhaseDiagnostics(env: CloudflareWorkerEnv) {
  let factory = sharedRunGetDiagnosticFactories.get(env);
  if (!factory) {
    factory = createRequestPhaseDiagnostics({
      environment: typeof env.TAKOSUMI_ENVIRONMENT === "string" ? env.TAKOSUMI_ENVIRONMENT : "",
      enabled: env.TAKOSUMI_REQUEST_PHASE_DIAGNOSTICS ?? "",
    });
    sharedRunGetDiagnosticFactories.set(env, factory);
  }
  return factory;
}

function platformInterfaceAccessFailure(
  request: Request,
  session: PlatformExtensionSessionContext,
): Response | undefined {
  const readOnly = request.method === "GET" || request.method === "HEAD";
  const scopes = new Set(session.scopes ?? []);

  if (session.authKind === "session") return undefined;

  if (session.authKind === "oauth-access-token") {
    const mayRead =
      scopes.has("admin") ||
      scopes.has("capsules:read") ||
      scopes.has("capsules:write");
    if (
      (readOnly || isPlatformInterfaceTokenIssueRequest(request)) &&
      mayRead
    ) {
      return undefined;
    }
    return Response.json(
      {
        error: "insufficient_scope",
        error_description: readOnly
          ? "delegated token lacks Capsule read scope"
          : isPlatformInterfaceTokenIssueRequest(request)
            ? "delegated token lacks Capsule read scope for Interface token issuance"
            : "delegated runtime tokens cannot mutate Interfaces",
      },
      { status: 403 },
    );
  }

  if (session.authKind === "personal-access-token") {
    const mayRead =
      scopes.has("admin") || scopes.has("read") || scopes.has("write");
    const mayWrite = scopes.has("admin") || scopes.has("write");
    if ((readOnly && mayRead) || (!readOnly && mayWrite)) return undefined;
    return Response.json(
      {
        error: "insufficient_scope",
        error_description: readOnly
          ? "personal access token lacks read scope"
          : "personal access token lacks write scope",
      },
      { status: 403 },
    );
  }

  // Interface OAuth credentials remain invocation-only. Run credentials are
  // accepted only by an explicitly declared platform extension route.
  return Response.json(
    {
      error: "access_denied",
      error_description: "credential type cannot access Interface control APIs",
    },
    { status: 403 },
  );
}

function platformOAuthAccessTokenAllowsControlRequest(
  request: Request,
  scopes: readonly string[] | undefined,
): boolean {
  const granted = new Set(scopes ?? []);
  if (granted.has("admin") || granted.has("capsules:write")) return true;
  return (
    (request.method === "GET" || request.method === "HEAD") &&
    granted.has("capsules:read")
  );
}

async function materializeRequestBody(request: Request): Promise<
  | {
      readonly ok: true;
      readonly request: Request;
      readonly bodyText?: string;
    }
  | { readonly ok: false; readonly response: Response }
> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { ok: true, request };
  }
  const maxBytes = 1_048_576;
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return platformRequestBodyTooLarge();
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body exceeds 1 MiB");
        return platformRequestBodyTooLarge();
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let bodyText: string;
  try {
    bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          error: "invalid_request",
          error_description: "body must be UTF-8 JSON",
        },
        { status: 400 },
      ),
    };
  }
  if (bodyText.trim()) {
    try {
      JSON.parse(bodyText);
    } catch {
      return {
        ok: false,
        response: Response.json(
          {
            error: "invalid_request",
            error_description: "body must be JSON",
          },
          { status: 400 },
        ),
      };
    }
  }
  return { ok: true, request, bodyText };
}

function platformRequestBodyTooLarge(): {
  readonly ok: false;
  readonly response: Response;
} {
  return {
    ok: false,
    response: Response.json(
      {
        error: "request_too_large",
        error_description: "body exceeds 1 MiB",
      },
      { status: 413 },
    ),
  };
}

function cloneRequestWithBody(
  materialized: { readonly request: Request; readonly bodyText?: string },
  updateHeaders: (headers: Headers) => void,
): Request {
  const headers = new Headers(materialized.request.headers);
  headers.delete(TAKOSUMI_INTERNAL_ACTOR_HEADER);
  updateHeaders(headers);
  return new Request(materialized.request.url, {
    method: materialized.request.method,
    headers,
    body:
      materialized.request.method === "GET" ||
      materialized.request.method === "HEAD"
        ? undefined
        : (materialized.bodyText ?? ""),
    redirect: materialized.request.redirect,
  });
}

/** The explicitly requested Workspace and where it came from, in precedence order. */
function platformControlRequestWorkspace(
  request: Request,
  url: URL,
  body: Record<string, unknown>,
):
  | { readonly workspaceId: string; readonly selector: LegacyWorkspaceSelector }
  | undefined {
  const query = safePlatformExtensionContextId(url.searchParams.get("workspaceId"));
  if (query) return { workspaceId: query, selector: "query" };
  const header = safePlatformExtensionContextId(
    request.headers.get(PLATFORM_EXTENSION_WORKSPACE_ID_HEADER),
  );
  if (header) return { workspaceId: header, selector: "header" };
  const fromBody = safePlatformExtensionContextId(valueString(body.workspaceId));
  if (fromBody) return { workspaceId: fromBody, selector: "body" };
  return undefined;
}

/** Core's own JSON body bound (`core/api/errors.ts`), reused for telemetry. */
const PLATFORM_DEPLOY_CONTROL_TELEMETRY_BODY_MAX_BYTES = 1_048_576;

/**
 * How a deploy-control request to the Interface API names a Workspace. Core
 * reads `?workspaceId=` and a `workspaceId` body field; the body is read from
 * a clone so the dispatched request is unchanged. Telemetry only: a body that
 * cannot be read or parsed is simply not counted here.
 */
async function platformDeployControlWorkspaceSelector(
  request: Request,
): Promise<LegacyWorkspaceSelector | undefined> {
  if (new URL(request.url).searchParams.has("workspaceId")) return "query";
  // Core refuses a body over 1 MiB by its declared length; telemetry reads
  // only a body Core could accept and whose length is declared.
  const declaredLength = Number(request.headers.get("content-length") ?? NaN);
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    request.body === null ||
    !(request.headers.get("content-type") ?? "").includes("json") ||
    !Number.isSafeInteger(declaredLength) ||
    declaredLength < 0 ||
    declaredLength > PLATFORM_DEPLOY_CONTROL_TELEMETRY_BODY_MAX_BYTES
  ) {
    return undefined;
  }
  try {
    const body = objectRecord(JSON.parse(await request.clone().text()));
    return body.workspaceId !== undefined ? "body" : undefined;
  } catch {
    return undefined;
  }
}

function platformInterfaceActorContext(
  session: PlatformExtensionSessionContext,
  workspaceId: string | undefined,
  request?: Request,
): ActorContext {
  const runtimePrincipal =
    session.authKind === "oauth-access-token" ||
    (session.authKind === "personal-access-token" &&
      request !== undefined &&
      isPlatformInterfaceTokenIssueRequest(request));
  return {
    actorAccountId:
      safePlatformExtensionContextId(session.subject) ??
      `${session.authKind ?? "session"}:interface`,
    roles: runtimePrincipal
      ? ["runtime-principal"]
      : session.scopes?.includes("admin")
        ? ["owner"]
        : ["operator"],
    requestId: crypto.randomUUID(),
    ...(workspaceId ? { workspaceId } : {}),
    // The installed app an OAuth token is bound to (introspected); Core
    // restricts a Workspace-free runtime principal's evidence to this app.
    ...(session.authKind === "oauth-access-token" &&
    safePlatformExtensionContextId(session.capsuleId)
      ? { capsuleId: safePlatformExtensionContextId(session.capsuleId) }
      : {}),
    // A personal access token limited to apps: Core never gives it Workspace
    // authority and decides only those apps, also when it issues an
    // Interface token (as a runtime principal).
    ...(session.authKind === "personal-access-token" && session.appIds !== undefined
      ? { appIds: [...session.appIds] }
      : {}),
    ...(session.authKind === "service-token"
      ? { principalKind: "service", serviceId: session.subject }
      : { principalKind: "account" }),
    ...(session.scopes && session.scopes.length > 0
      ? { scopes: [...session.scopes] }
      : {}),
  };
}

export function platformOperatorCapabilities(
  env: CloudflareWorkerEnv,
): TakosumiOperatorCapabilities {
  const configured = configuredOperatorCapabilities(env);
  const accountsDb = hasD1Binding(env.TAKOSUMI_ACCOUNTS_DB);
  const controlDb = hasD1Binding(env.TAKOSUMI_CONTROL_DB);
  const runner = hasDurableObjectBinding(env.RUNNER);
  const deployControlApi =
    controlDb && typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string";
  const enabled = (key: keyof TakosumiOperatorCapabilities): boolean =>
    configured.has(key);
  return {
    multi_tenant_workspaces:
      enabled("multi_tenant_workspaces") && accountsDb && controlDb,
    workspace_members: enabled("workspace_members") && accountsDb,
    runner_pools: enabled("runner_pools") && runner,
    operator_connections: enabled("operator_connections") && controlDb,
    target_catalog: false,
    db_backed_configuration:
      enabled("db_backed_configuration") && accountsDb && controlDb,
    cli_api_operations: enabled("cli_api_operations") && deployControlApi,
    usage_showback: enabled("usage_showback") && controlDb,
    audit_evidence: enabled("audit_evidence") && controlDb,
  };
}

function configuredOperatorCapabilities(
  env: CloudflareWorkerEnv,
): ReadonlySet<keyof TakosumiOperatorCapabilities> {
  const value = env.TAKOSUMI_OPERATOR_CAPABILITIES;
  if (typeof value !== "string" || value.trim().length === 0) {
    return new Set();
  }
  const raw = value.trim();
  const tokens =
    raw === "all" ? TAKOSUMI_OPERATOR_CAPABILITY_KEYS : parseTokens(raw);
  const allowed = new Set<string>(TAKOSUMI_OPERATOR_CAPABILITY_KEYS);
  return new Set(
    tokens.filter(
      (token): token is Extract<keyof TakosumiOperatorCapabilities, string> =>
        allowed.has(token),
    ),
  );
}

function parseTokens(raw: string): readonly string[] {
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (value): value is string => typeof value === "string",
        );
      }
    } catch {
      return [];
    }
  }
  return raw.split(/[\s,]+/u).filter(Boolean);
}

function hasD1Binding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly prepare?: unknown }).prepare === "function"
  );
}

function hasDurableObjectBinding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly get?: unknown }).get === "function"
  );
}

function platformExtensionDiscovery(env: CloudflareWorkerEnv): {
  readonly extensions: readonly string[];
  readonly endpoints: Readonly<Record<string, string>>;
} {
  let configuredRoutes: readonly PlatformExtensionRoute[] = [];
  try {
    configuredRoutes = platformExtensionRoutes(
      env as unknown as { readonly [key: string]: unknown },
    ).filter((route) => platformExtensionRouteConfigured(env, route));
  } catch {
    // Discovery is a known core surface. Optional extension configuration is
    // not allowed to make the core document unavailable; malformed routes are
    // simply omitted until the operator fixes the composition.
    configuredRoutes = [];
  }
  const extensions = new Set<string>();
  const endpoints: Record<string, string> = {};
  for (const route of configuredRoutes) {
    for (const capability of route.capabilities ?? []) {
      extensions.add(capability);
      endpoints[capability] = route.basePath;
    }
  }
  return {
    extensions: [...extensions].sort(),
    endpoints,
  };
}

export function withPlatformAssetCacheHeaders(
  request: Request,
  url: URL,
  response: Response,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") return response;
  if (response.status < 200 || response.status >= 400) return response;
  if (!url.pathname.startsWith("/assets/")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * A legacy Workspace use found while serving a platform route (TASK-0118
 * Phase 9). It is marked only after the credential is authenticated, so a 401
 * or a 403 before authentication is never counted; the first mark wins.
 */
interface PlatformLegacyWorkspaceObservation {
  use?: LegacyWorkspaceUse;
  credential?: LegacyWorkspaceCredential;
  workspaceBound?: boolean;
  appBound?: boolean;
  clientId?: string;
}

interface PlatformLegacyWorkspaceFacts {
  readonly credential: LegacyWorkspaceCredential;
  readonly workspaceBound?: boolean;
  readonly appBound?: boolean;
  readonly clientId?: string;
}

function markPlatformLegacyWorkspaceUse(
  observation: PlatformLegacyWorkspaceObservation,
  use: LegacyWorkspaceUse,
  facts: PlatformLegacyWorkspaceFacts,
): void {
  if (observation.use) return;
  observation.use = use;
  observation.credential = facts.credential;
  observation.workspaceBound = facts.workspaceBound ?? false;
  observation.appBound = facts.appBound ?? false;
  if (facts.clientId !== undefined) observation.clientId = facts.clientId;
}

/** The credential kind, bindings and OAuth client of an authenticated platform session. */
function platformLegacyWorkspaceSessionFacts(
  session: PlatformExtensionSessionContext,
): PlatformLegacyWorkspaceFacts {
  return {
    credential: session.authKind ?? "unknown",
    workspaceBound: session.workspaceId !== undefined,
    appBound: session.capsuleId !== undefined,
    ...(session.oauthClientId !== undefined
      ? { clientId: session.oauthClientId }
      : {}),
  };
}

/**
 * Metric tags of platform-served legacy responses, keyed by the response
 * object the composition returns. Accounts-served responses have no entry and
 * are tagged from their URL instead.
 */
const platformLegacyWorkspaceMetricTags = new WeakMap<
  Response,
  Record<string, string>
>();

/**
 * Reports the legacy Workspace use observed while serving a platform route
 * and adds the deprecation headers. Without an observation the response is
 * returned unchanged.
 */
function observePlatformLegacyWorkspaceUse(
  request: Request,
  env: CloudflareWorkerEnv,
  response: Response,
  observation: PlatformLegacyWorkspaceObservation,
): Response {
  const use = observation.use;
  if (!use) return response;
  reportLegacyWorkspaceRoute({
    use,
    method: request.method,
    status: response.status,
    entry: "platform",
    credential: observation.credential ?? "unknown",
    workspaceBound: observation.workspaceBound ?? false,
    appBound: observation.appBound ?? false,
    clientFamily: legacyWorkspaceClientFamily(request.headers),
    ...(observation.clientId !== undefined
      ? { clientId: observation.clientId }
      : {}),
  });
  const sunset = platformLegacyWorkspaceSunset(env);
  const marked = withLegacyWorkspaceDeprecation(
    response,
    use,
    sunset ? { sunset } : {},
  );
  platformLegacyWorkspaceMetricTags.set(
    marked,
    legacyWorkspaceUseMetricTags(use, request.method, response.status),
  );
  return marked;
}

/**
 * The operator `Sunset` for legacy Workspace routes. A malformed value is
 * ignored here (the Accounts composition refuses it at startup) so a request
 * never fails because of telemetry configuration.
 */
function platformLegacyWorkspaceSunset(
  env: CloudflareWorkerEnv,
): string | undefined {
  try {
    return parseLegacyWorkspaceSunset(env.TAKOSUMI_LEGACY_WORKSPACE_SUNSET);
  } catch {
    return undefined;
  }
}

function platformLegacyWorkspaceSunsetOption(
  env: CloudflareWorkerEnv,
): { readonly legacyWorkspaceSunset?: string } {
  const sunset = platformLegacyWorkspaceSunset(env);
  return sunset ? { legacyWorkspaceSunset: sunset } : {};
}

/** Seals Activity cursors with the secret-store passphrase, when configured. */
function platformActivityCursorSealerOption(
  env: CloudflareWorkerEnv,
): { readonly activityCursorSealer?: ActivityCursorSealer } {
  const sealer = activityCursorSealerFromEnv(env);
  return sealer ? { activityCursorSealer: sealer } : {};
}

/**
 * Writes one coalesced counter value. Resolves false when the write failed so
 * the caller can carry the value into the next write; a composition without
 * Control D1 has no sink and resolves true (there is nothing to retry).
 */
async function recordPlatformLegacyWorkspaceMetric(
  env: CloudflareWorkerEnv,
  tags: Record<string, string>,
  value: number,
): Promise<boolean> {
  if (!env.TAKOSUMI_CONTROL_DB) return true;
  try {
    const service = await cachedDeployControlService(env);
    return await recordWorkerMetric({
      observability: service.context.adapters.observability,
      env,
      name: LEGACY_WORKSPACE_ROUTE_METRIC,
      kind: "counter",
      value,
      tags,
    });
  } catch {
    // Metrics are best-effort and must never change a response.
    return false;
  }
}

async function recordPlatformOidcMetric(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  response: Response,
): Promise<void> {
  try {
    const service = await cachedDeployControlService(env);
    await recordWorkerMetric({
      observability: service.context.adapters.observability,
      env,
      name: "takosumi_oidc_request_count",
      kind: "counter",
      value: 1,
      tags: {
        method: request.method,
        route: oidcMetricRoute(url.pathname),
        status: String(response.status),
      },
    });
  } catch {
    // Metrics are best-effort and must never break OIDC/login responses.
  }
}

export function isOidcMetricPath(pathname: string): boolean {
  // Public metadata reads stay off the Control D1 path. Recording a
  // best-effort metric must not widen their maintenance or cost boundary.
  if (
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/oauth/jwks" ||
    pathname === "/api/v1/auth/providers"
  ) {
    return false;
  }
  return (
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/")
  );
}

export function oidcMetricRoute(pathname: string): string {
  if (pathname.startsWith("/oauth/upstream")) return "/oauth/upstream/*";
  if (pathname === "/oauth" || pathname.startsWith("/oauth/authorize")) {
    return "/oauth/authorize";
  }
  if (pathname.startsWith("/oauth/token")) return "/oauth/token";
  if (pathname.startsWith("/oauth/userinfo")) return "/oauth/userinfo";
  if (pathname.startsWith("/oauth/revoke")) return "/oauth/revoke";
  if (pathname.startsWith("/oauth/introspect")) return "/oauth/introspect";
  if (pathname.startsWith("/oauth/jwks")) return "/oauth/jwks";
  return pathname;
}

export function isPlatformMetricsPath(pathname: string): boolean {
  return pathname === TAKOSUMI_METRICS_PATH;
}

const PLATFORM_METRICS_DASHBOARD_PATH =
  "/internal/platform/metrics-dashboard" as const;
const REQUIRED_DASHBOARD_METRICS = [
  "takosumi_deploy_operation_count",
  "takosumi_apply_duration_seconds_bucket",
  "takosumi_runner_active_runs",
  "takosumi_runner_container_startup_seconds_bucket",
  "takosumi_api_request_duration_seconds_bucket",
  "takosumi_oidc_request_count",
] as const;
// Only labels the protected scrape actually carries. Tenant labels are never
// series labels: the exposition drops `capsule_id` (and any legacy
// `workspace_id`) to keep cardinality bounded (TASK-0118 P9.1-g).
const REQUIRED_DASHBOARD_LABELS = [
  "environment",
  "runner_profile_id",
  "operation_kind",
  "status",
] as const;

export function isPlatformMetricsDashboardPath(pathname: string): boolean {
  return pathname === PLATFORM_METRICS_DASHBOARD_PATH;
}

export async function handlePlatformMetricsRequest(
  request: Request,
  env: PlatformEnv,
  seamForEnv: (
    env: PlatformEnv,
  ) => PlatformDeployControlSeam = deployControlSeam,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (isPlatformMetricsDashboardPath(url.pathname)) {
    return await handlePlatformMetricsDashboardRequest(
      request,
      env,
      seamForEnv,
    );
  }
  if (!isPlatformMetricsPath(url.pathname)) return undefined;
  return await seamForEnv(env).fetch(request);
}

export async function handlePlatformMetricsDashboardRequest(
  request: Request,
  env: PlatformEnv,
  seamForEnv: (
    env: PlatformEnv,
  ) => PlatformDeployControlSeam = deployControlSeam,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD" },
    });
  }
  const url = new URL(request.url);
  const metricsRequest = new Request(
    new URL(TAKOSUMI_METRICS_PATH, url.origin),
    {
      headers: {
        accept: "text/plain",
        ...(request.headers.get("authorization")
          ? { authorization: request.headers.get("authorization") ?? "" }
          : {}),
      },
    },
  );
  const metricsResponse = await seamForEnv(env).fetch(metricsRequest);
  if (!metricsResponse.ok) return metricsResponse;
  const metricsText = await metricsResponse.text();
  const summary = summarizePrometheusMetrics(metricsText);
  return new Response(renderPlatformMetricsDashboard(summary, metricsText), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

interface PlatformMetricSummary {
  readonly generatedAt: string;
  readonly metricCount: number;
  readonly requiredMetrics: readonly {
    readonly name: string;
    readonly present: boolean;
    readonly sampleCount: number;
    readonly labels: readonly string[];
  }[];
  readonly labelSet: readonly string[];
  readonly missingRequiredMetrics: readonly string[];
  readonly missingRequiredLabels: readonly string[];
}

export function summarizePrometheusMetrics(
  text: string,
): PlatformMetricSummary {
  const byName = new Map<
    string,
    { sampleCount: number; labels: Set<string> }
  >();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+/u.exec(line);
    if (!match) continue;
    const [, name, labelsText] = match;
    const metric = byName.get(name) ?? { sampleCount: 0, labels: new Set() };
    metric.sampleCount += 1;
    for (const label of parsePrometheusLabelNames(labelsText ?? "")) {
      metric.labels.add(label);
    }
    byName.set(name, metric);
  }
  const labelSet = [
    ...new Set([...byName.values()].flatMap((metric) => [...metric.labels])),
  ].sort();
  const requiredMetrics = REQUIRED_DASHBOARD_METRICS.map((name) => {
    const metric = byName.get(name);
    return {
      name,
      present: metric !== undefined,
      sampleCount: metric?.sampleCount ?? 0,
      labels: [...(metric?.labels ?? [])].sort(),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    metricCount: byName.size,
    requiredMetrics,
    labelSet,
    missingRequiredMetrics: requiredMetrics
      .filter((metric) => !metric.present)
      .map((metric) => metric.name),
    missingRequiredLabels: REQUIRED_DASHBOARD_LABELS.filter(
      (label) => !labelSet.includes(label),
    ),
  };
}

function parsePrometheusLabelNames(labelsText: string): string[] {
  return [...labelsText.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function renderPlatformMetricsDashboard(
  summary: PlatformMetricSummary,
  metricsText: string,
): string {
  const requiredRows = summary.requiredMetrics
    .map(
      (metric) =>
        `<tr><td>${escapeHtml(metric.name)}</td><td>${metric.present ? "ok" : "missing"}</td><td>${metric.sampleCount}</td><td>${escapeHtml(metric.labels.join(", "))}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Takosumi Platform Metrics</title>
  <style>
    :root { color-scheme: dark light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 32px; background: #0f1419; color: #eef2f6; }
    main { max-width: 1120px; margin: 0 auto; }
    h1 { font-size: 28px; margin: 0 0 8px; }
    .muted { color: #9aa7b5; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 24px 0; }
    .panel { border: 1px solid #29323d; border-radius: 8px; padding: 16px; background: #151b22; }
    .value { font-size: 30px; font-weight: 700; margin-top: 8px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0 24px; }
    th, td { border-bottom: 1px solid #29323d; padding: 10px 8px; text-align: left; vertical-align: top; }
    th { color: #b8c3cf; font-size: 13px; }
    pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; border: 1px solid #29323d; border-radius: 8px; padding: 16px; background: #0b0f14; }
    @media (max-width: 720px) { body { padding: 18px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>Takosumi Platform Metrics</h1>
    <p class="muted">Live operator dashboard backed by the same protected Prometheus scrape used for production readiness evidence.</p>
    <section class="grid" id="deploy-overview-required-metrics">
      <div class="panel"><div class="muted">Metrics</div><div class="value">${summary.metricCount}</div></div>
      <div class="panel"><div class="muted">Missing Required Metrics</div><div class="value">${summary.missingRequiredMetrics.length}</div></div>
      <div class="panel"><div class="muted">Missing Required Labels</div><div class="value">${summary.missingRequiredLabels.length}</div></div>
    </section>
    <h2>Required Metrics</h2>
    <table>
      <thead><tr><th>Name</th><th>Status</th><th>Samples</th><th>Labels</th></tr></thead>
      <tbody>${requiredRows}</tbody>
    </table>
    <h2>Label Set</h2>
    <p>${escapeHtml(summary.labelSet.join(", "))}</p>
    <h2>Raw Prometheus Exposition</h2>
    <pre>${escapeHtml(metricsText)}</pre>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const WORKSPACE_ID_PATTERN = /^ws_[0-9a-zA-Z]{3,64}$/;
const INTERNAL_PLATFORM_WORKSPACE_PREFIX = "/internal/platform/workspaces/";
const INTERNAL_PLATFORM_WORKSPACE_BILLING_SUFFIX = "/billing";

export function isOperatorBillingPath(pathname: string): boolean {
  return (
    workspaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_WORKSPACE_BILLING_SUFFIX,
    ) !== undefined
  );
}

export interface OperatorBillingOperations {
  getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
    };
  }>;
}

export async function handleOperatorBillingRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  operations: OperatorBillingOperations,
): Promise<Response | undefined> {
  const billingWorkspaceId = workspaceIdFromInternalPlatformPath(
    url.pathname,
    INTERNAL_PLATFORM_WORKSPACE_BILLING_SUFFIX,
  );
  if (billingWorkspaceId !== undefined) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const auth = requireDeployControlBearer(request, env);
    if (auth) return auth;
    const result = await operations.getWorkspaceBilling(billingWorkspaceId);
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return Response.json(result, { status: 200 });
  }

  return undefined;
}

function workspaceIdFromInternalPlatformPath(
  pathname: string,
  suffix: string,
): string | undefined {
  if (!pathname.startsWith(INTERNAL_PLATFORM_WORKSPACE_PREFIX))
    return undefined;
  if (!pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(
    INTERNAL_PLATFORM_WORKSPACE_PREFIX.length,
    pathname.length - suffix.length,
  );
  if (!encoded || encoded.includes("/")) return undefined;
  const workspaceId = decodeURIComponent(encoded);
  return WORKSPACE_ID_PATTERN.test(workspaceId) ? workspaceId : undefined;
}

function requireDeployControlBearer(
  request: Request,
  env: CloudflareWorkerEnv,
): Response | undefined {
  const token =
    typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string"
      ? env.TAKOSUMI_DEPLOY_CONTROL_TOKEN
      : undefined;
  if (!token) return Response.json({ error: "not found" }, { status: 404 });
  const bearer = bearerFromAuthorization(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer || !constantTimeEqualsString(bearer, token)) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  return undefined;
}

async function readJsonRecord(
  request: Request,
): Promise<
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly response: Response }
> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return {
      ok: false,
      response: Response.json(
        { error: "invalid_request", error_description: "body must be JSON" },
        { status: 400 },
      ),
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "invalid_request",
          error_description: "body must be a JSON object",
        },
        { status: 400 },
      ),
    };
  }
  return { ok: true, value: parsed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PlatformExtensionCatalogItem {
  readonly id?: string;
  readonly basePath: `/${string}`;
  readonly matchMode?: PlatformExtensionRoute["matchMode"];
  readonly configured: boolean;
  readonly capabilities?: readonly string[];
  readonly authMode?: "platform" | "handler";
  readonly requiredScopes?: readonly string[];
  readonly selfServicePatScopes?: readonly string[];
  readonly requestScopeRules?: PlatformExtensionRoute["requestScopeRules"];
  readonly workspaceContext?: "query-required" | "query-optional";
  readonly appContext?: "query-required" | "query-optional";
  readonly contributions?: readonly PlatformExtensionContribution[];
}

export interface PlatformExtensionCatalog {
  readonly kind: "takosumi.platform-extensions@v1";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly extensions: readonly PlatformExtensionCatalogItem[];
  readonly summary: {
    readonly total: number;
    readonly configured: number;
    readonly missing: number;
  };
}

export function platformExtensionCatalog(
  env: CloudflareWorkerEnv,
  origin: string,
): PlatformExtensionCatalog {
  const extensions = platformExtensionRoutes(
    env as unknown as { readonly [key: string]: unknown },
  ).map((route) => ({
    ...(route.id ? { id: route.id } : {}),
    basePath: route.basePath,
    ...(route.matchMode ? { matchMode: route.matchMode } : {}),
    configured: platformExtensionRouteConfigured(env, route),
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
    ...(route.authMode ? { authMode: route.authMode } : {}),
    ...(route.requiredScopes ? { requiredScopes: route.requiredScopes } : {}),
    ...(route.selfServicePatScopes
      ? { selfServicePatScopes: route.selfServicePatScopes }
      : {}),
    ...(route.requestScopeRules
      ? { requestScopeRules: route.requestScopeRules }
      : {}),
    ...(route.workspaceContext
      ? { workspaceContext: route.workspaceContext }
      : {}),
    ...(route.appContext ? { appContext: route.appContext } : {}),
    ...(route.contributions ? { contributions: route.contributions } : {}),
  }));
  const configured = extensions.filter(
    (extension) => extension.configured,
  ).length;
  return {
    kind: "takosumi.platform-extensions@v1",
    generatedAt: new Date().toISOString(),
    serviceUrl: origin,
    extensions,
    summary: {
      total: extensions.length,
      configured,
      missing: extensions.length - configured,
    },
  };
}

export interface PlatformExtensionContributionCatalog {
  readonly kind: "takosumi.platform-extension-contributions@v1";
  readonly generatedAt: string;
  readonly contributions: readonly PlatformExtensionContribution[];
}

export function platformExtensionContributionCatalog(
  env: CloudflareWorkerEnv,
): PlatformExtensionContributionCatalog {
  const contributions = platformExtensionRoutes(
    env as unknown as { readonly [key: string]: unknown },
  )
    .filter((route) => platformExtensionRouteConfigured(env, route))
    .flatMap((route) => route.contributions ?? [])
    .sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        `${left.slot}:${left.id}`.localeCompare(`${right.slot}:${right.id}`),
    );
  return {
    kind: "takosumi.platform-extension-contributions@v1",
    generatedAt: new Date().toISOString(),
    contributions,
  };
}

export function handlePlatformExtensionContributionsRequest(
  request: Request,
  _url: URL,
  env: CloudflareWorkerEnv,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json",
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  return Response.json(platformExtensionContributionCatalog(env), { headers });
}

export async function handlePlatformExtensionCatalogRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = await authorizePlatformExtensionCatalogRequest(
    request,
    env,
    sessionVerifier,
  );
  if (auth) return auth;
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json",
  };
  if (request.method === "HEAD") return new Response(null, { headers });
  return Response.json(platformExtensionCatalog(env, url.origin), {
    headers,
  });
}

async function authorizePlatformExtensionCatalogRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier,
): Promise<Response | undefined> {
  const bearer = bearerFromAuthorization(
    request.headers.get("authorization") ?? "",
  );
  if (bearer) return requireDeployControlBearer(request, env);

  const session = await sessionVerifier(request, env);
  if (session.unavailable) return sharedAuthUnavailableResponse();
  if (session.authenticated) return undefined;
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}

export async function handlePlatformExtensionRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response | undefined> {
  const route = matchPlatformExtensionRoute(
    new URL(request.url).pathname,
    platformExtensionRoutes(
      env as unknown as { readonly [key: string]: unknown },
    ),
  );
  if (!route) return undefined;
  return await handlePlatformExtensionRouteRequest(
    request,
    env,
    route,
    verifyPlatformExtensionSession,
  );
}

/** Handler-owned protocol authentication assertion for handler-auth profiles. */
export async function handlePlatformExtensionRouteRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
  appAccess: PlatformExtensionAppAccess = platformExtensionSessionAppRole,
): Promise<Response> {
  const legacyWorkspace: PlatformLegacyWorkspaceObservation = {};
  const response = await handlePlatformExtensionRouteRequestObserved(
    request,
    env,
    route,
    sessionVerifier,
    workspaceAccess,
    appAccess,
    legacyWorkspace,
  );
  return observePlatformLegacyWorkspaceUse(
    request,
    env,
    response,
    legacyWorkspace,
  );
}

async function handlePlatformExtensionRouteRequestObserved(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute,
  sessionVerifier: PlatformExtensionSessionVerifier,
  workspaceAccess: PlatformExtensionWorkspaceAccess,
  appAccess: PlatformExtensionAppAccess,
  legacyWorkspace: PlatformLegacyWorkspaceObservation,
): Promise<Response> {
  const requestRoute = resolvePlatformExtensionRequestScopeRoute(request, route);
  if (!requestRoute) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  route = requestRoute;
  const authDelivery = route.authDelivery ?? "headers";
  if (authDelivery !== "headers" && authDelivery !== "context") {
    return Response.json(
      { error: "invalid extension authentication delivery" },
      { status: 400 },
    );
  }
  if (authDelivery === "context" && route.authMode === "handler") {
    return Response.json(
      {
        error: "invalid extension authentication delivery",
        error_description:
          "context delivery requires platform authentication",
      },
      { status: 400 },
    );
  }
  const handler = platformExtensionHandler(env, route.handlerKey);
  if (!handler) return Response.json({ error: "not found" }, { status: 404 });
  if (authDelivery === "context") {
    if (typeof handler.fetchAuthenticated !== "function") {
      return Response.json(
        {
          error: "authenticated context unavailable",
          error_description:
            "context delivery requires fetchAuthenticated(request, context)",
        },
        { status: 503 },
      );
    }
    const authContext = await platformExtensionAuthContext(
      request,
      env,
      route,
      sessionVerifier,
      workspaceAccess,
      "context",
      legacyWorkspace,
      appAccess,
    );
    if (!authContext.ok) return authContext.response;
    const authenticatedContext = platformExtensionAuthenticatedContext(
      authContext.session,
      authContext.workspaceRoleVerified,
      authContext.appRoleVerified,
      authContext.accountId,
    );
    if (!authenticatedContext) {
      return Response.json(
        {
          error: "authenticated context unavailable",
          error_description: "verified authentication context is incomplete",
        },
        { status: 401 },
      );
    }
    return await handler.fetchAuthenticated(
      authContext.request,
      authenticatedContext,
    );
  }
  if (typeof handler.fetch !== "function") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (
    request.method === "OPTIONS" &&
    route.authMode !== "handler" &&
    route.workspaceContext === undefined &&
    route.appContext === undefined &&
    route.requestScopeRules &&
    route.requiredScopes?.length === 0
  ) {
    // CORS preflight is explicitly represented by an empty-scope rule. Keep
    // it public at the platform seam, while still stripping all credentials
    // and trusted context before the extension sees the request.
    return await handler.fetch(platformExtensionPreflightRequest(request));
  }
  if (route.authMode === "handler") {
    const credentialFailure = await sharedAuthHandlerCredentialFailure(request, env);
    if (credentialFailure) return credentialFailure;
    return await handler.fetch(platformExtensionHandlerAuthRequest(request));
  }
  const authContext = await platformExtensionAuthContext(
    request,
    env,
    route,
    sessionVerifier,
    workspaceAccess,
    "headers",
    legacyWorkspace,
    appAccess,
  );
  if (!authContext.ok) return authContext.response;
  return await handler.fetch(authContext.request);
}

/** Local Accounts credentials never cross into a handler-owned protocol.
 * Exact persisted custody is a refusal only, including retained revoked rows;
 * an unknown external credential must still pass the owner's real verifier. */
async function sharedAuthHandlerCredentialFailure(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response | undefined> {
  if (!sharedAuthConfigured(env)) return undefined;
  const ingressFailure = sharedAuthRequestFailure(request, env);
  if (ingressFailure) return ingressFailure;
  const token = bearerValue(request.headers.get("authorization"));
  if (!token) return undefined;
  try {
    const salt = env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT;
    if (typeof salt !== "string" || salt.length === 0) {
      return sharedAuthUnavailableResponse();
    }
    const store = new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
      schemaMode: "predeployed", sessionHashSalt: salt,
    });
    // This existing port performs one bounded indexed read and never boots,
    // refreshes, touches usage, deletes credentials, or initializes schema.
    const candidates = await store.resolveAccountsBearerCandidates(token);
    if (candidates.session || candidates.accessToken || candidates.personalAccessToken) {
      return Response.json({ error: "unauthenticated" }, {
        status: 401, headers: { "cache-control": "no-store" },
      });
    }
    return undefined;
  } catch {
    return sharedAuthUnavailableResponse();
  }
}

function platformExtensionHandlerAuthRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of [
    ...PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS.filter(
      (name) => name !== "authorization",
    ),
    ...PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS,
  ]) {
    headers.delete(header);
  }
  return clonePlatformExtensionRequest(request, headers);
}

function retiredApiNotFoundResponse(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

const PLATFORM_EXTENSION_AUTHENTICATED_HEADER =
  "x-takosumi-platform-authenticated";
const PLATFORM_EXTENSION_SUBJECT_HEADER = "x-takosumi-platform-subject";
const PLATFORM_EXTENSION_AUTH_KIND_HEADER = "x-takosumi-platform-auth-kind";
const PLATFORM_EXTENSION_SCOPES_HEADER = "x-takosumi-platform-scopes";
const PLATFORM_EXTENSION_CAPSULE_ID_HEADER = "x-takosumi-platform-capsule-id";
/** The Takosumi account that authenticated (session or PAT), TASK-0118 9.1-e. */
const PLATFORM_EXTENSION_ACCOUNT_ID_HEADER = "x-takosumi-platform-account-id";
/** The live role on the `capsuleId` app context, TASK-0118 9.1-e. */
const PLATFORM_EXTENSION_APP_ROLE_HEADER = "x-takosumi-platform-app-role";
/** Compatibility only until stage 9B (Hosted selects its billing tenant). */
const PLATFORM_EXTENSION_WORKSPACE_ID_HEADER =
  "x-takosumi-platform-workspace-id";
const PLATFORM_EXTENSION_WORKSPACE_ROLE_HEADER =
  "x-takosumi-platform-workspace-role";
const PLATFORM_EXTENSION_AUDIENCE_HEADER = "x-takosumi-platform-audience";
const PLATFORM_EXTENSION_INTERFACE_ID_HEADER =
  "x-takosumi-platform-interface-id";
const PLATFORM_EXTENSION_INTERFACE_BINDING_ID_HEADER =
  "x-takosumi-platform-interface-binding-id";
const PLATFORM_EXTENSION_INTERFACE_REVISION_HEADER =
  "x-takosumi-platform-interface-resolved-revision";

const PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-auth-email",
  "x-auth-key",
  "x-auth-user-service-key",
  "x-takosumi-account-session",
] as const;

const PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS = [
  PLATFORM_EXTENSION_AUTHENTICATED_HEADER,
  PLATFORM_EXTENSION_SUBJECT_HEADER,
  PLATFORM_EXTENSION_AUTH_KIND_HEADER,
  PLATFORM_EXTENSION_SCOPES_HEADER,
  PLATFORM_EXTENSION_CAPSULE_ID_HEADER,
  PLATFORM_EXTENSION_ACCOUNT_ID_HEADER,
  PLATFORM_EXTENSION_APP_ROLE_HEADER,
  PLATFORM_EXTENSION_WORKSPACE_ID_HEADER,
  PLATFORM_EXTENSION_WORKSPACE_ROLE_HEADER,
  PLATFORM_EXTENSION_AUDIENCE_HEADER,
  PLATFORM_EXTENSION_INTERFACE_ID_HEADER,
  PLATFORM_EXTENSION_INTERFACE_BINDING_ID_HEADER,
  PLATFORM_EXTENSION_INTERFACE_REVISION_HEADER,
] as const;

function platformExtensionPreflightRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const header of [
    ...PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS,
    ...PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS,
  ]) {
    headers.delete(header);
  }
  return clonePlatformExtensionRequest(request, headers);
}

export interface PlatformExtensionSessionContext {
  readonly authenticated: boolean;
  /** Private composition markers, never accepted from headers or forwarded. */
  readonly sharedAccount?: true;
  readonly unavailable?: true;
  readonly authKind?:
    | "service-token"
    | "protocol-credential"
    | "interface-oauth-token"
    | "oauth-access-token"
    | "personal-access-token"
    | "session"
    | "run-credential";
  readonly subject?: string;
  readonly capsuleId?: string;
  /**
   * The apps a personal access token is limited to (introspected `app_ids`).
   * It travels to Core on the actor and narrows Workspace and app context on
   * extension routes; it is never forwarded to an extension.
   */
  readonly appIds?: readonly string[];
  /** Present only on a verified, short-lived Run credential. */
  readonly runId?: string;
  /** Installer provenance re-read from the canonical Capsule ledger. */
  readonly installingPrincipalId?: string;
  readonly phase?: "plan" | "apply" | "destroy";
  /** Canonical lifecycle intent re-read from the Run's Plan operation. */
  readonly lifecycleIntent?: "provision" | "destroy";
  readonly workspaceId?: string;
  /** Live Workspace role carried by token introspection or membership lookup. */
  readonly workspaceRole?: WorkspaceRole;
  /** Live role on `capsuleId`, set only by a verified `appContext`. */
  readonly appRole?: AppRole;
  readonly audience?: string;
  readonly interfaceId?: string;
  readonly interfaceBindingId?: string;
  readonly interfaceResolvedRevision?: number;
  readonly scopes?: readonly string[];
  /**
   * Registered OAuth client of an OAuth or Interface OAuth token, from
   * introspection. Telemetry only (TASK-0118 Phase 9); never forwarded.
   */
  readonly oauthClientId?: string;
}

export type PlatformExtensionSessionVerifier = (
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformExtensionRoute,
) => Promise<PlatformExtensionSessionContext>;

async function platformExtensionAuthContext(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute | undefined,
  sessionVerifier: PlatformExtensionSessionVerifier,
  workspaceAccess: PlatformExtensionWorkspaceAccess,
  delivery: "headers" | "context" = "headers",
  legacyWorkspace?: PlatformLegacyWorkspaceObservation,
  appAccess: PlatformExtensionAppAccess = platformExtensionSessionAppRole,
): Promise<
  | {
      readonly ok: true;
      readonly request: Request;
      readonly session: PlatformExtensionSessionContext;
      readonly workspaceRoleVerified: boolean;
      readonly appRoleVerified: boolean;
      readonly accountId?: string;
    }
  | { readonly ok: false; readonly response: Response }
> {
  let session = await sessionVerifier(request, env, route);
  if (session.unavailable) {
    return { ok: false, response: sharedAuthUnavailableResponse() };
  }
  if (!session.authenticated) {
    return {
      ok: false,
      response: Response.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  const sessionRoleFailure = platformExtensionSessionRoleFailure(session);
  if (sessionRoleFailure) {
    return { ok: false, response: sessionRoleFailure };
  }
  // From the credential itself, before a selected Workspace or app changes
  // the session: a restricted token never carries its account.
  const accountId = platformExtensionAccountId(session);
  let workspaceRoleVerified = false;
  const headers = new Headers(request.headers);
  for (const header of PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  for (const header of PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS) {
    headers.delete(header);
  }
  for (const header of [...headers.keys()]) {
    if (header.startsWith("x-takosumi-internal-")) headers.delete(header);
  }
  if (delivery === "context") {
    headers.delete(TAKOSUMI_INTERNAL_ACTOR_HEADER);
    for (const header of [...headers.keys()]) {
      if (header.startsWith("x-takosumi-")) {
        headers.delete(header);
      }
    }
  }
  // Descriptor-level scope enforcement applies only to token-based auth;
  // a full human session is allowed
  // through and the bound service performs any finer authorization.
  const requiredScopes = route?.requiredScopes ?? [];
  if (
    requiredScopes.length > 0 &&
    (session.authKind === "service-token" ||
      session.authKind === "interface-oauth-token" ||
      session.authKind === "oauth-access-token" ||
      session.authKind === "personal-access-token" ||
      session.authKind === "run-credential")
  ) {
    const scopes = session.scopes ?? [];
    const hasAll = requiredScopes.every(
      (scope) => scopes.includes(scope) || scopes.includes("admin"),
    );
    if (!hasAll) {
      return {
        ok: false,
        response: Response.json({ error: "unauthorized" }, { status: 401 }),
      };
    }
  }
  const csrfFailure = platformExtensionSessionCsrfFailure(
    request,
    env,
    session,
  );
  if (csrfFailure) {
    return { ok: false, response: csrfFailure };
  }
  if (route?.workspaceContext) {
    const requestedValues = new URL(request.url).searchParams.getAll(
      "workspaceId",
    );
    if (requestedValues.length > 0 && legacyWorkspace) {
      // Authenticated: a refusal from here on is still a use.
      markPlatformLegacyWorkspaceUse(legacyWorkspace, {
        surface: "platform_extension_workspace",
        route: `${route.basePath}/*`,
        selector: "query",
      }, platformLegacyWorkspaceSessionFacts(session));
    }
    if (
      requestedValues.length === 0 &&
      route.workspaceContext === "query-required"
    ) {
      return {
        ok: false,
        response: Response.json(
          {
            error: "invalid_request",
            error_description: "workspaceId query is required",
          },
          { status: 400 },
        ),
      };
    }
    if (requestedValues.length > 0) {
      const requestedWorkspaceId =
        requestedValues.length === 1
          ? safePlatformExtensionContextId(requestedValues[0])
          : undefined;
      if (!requestedWorkspaceId) {
        return {
          ok: false,
          response: Response.json(
            {
              error: "invalid_request",
              error_description:
                "workspaceId query must contain one valid Workspace id",
            },
            { status: 400 },
          ),
        };
      }
      const verified = await platformExtensionVerifiedWorkspaceSession(
        request,
        env,
        session,
        requestedWorkspaceId,
        workspaceAccess,
        request.method === "GET" || request.method === "HEAD"
          ? "read"
          : "write",
      );
      if (!verified.ok) return verified;
      session = verified.session;
      workspaceRoleVerified = true;
    }
  }
  let appRoleVerified = false;
  if (route?.appContext) {
    const requestedValues = new URL(request.url).searchParams.getAll(
      "capsuleId",
    );
    if (
      requestedValues.length === 0 &&
      route.appContext === "query-required"
    ) {
      return {
        ok: false,
        response: Response.json(
          {
            error: "invalid_request",
            error_description: "capsuleId query is required",
          },
          { status: 400 },
        ),
      };
    }
    if (requestedValues.length > 0) {
      const requestedCapsuleId =
        requestedValues.length === 1
          ? safePlatformExtensionContextId(requestedValues[0])
          : undefined;
      if (!requestedCapsuleId) {
        return {
          ok: false,
          response: Response.json(
            {
              error: "invalid_request",
              error_description:
                "capsuleId query must contain one valid app id",
            },
            { status: 400 },
          ),
        };
      }
      const verified = await platformExtensionVerifiedAppSession(
        request,
        env,
        session,
        requestedCapsuleId,
        appAccess,
      );
      if (!verified.ok) return verified;
      session = verified.session;
      appRoleVerified = verified.session.appRole !== undefined;
    }
  }
  const sessionContext = session;
  if (sessionContext.workspaceId && legacyWorkspace && route) {
    // The credential's own Workspace is forwarded to the extension (header or
    // authenticated context) even when the request names none.
    markPlatformLegacyWorkspaceUse(legacyWorkspace, {
      surface: "platform_extension_workspace",
      route: `${route.basePath}/*`,
      selector: "session",
    }, platformLegacyWorkspaceSessionFacts(sessionContext));
  }
  if (delivery === "headers") {
    headers.set(PLATFORM_EXTENSION_AUTHENTICATED_HEADER, "1");
    if (sessionContext.authKind) {
      headers.set(
        PLATFORM_EXTENSION_AUTH_KIND_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.authKind),
      );
    }
    if (sessionContext.scopes && sessionContext.scopes.length > 0) {
      headers.set(
        PLATFORM_EXTENSION_SCOPES_HEADER,
        sessionContext.scopes.map(safePlatformExtensionHeaderValue).join(" "),
      );
    }
    if (sessionContext.subject) {
      headers.set(
        PLATFORM_EXTENSION_SUBJECT_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.subject),
      );
    }
    if (sessionContext.capsuleId) {
      headers.set(
        PLATFORM_EXTENSION_CAPSULE_ID_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.capsuleId),
      );
    }
    if (accountId) {
      headers.set(
        PLATFORM_EXTENSION_ACCOUNT_ID_HEADER,
        safePlatformExtensionHeaderValue(accountId),
      );
    }
    if (appRoleVerified && sessionContext.appRole) {
      headers.set(PLATFORM_EXTENSION_APP_ROLE_HEADER, sessionContext.appRole);
    }
    if (sessionContext.workspaceId) {
      headers.set(
        PLATFORM_EXTENSION_WORKSPACE_ID_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.workspaceId),
      );
    }
    if (workspaceRoleVerified) {
      const workspaceRole = safePlatformWorkspaceRole(
        sessionContext.workspaceRole,
      );
      if (workspaceRole) {
        headers.set(PLATFORM_EXTENSION_WORKSPACE_ROLE_HEADER, workspaceRole);
      }
    }
    if (sessionContext.audience) {
      headers.set(
        PLATFORM_EXTENSION_AUDIENCE_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.audience),
      );
    }
    if (sessionContext.interfaceId) {
      headers.set(
        PLATFORM_EXTENSION_INTERFACE_ID_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.interfaceId),
      );
    }
    if (sessionContext.interfaceBindingId) {
      headers.set(
        PLATFORM_EXTENSION_INTERFACE_BINDING_ID_HEADER,
        safePlatformExtensionHeaderValue(sessionContext.interfaceBindingId),
      );
    }
    if (sessionContext.interfaceResolvedRevision !== undefined) {
      headers.set(
        PLATFORM_EXTENSION_INTERFACE_REVISION_HEADER,
        String(sessionContext.interfaceResolvedRevision),
      );
    }
  }
  return {
    ok: true,
    request: clonePlatformExtensionRequest(request, headers),
    session: sessionContext,
    workspaceRoleVerified,
    appRoleVerified,
    ...(accountId ? { accountId } : {}),
  };
}

/**
 * The Takosumi account behind an unrestricted human credential the platform
 * verified itself: a browser session (Accounts or shared account) or a
 * personal access token, whose subject is the account. A token limited to
 * apps (`appIds`) or bound to a Workspace does not act for the whole account,
 * so it carries none. OAuth subjects may be pairwise, and app, Interface, Run
 * and operator credentials act for something else, so they carry none either.
 * Call it on the session as the credential verified it, never after a
 * Workspace context was added.
 */
function platformExtensionAccountId(
  session: PlatformExtensionSessionContext,
): string | undefined {
  if (session.authKind === "session") {
    return safePlatformExtensionContextId(session.subject);
  }
  if (
    session.authKind === "personal-access-token" &&
    session.appIds === undefined &&
    session.workspaceId === undefined
  ) {
    return safePlatformExtensionContextId(session.subject);
  }
  return undefined;
}

function platformExtensionAuthenticatedContext(
  session: PlatformExtensionSessionContext,
  workspaceRoleVerified: boolean,
  appRoleVerified = false,
  accountId?: string,
): PlatformExtensionAuthenticatedContext | undefined {
  if (!session.authenticated) return undefined;
  const authKind = session.authKind;
  if (
    authKind !== "service-token" &&
    authKind !== "oauth-access-token" &&
    authKind !== "personal-access-token" &&
    authKind !== "session" &&
    authKind !== "interface-oauth-token" &&
    authKind !== "run-credential"
  ) {
    return undefined;
  }
  const subject = safePlatformExtensionSubject(session.subject);
  if (!subject) return undefined;

  const workspaceId = optionalSafePlatformExtensionId(session.workspaceId);
  if (session.workspaceId !== undefined && !workspaceId) return undefined;
  const capsuleId = optionalSafePlatformExtensionId(session.capsuleId);
  if (session.capsuleId !== undefined && !capsuleId) return undefined;
  const runId = optionalSafePlatformExtensionId(session.runId);
  if (session.runId !== undefined && !runId) return undefined;
  const installingPrincipalId = optionalSafePlatformExtensionId(
    session.installingPrincipalId,
  );
  if (
    session.installingPrincipalId !== undefined &&
    !installingPrincipalId
  ) {
    return undefined;
  }
  const phase = session.phase;
  if (
    phase !== undefined &&
    phase !== "plan" &&
    phase !== "apply" &&
    phase !== "destroy"
  ) {
    return undefined;
  }
  const lifecycleIntent = session.lifecycleIntent;
  if (
    lifecycleIntent !== undefined &&
    lifecycleIntent !== "provision" &&
    lifecycleIntent !== "destroy"
  ) {
    return undefined;
  }
  const audience = optionalSafePlatformExtensionText(session.audience, 2048);
  if (session.audience !== undefined && !audience) return undefined;
  const scopes = optionalSafePlatformExtensionScopes(session.scopes);
  if (session.scopes !== undefined && !scopes) return undefined;
  const workspaceRole =
    session.workspaceRole === undefined
      ? undefined
      : safePlatformWorkspaceRole(session.workspaceRole);
  if (session.workspaceRole !== undefined && !workspaceRole) return undefined;
  const appRole = appRoleVerified ? safePlatformAppRole(session.appRole) : undefined;
  if (appRoleVerified && !appRole) return undefined;

  return Object.freeze({
    authKind,
    subject,
    ...(accountId ? { accountId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRoleVerified && workspaceRole ? { workspaceRole } : {}),
    ...(appRole ? { appRole } : {}),
    ...(scopes ? { scopes } : {}),
    ...(capsuleId ? { capsuleId } : {}),
    ...(runId ? { runId } : {}),
    ...(installingPrincipalId ? { installingPrincipalId } : {}),
    ...(audience ? { audience } : {}),
    ...(phase ? { phase } : {}),
    ...(lifecycleIntent ? { lifecycleIntent } : {}),
  });
}

function optionalSafePlatformExtensionId(
  value: string | undefined,
): string | undefined {
  return value === undefined
    ? undefined
    : safePlatformExtensionContextId(value);
}

function optionalSafePlatformExtensionText(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed
    : undefined;
}

function optionalSafePlatformExtensionScopes(
  values: readonly string[] | undefined,
): readonly string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) return undefined;
  const normalized = values.map((value) =>
    optionalSafePlatformExtensionText(value, 256),
  );
  if (normalized.some((value) => value === undefined)) return undefined;
  const safeValues = normalized as string[];
  return safeValues.length > 0 ? Object.freeze(safeValues) : undefined;
}

type PlatformExtensionWorkspaceAccess = (
  request: Request,
  env: CloudflareWorkerEnv,
  workspaceId: string,
  session?: PlatformExtensionSessionContext,
) => Promise<boolean | WorkspaceRole | { readonly kind: "unavailable" }>;

export async function platformExtensionVerifiedWorkspaceSession(
  request: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  requestedWorkspaceId: string,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
  access: "read" | "write" = "read",
): Promise<
  | {
      readonly ok: true;
      readonly session: PlatformExtensionSessionContext;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const sessionRoleFailure = platformExtensionSessionRoleFailure(session);
  if (sessionRoleFailure) return { ok: false, response: sessionRoleFailure };

  let verifiedWorkspaceId = safePlatformExtensionContextId(session.workspaceId);
  if (verifiedWorkspaceId && requestedWorkspaceId !== verifiedWorkspaceId) {
    return platformExtensionWorkspaceAccessFailure();
  }
  let liveAccess: boolean | WorkspaceRole | { readonly kind: "unavailable" } | undefined;
  let workspaceAccessInvoked = false;
  if (!verifiedWorkspaceId || session.authKind === "session") {
    const canRequestWorkspace =
      session.authKind === "session" ||
      session.authKind === "personal-access-token";
    if (!canRequestWorkspace) {
      return platformExtensionWorkspaceAccessFailure();
    }
    workspaceAccessInvoked = true;
    liveAccess = await workspaceAccess(
      request,
      env,
      requestedWorkspaceId,
      session,
    );
    if (typeof liveAccess === "object" && liveAccess.kind === "unavailable") {
      return { ok: false, response: sharedAuthUnavailableResponse() };
    }
    if (!liveAccess) return platformExtensionWorkspaceAccessFailure();
    verifiedWorkspaceId = requestedWorkspaceId;
  }
  const workspaceRoleValue = workspaceAccessInvoked
    ? typeof liveAccess === "string"
      ? liveAccess
      : undefined
    : session.workspaceRole;
  const workspaceRole = safePlatformWorkspaceRole(workspaceRoleValue);
  if (workspaceRoleValue !== undefined && workspaceRole === undefined) {
    return platformExtensionWorkspaceAccessFailure();
  }
  if (
    access === "write" &&
    (workspaceRole === "viewer" ||
      ((session.authKind === "session" ||
        session.authKind === "personal-access-token" ||
        session.authKind === "oauth-access-token") &&
        workspaceRole === undefined))
  ) {
    return platformExtensionWorkspaceAccessFailure();
  }

  const sessionWithoutWorkspaceRole = workspaceAccessInvoked
    ? (() => {
        const { workspaceRole: _workspaceRole, ...rest } = session;
        return rest;
      })()
    : session;
  return {
    ok: true,
    session: {
      ...sessionWithoutWorkspaceRole,
      workspaceId: verifiedWorkspaceId,
      ...(workspaceRole ? { workspaceRole } : {}),
    },
  };
}

function platformExtensionWorkspaceAccessFailure(): {
  readonly ok: false;
  readonly response: Response;
} {
  return {
    ok: false,
    response: Response.json(
      {
        error: "access_denied",
        error_description: "workspace context is not authorized",
      },
      { status: 403 },
    ),
  };
}

/**
 * May this session name `workspaceId` for a compatibility Workspace context
 * (TASK-0118 P9.1-e)? This live check runs for browser sessions and personal
 * access tokens without a Workspace binding. It is decided by the account,
 * in-process, without the legacy `/api/v1/workspaces/:id` routes: only the
 * Workspace's owner may name it, and the forwarded role is `owner`. For these
 * credentials Workspace membership no longer grants this (there are no
 * non-owner members in production, and member writes are frozen). A
 * credential already bound to a Workspace (a Workspace-bound PAT or OAuth
 * token) never reaches this check: it may name only its own Workspace, with
 * the member role its introspection reports. A shared-account (Hosted)
 * session keeps the shared RP's decision until stage 9B.
 *
 * The credential gates the Accounts route applied are kept: a personal access
 * token restricted to apps never names a Workspace, and one without a core
 * `read` (or `admin`) scope cannot select one. Any failure refuses.
 */
async function platformExtensionSessionCanAccessWorkspace(
  request: Request,
  env: CloudflareWorkerEnv,
  workspaceId: string,
  session?: PlatformExtensionSessionContext,
  _context?: PlatformExecutionContext,
  operationsFor: (env: CloudflareWorkerEnv) => Promise<ControlPlaneOperations> = controlPlaneOperationsFor,
): Promise<boolean | WorkspaceRole | { readonly kind: "unavailable" }> {
  if (session?.sharedAccount) {
    const result = await resolveSharedAuthWorkspace(
      request, env, session.subject ?? "", workspaceId,
    );
    return result.kind === "authorized" ? result.role :
      result.kind === "unavailable" ? { kind: "unavailable" } : false;
  }
  const subject = safePlatformExtensionSubject(session?.subject);
  if (!session || !subject) return false;
  if (session.authKind !== "session" && session.authKind !== "personal-access-token") {
    return false;
  }
  if (session.authKind === "personal-access-token") {
    const scopes = session.scopes ?? [];
    if (session.appIds !== undefined ||
      !(scopes.includes("read") || scopes.includes("admin"))) {
      return false;
    }
  }
  try {
    const workspace = await (await operationsFor(env)).workspaces.getWorkspace(workspaceId);
    return workspace.id === workspaceId && workspace.ownerUserId === subject
      ? "owner"
      : false;
  } catch {
    return false;
  }
}

/** Test seam for the in-process Workspace decision (TASK-0118 P9.1-e). */
export async function platformExtensionAccountWorkspaceRole(
  workspaceId: string,
  session: PlatformExtensionSessionContext,
  operations: ControlPlaneOperations,
): Promise<boolean | WorkspaceRole | { readonly kind: "unavailable" }> {
  return await platformExtensionSessionCanAccessWorkspace(
    new Request("https://takosumi.invalid/"),
    {} as CloudflareWorkerEnv,
    workspaceId,
    session,
    undefined,
    async () => operations,
  );
}

/** The caller's live role on one app, or a refusal. */
export type PlatformExtensionAppAccess = (
  request: Request,
  env: CloudflareWorkerEnv,
  capsuleId: string,
  session: PlatformExtensionSessionContext,
) => Promise<AppRole | false | { readonly kind: "unavailable" }>;

/**
 * Binds an `appContext` route's `capsuleId` to the session (TASK-0118 P9.1-e).
 * A credential bound to one app (an installed app's OAuth token, an
 * Interface OAuth token, a Run credential) may name only that app and gains
 * no role. An account session or personal access token gets its live owner or
 * member role on the app; a token needs the core scope Accounts requires for
 * the method (`read` to read, `write` to change, or `admin`), and a token
 * restricted to apps must list it. Operator service tokens and unbound OAuth
 * tokens cannot name an app.
 */
export async function platformExtensionVerifiedAppSession(
  request: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  requestedCapsuleId: string,
  appAccess: PlatformExtensionAppAccess = platformExtensionSessionAppRole,
): Promise<
  | { readonly ok: true; readonly session: PlatformExtensionSessionContext }
  | { readonly ok: false; readonly response: Response }
> {
  const boundCapsuleId = safePlatformExtensionContextId(session.capsuleId);
  if (session.capsuleId !== undefined) {
    if (boundCapsuleId !== requestedCapsuleId) return platformExtensionAppAccessFailure();
    // A bound credential acts for its app, never with a person's role.
    const { appRole: _appRole, ...withoutRole } = session;
    return { ok: true, session: withoutRole };
  }
  if (session.authKind !== "session" && session.authKind !== "personal-access-token") {
    return platformExtensionAppAccessFailure();
  }
  if (session.authKind === "personal-access-token") {
    // A token gets an app role only with the core scope Accounts' own per-app
    // decision requires for this method: `read` to read, `write` to change
    // (`admin` covers both). Extension-only scopes never confer one.
    const scopes = session.scopes ?? [];
    const required = request.method === "GET" || request.method === "HEAD" ||
        request.method === "OPTIONS"
      ? "read"
      : "write";
    if (!scopes.includes(required) && !scopes.includes("admin")) {
      return platformExtensionAppAccessFailure();
    }
    if (session.appIds !== undefined && !session.appIds.includes(requestedCapsuleId)) {
      return platformExtensionAppAccessFailure();
    }
  }
  const live = await appAccess(request, env, requestedCapsuleId, session);
  if (typeof live === "object") return { ok: false, response: sharedAuthUnavailableResponse() };
  const appRole = safePlatformAppRole(live);
  if (!appRole) return platformExtensionAppAccessFailure();
  return { ok: true, session: { ...session, capsuleId: requestedCapsuleId, appRole } };
}

function platformExtensionAppAccessFailure(): {
  readonly ok: false;
  readonly response: Response;
} {
  return {
    ok: false,
    response: Response.json(
      { error: "access_denied", error_description: "app context is not authorized" },
      { status: 403 },
    ),
  };
}

function safePlatformAppRole(value: unknown): AppRole | undefined {
  return value === "owner" || value === "member" ? value : undefined;
}

/**
 * The live per-app role of an account session or personal access token, from
 * the same resolver Accounts' per-app decision uses (an app still without an
 * ownership row keeps that resolver's rollout fallback). A shared-account (Hosted) session
 * must first pass the same shared-auth app view the dashboard uses, so its
 * current-membership rule still applies. A credential still bound to a
 * Workspace (a Workspace-bound PAT, or a Workspace this request already
 * verified) reaches only apps in that Workspace: a restriction, never a grant.
 */
async function platformExtensionSessionAppRole(
  request: Request,
  env: CloudflareWorkerEnv,
  capsuleId: string,
  session: PlatformExtensionSessionContext,
  context?: PlatformExecutionContext,
  operationsFor: (env: CloudflareWorkerEnv) => Promise<ControlPlaneOperations> = controlPlaneOperationsFor,
  appPartition: PlatformInterfaceAppPartition = platformExtensionSessionAppPartition,
): Promise<AppRole | false | { readonly kind: "unavailable" }> {
  const subject = safePlatformExtensionSubject(session.subject);
  if (!subject) return false;
  if (session.sharedAccount) {
    const partition = await appPartition(request, env, capsuleId, {
      sharedAccount: true,
      ...(context ? { context } : {}),
    });
    if (!partition) return false;
  }
  let operations: ControlPlaneOperations;
  try {
    operations = await operationsFor(env);
  } catch {
    return { kind: "unavailable" };
  }
  if (!operations.appAccess) return { kind: "unavailable" };
  try {
    if (session.workspaceId !== undefined) {
      const capsule = await operations.capsules.getCapsule(capsuleId);
      if (capsule.id !== capsuleId || capsule.workspaceId !== session.workspaceId) return false;
    }
    const access = await operations.appAccess.resolveAppAccess(subject, capsuleId);
    return access?.capsuleId === capsuleId ? safePlatformAppRole(access.role) ?? false : false;
  } catch {
    return false;
  }
}

/** Test seam for the in-process app decision (TASK-0118 P9.1-e). */
export async function platformExtensionAccountAppRole(
  capsuleId: string,
  session: PlatformExtensionSessionContext,
  operations: ControlPlaneOperations,
  sharedAppView?: PlatformInterfaceAppPartition,
): Promise<AppRole | false | { readonly kind: "unavailable" }> {
  return await platformExtensionSessionAppRole(
    new Request("https://takosumi.invalid/"),
    {} as CloudflareWorkerEnv,
    capsuleId,
    session,
    undefined,
    async () => operations,
    ...(sharedAppView ? [sharedAppView] : []),
  );
}

type PlatformExtensionAccountsFetch = (
  request: Request,
  env: CloudflareWorkerEnv,
) => Promise<Response>;

export async function platformExtensionSessionCanAccessCapsule(
  request: Request,
  env: CloudflareWorkerEnv,
  capsuleId: string,
  workspaceId: string,
  accountsFetch: PlatformExtensionAccountsFetch = async (
    accountsRequest,
    accountsEnv,
  ) => await accountsWorker.fetch(accountsRequest, accountsEnv),
): Promise<boolean> {
  const headers = sessionMirrorHeaders(request);
  if (!headers) return false;
  try {
    const response = await accountsFetch(
      new Request(
        new URL(
          `/api/v1/capsules/${encodeURIComponent(capsuleId)}`,
          request.url,
        ),
        { method: "GET", headers },
      ),
      env,
    );
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    return workspaceIdFromCapsuleBody(body) === workspaceId;
  } catch {
    return false;
  }
}

function workspaceIdFromCapsuleBody(value: unknown): string | undefined {
  const body = objectRecord(value);
  for (const candidate of [objectRecord(body.capsule), body]) {
    const workspaceId = safePlatformExtensionContextId(
      valueString(candidate.workspaceId),
    );
    if (workspaceId) return workspaceId;
  }
  return undefined;
}

function clonePlatformExtensionRequest(
  request: Request,
  headers: Headers,
): Request {
  return new Request(request.url, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: request.redirect,
  });
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safePlatformExtensionContextId(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

function valueString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function verifyPlatformExtensionSession(
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformExtensionRoute,
  context?: PlatformExecutionContext,
): Promise<PlatformExtensionSessionContext> {
  const ingressFailure = sharedAuthRequestFailure(request, env);
  if (ingressFailure) return ingressFailure.status === 503
    ? { authenticated: false, unavailable: true }
    : { authenticated: false };
  const opaqueBearer = bearerValue(request.headers.get("authorization"));
  const deployControlToken =
    typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string" &&
    env.TAKOSUMI_DEPLOY_CONTROL_TOKEN.length > 0
      ? env.TAKOSUMI_DEPLOY_CONTROL_TOKEN
      : undefined;
  if (
    opaqueBearer &&
    deployControlToken &&
    constantTimeEqualsString(opaqueBearer, deployControlToken)
  ) {
    // The deploy-control bearer is the operator-owned service credential.
    // Preserve that authority kind across the extension seam without ever
    // forwarding the raw bearer to the extension handler.
    return {
      authenticated: true,
      authKind: "service-token",
      subject: "takosumi:deploy-control",
      scopes: ["admin"],
    };
  }
  const runCredentialToken = platformExtensionRunCredentialToken(request);
  if (runCredentialToken) {
    return await verifyPlatformExtensionRunCredentialToken(
      env,
      runCredentialToken,
      route,
    );
  }

  if (opaqueBearer) {
    // Existing Accounts OAuth/PAT/Principal Interface grants represent human
    // authority. This product profile accepts humans only through the RP;
    // verified operator and current Run credentials above keep their own lane.
    if (sharedAuthConfigured(env)) return { authenticated: false };
    const tokenSession = await verifyPlatformExtensionBearerToken(
      request,
      env,
      opaqueBearer,
      route,
      (request, env) => accountsWorker.fetch(request, env, context),
    );
    if (tokenSession.authenticated) return tokenSession;
  }

  const sharedIdentity = await authenticateSharedAuthRequest(request, env);
  if (sharedIdentity !== undefined) {
    return sharedIdentity.kind === "authenticated"
      ? {
          authenticated: true,
          authKind: "session",
          subject: sharedIdentity.accountId,
          sharedAccount: true,
        }
      : sharedIdentity.kind === "unavailable"
        ? { authenticated: false, unavailable: true }
        : { authenticated: false };
  }

  const headers = sessionMirrorHeaders(request);
  if (!headers) return { authenticated: false };
  try {
    const response = await accountsWorker.fetch(
      new Request(new URL("/api/v1/account/session/me", request.url), {
        method: "GET",
        headers,
      }),
      env,
      context,
    );
    if (!response.ok) return { authenticated: false };
    const body = await response.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { authenticated: false };
    }
    const subject = (body as Record<string, unknown>).subject;
    return typeof subject === "string" && subject.length > 0
      ? { authenticated: true, authKind: "session", subject }
      : { authenticated: false };
  } catch {
    return { authenticated: false };
  }
}

export async function verifyPlatformExtensionRunCredentialToken(
  env: CloudflareWorkerEnv,
  token: string,
  route?: PlatformExtensionRoute,
  ledger?: PlatformExtensionRunCredentialLedger,
  resolveConnection?: PlatformRunCredentialConnectionResolver,
): Promise<PlatformExtensionSessionContext> {
  const durableLedger =
    ledger ??
    createCloudflareD1OpenTofuControlStore(env.TAKOSUMI_CONTROL_DB, {
      schemaMode: env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE ?? "bootstrap",
    });
  const secret = runCredentialTokenSecret(env);
  const descriptor = route?.runCredential;
  if (!secret || !descriptor) return { authenticated: false };
  const verified = await verifyRunCredentialToken(token, {
    secret,
    expectedAudience: descriptor.audience,
    requiredScopes: descriptor.requiredScopes,
  });
  if (!verified.ok) return { authenticated: false };
  const payload = verified.payload;
  const scopes = [...payload.scopes];
  if (!platformExtensionScopesAllowAccess(scopes, route)) {
    return { authenticated: false };
  }
  const [canonical, currentConnection, unexpectedBlob] = await Promise.all([
    resolveCanonicalCapsuleRunCredentialContext(durableLedger, {
      workspaceId: payload.workspaceId,
      capsuleId: payload.capsuleId,
      runId: payload.runId,
      phase: payload.phase,
    }),
    (resolveConnection ??
      (ledger
        ? (id) => durableLedger.getConnection(id)
        : (id) => resolveComposedProviderConnection(env, id)))(
      payload.connectionId,
    ),
    durableLedger.getSecretBlob(payload.connectionId),
  ]);
  const canonicalLiveProvider = currentConnection
    ? canonicalProviderSource(currentConnection.provider)
    : undefined;
  const liveIssuance = currentConnection?.credentialRecipe?.runIssuance;
  if (
    !canonical.ok ||
    canonical.context.installingPrincipalId !== payload.installingPrincipalId ||
    !currentConnection ||
    canonicalLiveProvider !== payload.provider ||
    currentConnection.provider !== payload.provider ||
    currentConnection.providerSource !== canonicalLiveProvider ||
    !isWorkspaceBindableOperatorConnection(currentConnection) ||
    descriptor.audience !== liveIssuance?.audience ||
    !sameExactScopes(descriptor.requiredScopes, liveIssuance?.scopes) ||
    !sameExactScopes(scopes, liveIssuance?.scopes) ||
    scopes.includes("admin") ||
    hasLegacyManagedProviderScopeHints(currentConnection.scopeHints) ||
    unexpectedBlob !== undefined
  ) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    authKind: "run-credential",
    subject: canonical.context.installingPrincipalId,
    workspaceId: canonical.context.workspaceId,
    capsuleId: canonical.context.capsuleId,
    runId: canonical.context.runId,
    installingPrincipalId: canonical.context.installingPrincipalId,
    phase: canonical.context.phase,
    lifecycleIntent: canonical.context.lifecycleIntent,
    audience: descriptor.audience,
    scopes,
  };
}

function sameExactScopes(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((scope) => rightSet.has(scope));
}

export type PlatformExtensionRunCredentialLedger =
  CapsuleRunCredentialLedger &
    Pick<OpenTofuControlStore, "getConnection" | "getSecretBlob">;

export type PlatformRunCredentialConnectionResolver = (
  id: string,
) => Promise<ProviderConnection | undefined>;

async function resolveComposedProviderConnection(
  env: CloudflareWorkerEnv,
  id: string,
): Promise<ProviderConnection | undefined> {
  try {
    const operations = await takosumiOperationsFor(env);
    return await operations.connections.getProviderConnection(id);
  } catch {
    return undefined;
  }
}

export type PlatformExtensionIntrospectFetch = (
  request: Request,
  env: CloudflareWorkerEnv,
) => Promise<Response>;

export async function verifyPlatformExtensionBearerToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  route?: PlatformExtensionRoute,
  introspectFetch: PlatformExtensionIntrospectFetch = defaultPlatformExtensionIntrospectFetch,
): Promise<PlatformExtensionSessionContext> {
  if (sharedAuthConfigured(env)) {
    const failure = sharedAuthRequestFailure(request, env);
    return failure?.status === 503
      ? { authenticated: false, unavailable: true }
      : { authenticated: false };
  }
  return await introspectPlatformExtensionToken(
    request,
    env,
    token,
    route,
    introspectFetch,
  );
}

async function introspectPlatformExtensionToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  route: PlatformExtensionRoute | undefined,
  introspectFetch: PlatformExtensionIntrospectFetch,
): Promise<PlatformExtensionSessionContext> {
  const clientId = env.TAKOSUMI_ACCOUNTS_CLIENT_ID;
  const clientSecret = env.TAKOSUMI_ACCOUNTS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { authenticated: false };
  try {
    const response = await introspectFetch(
      new Request(new URL("/oauth/introspect", request.url), {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          token,
          client_id: clientId,
          client_secret: clientSecret,
          ...(route
            ? { resource: platformExtensionRouteBaseUrl(request, route, env) }
            : {}),
        }),
      }),
      env,
    );
    if (!response.ok) return { authenticated: false };
    const body = await response.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { authenticated: false };
    }
    const record = body as Record<string, unknown>;
    if (record.active !== true) return { authenticated: false };
    const tokenUse = record.token_use;
    if (
      tokenUse !== "oauth_access" &&
      tokenUse !== "personal_access" &&
      tokenUse !== "interface_oauth"
    ) {
      return { authenticated: false };
    }
    const scope = typeof record.scope === "string" ? record.scope : "";
    const scopes = platformExtensionScopes(scope);
    if (!platformExtensionScopesAllowAccess(scopes, route)) {
      return { authenticated: false };
    }
    const subject = safePlatformExtensionSubject(valueString(record.sub));
    if (!subject) return { authenticated: false };
    const takosumiMetadata = objectRecord(record.takosumi);
    if (
      takosumiMetadata.role !== undefined &&
      safePlatformWorkspaceRole(takosumiMetadata.role) === undefined
    ) {
      return { authenticated: false };
    }
    if (tokenUse === "interface_oauth") {
      const interfaceSession = platformExtensionInterfaceOAuthSession(
        request,
        env,
        record,
        subject,
        scopes,
        route,
      );
      return interfaceSession.authenticated
        ? { ...interfaceSession, ...platformExtensionOAuthClientId(record) }
        : interfaceSession;
    }
    const takosumi = platformExtensionTakosumiMetadata(record);
    // A personal access token restricted to apps keeps that restriction on
    // the platform seam; a malformed list refuses the token.
    const appIds = tokenUse === "personal_access" ? platformExtensionPatAppIds(record) : undefined;
    if (appIds === null) return { authenticated: false };
    return {
      authenticated: true,
      authKind:
        tokenUse === "oauth_access"
          ? "oauth-access-token"
          : "personal-access-token",
      subject,
      ...takosumi,
      ...(appIds !== undefined ? { appIds } : {}),
      scopes,
      ...(tokenUse === "oauth_access"
        ? platformExtensionOAuthClientId(record)
        : {}),
    };
  } catch {
    return { authenticated: false };
  }
}

/**
 * The apps a personal access token is limited to (introspection `app_ids`):
 * `undefined` when unlimited, `null` (refuse the token) when malformed. An
 * empty list is a deny-all snapshot and stays empty. The bound is the stored
 * PAT limit (10,000), so no valid token is refused for its length.
 */
function platformExtensionPatAppIds(
  record: Record<string, unknown>,
): readonly string[] | undefined | null {
  const raw = record.app_ids;
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 10_000) return null;
  const ids = raw.map((value) => typeof value === "string" ? safePlatformExtensionContextId(value) : undefined);
  return ids.every((id): id is string => id !== undefined) ? ids : null;
}

/** The introspected OAuth client id, only in a bounded printable shape. */
function platformExtensionOAuthClientId(
  record: Record<string, unknown>,
): { readonly oauthClientId?: string } {
  const value = valueString(record.client_id);
  return value && /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    ? { oauthClientId: value }
    : {};
}

function safePlatformExtensionSubject(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[^\u0000-\u001f\u007f]{1,512}$/u.test(trimmed) ? trimmed : undefined;
}

function platformExtensionInterfaceOAuthSession(
  request: Request,
  env: CloudflareWorkerEnv,
  record: Record<string, unknown>,
  subject: string,
  scopes: readonly string[],
  route: PlatformExtensionRoute | undefined,
): PlatformExtensionSessionContext {
  if (!route || route.authMode === "handler") return { authenticated: false };
  const expectedAudience = platformExtensionRouteBaseUrl(request, route, env);
  if (record.aud !== expectedAudience) return { authenticated: false };
  const requiredScopes = route.requiredScopes ?? [];
  if (
    scopes.length !== 1 ||
    requiredScopes.length !== 1 ||
    scopes[0] !== requiredScopes[0]
  ) {
    return { authenticated: false };
  }
  const takosumi = objectRecord(record.takosumi);
  const workspaceId = safePlatformExtensionContextId(
    valueString(takosumi.workspace_id),
  );
  const capsuleId = safePlatformExtensionContextId(
    valueString(takosumi.capsule_id),
  );
  const interfaceId = safePlatformExtensionContextId(
    valueString(takosumi.interface_id),
  );
  const interfaceBindingId = safePlatformExtensionContextId(
    valueString(takosumi.interface_binding_id),
  );
  const interfaceResolvedRevision = takosumi.interface_resolved_revision;
  // The Interface owner is evidence enough (TASK-0118 Phase 9): a Capsule for
  // a Capsule-owned Interface, the Workspace only for a Workspace-owned one.
  // A Workspace the token still carries is forwarded as compatibility
  // context; it is never required next to a Capsule.
  if (
    (takosumi.workspace_id !== undefined && !workspaceId) ||
    (takosumi.capsule_id !== undefined && !capsuleId) ||
    (!workspaceId && !capsuleId) ||
    !interfaceId ||
    !interfaceBindingId ||
    typeof interfaceResolvedRevision !== "number" ||
    !Number.isSafeInteger(interfaceResolvedRevision) ||
    interfaceResolvedRevision <= 0
  ) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    authKind: "interface-oauth-token",
    subject,
    ...(workspaceId ? { workspaceId } : {}),
    ...(capsuleId ? { capsuleId } : {}),
    audience: expectedAudience,
    interfaceId,
    interfaceBindingId,
    interfaceResolvedRevision,
    scopes,
  };
}

function platformExtensionScopesAllowAccess(
  scopes: readonly string[],
  route?: PlatformExtensionRoute,
): boolean {
  const required = route?.requiredScopes ?? [];
  if (required.length === 0) return true;
  return required.every(
    (scope) => scopes.includes(scope) || scopes.includes("admin"),
  );
}

function platformExtensionScopes(scope: string): string[] {
  return scope.split(/\s+/u).filter(Boolean);
}

function platformExtensionTakosumiMetadata(record: Record<string, unknown>): {
  readonly capsuleId?: string;
  readonly workspaceId?: string;
  readonly workspaceRole?: WorkspaceRole;
} {
  const takosumi = record.takosumi;
  if (!takosumi || typeof takosumi !== "object" || Array.isArray(takosumi)) {
    return {};
  }
  const metadata = takosumi as Record<string, unknown>;
  const capsuleId =
    typeof metadata.capsule_id === "string" && metadata.capsule_id.trim()
      ? metadata.capsule_id.trim()
      : undefined;
  const workspaceId =
    typeof metadata.workspace_id === "string" && metadata.workspace_id.trim()
      ? metadata.workspace_id.trim()
      : undefined;
  const workspaceRole = safePlatformWorkspaceRole(metadata.role);
  return {
    ...(capsuleId ? { capsuleId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(workspaceRole ? { workspaceRole } : {}),
  };
}

function safePlatformWorkspaceRole(value: unknown): WorkspaceRole | undefined {
  return value === "owner" ||
    value === "admin" ||
    value === "member" ||
    value === "viewer"
    ? value
    : undefined;
}

function platformExtensionSessionRoleFailure(
  session: PlatformExtensionSessionContext,
): Response | undefined {
  const role = (session as { readonly workspaceRole?: unknown }).workspaceRole;
  return role !== undefined && safePlatformWorkspaceRole(role) === undefined
    ? platformExtensionWorkspaceAccessFailure().response
    : undefined;
}

async function defaultPlatformExtensionIntrospectFetch(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  return await accountsWorker.fetch(request, env);
}

function platformExtensionRunCredentialToken(
  request: Request,
): string | undefined {
  const token = bearerValue(request.headers.get("authorization"));
  return token && isRunCredentialToken(token) ? token : undefined;
}

function platformExtensionRouteBaseUrl(
  request: Request,
  route: PlatformExtensionRoute,
  env?: Pick<
    CloudflareWorkerEnv,
    "LOCAL_SUBSTRATE_TEST_BED" | "TAKOSUMI_ACCOUNTS_ISSUER"
  >,
): string {
  const url = new URL(request.url);
  if (env?.LOCAL_SUBSTRATE_TEST_BED === "1" && url.protocol !== "https:") {
    try {
      const issuer = new URL(env.TAKOSUMI_ACCOUNTS_ISSUER ?? "");
      if (
        issuer.protocol === "https:" &&
        issuer.hostname === url.hostname &&
        issuer.pathname === "/" &&
        !issuer.username &&
        !issuer.password &&
        !issuer.search &&
        !issuer.hash
      ) {
        url.protocol = issuer.protocol;
        url.host = issuer.host;
      }
    } catch {
      // Invalid local issuer configuration keeps the inbound audience. Token
      // introspection then fails closed instead of trusting proxy headers.
    }
  }
  url.pathname = route.basePath;
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/u, "");
}

function bearerValue(authorization: string | null): string | undefined {
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

function sessionMirrorHeaders(request: Request): Headers | undefined {
  const headers = new Headers({ accept: "application/json" });
  const authorization = request.headers.get("authorization");
  const sessionHeader = request.headers.get("x-takosumi-account-session");
  const cookie = request.headers.get("cookie");
  if (authorization) headers.set("authorization", authorization);
  if (sessionHeader) headers.set("x-takosumi-account-session", sessionHeader);
  if (cookie) headers.set("cookie", cookie);
  return authorization || sessionHeader || cookie ? headers : undefined;
}

function safePlatformExtensionHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

interface PlatformExtensionHandler {
  fetch?(request: Request): Response | Promise<Response>;
  fetchAuthenticated?: PlatformExtensionAuthenticatedHandler["fetchAuthenticated"];
}

function platformExtensionHandler(
  env: CloudflareWorkerEnv,
  handlerKey: string,
): PlatformExtensionHandler | undefined {
  const handler = (env as Record<string, unknown>)[handlerKey];
  if (
    !handler ||
    typeof handler !== "object" ||
    (typeof (handler as { fetch?: unknown }).fetch !== "function" &&
      typeof (handler as { fetchAuthenticated?: unknown })
        .fetchAuthenticated !== "function")
  ) {
    return undefined;
  }
  return handler as PlatformExtensionHandler;
}

function platformExtensionRouteConfigured(
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute,
): boolean {
  const handler = platformExtensionHandler(env, route.handlerKey);
  if ((route.authDelivery ?? "headers") === "context") {
    return (
      route.authMode !== "handler" &&
      typeof handler?.fetchAuthenticated === "function"
    );
  }
  return typeof handler?.fetch === "function";
}

function handleHardeningGatesRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = requireDeployControlBearer(request, env);
  if (auth) return auth;
  const result = evaluateProductionHardeningGates(env);
  const status = result.enforced && !result.ok ? 503 : 200;
  if (request.method === "HEAD") return new Response(null, { status });
  return Response.json(result, { status });
}

const INTERNAL_PLATFORM_RUN_OWNER_PATH = "/internal/platform/run-owner";
const RUN_OWNER_RUN_ID_PATTERN = /^[a-z][a-z0-9_]{1,31}_[0-9a-zA-Z]{8,96}$/;

export async function handlePlatformRunOwnerRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  deps: {
    readonly operations?: Pick<ControlPlaneOperations, "getRun">;
    readonly now?: () => number;
  } = {},
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = requireDeployControlBearer(request, env);
  if (auth) return auth;
  const namespace = env.RUN_OWNER;
  if (!namespace) {
    return Response.json(
      { error: "RUN_OWNER binding is not configured" },
      { status: 503 },
    );
  }
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  if (!RUN_OWNER_RUN_ID_PATTERN.test(runId)) {
    return Response.json({ error: "invalid runId" }, { status: 400 });
  }
  if (request.method === "GET") {
    const owner = await fetchPlatformRunOwnerJson(namespace, runId, "debug", {
      method: "GET",
    });
    return Response.json(
      {
        runId,
        operation: "debug",
        owner: owner.body,
      },
      { status: owner.response.ok ? 200 : 502 },
    );
  }
  let run: Run;
  try {
    const operations =
      deps.operations ?? (await controlPlaneOperationsFor(env));
    run = await operations.getRun(runId);
  } catch (error) {
    if (error instanceof OpenTofuControllerError) {
      return Response.json(
        { error: error.code, message: error.message },
        { status: DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE[error.code] },
      );
    }
    throw error;
  }
  const action = repairActionForRunType(run.type);
  if (!action) {
    return Response.json(
      {
        error: "unsupported run type",
        runId,
        runType: run.type,
      },
      { status: 409 },
    );
  }
  const workspaceId = run.workspaceId;
  if (!workspaceId) {
    return Response.json(
      {
        error: "run is missing workspace",
        runId,
      },
      { status: 409 },
    );
  }
  const now = deps.now?.() ?? Date.now();
  const start = await fetchPlatformRunOwnerJson(namespace, runId, "start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "takosumi.opentofu-run-owner.start@v1",
      action,
      runId,
      workspaceId,
      cause: "controller_retry",
      queueAttempt: 1,
      messageId: `operator-repair:${runId}:${now.toString(36)}`,
    }),
  });
  if (!start.response.ok) {
    return Response.json(
      {
        runId,
        operation: "reschedule",
        run: {
          type: run.type,
          status: run.status,
          workspaceId,
        },
        owner: start.body,
      },
      { status: 502 },
    );
  }
  const drain = await fetchPlatformRunOwnerJson(namespace, runId, "drain", {
    method: "POST",
  });
  return Response.json(
    {
      runId,
      operation: "reschedule_drain",
      run: {
        type: run.type,
        status: run.status,
        workspaceId,
      },
      start: start.body,
      drain: drain.body,
    },
    { status: drain.response.ok ? 200 : 502 },
  );
}

async function fetchPlatformRunOwnerJson(
  namespace: NonNullable<DeployControlEnv["RUN_OWNER"]>,
  runId: string,
  path: "debug" | "drain" | "start",
  init: RequestInit,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await namespace.get(namespace.idFromName(runId)).fetch(
    new Request(`https://opentofu-run-owner/${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...Object.fromEntries(new Headers(init.headers).entries()),
      },
    }),
  );
  const text = await response.text();
  try {
    return { response, body: text ? JSON.parse(text) : null };
  } catch {
    return {
      response,
      body: { textClass: text ? "non-json" : "empty" },
    };
  }
}

const SOURCE_ID_PATTERN = /^src_[0-9a-zA-Z]{8,64}$/;

/**
 * Subset of the deploy-control operations facade the source webhook / scheduler
 * need. Kept narrow so the seam-level handlers are unit-testable with a stub.
 */
export interface SourceWebhookOperations {
  getSource(sourceId: string): Promise<unknown>;
  verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean>;
  createSourceReconciliationSyncs(
    sourceId: string,
    options?: { readonly scheduled?: boolean },
  ): Promise<readonly { readonly run: { readonly id: string } }[]>;
}

export interface SourcePollOperations extends SourceWebhookOperations {
  readonly controller: {
    listAutoSyncSourcesDue(
      limit: number,
    ): Promise<readonly { readonly id: string }[]>;
  };
}

export interface OpenTofuRunRepairOperations {
  readonly workspaces: {
    listWorkspacesByIds(
      workspaceIds: readonly string[],
    ): Promise<
      readonly { readonly id: string; readonly archivedAt?: string }[]
    >;
  };
  readonly controller: {
    listRecoverableOpenTofuRuns(options: {
      readonly staleQueuedBeforeMs: number;
      readonly staleRunningBeforeMs: number;
      readonly limit?: number;
      readonly sweep?: true;
    }): Promise<readonly Run[]>;
    hasPendingRunnerUsage(input: {
      readonly runId: string;
      readonly workspaceId: string;
    }): Promise<boolean>;
    listPendingRuntimeSecretRetirementRuns(options: {
      readonly staleBeforeMs: number;
      readonly limit?: number;
    }): Promise<readonly Run[]>;
    claimPendingRuntimeSecretRetirementDispatch(input: {
      readonly runId: string;
      readonly staleBeforeMs: number;
      readonly attemptedAt: number;
    }): Promise<boolean>;
  };
}

type RepairRunAction = "plan" | "apply" | "source_sync" | "restore";

/**
 * The deploy-control facade members the per-app sweep reads. Every read is per
 * app; nothing here lists Workspaces.
 */
export interface ScheduledCapsuleSweepOperations {
  readonly appOwnership?: Pick<import("../../core/domains/app-ownership/store.ts").AppOwnershipStore, "getOwnership">;
  readonly controller: {
    listCapsulesForScheduledSweep(limit: number): Promise<readonly Capsule[]>;
  };
  listCapsuleRunsPage(
    capsuleId: string,
    options: {
      readonly workspaceId: string;
      readonly limit?: number;
      readonly types?: readonly RunType[];
    },
  ): Promise<{ readonly runs: readonly Run[] }>;
  createCapsulePlan(
    capsuleId: string,
    options: {
      readonly actor: string;
      readonly actorOwnershipEpoch?: number;
      readonly origin: { readonly kind: "update" };
    },
  ): Promise<unknown>;
  createCapsuleDriftCheck(
    capsuleId: string,
    options: { readonly actor: string; readonly actorOwnershipEpoch?: number },
  ): Promise<unknown>;
  readonly activity?: Pick<ActivityRecorder, "record">;
}

export interface OpenTofuRunRepairScheduler {
  schedule(dispatch: {
    readonly action: RepairRunAction;
    readonly runId: string;
    readonly workspaceId: string;
  }): Promise<void>;
}

async function handleSourceWebhook(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  const operations = await deployControlSeam(env).operations();
  return await handleSourceWebhookRequest(request, url, operations);
}

/**
 * Per-source webhook seam (`POST /hooks/sources/:sourceId`). The bearer is the
 * per-source hook secret (compared against the stored hash by the source
 * service). The payload body is IGNORED (untrusted); a valid bearer triggers
 * deduped source_sync runs for the Source default plus applied Capsule lanes.
 */
export async function handleSourceWebhookRequest(
  request: Request,
  url: URL,
  operations: SourceWebhookOperations,
): Promise<Response> {
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const sourceId = decodeURIComponent(
    url.pathname.slice("/hooks/sources/".length),
  );
  if (!SOURCE_ID_PATTERN.test(sourceId)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const bearer = bearerFromAuthorization(
    request.headers.get("authorization") ?? "",
  );
  if (!bearer) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  let valid = false;
  try {
    valid = await operations.verifySourceHookSecret(sourceId, bearer);
  } catch {
    valid = false;
  }
  if (!valid) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  // Payload is untrusted and ignored; addresses come only from durable Source
  // defaults and current Capsule StateVersion provenance.
  let runs: Awaited<ReturnType<SourceWebhookOperations["createSourceReconciliationSyncs"]>>;
  try {
    runs = await operations.createSourceReconciliationSyncs(sourceId);
  } catch (error) {
    // A valid delivery can race retirement marking. Acknowledge that no-op so
    // the Git host does not retry a Source whose sync admission is closed.
    if (!(error instanceof OpenTofuControllerError) ||
      error.code !== "failed_precondition" || structuredErrorReason(error) !== "source_not_active") throw error;
    runs = [];
  }
  return Response.json(
    {
      accepted: true,
      runId: runs[0]?.run.id,
      runIds: runs.map(({ run }) => run.id),
    },
    { status: 202 },
  );
}

function bearerFromAuthorization(header: string): string | undefined {
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

// Capped batch so a single cron tick never enqueues an unbounded number of runs.
// Start conservatively while previously unpolled Sources enter the cadence.
const DEFAULT_SCHEDULED_SOURCE_POLL_BATCH = 5;
export function scheduledSourcePollBatch(env: DeployControlEnv): number {
  return positiveInteger(
    Number(env.TAKOSUMI_SCHEDULED_SOURCE_POLL_BATCH),
    DEFAULT_SCHEDULED_SOURCE_POLL_BATCH,
  );
}

async function runScheduledSourcePoll(env: DeployControlEnv): Promise<void> {
  const operations = await deployControlSeam(env).operations();
  await pollAutoSyncSources(operations, scheduledSourcePollBatch(env));
}

/**
 * Scheduled source polling seam. Scans active sources whose autoSync flag is set
 * and enqueues deduped source_sync runs for the shared default address plus
 * each distinct ref/path lane adopted by a current Capsule StateVersion. The
 * runner resolves each ref with git ls-remote and reuses an unchanged immutable
 * archive. Best-effort and capped by Source; each Source's lane set is bounded
 * by its Capsule count.
 */
export async function pollAutoSyncSources(
  operations: SourcePollOperations,
  batch: number,
): Promise<void> {
  const sources = await operations.controller.listAutoSyncSourcesDue(batch);
  for (const source of sources) {
    try {
      await operations.createSourceReconciliationSyncs(source.id, { scheduled: true });
    } catch {
      // Best-effort: one bad source must not abort the whole poll.
      console.warn("scheduled.source_poll_reconciliation_failed", {
        sourceCount: sources.length,
      });
    }
  }
}

const SCHEDULED_SOURCE_RETIREMENT_LIMIT = 25;

async function runScheduledSourceRetirement(env: DeployControlEnv): Promise<void> {
  try {
    const result = await (await deployControlSeam(env).operations())
      .sweepRetiredSources({ limit: SCHEDULED_SOURCE_RETIREMENT_LIMIT });
    console.log(JSON.stringify({ event: "source_retirement_sweep", ...result }));
  } catch (error) {
    console.warn(JSON.stringify({
      event: "source_retirement_sweep_failed",
      errorName: error instanceof Error ? error.name : "unknown",
    }));
  }
}

/**
 * Operator/Cloud opt-in: turn stale Capsules into reviewable update plans.
 *
 * Core source sync only marks Capsules `stale`; it never silently applies. The
 * per-app sweep is an operator policy layer that creates at most one pending
 * plan per stale Capsule, then leaves normal Run approval/apply semantics in
 * charge.
 */
export function autoPlanStaleCapsulesEnabled(
  env: CloudflareWorkerEnv,
): boolean {
  const flag = env.TAKOSUMI_AUTO_PLAN_STALE_CAPSULES;
  return typeof flag === "string" && flag === "1";
}

async function runScheduledCapsuleSweep(
  env: CloudflareWorkerEnv & DeployControlEnv,
): Promise<void> {
  const autoPlanStale = autoPlanStaleCapsulesEnabled(env);
  const driftCheck = driftCheckEnabled(env);
  if (!autoPlanStale && !driftCheck) return;
  const operations = await deployControlSeam(env).operations();
  await runCapsuleSweep(operations, { autoPlanStale, driftCheck });
}

/**
 * One per-app sweep tick over the deploy-control facade (TASK-0118 9.1). Each
 * live Capsule is handled on its own: a stale one may get an update Plan, an
 * active one a drift check. Its open plans are read per app, never per
 * Workspace, and no RunGroup is created.
 */
export async function runCapsuleSweep(
  operations: ScheduledCapsuleSweepOperations,
  options: {
    readonly autoPlanStale: boolean;
    readonly driftCheck: boolean;
    readonly limit?: number;
  },
): Promise<CapsuleSweepResult> {
  const appOwnership = operations.appOwnership;
  const sweepOperations: CapsuleSweepOperations = {
    listCapsulesForScheduledSweep: (limit) =>
      operations.controller.listCapsulesForScheduledSweep(limit),
    ...(appOwnership
      ? { getOwnership: (capsuleId: string) => appOwnership.getOwnership(capsuleId) }
      : {}),
    listCapsuleRuns: async (capsule, { types, limit }) =>
      (await operations.listCapsuleRunsPage(capsule.id, {
        // The store matches the app's own Workspace column with its id; the
        // read never widens past this one app.
        workspaceId: capsule.workspaceId,
        limit,
        types,
      })).runs,
    createCapsulePlan: (capsuleId, planOptions) =>
      operations.createCapsulePlan(capsuleId, planOptions),
    createCapsuleDriftCheck: (capsuleId, driftOptions) =>
      operations.createCapsuleDriftCheck(capsuleId, driftOptions),
    recordStaleAutoPlan: async (capsule) => {
      // The Workspace id only fills the Activity row's column (kept until 9.6).
      await operations.activity?.record({
        workspaceId: capsule.workspaceId,
        actorId: "system:stale-auto-plan",
        action: "capsule.stale_auto_plan_created",
        targetType: "capsule",
        targetId: capsule.id,
        metadata: {},
      });
    },
  };
  return await sweepCapsules(sweepOperations, options);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

const SCHEDULED_RUN_REPAIR_WORKSPACE_LIMIT = 100;
const SCHEDULED_RUN_REPAIR_RUNS_PER_WORKSPACE = 50;
const SCHEDULED_RUN_REPAIR_QUEUED_STALE_MS = 2 * 60 * 1000;
const SCHEDULED_RUN_REPAIR_WORKSPACE_LOOKUP_CHUNK_SIZE = 90;

export interface OpenTofuRunRepairResult {
  readonly workspacesScanned: number;
  readonly runsScanned: number;
  readonly rescheduled: number;
  readonly ordinaryFailures: number;
  readonly retirementFailures: number;
}

async function runScheduledOpenTofuRunRepair(
  env: DeployControlEnv,
): Promise<void> {
  if (!env.RUN_OWNER) return;
  const operations = await deployControlSeam(env).operations();
  const result = await repairStaleOpenTofuRuns(
    operations,
    {
      schedule: (dispatch) => scheduleRunOwnerRepair(env, dispatch),
    },
    {
      now: Date.now(),
      workspaceLimit: SCHEDULED_RUN_REPAIR_WORKSPACE_LIMIT,
      runsPerWorkspace: SCHEDULED_RUN_REPAIR_RUNS_PER_WORKSPACE,
    },
  );
  const failures = result.ordinaryFailures + result.retirementFailures;
  if (failures > 0) {
    console.warn("scheduled.run_repair_failures", {
      ordinaryFailures: result.ordinaryFailures,
      retirementFailures: result.retirementFailures,
    });
  }
  const service = await cachedDeployControlService(env);
  for (const [outcome, value] of [
    ["rescheduled", result.rescheduled],
    ["ordinary_failure", result.ordinaryFailures],
    ["retirement_failure", result.retirementFailures],
  ] as const) {
    try {
      await recordWorkerMetric({
        observability: service.context.adapters.observability,
        env,
        name: "takosumi_run_repair_total",
        kind: "counter",
        value,
        tags: { outcome },
      });
    } catch {
      // Repair visibility must never change the sweep result or cron behavior.
    }
  }
}

/**
 * Scheduled run repair safety net. Creation already schedules the per-run owner
 * directly for speed; this bounded sweep re-pokes old non-terminal rows whose
 * owner alarm/record was lost, terminal provider-applied rows with a durable
 * pending billing-finalization marker, and failed destroys with pending runner
 * usage even after their Workspace is frozen. The controller consumers stay
 * idempotent and own all state changes.
 */
export async function repairStaleOpenTofuRuns(
  operations: OpenTofuRunRepairOperations,
  scheduler: OpenTofuRunRepairScheduler,
  options: {
    readonly now?: number;
    readonly workspaceLimit?: number;
    readonly runsPerWorkspace?: number;
    readonly queuedStaleMs?: number;
    readonly runningStaleMs?: number;
  } = {},
): Promise<OpenTofuRunRepairResult> {
  const now = options.now ?? Date.now();
  const workspaceLimit =
    options.workspaceLimit ?? SCHEDULED_RUN_REPAIR_WORKSPACE_LIMIT;
  const runsPerWorkspace =
    options.runsPerWorkspace ?? SCHEDULED_RUN_REPAIR_RUNS_PER_WORKSPACE;
  const queuedStaleMs =
    options.queuedStaleMs ?? SCHEDULED_RUN_REPAIR_QUEUED_STALE_MS;
  const runningStaleMs = options.runningStaleMs ?? RUN_HEARTBEAT_STALE_MS;
  let workspacesScanned = 0;
  let runsScanned = 0;
  let rescheduled = 0;
  let ordinaryFailures = 0;
  let retirementFailures = 0;
  const scheduledRunIds = new Set<string>();
  try {
    const runLimit = Math.max(
      0,
      Math.floor(runsPerWorkspace) *
        Math.max(1, Math.max(0, Math.floor(workspaceLimit))),
    );
    const runs = await operations.controller.listRecoverableOpenTofuRuns({
      staleQueuedBeforeMs: now - queuedStaleMs,
      staleRunningBeforeMs: now - runningStaleMs,
      limit: runLimit,
      sweep: true,
    });
    runsScanned = runs.length;
    const requiredWorkspaceIds = [
      ...new Set(
        runs.flatMap((run) =>
          typeof run.workspaceId === "string" ? [run.workspaceId] : [],
        ),
      ),
    ];
    const knownWorkspaceIds = new Set<string>();
    const activeWorkspaceIds = new Set<string>();
    for (
      let offset = 0;
      offset < requiredWorkspaceIds.length;
      offset += SCHEDULED_RUN_REPAIR_WORKSPACE_LOOKUP_CHUNK_SIZE
    ) {
      const workspaceIds = requiredWorkspaceIds.slice(
        offset,
        offset + SCHEDULED_RUN_REPAIR_WORKSPACE_LOOKUP_CHUNK_SIZE,
      );
      const requestedIds = new Set(workspaceIds);
      const workspaces =
        await operations.workspaces.listWorkspacesByIds(workspaceIds);
      for (const workspace of workspaces) {
        if (!requestedIds.has(workspace.id)) continue;
        knownWorkspaceIds.add(workspace.id);
        if (!workspace.archivedAt) activeWorkspaceIds.add(workspace.id);
      }
    }
    workspacesScanned = activeWorkspaceIds.size;
    for (const run of runs) {
      const workspaceId = run.workspaceId;
      if (!workspaceId) continue;
      const activeWorkspace = activeWorkspaceIds.has(workspaceId);
      if (!activeWorkspace) {
        if (
          !knownWorkspaceIds.has(workspaceId) ||
          run.type !== "destroy_apply" ||
          run.status !== "failed"
        ) continue;
        try {
          if (!await operations.controller.hasPendingRunnerUsage({
            runId: run.id,
            workspaceId,
          })) continue;
        } catch {
          ordinaryFailures += 1;
          continue;
        }
      }
      const dispatch = recoverableRunDispatch(run, now, {
        queuedStaleMs,
        runningStaleMs,
        fallbackWorkspaceId: workspaceId,
      });
      if (!dispatch) continue;
      try {
        await scheduler.schedule(dispatch);
        scheduledRunIds.add(run.id);
        rescheduled += 1;
      } catch {
        ordinaryFailures += 1;
      }
    }
  } catch {
    ordinaryFailures += 1;
  }

  try {
    // Terminal retirement intents are a Takosumi-owned outbox, not ordinary
    // Workspace execution. Scan them independently of the active Workspace
    // prefix so archived Workspaces and ids beyond the first catalog page still
    // retire sealed Capsule material. Failed attempts update their durable Run
    // timestamp, making this bounded oldest-attempt-first scan fair over time.
    const retirementStaleBeforeMs = now - queuedStaleMs;
    const retirementRuns =
      await operations.controller.listPendingRuntimeSecretRetirementRuns({
        staleBeforeMs: retirementStaleBeforeMs,
        limit: Math.max(1, Math.floor(runsPerWorkspace)),
      });
    runsScanned += retirementRuns.length;
    for (const run of retirementRuns) {
      if (scheduledRunIds.has(run.id)) continue;
      const workspaceId = run.workspaceId;
      if (!workspaceId) continue;
      const dispatch = recoverableRunDispatch(run, now, {
        queuedStaleMs,
        runningStaleMs,
        fallbackWorkspaceId: workspaceId,
      });
      if (!dispatch || dispatch.action !== "apply") continue;
      try {
        const claimed =
          await operations.controller
            .claimPendingRuntimeSecretRetirementDispatch({
              runId: run.id,
              staleBeforeMs: retirementStaleBeforeMs,
              attemptedAt: now,
            });
        if (!claimed) continue;
        await scheduler.schedule(dispatch);
        scheduledRunIds.add(run.id);
        rescheduled += 1;
      } catch {
        retirementFailures += 1;
      }
    }
  } catch {
    retirementFailures += 1;
  }
  return {
    workspacesScanned,
    runsScanned,
    rescheduled,
    ordinaryFailures,
    retirementFailures,
  };
}

function recoverableRunDispatch(
  run: Pick<
    Run,
    | "id"
    | "type"
    | "status"
    | "workspaceId"
    | "createdAt"
    | "startedAt"
    | "heartbeatAt"
    | "finishedAt"
  >,
  now: number,
  options: {
    readonly queuedStaleMs: number;
    readonly runningStaleMs: number;
    readonly fallbackWorkspaceId: string;
  },
):
  | {
      readonly action: RepairRunAction;
      readonly runId: string;
      readonly workspaceId: string;
    }
  | undefined {
  const action = repairActionForRunType(run.type);
  if (!action) return undefined;
  const billingFinalizationRepair =
    action === "apply" &&
    (run.status === "succeeded" || run.status === "failed");
  if (!isRecoverableRunStatus(run.status) && !billingFinalizationRepair) {
    return undefined;
  }
  const ageMs =
    run.status === "queued"
      ? runAgeMs(now, run.createdAt)
      : run.status === "running"
        ? runAgeMs(
            now,
            run.heartbeatAt ?? runTimestampMs(run.startedAt) ?? run.createdAt,
          )
        : runAgeMs(now, run.finishedAt ?? run.createdAt);
  const staleMs =
    run.status === "running" ? options.runningStaleMs : options.queuedStaleMs;
  if (!Number.isFinite(ageMs) || ageMs < staleMs) return undefined;
  return {
    action,
    runId: run.id,
    workspaceId: run.workspaceId ?? options.fallbackWorkspaceId,
  };
}

function isRecoverableRunStatus(
  status: RunStatus,
): status is "queued" | "running" {
  return status === "queued" || status === "running";
}

function repairActionForRunType(type: RunType): RepairRunAction | undefined {
  if (type === "plan" || type === "destroy_plan" || type === "drift_check") {
    return "plan";
  }
  if (type === "apply" || type === "destroy_apply") return "apply";
  if (type === "source_sync") return "source_sync";
  if (type === "restore") return "restore";
  return undefined;
}

async function scheduleRunOwnerRepair(
  env: DeployControlEnv,
  dispatch: {
    readonly action: RepairRunAction;
    readonly runId: string;
    readonly workspaceId: string;
  },
): Promise<void> {
  const namespace = env.RUN_OWNER;
  if (!namespace) return;
  const response = await namespace
    .get(namespace.idFromName(dispatch.runId))
    .fetch(
      new Request("https://opentofu-run-owner/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run-owner.start@v1",
          action: dispatch.action,
          runId: dispatch.runId,
          workspaceId: dispatch.workspaceId,
          cause: "controller_retry",
          queueAttempt: 1,
          messageId: `scheduled-repair:${dispatch.runId}:${Date.now().toString(36)}`,
        }),
      }),
    );
  if (!response.ok) {
    throw new Error("opentofu run owner repair scheduling failed");
  }
}

function runAgeMs(now: number, value: string | number | undefined): number {
  const at = runTimestampMs(value);
  return at === undefined ? Number.NaN : now - at;
}

function runTimestampMs(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Drift-check flag (spec §28; Phase 8). The per-app sweep drift-checks active
 * Capsules ONLY when `TAKOSUMI_DRIFT_CHECK_ENABLED=1` (default OFF), mirroring
 * how the platform keeps the sweep opt-in alongside the always-on source poll.
 */
export function driftCheckEnabled(env: CloudflareWorkerEnv): boolean {
  const flag = env.TAKOSUMI_DRIFT_CHECK_ENABLED;
  return typeof flag === "string" && flag === "1";
}
