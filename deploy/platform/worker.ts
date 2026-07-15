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
  createCloudflareWorker,
} from "../accounts-cloudflare/src/handler.ts";
import { type ControlPlaneOperations } from "@takosjp/takosumi-accounts-service";
import {
  type CloudflareWorkerEnv as DeployControlEnv,
  createDeployControlQueueConsumer,
  createInProcessDeployControlSeam,
  type QueueBatch,
  CoordinationObject,
  OpenTofuRunOwnerObject,
  OpenTofuRunnerObject,
} from "../../worker/src/handler.ts";
import { cachedDeployControlService } from "../../worker/src/deploy_control_seam.ts";
import { recordWorkerMetric } from "../../worker/src/metrics.ts";
import {
  driftSweep,
  type DriftSweepOperations,
} from "../../worker/src/scheduled/drift.ts";
import {
  RESOURCE_OBSERVATION_DEFAULT_CONCURRENCY,
  RESOURCE_OBSERVATION_DEFAULT_INTERVAL_MS,
  RESOURCE_OBSERVATION_DEFAULT_LEASE_MS,
  RESOURCE_OBSERVATION_DEFAULT_LIMIT,
  resourceObservationSweep,
  type ResourceObservationSweepOptions,
} from "../../worker/src/scheduled/resource_observation.ts";
import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import {
  CompatibilityRouteControlService,
  type CompatibilityRouteRecord,
  type CompatibilityRouteRetireResult,
} from "../../core/domains/interfaces/compatibility_route_control.ts";
import { TAKOSUMI_METRICS_PATH } from "../../core/api/metrics_routes.ts";
import { TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER } from "../../core/api/resource_routes.ts";
import { DEPLOY_CONTROL_ERROR_HTTP_STATUS_BY_CODE } from "@takosumi/internal/deploy-control-api";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
} from "takosumi-contract/capabilities";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "takosumi-contract/api-surface";
import type {
  ActorContext,
  Interface,
  NativeResourceRef,
  ResourceObject,
  ResourceShapeKind,
} from "takosumi-contract";
import { isResourceShapeKind } from "takosumi-contract";
import type {
  ManagedPublicHostnameClaimRequest,
  ManagedPublicHostnameClaimResult,
} from "takosumi-contract/install-configs";
import {
  encodeActorContext,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
} from "takosumi-contract/internal/rpc";
import type { BillingSettings } from "takosumi-contract/billing";
import {
  isManagedProviderRunToken,
  managedProviderRunTokenSecret,
  verifyManagedProviderRunToken,
} from "../../core/shared/managed_provider_tokens.ts";
import type { TakosumiOperations } from "../../core/bootstrap.ts";
import {
  OpenTofuControllerError,
  RUN_HEARTBEAT_STALE_MS,
} from "../../core/domains/deploy-control/mod.ts";
import {
  isPlatformExtensionCatalogPath,
  isPlatformExtensionContributionsPath,
  matchPlatformExtensionRoute,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
  platformExtensionRoutes,
  type PlatformCompatibilityProfile,
  type PlatformExtensionRoute,
  type PlatformExtensionContribution,
} from "./platform_extensions.ts";
import {
  TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  type CreateTakosumiDiscoveryOptions,
  type TakosumiAdapterCapabilities,
  type TakosumiCompatibilityProfileCapabilities,
  type TakosumiOperatorCapabilities,
  type TakosumiResourceCapabilities,
} from "takosumi-contract/capabilities";
import type { Capsule } from "takosumi-contract/capsules";
import type { Run, RunStatus, RunType } from "takosumi-contract/runs";
import {
  configuredResourceShapeKinds,
  resourceShapeHostContributionsFromEnv,
} from "../../worker/src/resource_shape_composition.ts";
import { evaluateProductionHardeningGates } from "./production_hardening.ts";
export {
  isPlatformExtensionCatalogPath,
  isPlatformExtensionContributionsPath,
  matchPlatformExtensionRoute,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
  platformExtensionRoutes,
} from "./platform_extensions.ts";
export {
  evaluateProductionHardeningGates,
  OSS_PLATFORM_HARDENING_CONTRIBUTION,
  platformHardeningContributions,
  TAKOSUMI_PRODUCTION_HARDENING_GATE_RESULT_KIND,
  type ProductionHardeningCheck,
  type ProductionHardeningContributionResult,
  type ProductionHardeningGateResult,
} from "./production_hardening.ts";

export { CoordinationObject, OpenTofuRunOwnerObject, OpenTofuRunnerObject };

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
  DeployControlEnv;
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

/**
 * Composition-root bridge used by hosted operator extensions. It keeps
 * managed-hostname ownership in the OSS controller without exposing an
 * internal HTTP route or allowing an extension to reach into core modules.
 */
export async function claimPlatformManagedPublicHostname(
  input: ManagedPublicHostnameClaimRequest,
  env: object,
): Promise<ManagedPublicHostnameClaimResult> {
  return await (
    await takosumiOperationsFor(env as PlatformEnv)
  ).claimManagedPublicHostname(input);
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

const accountsWorker = createCloudflareWorker<CloudflareWorkerEnv>({
  // The session-authed `/api/v1/*` dashboard surface reads the canonical
  // in-process operations facade adapted to the `ControlPlaneOperations`
  // shape (see `controlPlaneOperationsFor`).
  controlPlaneOperations: (env) => controlPlaneOperationsFor(env),
});

// The platform worker owns the public fetch surface (accounts handler) AND runs
// the OpenTofu run-queue consumer in-process. The consumer reaches the same
// deploy-control operations facade as the accounts surface, so a run dispatched
// by the create path is executed here against the same store.
const runQueueConsumer = createDeployControlQueueConsumer();

export default {
  async fetch(
    request: Request,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<Response> {
    const metricsResponse = await handlePlatformMetricsRequest(request, env);
    if (metricsResponse) return metricsResponse;
    const url = new URL(request.url);
    if (url.pathname === TAKOSUMI_WELL_KNOWN_PATH) {
      return Response.json(
        createTakosumiWellKnownDocument(
          platformDiscoveryOptions(url.origin, env),
        ),
      );
    }
    if (url.pathname === TAKOSUMI_PRODUCT_CAPABILITIES_PATH) {
      return Response.json(
        createTakosumiProductCapabilities(
          platformDiscoveryOptions(url.origin, env),
        ),
      );
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
    if (isPlatformExtensionCatalogPath(url.pathname)) {
      return await handlePlatformExtensionCatalogRequest(request, url, env);
    }
    if (isPlatformExtensionContributionsPath(url.pathname)) {
      return handlePlatformExtensionContributionsRequest(request, url, env);
    }
    // Core lifecycle and identity prefixes always win over extension routing.
    // Descriptor validation rejects overlaps too; keeping the dispatch order
    // explicit prevents a future parser regression from shadowing authority.
    if (isPlatformResourceShapeApiPath(url.pathname)) {
      return await handlePlatformResourceShapeApiRequest(request, env);
    }
    // Source webhook surface (Core Specification §6). This is a NEW top-level
    // prefix the accounts handler does not own; handle it here via the
    // deploy-control service seam BEFORE delegating to the accounts handler.
    if (url.pathname.startsWith("/hooks/sources/")) {
      return await handleSourceWebhook(request, url, env);
    }
    if (!platformExtensionBasePathIsReserved(url.pathname)) {
      const platformExtensionRoute = matchPlatformExtensionRoute(
        url.pathname,
        platformExtensionRoutes(
          env as unknown as { readonly [key: string]: unknown },
        ),
      );
      if (platformExtensionRoute) {
        return await handlePlatformExtensionRouteRequest(
          request,
          env,
          platformExtensionRoute,
          verifyPlatformExtensionSession,
        );
      }
    }
    const accountsResponse = withPlatformAssetCacheHeaders(
      request,
      url,
      await accountsWorker.fetch(request, env),
    );
    if (isOidcMetricPath(url.pathname)) {
      await schedulePlatformSideEffect(
        recordPlatformOidcMetric(request, url, env, accountsResponse),
        context,
      );
    }
    return accountsResponse;
  },
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
    return runQueueConsumer(batch, env);
  },
  // Scheduled cron tick. Always runs source polling (Core Specification §6: scan
  // active autoSync sources and enqueue a deduped source_sync). When the
  // `TAKOSUMI_DRIFT_CHECK_ENABLED=1` flag is set (default OFF), ALSO runs the
  // current compatibility drift sweep for Workspaces with active Capsules.
  // Resource Shape observation is a separate, read-only reconciler. It follows
  // configured Resource Shape capability by default and uses waitUntil so slow
  // runner-backed checks do not serialize the rest of the cron tick.
  async scheduled(
    _event: unknown,
    env: CloudflareWorkerEnv,
    context?: PlatformExecutionContext,
  ): Promise<void> {
    await runScheduledSourcePoll(env);
    await runScheduledOpenTofuRunRepair(env);
    await runScheduledResourceOperationRepair(env);
    if (autoPlanStaleCapsulesEnabled(env)) {
      await runScheduledStaleCapsuleAutoPlan(env);
    }
    if (driftCheckEnabled(env)) {
      await runScheduledDriftSweep(env);
    }
    if (resourceObservationEnabled(env)) {
      await schedulePlatformSideEffect(
        runScheduledResourceObservation(env),
        context,
      );
    }
  },
};

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
  const resourceShapeApi = platformResourceShapeApiEnabled(env);
  const resources = platformResourceCapabilities(env, resourceShapeApi);
  const resourceShapes =
    resourceShapeApi && resourceCapabilitiesEnabled(resources);
  const adapters = platformAdapterCapabilities(env, resourceShapes);
  const operator = platformOperatorCapabilities(env, resourceShapes);
  return {
    origin,
    resources,
    adapters,
    identity: {
      external_oidc_login: accountsExternalLoginConfigured(env),
    },
    operator,
    compat: extensionDiscovery.compat,
    compatibilityProfiles: extensionDiscovery.compatibilityProfiles,
    extensions: extensionDiscovery.extensions,
    endpoints: Object.fromEntries(
      Object.entries(extensionDiscovery.endpoints).map(([token, path]) => [
        token,
        new URL(path, origin).toString(),
      ]),
    ),
    resourceShapesEnabled: resourceShapes,
    interfacesEnabled: platformResourceShapeApiEnabled(env),
  };
}

const RESOURCE_CAPABILITY_KEYS = [
  "EdgeWorker",
  "ObjectBucket",
  "KVStore",
  "Queue",
  "SQLDatabase",
  "ContainerService",
] as const;

type MutablePartial<T> = {
  -readonly [K in keyof T]?: T[K];
};

function platformResourceCapabilities(
  env: CloudflareWorkerEnv,
  apiEnabled: boolean,
): Partial<TakosumiResourceCapabilities> {
  const base = Object.fromEntries(
    RESOURCE_CAPABILITY_KEYS.map((key) => [key, false]),
  ) as MutablePartial<TakosumiResourceCapabilities>;
  if (!apiEnabled) return base;
  for (const key of resourceShapeCapabilityTokens(
    env.TAKOSUMI_RESOURCE_SHAPES,
    resourceShapeHostContributionsFromEnv(env).schemaRegistry,
  )) {
    base[key] = true;
  }
  return base;
}

function platformAdapterCapabilities(
  env: CloudflareWorkerEnv,
  resourceShapesEnabled: boolean,
): Partial<TakosumiAdapterCapabilities> {
  const base: MutablePartial<TakosumiAdapterCapabilities> = {};
  if (!resourceShapesEnabled) return base;
  base.opentofu = true;
  for (const key of parseExtensionCapabilityTokens(
    env.TAKOSUMI_RESOURCE_ADAPTERS,
  )) {
    base[key] = true;
  }
  return base;
}

function resourceCapabilitiesEnabled(
  resources: Partial<TakosumiResourceCapabilities>,
): boolean {
  return Object.entries(resources).some(
    ([key, enabled]) => key !== "Stack" && enabled === true,
  );
}

function resourceShapeCapabilityTokens(
  value: unknown,
  schemaRegistry?: import("../../core/domains/resource-shape/mod.ts").ResourceShapeSchemaRegistry,
): readonly string[] {
  return configuredResourceShapeKinds(value, schemaRegistry);
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

export function platformResourceShapeApiEnabled(
  env: CloudflareWorkerEnv,
): boolean {
  return Boolean(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN && env.TAKOSUMI_CONTROL_DB);
}

const PUBLIC_RESOURCE_API_MANAGED_BY = "takosumi.resource-api.v1";

export function isPlatformResourceShapeApiPath(pathname: string): boolean {
  return (
    pathname === "/v1/interfaces" ||
    pathname.startsWith("/v1/interfaces/") ||
    pathname === "/v1/resources" ||
    pathname.startsWith("/v1/resources/") ||
    pathname === "/v1/target-pools" ||
    pathname.startsWith("/v1/target-pools/") ||
    pathname === "/v1/space-policies" ||
    pathname.startsWith("/v1/space-policies/")
  );
}

function isPlatformInterfaceApiPath(pathname: string): boolean {
  return (
    pathname === "/v1/interfaces" || pathname.startsWith("/v1/interfaces/")
  );
}

function isPlatformInterfaceTokenIssueRequest(request: Request): boolean {
  return (
    request.method === "POST" &&
    /^\/v1\/interfaces\/[^/]+\/token$/u.test(new URL(request.url).pathname)
  );
}

export async function handlePlatformResourceShapeApiRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
): Promise<Response> {
  if (!platformResourceShapeApiEnabled(env)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!platformResourceShapeHasDeployControlBearer(request, env)) {
    const authorized = await platformResourceShapeExternalRequest(
      request,
      env,
      sessionVerifier,
    );
    if (!authorized.ok) return authorized.response;
    request = authorized.request;
  }
  const service = await cachedDeployControlService(env);
  return await service.app.fetch(request);
}

function platformResourceShapeHasDeployControlBearer(
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

async function platformResourceShapeExternalRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  sessionVerifier: PlatformExtensionSessionVerifier,
): Promise<
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly response: Response }
> {
  const session = await sessionVerifier(request, env);
  if (!session.authenticated) {
    return {
      ok: false,
      response: Response.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  return await platformResourceShapeAuthorizedRequest(
    request,
    request,
    env,
    session,
  );
}

async function platformResourceShapeAuthorizedRequest(
  request: Request,
  workspaceVerificationRequest: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  trustedManagedBy?: string,
): Promise<
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly response: Response }
> {
  const url = new URL(request.url);
  const interfaceAccessFailure = isPlatformInterfaceApiPath(url.pathname)
    ? platformInterfaceAccessFailure(request, session)
    : undefined;
  if (interfaceAccessFailure) {
    return { ok: false, response: interfaceAccessFailure };
  }
  if (!isPlatformInterfaceApiPath(url.pathname)) {
    const resourceAccessFailure = platformResourceShapeAccessFailure(
      request,
      session,
    );
    if (resourceAccessFailure) {
      return { ok: false, response: resourceAccessFailure };
    }
  }

  const materialized = await materializeRequestBody(request);
  if (!materialized.ok) return materialized;
  const body = materialized.bodyText
    ? objectRecord(JSON.parse(materialized.bodyText))
    : {};
  const effectiveManagedBy =
    trustedManagedBy ??
    platformPublicResourceManagedBy(url, body, session);
  const requestedWorkspaceId = platformResourceShapeRequestWorkspaceId(
    request,
    url,
    body,
  );
  const workspaceId =
    requestedWorkspaceId ?? safePlatformExtensionContextId(session.workspaceId);
  if (!workspaceId) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "invalid_request",
          error_description: "workspaceId is required",
        },
        { status: 400 },
      ),
    };
  }

  const verified = await platformExtensionVerifiedWorkspaceSession(
    workspaceVerificationRequest,
    env,
    session,
    workspaceId,
  );
  if (!verified.ok) return verified;

  // The public/session Resource Shape surface currently uses the verified
  // Workspace id as its Resource Space id. Core deliberately has no implicit
  // Space-to-Workspace mapping, so accepting an unrelated `space` here would
  // turn a valid membership in any Workspace into a cross-Workspace read/write
  // oracle against the global Resource stores. Direct deploy-control bearer
  // calls bypass this external-session seam and retain operator authority over
  // arbitrary Spaces.
  if (!isPlatformInterfaceApiPath(url.pathname)) {
    const requestedSpaces = platformResourceShapeRequestedSpaces(url, body);
    if (requestedSpaces.some((space) => space !== workspaceId)) {
      return {
        ok: false,
        response: Response.json(
          {
            error: "forbidden",
            error_description:
              "Resource Space must match the verified Workspace",
          },
          { status: 403 },
        ),
      };
    }
  }

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
          platformResourceShapeActorContext(verified.session, workspaceId),
        ),
      );
      headers.set(
        TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER,
        effectiveManagedBy,
      );
      for (const header of PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS) {
        if (header !== "authorization") headers.delete(header);
      }
    }),
  };
}

function platformPublicResourceManagedBy(
  url: URL,
  body: Record<string, unknown>,
  session: PlatformExtensionSessionContext,
): string {
  const requestedManagedBy =
    safePlatformResourceManagedBy(url.searchParams.get("managedBy")) ??
    safePlatformResourceManagedBy(
      valueString(objectRecord(body.metadata).managedBy),
    );
  // `opentofu` is the one public first-party authoring surface carried by the
  // provider contract. A bearer that already has Resource write authority may
  // deliberately act through that surface; arbitrary compatibility/operator
  // manager identities remain impossible to select at public ingress.
  return requestedManagedBy === "opentofu" &&
    platformResourceShapeSessionMayWrite(session)
    ? "opentofu"
    : PUBLIC_RESOURCE_API_MANAGED_BY;
}

function safePlatformResourceManagedBy(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(normalized)
    ? normalized
    : undefined;
}

function platformResourceShapeAccessFailure(
  request: Request,
  session: PlatformExtensionSessionContext,
): Response | undefined {
  const readOnly = request.method === "GET" || request.method === "HEAD";
  if (session.authKind === "session") return undefined;
  if (session.authKind === "oauth-access-token") {
    if (platformOAuthAccessTokenAllowsControlRequest(request, session.scopes)) {
      return undefined;
    }
    return Response.json(
      {
        error: "insufficient_scope",
        error_description: "delegated token lacks Capsule access scope",
      },
      { status: 403 },
    );
  }
  const scopes = new Set(session.scopes ?? []);
  if (session.authKind === "personal-access-token") {
    const allowed = readOnly
      ? scopes.has("admin") || scopes.has("read") || scopes.has("write")
      : scopes.has("admin") || scopes.has("write");
    if (allowed) return undefined;
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
  if (session.authKind === "service-token") {
    const allowed = readOnly
      ? scopes.has("admin") ||
        scopes.has("read") ||
        scopes.has("write") ||
        scopes.has("capsules:read") ||
        scopes.has("capsules:write")
      : scopes.has("admin") ||
        scopes.has("write") ||
        scopes.has("capsules:write");
    if (allowed) return undefined;
  }
  return Response.json(
    {
      error: "access_denied",
      error_description: "credential type cannot access Resource control APIs",
    },
    { status: 403 },
  );
}

function platformResourceShapeSessionMayWrite(
  session: PlatformExtensionSessionContext,
): boolean {
  if (session.authKind === "personal-access-token") {
    const scopes = new Set(session.scopes ?? []);
    return scopes.has("admin") || scopes.has("write");
  }
  if (
    session.authKind === "oauth-access-token" ||
    session.authKind === "service-token"
  ) {
    const scopes = new Set(session.scopes ?? []);
    return (
      scopes.has("admin") ||
      scopes.has("write") ||
      scopes.has("capsules:write")
    );
  }
  return false;
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

  // Interface OAuth and managed-provider run credentials are invocation-only.
  // They must never be rewritten into the deploy-control bearer. Token format
  // prefixes are deliberately not authorization authority here.
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

function platformResourceShapeRequestWorkspaceId(
  request: Request,
  url: URL,
  body: Record<string, unknown>,
): string | undefined {
  return (
    safePlatformExtensionContextId(url.searchParams.get("workspaceId")) ??
    safePlatformExtensionContextId(
      request.headers.get(PLATFORM_EXTENSION_WORKSPACE_ID_HEADER),
    ) ??
    safePlatformExtensionContextId(valueString(body.workspaceId))
  );
}

function platformResourceShapeRequestedSpaces(
  url: URL,
  body: Record<string, unknown>,
): readonly string[] {
  // Every route-level Space selector supplied by an external caller.
  const metadata = objectRecord(body.metadata);
  const candidates = [
    url.searchParams.get("space"),
    valueString(body.space),
    valueString(metadata.space),
  ];
  return [
    ...new Set(
      candidates
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

function platformResourceShapeActorContext(
  session: PlatformExtensionSessionContext,
  workspaceId: string,
): ActorContext {
  const runtimePrincipal = session.authKind === "oauth-access-token";
  return {
    actorAccountId:
      safePlatformExtensionContextId(session.subject) ??
      `${session.authKind ?? "session"}:resource-shape`,
    roles: runtimePrincipal
      ? ["runtime-principal"]
      : session.scopes?.includes("admin")
        ? ["owner"]
        : ["operator"],
    requestId: crypto.randomUUID(),
    workspaceId,
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
  resourceShapesEnabled = platformResourceShapeApiEnabled(env),
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
    managed_target_catalog:
      enabled("managed_target_catalog") && controlDb && resourceShapesEnabled,
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
  readonly compat: Readonly<Record<string, boolean>>;
  readonly compatibilityProfiles: TakosumiCompatibilityProfileCapabilities;
  readonly extensions: readonly string[];
  readonly endpoints: Readonly<Record<string, string>>;
} {
  const configuredRoutes = platformExtensionRoutes(
    env as unknown as { readonly [key: string]: unknown },
  ).filter((route) => platformExtensionRouteConfigured(env, route));
  const compat: Record<string, boolean> = {};
  const compatibilityProfiles: Record<
    string,
    { readonly planes: readonly ("control" | "data")[] }
  > = {};
  const extensions = new Set<string>();
  const endpoints: Record<string, string> = {};
  for (const route of configuredRoutes) {
    for (const capability of route.capabilities ?? []) {
      extensions.add(capability);
      endpoints[capability] = route.basePath;
    }
    for (const profile of route.compatibilityProfiles ?? []) {
      compat[profile.profile] = true;
      compatibilityProfiles[profile.profile] = { planes: profile.planes };
      endpoints[profile.profile] = route.basePath;
    }
  }
  return {
    compat,
    compatibilityProfiles,
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
  if (url.pathname.startsWith("/opentofu/providers/")) {
    const headers = new Headers(response.headers);
    headers.set(
      "cache-control",
      url.pathname.endsWith("/index.json")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  if (!url.pathname.startsWith("/assets/")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
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
  return (
    pathname === "/.well-known/openid-configuration" ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/v1/auth" ||
    pathname.startsWith("/v1/auth/")
  );
}

export function oidcMetricRoute(pathname: string): string {
  if (pathname === "/.well-known/openid-configuration") {
    return "/.well-known/openid-configuration";
  }
  if (pathname === "/oauth" || pathname.startsWith("/oauth/authorize")) {
    return "/oauth/authorize";
  }
  if (pathname.startsWith("/oauth/token")) return "/oauth/token";
  if (pathname.startsWith("/oauth/userinfo")) return "/oauth/userinfo";
  if (pathname.startsWith("/oauth/revoke")) return "/oauth/revoke";
  if (pathname.startsWith("/oauth/introspect")) return "/oauth/introspect";
  if (pathname.startsWith("/oauth/jwks")) return "/oauth/jwks";
  if (pathname.startsWith("/v1/auth/upstream")) return "/v1/auth/upstream/*";
  return pathname;
}

type PlatformDeployControlSeam = Pick<
  ReturnType<typeof createInProcessDeployControlSeam>,
  "fetch"
>;

export function isPlatformMetricsPath(pathname: string): boolean {
  return pathname === TAKOSUMI_METRICS_PATH;
}

const PLATFORM_METRICS_DASHBOARD_PATH =
  "/internal/platform/metrics-dashboard" as const;
const REQUIRED_DASHBOARD_METRICS = [
  "takosumi_deploy_operation_count",
  "takosumi_apply_duration_seconds_bucket",
  "takosumi_runner_queue_age_seconds",
  "takosumi_runner_active_runs",
  "takosumi_runner_container_startup_seconds_bucket",
  "takosumi_api_request_duration_seconds_bucket",
  "takosumi_oidc_request_count",
] as const;
const REQUIRED_DASHBOARD_LABELS = [
  "environment",
  "runner_profile_id",
  "workspace_id",
  "capsule_id",
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
  readonly configured: boolean;
  readonly capabilities?: readonly string[];
  readonly compatibilityProfiles?: readonly PlatformCompatibilityProfile[];
  readonly authMode?: "platform" | "handler";
  readonly requiredScopes?: readonly string[];
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
    configured: platformExtensionRouteConfigured(env, route),
    ...(route.capabilities ? { capabilities: route.capabilities } : {}),
    ...(route.compatibilityProfiles
      ? { compatibilityProfiles: route.compatibilityProfiles }
      : {}),
    ...(route.authMode ? { authMode: route.authMode } : {}),
    ...(route.requiredScopes ? { requiredScopes: route.requiredScopes } : {}),
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
export interface PlatformCompatibilityAuthorization {
  readonly workspaceId: string;
  readonly subject: string;
  readonly scopes?: readonly string[];
}

/**
 * The only mutation authority given to a control-plane compatibility profile.
 * Every accepted request is constrained to `/v1/resources` and dispatched to
 * the same Resource Deploy API used by the provider, CLI, and dashboard.
 */
export interface PlatformCompatibilityResourceDeployApiPort {
  fetch(
    request: Request,
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<Response>;
}

/**
 * Canonical http.route Interface control available to scoped compatibility
 * profiles. The fixed service owns Interface/Binding validation and never
 * exposes the generic Interface store or CRUD service to an extension.
 */
export interface PlatformCompatibilityRouteInterfaceControlPort {
  ensure(
    input: {
      readonly workspaceId: string;
      readonly resourceName: string;
      readonly pathPattern: string;
      readonly expectedEndpoint: string;
    },
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<CompatibilityRouteRecord>;
  list(
    input: {
      readonly workspaceId: string;
      readonly resourceName?: string;
    },
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<readonly CompatibilityRouteRecord[]>;
  get(
    input: { readonly workspaceId: string; readonly interfaceId: string },
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<CompatibilityRouteRecord | undefined>;
  update(
    input: {
      readonly workspaceId: string;
      readonly interfaceId: string;
      readonly resourceName: string;
      readonly pathPattern: string;
      readonly expectedEndpoint: string;
      readonly expectedEtag?: string;
    },
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<CompatibilityRouteRecord>;
  retire(
    input: {
      readonly workspaceId: string;
      readonly interfaceId: string;
      readonly expectedEtag?: string;
    },
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<CompatibilityRouteRetireResult | undefined>;
}

/**
 * Manager-neutral, exact-GET-only canonical Resource reader for operator
 * recovery loops. This is deliberately separate from compatibility profile
 * authority: recovery must protect artifacts for every authoring surface,
 * while compatibility reads are scoped to their declared profile.
 */
export interface PlatformCanonicalResourceReadAuthority {
  fetch(
    request: Request,
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<Response>;
}

export interface PlatformCanonicalReadyResourceInventoryItem {
  readonly resourceId: string;
  readonly resource: ResourceObject;
  readonly resourceGeneration: number;
  readonly nativeResources: readonly NativeResourceRef[];
}

export interface PlatformCanonicalReadyResourceInventoryPage {
  readonly items: readonly PlatformCanonicalReadyResourceInventoryItem[];
  readonly nextCursor?: string;
}

/**
 * Read-only global Resource inventory for host-operated reconciliation jobs.
 * It is a composition port only: no public HTTP route exposes global
 * enumeration, and every item is a coherent fully observed Ready Resource.
 */
export interface PlatformCanonicalReadyResourceInventory {
  list(input: {
    readonly kind: ResourceShapeKind;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<PlatformCanonicalReadyResourceInventoryPage>;
}

export interface PlatformCompatibilityReadyResourceInput {
  readonly space: string;
  readonly kind: ResourceShapeKind;
  readonly name: string;
  /** Optional Interface grant to resolve alongside the Resource evidence. */
  readonly interface?: {
    readonly id: string;
    readonly permission: string;
  };
}

/** Immutable, read-only evidence returned to a data-plane profile. */
export interface PlatformCompatibilityReadyResourceEvidence {
  readonly resource: ResourceObject;
  /** Desired generation proven Ready by the canonical Resource store. */
  readonly resourceGeneration: number;
  readonly nativeResources: readonly NativeResourceRef[];
  readonly interface?: Interface;
  readonly interfaceBindings?: readonly import("takosumi-contract/interfaces").InterfaceBinding[];
}

/** The only authority given to a data-plane compatibility profile. */
export interface PlatformCompatibilityDataReadResolver {
  resolveReadyResource(
    input: PlatformCompatibilityReadyResourceInput,
    authorization?: PlatformCompatibilityAuthorization,
  ): Promise<PlatformCompatibilityReadyResourceEvidence | undefined>;
}

/**
 * Capability-limited authority passed to compatibility handlers. It contains
 * no env, store, adapter, backend manager, lifecycle registry, or write API.
 */
export interface PlatformCompatibilityAuthority {
  readonly profiles: readonly PlatformCompatibilityProfile[];
  readonly control?: {
    readonly resourceApi: PlatformCompatibilityResourceDeployApiPort;
    readonly routeInterfaces: PlatformCompatibilityRouteInterfaceControlPort;
  };
  readonly data?: PlatformCompatibilityDataReadResolver;
}

export interface PlatformCompatibilityHandler {
  fetchCompatibility(
    request: Request,
    authority: PlatformCompatibilityAuthority,
  ): Response | Promise<Response>;
}

export type PlatformCompatibilityAuthorityFactory = (input: {
  readonly request: Request;
  readonly env: CloudflareWorkerEnv;
  readonly route: PlatformExtensionRoute;
  readonly session?: PlatformExtensionSessionContext;
}) => PlatformCompatibilityAuthority | Promise<PlatformCompatibilityAuthority>;

export async function handlePlatformExtensionRouteRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute,
  sessionVerifier: PlatformExtensionSessionVerifier = verifyPlatformExtensionSession,
  authorityFactory: PlatformCompatibilityAuthorityFactory = createPlatformCompatibilityAuthority,
): Promise<Response> {
  const handler = platformExtensionHandler(env, route.handlerKey);
  if (!handler) return Response.json({ error: "not found" }, { status: 404 });
  if ((route.compatibilityProfiles?.length ?? 0) > 0) {
    if (typeof handler.fetchCompatibility !== "function") {
      return Response.json(
        {
          error: "compatibility authority unavailable",
          error_description:
            "profile handler must implement fetchCompatibility(request, authority)",
        },
        { status: 503 },
      );
    }
    if (route.authMode === "handler") {
      const sanitized = platformExtensionHandlerAuthRequest(request);
      const authority = await authorityFactory({ request, env, route });
      return await handler.fetchCompatibility(sanitized, authority);
    }
    const authContext = await platformExtensionAuthContext(
      request,
      env,
      route,
      sessionVerifier,
    );
    if (!authContext.ok) return authContext.response;
    const authority = await authorityFactory({
      request,
      env,
      route,
      session: authContext.session,
    });
    return await handler.fetchCompatibility(authContext.request, authority);
  }
  if (typeof handler.fetch !== "function") {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (route.authMode === "handler") {
    return await handler.fetch(platformExtensionHandlerAuthRequest(request));
  }
  const authContext = await platformExtensionAuthContext(
    request,
    env,
    route,
    sessionVerifier,
  );
  if (!authContext.ok) return authContext.response;
  return await handler.fetch(authContext.request);
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

export interface PlatformExtensionSessionContext {
  readonly authenticated: boolean;
  readonly authKind?:
    | "service-token"
    | "protocol-credential"
    | "interface-oauth-token"
    | "oauth-access-token"
    | "personal-access-token"
    | "session";
  readonly subject?: string;
  readonly capsuleId?: string;
  readonly workspaceId?: string;
  readonly audience?: string;
  readonly interfaceId?: string;
  readonly interfaceBindingId?: string;
  readonly interfaceResolvedRevision?: number;
  readonly scopes?: readonly string[];
}

export type PlatformExtensionSessionVerifier = (
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformExtensionRoute,
) => Promise<PlatformExtensionSessionContext>;

export interface PlatformCompatibilityAuthorityDependencies {
  readonly dispatchResourceRequest?: typeof dispatchPlatformCompatibilityResourceRequest;
  readonly resolveReadyResource?: typeof resolvePlatformCompatibilityReadyResource;
  readonly routeInterfaces?: PlatformCompatibilityRouteInterfaceControlPort;
}

export async function createPlatformCompatibilityAuthority(
  input: {
    readonly request: Request;
    readonly env: CloudflareWorkerEnv;
    readonly route: PlatformExtensionRoute;
    readonly session?: PlatformExtensionSessionContext;
  },
  dependencies: PlatformCompatibilityAuthorityDependencies = {},
): Promise<PlatformCompatibilityAuthority> {
  const profiles = input.route.compatibilityProfiles ?? [];
  const exposesControl = profiles.some(({ planes }) =>
    planes.includes("control"),
  );
  const exposesData = profiles.some(({ planes }) => planes.includes("data"));
  return Object.freeze({
    profiles: Object.freeze(
      profiles.map((profile) =>
        Object.freeze({
          profile: profile.profile,
          planes: Object.freeze([...profile.planes]),
        }),
      ),
    ),
    ...(exposesControl
      ? {
          control: Object.freeze({
            resourceApi: Object.freeze({
              fetch: (
                request: Request,
                authorization?: PlatformCompatibilityAuthorization,
              ) =>
                (
                  dependencies.dispatchResourceRequest ??
                  dispatchPlatformCompatibilityResourceRequest
                )(request, authorization, input),
            }),
            routeInterfaces:
              dependencies.routeInterfaces ??
              createPlatformCompatibilityRouteInterfaceControlPort(input),
          }),
        }
      : {}),
    ...(exposesData
      ? {
          data: Object.freeze({
            resolveReadyResource: (
              resource: PlatformCompatibilityReadyResourceInput,
              authorization?: PlatformCompatibilityAuthorization,
            ) =>
              resolveReadyCompatibilityEvidence(
                dependencies.resolveReadyResource ??
                  resolvePlatformCompatibilityReadyResource,
                resource,
                authorization,
                input,
              ),
          }),
        }
      : {}),
  });
}

function createPlatformCompatibilityRouteInterfaceControlPort(context: {
  readonly request: Request;
  readonly env: CloudflareWorkerEnv;
  readonly route: PlatformExtensionRoute;
  readonly session?: PlatformExtensionSessionContext;
}): PlatformCompatibilityRouteInterfaceControlPort {
  return Object.freeze({
    ensure: async (
      input: Parameters<
        PlatformCompatibilityRouteInterfaceControlPort["ensure"]
      >[0],
      authorization?: PlatformCompatibilityAuthorization,
    ) => {
      const scoped = await platformCompatibilityRouteInterfaceScope(
        input.workspaceId,
        authorization,
        context,
        "write",
      );
      return await scoped.service.ensure(scoped.scope, {
        resourceName: input.resourceName,
        pathPattern: input.pathPattern,
        expectedEndpoint: input.expectedEndpoint,
      });
    },
    list: async (
      input: Parameters<
        PlatformCompatibilityRouteInterfaceControlPort["list"]
      >[0],
      authorization?: PlatformCompatibilityAuthorization,
    ) => {
      const scoped = await platformCompatibilityRouteInterfaceScope(
        input.workspaceId,
        authorization,
        context,
        "read",
      );
      return await scoped.service.list(scoped.scope, {
        ...(input.resourceName ? { resourceName: input.resourceName } : {}),
      });
    },
    get: async (
      input: Parameters<
        PlatformCompatibilityRouteInterfaceControlPort["get"]
      >[0],
      authorization?: PlatformCompatibilityAuthorization,
    ) => {
      const scoped = await platformCompatibilityRouteInterfaceScope(
        input.workspaceId,
        authorization,
        context,
        "read",
      );
      return await scoped.service.get(scoped.scope, input.interfaceId);
    },
    update: async (
      input: Parameters<
        PlatformCompatibilityRouteInterfaceControlPort["update"]
      >[0],
      authorization?: PlatformCompatibilityAuthorization,
    ) => {
      const scoped = await platformCompatibilityRouteInterfaceScope(
        input.workspaceId,
        authorization,
        context,
        "write",
      );
      return await scoped.service.update(scoped.scope, {
        interfaceId: input.interfaceId,
        resourceName: input.resourceName,
        pathPattern: input.pathPattern,
        expectedEndpoint: input.expectedEndpoint,
        ...(input.expectedEtag ? { expectedEtag: input.expectedEtag } : {}),
      });
    },
    retire: async (
      input: Parameters<
        PlatformCompatibilityRouteInterfaceControlPort["retire"]
      >[0],
      authorization?: PlatformCompatibilityAuthorization,
    ) => {
      const scoped = await platformCompatibilityRouteInterfaceScope(
        input.workspaceId,
        authorization,
        context,
        "write",
      );
      return await scoped.service.retire(scoped.scope, {
        interfaceId: input.interfaceId,
        ...(input.expectedEtag ? { expectedEtag: input.expectedEtag } : {}),
      });
    },
  });
}

async function platformCompatibilityRouteInterfaceScope(
  requestedWorkspaceId: string,
  authorization: PlatformCompatibilityAuthorization | undefined,
  context: {
    readonly request: Request;
    readonly env: CloudflareWorkerEnv;
    readonly route: PlatformExtensionRoute;
    readonly session?: PlatformExtensionSessionContext;
  },
  access: "read" | "write",
): Promise<{
  readonly service: CompatibilityRouteControlService;
  readonly scope: {
    readonly profile: string;
    readonly workspaceId: string;
    readonly actor: ActorContext;
  };
}> {
  const workspaceId = safePlatformExtensionContextId(requestedWorkspaceId);
  const profile = compatibilityControlManagedBy(context.route);
  const session = compatibilityAuthoritySession(context.session, authorization);
  if (!workspaceId || !profile || !session) {
    throw new TypeError(
      "compatibility route Interface authority requires one profile and authenticated Workspace context",
    );
  }
  if (
    platformResourceShapeAccessFailure(
      new Request(context.request, {
        method: access === "read" ? "GET" : "POST",
      }),
      session,
    )
  ) {
    const error = new Error(
      `compatibility route ${access} scope is not authorized`,
    );
    (error as { code?: string }).code = "forbidden";
    throw error;
  }
  const verified = await platformExtensionVerifiedWorkspaceSession(
    context.request,
    context.env,
    session,
    workspaceId,
  );
  if (!verified.ok) {
    const error = new Error("compatibility route Workspace is not authorized");
    (error as { code?: string }).code = "forbidden";
    throw error;
  }
  const operations = await takosumiOperationsFor(context.env);
  return {
    service: new CompatibilityRouteControlService(operations.interfaces, {
      resolveReadyEdgeWorker: async ({ workspaceId, resourceName }) =>
        (
          await operations.resourceCompatibility?.resolveReadyResource({
            space: workspaceId,
            kind: "EdgeWorker",
            name: resourceName,
          })
        )?.resource,
    }),
    scope: {
      profile,
      workspaceId,
      actor: platformResourceShapeActorContext(verified.session, workspaceId),
    },
  };
}

export function createPlatformCanonicalResourceReadAuthority(
  env: CloudflareWorkerEnv,
): PlatformCanonicalResourceReadAuthority {
  return Object.freeze({
    fetch: async (
      request: Request,
      authorization?: PlatformCompatibilityAuthorization,
    ): Promise<Response> => {
      const url = new URL(request.url);
      const segments = url.pathname.split("/").filter(Boolean);
      let resourceKind = "";
      let resourceName = "";
      try {
        resourceKind = decodeURIComponent(segments[2] ?? "");
        resourceName = decodeURIComponent(segments[3] ?? "");
      } catch {
        // Malformed paths are rejected by the exact-read check below.
      }
      const workspaceId = safePlatformExtensionContextId(
        authorization?.workspaceId,
      );
      const subject = safePlatformExtensionSubject(authorization?.subject);
      const requestedSpace = safePlatformExtensionContextId(
        url.searchParams.get("space"),
      );
      const exactResourceRead =
        request.method === "GET" &&
        segments.length === 4 &&
        segments[0] === "v1" &&
        segments[1] === "resources" &&
        isResourceShapeKind(resourceKind) &&
        Boolean(safePlatformCompatibilityResourceName(resourceName)) &&
        [...url.searchParams.keys()].every((key) => key === "space");
      if (!exactResourceRead) {
        return Response.json(
          {
            error: "invalid_resource_read",
            error_description:
              "canonical Resource recovery authority permits only exact GET reads",
          },
          { status: 400 },
        );
      }
      if (
        !workspaceId ||
        !subject ||
        requestedSpace !== workspaceId ||
        !authorization?.scopes?.includes("admin")
      ) {
        return Response.json(
          {
            error: "forbidden",
            error_description:
              "canonical Resource recovery read requires matching Workspace admin authority",
          },
          { status: 403 },
        );
      }
      if (!platformResourceShapeApiEnabled(env)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const headers = new Headers(request.headers);
      for (const header of [
        ...PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS,
        ...PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS,
        TAKOSUMI_INTERNAL_ACTOR_HEADER,
      ]) {
        headers.delete(header);
      }
      headers.set(
        "authorization",
        `Bearer ${String(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN)}`,
      );
      headers.set(
        TAKOSUMI_INTERNAL_ACTOR_HEADER,
        encodeActorContext(
          platformResourceShapeActorContext(
            {
              authenticated: true,
              authKind: "service-token",
              workspaceId,
              subject,
              scopes: ["admin"],
            },
            workspaceId,
          ),
        ),
      );
      headers.delete(TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER);
      return await handlePlatformResourceShapeApiRequest(
        new Request(url, { method: "GET", headers }),
        env,
      );
    },
  });
}

export function createPlatformCanonicalReadyResourceInventory(
  env: CloudflareWorkerEnv,
): PlatformCanonicalReadyResourceInventory {
  return Object.freeze({
    list: async (
      input: Parameters<PlatformCanonicalReadyResourceInventory["list"]>[0],
    ): Promise<PlatformCanonicalReadyResourceInventoryPage> => {
      if (!isResourceShapeKind(input.kind)) {
        throw new TypeError("canonical Resource inventory kind is invalid");
      }
      const operations = await takosumiOperationsFor(env);
      const inventory = operations.resourceCompatibility;
      if (!inventory) {
        throw new Error("canonical Ready Resource inventory is unavailable");
      }
      const page = await inventory.listReadyResourcesPage({
        kind: input.kind,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return structuredClone(page);
    },
  });
}

async function resolveReadyCompatibilityEvidence(
  resolver: typeof resolvePlatformCompatibilityReadyResource,
  input: PlatformCompatibilityReadyResourceInput,
  authorization: PlatformCompatibilityAuthorization | undefined,
  context: {
    readonly request: Request;
    readonly env: CloudflareWorkerEnv;
    readonly route: PlatformExtensionRoute;
    readonly session?: PlatformExtensionSessionContext;
  },
): Promise<PlatformCompatibilityReadyResourceEvidence | undefined> {
  const evidence = await resolver(input, authorization, context);
  return evidence?.resource.status?.phase === "Ready" ? evidence : undefined;
}

async function dispatchPlatformCompatibilityResourceRequest(
  request: Request,
  authorization: PlatformCompatibilityAuthorization | undefined,
  context: {
    readonly request: Request;
    readonly env: CloudflareWorkerEnv;
    readonly route: PlatformExtensionRoute;
    readonly session?: PlatformExtensionSessionContext;
  },
): Promise<Response> {
  const url = new URL(request.url);
  if (!pathIsUnderBase(url.pathname, "/v1/resources")) {
    return Response.json(
      {
        error: "invalid_compatibility_translation",
        error_description:
          "control-plane compatibility profiles may call only /v1/resources",
      },
      { status: 400 },
    );
  }
  if (url.searchParams.has("force")) {
    return Response.json(
      {
        error: "forbidden",
        error_description:
          "compatibility profiles cannot request break-glass Resource deletion",
      },
      { status: 403 },
    );
  }
  const trustedManagedBy = compatibilityControlManagedBy(context.route);
  if (!trustedManagedBy) {
    return Response.json(
      {
        error: "invalid_compatibility_translation",
        error_description:
          "compatibility Resource authority requires exactly one declared control profile",
      },
      { status: 503 },
    );
  }
  const session = compatibilityAuthoritySession(context.session, authorization);
  if (!session) {
    return Response.json(
      {
        error: "unauthenticated",
        error_description:
          "handler-auth compatibility calls require an authenticated Workspace assertion",
      },
      { status: 401 },
    );
  }

  const normalized = compatibilityResourceApiRequest(request, context.request);
  const authorized = await platformResourceShapeAuthorizedRequest(
    normalized,
    context.request,
    context.env,
    session,
    trustedManagedBy,
  );
  if (!authorized.ok) return authorized.response;
  const service = await cachedDeployControlService(context.env);
  return await scopePlatformCompatibilityResourceResponse(
    await service.app.fetch(authorized.request),
    authorized.request,
    trustedManagedBy,
  );
}

async function scopePlatformCompatibilityResourceResponse(
  response: Response,
  request: Request,
  trustedManagedBy: string,
): Promise<Response> {
  if (!response.ok || request.method !== "GET") return response;
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const isList = segments.length === 2 && url.pathname === "/v1/resources";
  const isGet =
    segments.length === 4 &&
    segments[0] === "v1" &&
    segments[1] === "resources";
  if (!isList && !isGet) return response;
  const body = objectRecord(await response.json().catch(() => undefined));
  if (isGet) {
    if (resourceObjectManagedBy(body) !== trustedManagedBy) {
      return Response.json(
        {
          error: {
            code: "not_found",
            message: "resource was not found for this compatibility profile",
          },
        },
        { status: 404 },
      );
    }
    return jsonResponseWithHeaders(body, response);
  }
  if (!Array.isArray(body.resources)) {
    return Response.json(
      {
        error: "invalid_resource_projection",
        error_description:
          "canonical Resource list returned an invalid projection",
      },
      { status: 502 },
    );
  }
  return jsonResponseWithHeaders(
    {
      ...body,
      resources: body.resources.filter(
        (resource) =>
          resourceObjectManagedBy(objectRecord(resource)) === trustedManagedBy,
      ),
    },
    response,
  );
}

function resourceObjectManagedBy(resource: Record<string, unknown>): string {
  return valueString(objectRecord(resource.metadata).managedBy)?.trim() ?? "";
}

function jsonResponseWithHeaders(
  body: Record<string, unknown>,
  source: Response,
): Response {
  const headers = new Headers(source.headers);
  headers.delete("content-length");
  headers.set("content-type", "application/json; charset=UTF-8");
  return Response.json(body, { status: source.status, headers });
}

function compatibilityControlManagedBy(
  route: PlatformExtensionRoute,
): string | undefined {
  const profiles = [
    ...new Set(
      (route.compatibilityProfiles ?? [])
        .filter(({ planes }) => planes.includes("control"))
        .map(({ profile }) => profile.trim())
        .filter(Boolean),
    ),
  ];
  return profiles.length === 1 ? profiles[0] : undefined;
}

async function resolvePlatformCompatibilityReadyResource(
  input: PlatformCompatibilityReadyResourceInput,
  authorization: PlatformCompatibilityAuthorization | undefined,
  context: {
    readonly request: Request;
    readonly env: CloudflareWorkerEnv;
    readonly route: PlatformExtensionRoute;
    readonly session?: PlatformExtensionSessionContext;
  },
): Promise<PlatformCompatibilityReadyResourceEvidence | undefined> {
  const space = safePlatformExtensionContextId(input.space);
  const name = safePlatformCompatibilityResourceName(input.name);
  if (!space || !name || !isResourceShapeKind(input.kind)) return undefined;
  const session = compatibilityAuthoritySession(context.session, authorization);
  if (!session) return undefined;
  const verified = await platformExtensionVerifiedWorkspaceSession(
    context.request,
    context.env,
    session,
    space,
  );
  if (!verified.ok) return undefined;

  const operations = await takosumiOperationsFor(context.env);
  const evidence = await operations.resourceCompatibility?.resolveReadyResource(
    {
      space,
      kind: input.kind,
      name,
    },
  );
  if (!evidence || evidence.resource.status?.phase !== "Ready") {
    return undefined;
  }

  let resolvedInterface: Interface | undefined;
  let resolvedInterfaceBindings:
    | readonly import("takosumi-contract/interfaces").InterfaceBinding[]
    | undefined;
  if (input.interface) {
    const subject = safePlatformExtensionSubject(verified.session.subject);
    const interfaceId = safePlatformExtensionContextId(input.interface.id);
    const permission = input.interface.permission.trim();
    if (!subject || !interfaceId || !permission) return undefined;
    try {
      const candidate = await operations.interfaces.getAuthorizedForPrincipal(
        interfaceId,
        subject,
        permission,
      );
      const resourceId = `tkrn:${space}:${input.kind}:${name}`;
      if (
        candidate.metadata.workspaceId !== space ||
        candidate.metadata.ownerRef.kind !== "Resource" ||
        candidate.metadata.ownerRef.id !== resourceId ||
        candidate.status.phase !== "Resolved"
      ) {
        return undefined;
      }
      resolvedInterface = candidate;
      resolvedInterfaceBindings =
        await operations.interfaces.listAuthorizedBindingsForPrincipal(
          interfaceId,
          subject,
          permission,
        );
    } catch {
      return undefined;
    }
  }

  return structuredClone({
    ...evidence,
    ...(resolvedInterface ? { interface: resolvedInterface } : {}),
    ...(resolvedInterfaceBindings
      ? { interfaceBindings: resolvedInterfaceBindings }
      : {}),
  });
}

function compatibilityAuthoritySession(
  session: PlatformExtensionSessionContext | undefined,
  authorization: PlatformCompatibilityAuthorization | undefined,
): PlatformExtensionSessionContext | undefined {
  if (session?.authenticated) {
    // Platform-auth profiles cannot replace their verified identity with a
    // handler assertion. Workspace membership is checked per port call.
    return authorization === undefined ? session : undefined;
  }
  const workspaceId = safePlatformExtensionContextId(
    authorization?.workspaceId,
  );
  const subject = safePlatformExtensionSubject(authorization?.subject);
  if (!workspaceId || !subject) return undefined;
  const scopes = (authorization?.scopes ?? []).filter(
    (scope) => typeof scope === "string" && scope.trim().length > 0,
  );
  return {
    authenticated: true,
    authKind: "protocol-credential",
    workspaceId,
    subject,
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

function compatibilityResourceApiRequest(
  request: Request,
  extensionRequest: Request,
): Request {
  const requestedUrl = new URL(request.url);
  const normalizedUrl = new URL(extensionRequest.url);
  normalizedUrl.pathname = requestedUrl.pathname;
  normalizedUrl.search = requestedUrl.search;
  normalizedUrl.hash = "";
  const headers = new Headers(request.headers);
  for (const name of [
    ...PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS,
    ...PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS,
    TAKOSUMI_INTERNAL_ACTOR_HEADER,
  ]) {
    headers.delete(name);
  }
  return new Request(normalizedUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: request.redirect,
  });
}

function safePlatformCompatibilityResourceName(
  value: string,
): string | undefined {
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(trimmed)
    ? trimmed
    : undefined;
}

const PLATFORM_EXTENSION_AUTHENTICATED_HEADER =
  "x-takosumi-platform-authenticated";
const PLATFORM_EXTENSION_SUBJECT_HEADER = "x-takosumi-platform-subject";
const PLATFORM_EXTENSION_AUTH_KIND_HEADER = "x-takosumi-platform-auth-kind";
const PLATFORM_EXTENSION_SCOPES_HEADER = "x-takosumi-platform-scopes";
const PLATFORM_EXTENSION_CAPSULE_ID_HEADER = "x-takosumi-platform-capsule-id";
const PLATFORM_EXTENSION_WORKSPACE_ID_HEADER =
  "x-takosumi-platform-workspace-id";
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
  PLATFORM_EXTENSION_WORKSPACE_ID_HEADER,
  PLATFORM_EXTENSION_AUDIENCE_HEADER,
  PLATFORM_EXTENSION_INTERFACE_ID_HEADER,
  PLATFORM_EXTENSION_INTERFACE_BINDING_ID_HEADER,
  PLATFORM_EXTENSION_INTERFACE_REVISION_HEADER,
  TAKOSUMI_INTERNAL_RESOURCE_MANAGED_BY_HEADER,
] as const;

async function platformExtensionAuthContext(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformExtensionRoute | undefined,
  sessionVerifier: PlatformExtensionSessionVerifier,
): Promise<
  | {
      readonly ok: true;
      readonly request: Request;
      readonly session: PlatformExtensionSessionContext;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const session = await sessionVerifier(request, env, route);
  const headers = new Headers(request.headers);
  for (const header of PLATFORM_EXTENSION_RAW_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  for (const header of PLATFORM_EXTENSION_TRUSTED_CONTEXT_HEADERS) {
    headers.delete(header);
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
      session.authKind === "personal-access-token")
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
  if (!session.authenticated) {
    return {
      ok: false,
      response: Response.json({ error: "unauthenticated" }, { status: 401 }),
    };
  }
  const sessionContext = session;
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
  if (sessionContext.workspaceId) {
    headers.set(
      PLATFORM_EXTENSION_WORKSPACE_ID_HEADER,
      safePlatformExtensionHeaderValue(sessionContext.workspaceId),
    );
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
  return {
    ok: true,
    request: clonePlatformExtensionRequest(request, headers),
    session: sessionContext,
  };
}

type PlatformExtensionWorkspaceAccess = (
  request: Request,
  env: CloudflareWorkerEnv,
  workspaceId: string,
) => Promise<boolean>;

export async function platformExtensionVerifiedWorkspaceSession(
  request: Request,
  env: CloudflareWorkerEnv,
  session: PlatformExtensionSessionContext,
  requestedWorkspaceId: string,
  workspaceAccess: PlatformExtensionWorkspaceAccess = platformExtensionSessionCanAccessWorkspace,
): Promise<
  | {
      readonly ok: true;
      readonly session: PlatformExtensionSessionContext;
    }
  | { readonly ok: false; readonly response: Response }
> {
  let verifiedWorkspaceId = safePlatformExtensionContextId(session.workspaceId);
  if (verifiedWorkspaceId && requestedWorkspaceId !== verifiedWorkspaceId) {
    return platformExtensionWorkspaceAccessFailure();
  }
  if (!verifiedWorkspaceId) {
    const canRequestWorkspace =
      session.authKind === "session" ||
      session.authKind === "personal-access-token";
    if (
      !canRequestWorkspace ||
      !(await workspaceAccess(request, env, requestedWorkspaceId))
    ) {
      return platformExtensionWorkspaceAccessFailure();
    }
    verifiedWorkspaceId = requestedWorkspaceId;
  }

  return {
    ok: true,
    session: {
      ...session,
      workspaceId: verifiedWorkspaceId,
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

async function platformExtensionSessionCanAccessWorkspace(
  request: Request,
  env: CloudflareWorkerEnv,
  workspaceId: string,
): Promise<boolean> {
  const headers = sessionMirrorHeaders(request);
  if (!headers) return false;
  try {
    const response = await accountsWorker.fetch(
      new Request(
        new URL(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`,
          request.url,
        ),
        { method: "GET", headers },
      ),
      env,
    );
    return response.ok;
  } catch {
    return false;
  }
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
): Promise<PlatformExtensionSessionContext> {
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
  const managedProviderToken =
    platformExtensionManagedProviderRunToken(request);
  if (managedProviderToken) {
    const managedProviderSession =
      await verifyPlatformExtensionManagedProviderRunToken(
        env,
        managedProviderToken,
        route,
      );
    return managedProviderSession;
  }

  if (opaqueBearer) {
    const tokenSession = await verifyPlatformExtensionBearerToken(
      request,
      env,
      opaqueBearer,
      route,
    );
    if (tokenSession.authenticated) return tokenSession;
  }

  const headers = sessionMirrorHeaders(request);
  if (!headers) return { authenticated: false };
  try {
    const response = await accountsWorker.fetch(
      new Request(new URL("/v1/account/session/me", request.url), {
        method: "GET",
        headers,
      }),
      env,
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

async function verifyPlatformExtensionManagedProviderRunToken(
  env: CloudflareWorkerEnv,
  token: string,
  route?: PlatformExtensionRoute,
): Promise<PlatformExtensionSessionContext> {
  const secret = managedProviderRunTokenSecret(env);
  const profile = route?.managedProviderProfile;
  if (!secret || !profile) return { authenticated: false };
  const verified = await verifyManagedProviderRunToken(token, {
    secret,
    expectedAudience: profile,
    ...(route?.requiredScopes ? { requiredScopes: route.requiredScopes } : {}),
  });
  if (!verified.ok) return { authenticated: false };
  const payload = verified.payload;
  const scopes = [...payload.scopes];
  if (!platformExtensionScopesAllowAccess(scopes, route)) {
    return { authenticated: false };
  }
  return {
    authenticated: true,
    authKind: "service-token",
    subject: payload.sub,
    workspaceId: payload.workspaceId,
    ...(payload.capsuleId ? { capsuleId: payload.capsuleId } : {}),
    scopes,
  };
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
            ? { resource: platformExtensionRouteBaseUrl(request, route) }
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
    if (tokenUse === "interface_oauth") {
      return platformExtensionInterfaceOAuthSession(
        request,
        record,
        subject,
        scopes,
        route,
      );
    }
    const takosumi = platformExtensionTakosumiMetadata(record);
    return {
      authenticated: true,
      authKind:
        tokenUse === "oauth_access"
          ? "oauth-access-token"
          : "personal-access-token",
      subject,
      ...takosumi,
      scopes,
    };
  } catch {
    return { authenticated: false };
  }
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
  record: Record<string, unknown>,
  subject: string,
  scopes: readonly string[],
  route: PlatformExtensionRoute | undefined,
): PlatformExtensionSessionContext {
  if (!route || route.authMode === "handler") return { authenticated: false };
  const expectedAudience = platformExtensionRouteBaseUrl(request, route);
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
  if (
    !workspaceId ||
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
    workspaceId,
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
  return {
    ...(capsuleId ? { capsuleId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

async function defaultPlatformExtensionIntrospectFetch(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  return await accountsWorker.fetch(request, env);
}

function platformExtensionManagedProviderRunToken(
  request: Request,
): string | undefined {
  const token = bearerValue(request.headers.get("authorization"));
  return token && isManagedProviderRunToken(token) ? token : undefined;
}

function platformExtensionRouteBaseUrl(
  request: Request,
  route: PlatformExtensionRoute,
): string {
  const url = new URL(request.url);
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
  fetchCompatibility?(
    request: Request,
    authority: PlatformCompatibilityAuthority,
  ): Response | Promise<Response>;
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
      typeof (handler as { fetchCompatibility?: unknown })
        .fetchCompatibility !== "function")
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
  return (route.compatibilityProfiles?.length ?? 0) > 0
    ? typeof handler?.fetchCompatibility === "function"
    : typeof handler?.fetch === "function";
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
  verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<{ readonly run: { readonly id: string } }>;
}

export interface SourcePollOperations extends SourceWebhookOperations {
  readonly controller: {
    listAutoSyncSources(
      limit: number,
    ): Promise<readonly { readonly id: string }[]>;
  };
}

export interface OpenTofuRunRepairOperations {
  readonly workspaces: {
    listWorkspaces(): Promise<
      readonly { readonly id: string; readonly archivedAt?: string }[]
    >;
  };
  readonly controller: {
    listRecoverableOpenTofuRuns(options: {
      readonly staleQueuedBeforeMs: number;
      readonly staleRunningBeforeMs: number;
      readonly limit?: number;
    }): Promise<readonly Run[]>;
  };
}

type RepairRunAction = "plan" | "apply" | "source_sync" | "restore";

export interface StaleCapsuleAutoPlanOperations {
  readonly workspaces: {
    listWorkspaces(): Promise<
      readonly { readonly id: string; readonly archivedAt?: string }[]
    >;
  };
  readonly capsules: {
    listCapsules(workspaceId: string): Promise<readonly Capsule[]>;
  };
  readonly controller: {
    listRuns(
      workspaceId: string,
      options?: { readonly limit?: number },
    ): Promise<readonly Run[]>;
  };
  createCapsulePlan(capsuleId: string): Promise<unknown>;
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
 * service). The payload body is IGNORED (untrusted); a valid bearer triggers a
 * deduped source_sync for the source's default ref.
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
  // Payload is untrusted and ignored; effect is a deduped re-resolution.
  const { run } = await operations.createSourceSync(sourceId, { dedupe: true });
  return Response.json({ accepted: true, runId: run.id }, { status: 202 });
}

function bearerFromAuthorization(header: string): string | undefined {
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length) : undefined;
}

// Capped batch so a single cron tick never enqueues an unbounded number of runs.
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
 * and enqueues a deduped source_sync for each. The runner resolves the ref with
 * git ls-remote; when the ref still points at the latest SourceSnapshot commit,
 * it reuses that immutable archive object instead of cloning/archiving again.
 * Best-effort and capped.
 */
export async function pollAutoSyncSources(
  operations: SourcePollOperations,
  batch: number,
): Promise<void> {
  const sources = await operations.controller.listAutoSyncSources(batch);
  for (const source of sources) {
    try {
      await operations.createSourceSync(source.id, { dedupe: true });
    } catch {
      // Best-effort: one bad source must not abort the whole poll.
    }
  }
}

const SCHEDULED_STALE_AUTO_PLAN_WORKSPACE_LIMIT = 25;
const SCHEDULED_STALE_AUTO_PLAN_RUN_LOOKBACK = 100;

/**
 * Operator/Cloud opt-in: turn stale Capsules into reviewable update plans.
 *
 * Core source sync only marks Capsules `stale`; it never silently applies. This
 * scheduled sweep is an operator policy layer that creates at most one pending
 * plan per stale Capsule, then leaves normal Run approval/apply semantics in
 * charge.
 */
export function autoPlanStaleCapsulesEnabled(
  env: CloudflareWorkerEnv,
): boolean {
  const flag = env.TAKOSUMI_AUTO_PLAN_STALE_CAPSULES;
  return typeof flag === "string" && flag === "1";
}

async function runScheduledStaleCapsuleAutoPlan(
  env: DeployControlEnv,
): Promise<void> {
  const operations = await deployControlSeam(env).operations();
  await planStaleCapsuleUpdates(operations, {
    workspaceLimit: SCHEDULED_STALE_AUTO_PLAN_WORKSPACE_LIMIT,
    runLookback: SCHEDULED_STALE_AUTO_PLAN_RUN_LOOKBACK,
  });
}

export interface StaleCapsuleAutoPlanResult {
  readonly workspacesScanned: number;
  readonly staleCapsulesScanned: number;
  readonly plansCreated: number;
}

export async function planStaleCapsuleUpdates(
  operations: StaleCapsuleAutoPlanOperations,
  options: {
    readonly workspaceLimit?: number;
    readonly runLookback?: number;
  } = {},
): Promise<StaleCapsuleAutoPlanResult> {
  const workspaceLimit = positiveInteger(
    options.workspaceLimit,
    SCHEDULED_STALE_AUTO_PLAN_WORKSPACE_LIMIT,
  );
  const runLookback = positiveInteger(
    options.runLookback,
    SCHEDULED_STALE_AUTO_PLAN_RUN_LOOKBACK,
  );
  const workspaces = (await operations.workspaces.listWorkspaces())
    .filter((workspace) => !workspace.archivedAt)
    .slice(0, workspaceLimit);
  let staleCapsulesScanned = 0;
  let plansCreated = 0;
  for (const workspace of workspaces) {
    let staleCapsules: readonly Capsule[];
    try {
      staleCapsules = (
        await operations.capsules.listCapsules(workspace.id)
      ).filter((capsule) => capsule.status === "stale");
    } catch {
      continue;
    }
    if (staleCapsules.length === 0) continue;
    staleCapsulesScanned += staleCapsules.length;
    let pendingRuns: readonly Run[];
    try {
      pendingRuns = await operations.controller.listRuns(workspace.id, {
        limit: runLookback,
      });
    } catch {
      continue;
    }
    const pendingPlanCapsuleIds = new Set(
      pendingRuns
        .filter(isPendingCapsulePlan)
        .map((run) => run.capsuleId)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    );
    for (const capsule of staleCapsules) {
      if (pendingPlanCapsuleIds.has(capsule.id)) continue;
      try {
        await operations.createCapsulePlan(capsule.id);
        pendingPlanCapsuleIds.add(capsule.id);
        plansCreated += 1;
      } catch {
        // Best-effort: one bad Capsule must not abort other update plans.
      }
    }
  }
  return {
    workspacesScanned: workspaces.length,
    staleCapsulesScanned,
    plansCreated,
  };
}

function isPendingCapsulePlan(run: Run): boolean {
  return (
    run.type === "plan" &&
    (run.status === "queued" ||
      run.status === "running" ||
      run.status === "waiting_approval") &&
    typeof run.capsuleId === "string"
  );
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

export interface OpenTofuRunRepairResult {
  readonly workspacesScanned: number;
  readonly runsScanned: number;
  readonly rescheduled: number;
}

async function runScheduledOpenTofuRunRepair(
  env: DeployControlEnv,
): Promise<void> {
  if (!env.RUN_OWNER) return;
  const operations = await deployControlSeam(env).operations();
  await repairStaleOpenTofuRuns(
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
}

/**
 * Scheduled run repair safety net. Creation already schedules the per-run owner
 * directly for speed; this bounded sweep re-pokes old non-terminal rows whose
 * owner alarm/record was lost and terminal provider-applied rows with a durable
 * pending billing-finalization marker. The controller consumers stay
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
  const workspaces = (await operations.workspaces.listWorkspaces())
    .filter((workspace) => !workspace.archivedAt)
    .slice(0, Math.max(0, Math.floor(workspaceLimit)));
  const activeWorkspaceIds = new Set(
    workspaces.map((workspace) => workspace.id),
  );
  const runLimit = Math.max(
    0,
    Math.floor(runsPerWorkspace) * Math.max(1, workspaces.length),
  );
  let runsScanned = 0;
  let rescheduled = 0;
  try {
    const runs = await operations.controller.listRecoverableOpenTofuRuns({
      staleQueuedBeforeMs: now - queuedStaleMs,
      staleRunningBeforeMs: now - runningStaleMs,
      limit: runLimit,
    });
    runsScanned = runs.length;
    for (const run of runs) {
      const workspaceId = run.workspaceId;
      if (!workspaceId || !activeWorkspaceIds.has(workspaceId)) continue;
      const dispatch = recoverableRunDispatch(run, now, {
        queuedStaleMs,
        runningStaleMs,
        fallbackWorkspaceId: workspaceId,
      });
      if (!dispatch) continue;
      await scheduler.schedule(dispatch);
      rescheduled += 1;
    }
  } catch {
    // Best-effort: a repair failure must not abort the cron tick.
  }
  return { workspacesScanned: workspaces.length, runsScanned, rescheduled };
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

const RESOURCE_OBSERVATION_MAX_BATCH = 32;
const RESOURCE_OBSERVATION_MAX_CONCURRENCY = 8;
const RESOURCE_OBSERVATION_MIN_INTERVAL_SECONDS = 5 * 60;
const RESOURCE_OBSERVATION_MAX_INTERVAL_SECONDS = 7 * 24 * 60 * 60;
const RESOURCE_OBSERVATION_MIN_LEASE_SECONDS = 10 * 60;
const RESOURCE_OBSERVATION_MAX_LEASE_SECONDS = 2 * 60 * 60;

/**
 * Read-only Resource observation follows the host's enabled Resource Shape
 * capability unless the operator explicitly overrides it with `0` or `1`.
 */
export function resourceObservationEnabled(env: CloudflareWorkerEnv): boolean {
  const configured = env.TAKOSUMI_RESOURCE_OBSERVATION_ENABLED;
  if (configured !== undefined) {
    return typeof configured === "string" && configured === "1";
  }
  return (
    resourceShapeCapabilityTokens(
      env.TAKOSUMI_RESOURCE_SHAPES,
      resourceShapeHostContributionsFromEnv(env).schemaRegistry,
    ).length > 0
  );
}

export function scheduledResourceObservationOptions(
  env: CloudflareWorkerEnv,
): Required<
  Pick<
    ResourceObservationSweepOptions,
    "limit" | "concurrency" | "intervalMs" | "leaseMs"
  >
> {
  const limit = boundedEnvInteger(
    env.TAKOSUMI_RESOURCE_OBSERVATION_BATCH,
    RESOURCE_OBSERVATION_DEFAULT_LIMIT,
    1,
    RESOURCE_OBSERVATION_MAX_BATCH,
  );
  const concurrency = Math.min(
    limit,
    boundedEnvInteger(
      env.TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY,
      RESOURCE_OBSERVATION_DEFAULT_CONCURRENCY,
      1,
      RESOURCE_OBSERVATION_MAX_CONCURRENCY,
    ),
  );
  const intervalSeconds = boundedEnvInteger(
    env.TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS,
    RESOURCE_OBSERVATION_DEFAULT_INTERVAL_MS / 1000,
    RESOURCE_OBSERVATION_MIN_INTERVAL_SECONDS,
    RESOURCE_OBSERVATION_MAX_INTERVAL_SECONDS,
  );
  const leaseSeconds = boundedEnvInteger(
    env.TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS,
    RESOURCE_OBSERVATION_DEFAULT_LEASE_MS / 1000,
    RESOURCE_OBSERVATION_MIN_LEASE_SECONDS,
    RESOURCE_OBSERVATION_MAX_LEASE_SECONDS,
  );
  return {
    limit,
    concurrency,
    intervalMs: intervalSeconds * 1000,
    leaseMs: leaseSeconds * 1000,
  };
}

async function runScheduledResourceObservation(
  env: CloudflareWorkerEnv,
): Promise<void> {
  const service = await cachedDeployControlService(env);
  const operations = service.operations.resourceObservation;
  if (!operations) return;
  const result = await resourceObservationSweep(
    operations,
    scheduledResourceObservationOptions(env),
  );
  const counts = {
    claimed: result.claimed,
    observed: result.observed,
    failed: result.failed,
    lease_lost: result.leaseLost,
    claim_error: result.claimErrors,
  } as const;
  await Promise.all(
    Object.entries(counts).map(([outcome, value]) =>
      recordWorkerMetric({
        observability: service.context.adapters.observability,
        env,
        name: "takosumi_resource_observation_count",
        kind: "counter",
        value,
        tags: { outcome },
      }),
    ),
  );
}

async function runScheduledResourceOperationRepair(
  env: CloudflareWorkerEnv,
): Promise<void> {
  const service = await cachedDeployControlService(env);
  const repair = service.operations.resourceOperationRepair;
  if (!repair) return;
  const result = await repairDirectResourceRuns(repair, { limit: 100 });
  await Promise.all(
    Object.entries(result).map(([outcome, value]) =>
      recordWorkerMetric({
        observability: service.context.adapters.observability,
        env,
        name: "takosumi_resource_operation_repair_count",
        kind: "counter",
        value,
        tags: { outcome },
      }),
    ),
  );
}

export interface ScheduledResourceOperationRepairResult {
  readonly scanned: number;
  readonly completed: number;
  readonly auditsRepaired: number;
  readonly pending: number;
  readonly failures: number;
}

/** Bounded, failure-isolated adapter used by the platform cron wiring. */
export async function repairDirectResourceRuns(
  repair: {
    repair(options?: {
      readonly workspaceId?: string;
      readonly limit?: number;
    }): Promise<{
      readonly scanned: number;
      readonly completed: number;
      readonly auditsRepaired: number;
      readonly pending: number;
    }>;
  },
  options: { readonly limit?: number } = {},
): Promise<ScheduledResourceOperationRepairResult> {
  const limit = positiveInteger(options.limit, 100);
  try {
    return { ...(await repair.repair({ limit })), failures: 0 };
  } catch {
    // A transient Run-ledger outage must not suppress source polling, drift,
    // stale-plan handling, or Resource observation in the same cron tick.
    return {
      scanned: 0,
      completed: 0,
      auditsRepaired: 0,
      pending: 0,
      failures: 1,
    };
  }
}

function boundedEnvInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return fallback;
  }
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

// Cap so a single cron tick never creates an unbounded number of drift checks.
const SCHEDULED_DRIFT_SWEEP_LIMIT = 20;

/**
 * Drift-check flag (spec §28; Phase 8). The scheduled drift sweep runs ONLY when
 * `TAKOSUMI_DRIFT_CHECK_ENABLED=1` (default OFF), mirroring how the platform
 * keeps the new sweep opt-in alongside the always-on source poll.
 */
export function driftCheckEnabled(env: CloudflareWorkerEnv): boolean {
  const flag = env.TAKOSUMI_DRIFT_CHECK_ENABLED;
  return typeof flag === "string" && flag === "1";
}

async function runScheduledDriftSweep(env: DeployControlEnv): Promise<void> {
  const operations = await deployControlSeam(env).operations();
  // Adapt the two methods the sweep needs: active Capsule listing from the
  // controller and grouped drift checks through the current compatibility service.
  const driftOps: DriftSweepOperations = {
    listActiveCapsules: (limit) =>
      operations.controller.listActiveCapsules(limit),
    createWorkspaceDriftCheck: (workspaceId, options) =>
      operations.runGroups.createWorkspaceDriftCheck(workspaceId, options),
  };
  await driftSweep(driftOps, { limit: SCHEDULED_DRIFT_SWEEP_LIMIT });
}
