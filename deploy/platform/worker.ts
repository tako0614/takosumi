// THE operator-deployed Takosumi platform worker (app.takosumi.com).
//
// This single worker hosts the accounts plane (bare-origin OIDC issuer +
// dashboard SPA) and the OpenTofu-native deploy-control plane in one process.
// The accounts handler owns the public HTTP surface and serves the dashboard SPA
// from its built-in ASSETS fallback (non-API GET/HEAD). Public `/api` control
// routes are still the current compatibility surface. Public Takosumi wording
// maps that surface to Workspace / Project / Capsule / Source /
// ProviderConnection / CredentialRecipe / ProviderBinding / Secret / Run /
// StateVersion / Output / Runner / AuditEvent / Backup while migration from
// legacy Space / Installation / Deployment rows continues. This platform worker reaches the
// deploy-control implementation in-process through the typed `operations` seam
// injected below. There is no separate control-plane worker.
// The two Durable Object classes (coordination leases/alarms + the OpenTofu
// Container runner) are re-exported so the wrangler bindings/migrations can
// name them.

import {
  type CloudflareWorkerEnv,
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
import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import { TAKOSUMI_METRICS_PATH } from "../../core/api/metrics_routes.ts";
import type { RuntimeAgentRegistry } from "../../core/agents/types.ts";
import type {
  BillingSettings,
  UsageEventKind,
  UsageResourceMetadata,
  UsageResourceMetadataValue,
} from "takosumi-contract/billing";
import type { TakosumiOperations } from "../../core/bootstrap.ts";
import {
  OpenTofuControllerError,
  type RecordMeteredUsageInput,
} from "../../core/domains/deploy-control/mod.ts";
import {
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  pathIsUnderBase,
  platformCloudExtensionRoutes,
  type PlatformCloudExtensionRoute,
} from "./cloud_extensions.ts";
export {
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  pathIsUnderBase,
  platformCloudExtensionRoutes,
  PLATFORM_CLOUD_EXTENSION_CATALOG_PATH,
} from "./cloud_extensions.ts";

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
type PlatformEnv = CloudflareWorkerEnv | DeployControlEnv;

const seams = new WeakMap<
  object,
  ReturnType<typeof createInProcessDeployControlSeam>
>();

function deployControlSeam(env: PlatformEnv) {
  let seam = seams.get(env);
  if (!seam) {
    seam = createInProcessDeployControlSeam(env as unknown as DeployControlEnv);
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

const accountsWorker = createCloudflareWorker({
  deployControlOperations: (env) => deployControlSeam(env).operations(),
  // The session-authed `/api/v1/*` dashboard surface (M10) reads the SAME
  // in-process operations facade the deploy-control facade uses, adapted to the
  // `ControlPlaneOperations` shape (see `controlPlaneOperationsFor`).
  controlPlaneOperations: (env) => controlPlaneOperationsFor(env),
});

// The platform worker owns the public fetch surface (accounts handler) AND runs
// the OpenTofu run-queue consumer in-process. The consumer reaches the same
// deploy-control operations facade as the accounts surface, so a run dispatched
// by the create path is executed here against the same store.
const runQueueConsumer = createDeployControlQueueConsumer();

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
    const metricsResponse = await handlePlatformMetricsRequest(request, env);
    if (metricsResponse) return metricsResponse;
    const url = new URL(request.url);
    if (url.pathname === "/internal/platform/hardening-gates") {
      return handleHardeningGatesRequest(request, env);
    }
    if (isPlatformRuntimeCellDrillPath(url.pathname)) {
      const response = await handlePlatformRuntimeCellDrillRequest(
        request,
        url,
        env,
        await runtimeAgentRegistryFor(env),
      );
      return response ?? Response.json({ error: "not found" }, { status: 404 });
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
    if (isPlatformCloudExtensionCatalogPath(url.pathname)) {
      return handlePlatformCloudExtensionCatalogRequest(request, url, env);
    }
    const cloudExtensionRoute = matchPlatformCloudExtensionRoute(
      url.pathname,
      platformCloudExtensionRoutes(
        env as unknown as { readonly [key: string]: unknown },
      ),
    );
    if (cloudExtensionRoute) {
      return await handlePlatformCloudExtensionRouteRequest(
        request,
        env,
        cloudExtensionRoute,
        verifyPlatformCloudExtensionSession,
      );
    }
    // Source webhook surface (Core Specification §6). This is a NEW top-level
    // prefix the accounts handler does not own; handle it here via the
    // deploy-control service seam BEFORE delegating to the accounts handler.
    if (url.pathname.startsWith("/hooks/sources/")) {
      return await handleSourceWebhook(request, url, env);
    }
    const accountsResponse = await accountsWorker.fetch(request, env);
    if (isOidcMetricPath(url.pathname)) {
      await recordPlatformOidcMetric(request, url, env, accountsResponse);
    }
    return accountsResponse;
  },
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
    return runQueueConsumer(batch, env as unknown as DeployControlEnv);
  },
  // Scheduled cron tick. Always runs source polling (Core Specification §6: scan
  // active autoSync sources and enqueue a deduped source_sync). When the
  // `TAKOSUMI_DRIFT_CHECK_ENABLED=1` flag is set (default OFF), ALSO runs the
  // current compatibility drift sweep for Workspaces with active Capsules.
  async scheduled(_event: unknown, env: CloudflareWorkerEnv): Promise<void> {
    await runScheduledSourcePoll(env as unknown as DeployControlEnv);
    if (driftCheckEnabled(env)) {
      await runScheduledDriftSweep(env as unknown as DeployControlEnv);
    }
  },
};

async function recordPlatformOidcMetric(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  response: Response,
): Promise<void> {
  try {
    const service = await cachedDeployControlService(
      env as unknown as DeployControlEnv,
    );
    await recordWorkerMetric({
      observability: service.context.adapters.observability,
      env: env as unknown as DeployControlEnv,
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
  "runtime_cell_id",
  "space_id",
  "capsule_id",
  "operationKind",
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

const SPACE_ID_PATTERN = /^space_[0-9a-zA-Z]{8,64}$/;
const RUNTIME_CELL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const INTERNAL_PLATFORM_RUNTIME_CELL_PREFIX =
  "/internal/platform/runtime-cells/";
const INTERNAL_PLATFORM_RUNTIME_CELL_DRILL_SUFFIX = "/drill";
const INTERNAL_PLATFORM_SPACE_PREFIX = "/internal/platform/spaces/";
const INTERNAL_PLATFORM_SPACE_BILLING_SUFFIX = "/billing";
const INTERNAL_PLATFORM_SPACE_CREDITS_TOP_UP_SUFFIX = "/credits/top-up";
const INTERNAL_PLATFORM_SPACE_SUBSCRIPTION_CHANGE_SUFFIX =
  "/subscription/change";

async function runtimeAgentRegistryFor(
  env: CloudflareWorkerEnv,
): Promise<RuntimeAgentRegistry> {
  const service = await cachedDeployControlService(
    env as unknown as DeployControlEnv,
  );
  return service.context.adapters.runtimeAgent;
}

export type PlatformRuntimeCellDrillAction = "drain" | "evacuation";

export interface PlatformRuntimeCellDrillResult {
  readonly kind: "takosumi.platform-runtime-cell-drill@v1";
  readonly action: PlatformRuntimeCellDrillAction;
  readonly runtimeCellId: string;
  readonly eventId?: string;
  readonly evacuationRunId?: string;
  readonly agentId: string;
  readonly workId: string;
  readonly status: "completed";
  readonly requestedAt: string;
  readonly completedAt: string;
}

export async function handlePlatformRuntimeCellDrillRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  registry: RuntimeAgentRegistry,
): Promise<Response | undefined> {
  const runtimeCellId = runtimeCellIdFromInternalPlatformPath(url.pathname);
  if (runtimeCellId === undefined) return undefined;
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = requireDeployControlBearer(request, env);
  if (auth) return auth;
  const body = await readJsonRecord(request);
  if (!body.ok) return body.response;
  const action = parsePlatformRuntimeCellDrillAction(body.value.action);
  if (!action) {
    return Response.json(
      {
        error: "invalid_request",
        error_description: "action must be drain or evacuation",
      },
      { status: 400 },
    );
  }
  const result = await runPlatformRuntimeCellDrill({
    action,
    runtimeCellId,
    registry,
    reason:
      optionalString(body.value.reason) ??
      "platform-readiness-shared-cell-runtime-drill",
  });
  return Response.json(result, { status: 200 });
}

export function isPlatformRuntimeCellDrillPath(pathname: string): boolean {
  return runtimeCellIdFromInternalPlatformPath(pathname) !== undefined;
}

async function runPlatformRuntimeCellDrill(input: {
  readonly action: PlatformRuntimeCellDrillAction;
  readonly runtimeCellId: string;
  readonly registry: RuntimeAgentRegistry;
  readonly reason: string;
}): Promise<PlatformRuntimeCellDrillResult> {
  const requestedAt = new Date().toISOString();
  const drillId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const agentId = `agent_drill_${input.runtimeCellId}_${drillId}`;
  const workPrefix =
    input.action === "drain" ? "runtime_drain" : "runtime_evac";
  const workId = `${workPrefix}_${input.runtimeCellId}_${drillId}`;
  await input.registry.register({
    agentId,
    provider: "operator-drill",
    capabilities: {
      providers: ["operator-drill"],
      maxConcurrentLeases: 1,
      labels: {
        runtimeCellId: input.runtimeCellId,
        drillAction: input.action,
      },
    },
    metadata: {
      runtimeCellId: input.runtimeCellId,
      action: input.action,
      reason: input.reason,
      drillId,
    },
    heartbeatAt: requestedAt,
  });
  const work = await input.registry.enqueueWork({
    workId,
    kind: `runtime.cell.${input.action}.drill`,
    provider: "operator-drill",
    payload: {
      runtimeCellId: input.runtimeCellId,
      action: input.action,
      reason: input.reason,
    },
    metadata: {
      runtimeCellId: input.runtimeCellId,
      action: input.action,
      reason: input.reason,
      drillId,
    },
    queuedAt: requestedAt,
    idempotencyKey: workId,
  });
  const lease = await input.registry.leaseWork({
    agentId,
    now: requestedAt,
  });
  if (!lease || lease.workId !== work.id) {
    throw new Error("runtime-cell drill work was not leased by scratch agent");
  }
  const completedAt = new Date().toISOString();
  await input.registry.completeWork({
    agentId,
    leaseId: lease.id,
    completedAt,
    result: {
      runtimeCellId: input.runtimeCellId,
      action: input.action,
      drillId,
      status: "completed",
    },
  });
  if (input.action === "drain") {
    await input.registry.requestDrain(agentId, completedAt);
  }
  return {
    kind: "takosumi.platform-runtime-cell-drill@v1",
    action: input.action,
    runtimeCellId: input.runtimeCellId,
    ...(input.action === "drain"
      ? { eventId: workId }
      : { evacuationRunId: workId }),
    agentId,
    workId,
    status: "completed",
    requestedAt,
    completedAt,
  };
}

function runtimeCellIdFromInternalPlatformPath(
  pathname: string,
): string | undefined {
  if (!pathname.startsWith(INTERNAL_PLATFORM_RUNTIME_CELL_PREFIX)) {
    return undefined;
  }
  if (!pathname.endsWith(INTERNAL_PLATFORM_RUNTIME_CELL_DRILL_SUFFIX)) {
    return undefined;
  }
  const encoded = pathname.slice(
    INTERNAL_PLATFORM_RUNTIME_CELL_PREFIX.length,
    pathname.length - INTERNAL_PLATFORM_RUNTIME_CELL_DRILL_SUFFIX.length,
  );
  if (!encoded || encoded.includes("/")) return undefined;
  const runtimeCellId = decodeURIComponent(encoded);
  return RUNTIME_CELL_ID_PATTERN.test(runtimeCellId)
    ? runtimeCellId
    : undefined;
}

function parsePlatformRuntimeCellDrillAction(
  value: unknown,
): PlatformRuntimeCellDrillAction | undefined {
  return value === "drain" || value === "evacuation" ? value : undefined;
}

export function isOperatorBillingPath(pathname: string): boolean {
  return (
    spaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_SPACE_BILLING_SUFFIX,
    ) !== undefined ||
    spaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_SPACE_CREDITS_TOP_UP_SUFFIX,
    ) !== undefined ||
    spaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_SPACE_SUBSCRIPTION_CHANGE_SUFFIX,
    ) !== undefined
  );
}

export interface OperatorBillingOperations {
  getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: unknown;
    };
  }>;
  changeWorkspaceSubscription(
    workspaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
  topUpWorkspaceCredits(
    workspaceId: string,
    input: { readonly usdMicros?: number; readonly credits?: number },
  ): Promise<{ readonly balance: unknown }>;
}

export async function handleOperatorBillingRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
  operations: OperatorBillingOperations,
): Promise<Response | undefined> {
  const billingSpaceId = spaceIdFromInternalPlatformPath(
    url.pathname,
    INTERNAL_PLATFORM_SPACE_BILLING_SUFFIX,
  );
  if (billingSpaceId !== undefined) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const auth = requireDeployControlBearer(request, env);
    if (auth) return auth;
    const result = await operations.getWorkspaceBilling(billingSpaceId);
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return Response.json(result, { status: 200 });
  }

  const topUpSpaceId = spaceIdFromInternalPlatformPath(
    url.pathname,
    INTERNAL_PLATFORM_SPACE_CREDITS_TOP_UP_SUFFIX,
  );
  if (topUpSpaceId !== undefined) {
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const auth = requireDeployControlBearer(request, env);
    if (auth) return auth;
    const body = await readJsonRecord(request);
    if (!body.ok) return body.response;
    return Response.json(
      await operations.topUpWorkspaceCredits(topUpSpaceId, {
        ...(typeof body.value.usdMicros === "number"
          ? { usdMicros: body.value.usdMicros }
          : {}),
        ...(typeof body.value.credits === "number"
          ? { credits: body.value.credits }
          : {}),
      }),
      { status: 200 },
    );
  }

  const subscriptionSpaceId = spaceIdFromInternalPlatformPath(
    url.pathname,
    INTERNAL_PLATFORM_SPACE_SUBSCRIPTION_CHANGE_SUFFIX,
  );
  if (subscriptionSpaceId === undefined) return undefined;
  if (request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const auth = requireDeployControlBearer(request, env);
  if (auth) return auth;
  const body = await readJsonRecord(request);
  if (!body.ok) return body.response;
  const billingSettings = parseBillingSettings(body.value.billingSettings);
  if (!billingSettings.ok) {
    return Response.json(
      { error: "invalid_request", error_description: billingSettings.error },
      { status: 400 },
    );
  }
  return Response.json(
    await operations.changeWorkspaceSubscription(subscriptionSpaceId, {
      billingSettings: billingSettings.value,
    }),
    { status: 200 },
  );
}

function spaceIdFromInternalPlatformPath(
  pathname: string,
  suffix: string,
): string | undefined {
  if (!pathname.startsWith(INTERNAL_PLATFORM_SPACE_PREFIX)) return undefined;
  if (!pathname.endsWith(suffix)) return undefined;
  const encoded = pathname.slice(
    INTERNAL_PLATFORM_SPACE_PREFIX.length,
    pathname.length - suffix.length,
  );
  if (!encoded || encoded.includes("/")) return undefined;
  const spaceId = decodeURIComponent(encoded);
  return SPACE_ID_PATTERN.test(spaceId) ? spaceId : undefined;
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

function parseBillingSettings(
  value: unknown,
):
  | { readonly ok: true; readonly value: BillingSettings }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: "billingSettings must be an object" };
  }
  if (value.mode === "disabled") {
    return value.provider === "none"
      ? { ok: true, value: { mode: "disabled", provider: "none" } }
      : { ok: false, error: "disabled billing requires provider none" };
  }
  if (value.mode === "showback") {
    if (!isBillingProvider(value.provider)) {
      return {
        ok: false,
        error: "showback billing provider must be stripe, manual, or none",
      };
    }
    if (
      value.reservationRequired !== undefined &&
      value.reservationRequired !== false
    ) {
      return {
        ok: false,
        error:
          "showback billing reservationRequired must be false when provided",
      };
    }
    return {
      ok: true,
      value: {
        mode: "showback",
        provider: value.provider,
        ...(value.reservationRequired === false
          ? { reservationRequired: false }
          : {}),
      },
    };
  }
  // `enforce` is a Takosumi Cloud-only closed mode. OSS / the operator platform
  // worker never accepts it: the only billing modes are disabled | showback.
  return { ok: false, error: "unknown billing mode" };
}

function isBillingProvider(
  value: unknown,
): value is "stripe" | "manual" | "none" {
  return value === "stripe" || value === "manual" || value === "none";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface PlatformCloudExtensionCatalogItem {
  readonly basePath: `/${string}`;
  readonly configured: boolean;
  readonly requiredScopes?: readonly string[];
}

export interface PlatformCloudExtensionCatalog {
  readonly kind: "takosumi.platform-cloud-extensions@v1";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly extensions: readonly PlatformCloudExtensionCatalogItem[];
  readonly summary: {
    readonly total: number;
    readonly configured: number;
    readonly missing: number;
  };
}

export function platformCloudExtensionCatalog(
  env: CloudflareWorkerEnv,
  origin: string,
): PlatformCloudExtensionCatalog {
  const extensions = platformCloudExtensionRoutes(
    env as unknown as { readonly [key: string]: unknown },
  ).map((route) => ({
    basePath: route.basePath,
    configured:
      platformCloudExtensionBinding(env, route.bindingName) !== undefined,
    ...(route.requiredScopes ? { requiredScopes: route.requiredScopes } : {}),
  }));
  const configured = extensions.filter(
    (extension) => extension.configured,
  ).length;
  return {
    kind: "takosumi.platform-cloud-extensions@v1",
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

export function handlePlatformCloudExtensionCatalogRequest(
  request: Request,
  url: URL,
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
  return Response.json(platformCloudExtensionCatalog(env, url.origin), {
    headers,
  });
}

export async function handlePlatformCloudExtensionRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response | undefined> {
  const route = matchPlatformCloudExtensionRoute(
    new URL(request.url).pathname,
    platformCloudExtensionRoutes(
      env as unknown as { readonly [key: string]: unknown },
    ),
  );
  if (!route) return undefined;
  return await handlePlatformCloudExtensionRouteRequest(
    request,
    env,
    route,
    verifyPlatformCloudExtensionSession,
  );
}

export async function handlePlatformCloudExtensionRouteRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformCloudExtensionRoute,
  sessionVerifier: PlatformCloudExtensionSessionVerifier = verifyPlatformCloudExtensionSession,
  usageRecorder: PlatformCloudExtensionUsageRecorder = async (
    spaceId,
    input,
  ) => {
    await (await takosumiOperationsFor(env)).recordMeteredUsage(spaceId, input);
  },
): Promise<Response> {
  const binding = platformCloudExtensionBinding(env, route.bindingName);
  if (!binding) return Response.json({ error: "not found" }, { status: 404 });
  const authContext = await platformCloudExtensionAuthContext(
    request,
    env,
    route,
    sessionVerifier,
  );
  if (!authContext.ok) return authContext.response;
  if (
    fallbackPlatformCloudUsageMeter(
      authContext.request,
      route,
      authContext.session,
    ) &&
    !authContext.session.spaceId
  ) {
    return platformCloudExtensionUsageFailure("usage_workspace_id_missing")
      .response;
  }
  const upstreamResponse = await binding.fetch(authContext.request);
  return await responseForPlatformCloudExtensionClient(
    authContext.request,
    upstreamResponse,
    env,
    route,
    authContext.session,
    usageRecorder,
  );
}

export interface PlatformCloudExtensionSessionContext {
  readonly authenticated: boolean;
  readonly authKind?: "service-token" | "personal-access-token" | "session";
  readonly subject?: string;
  readonly installationId?: string;
  readonly spaceId?: string;
  readonly scopes?: readonly string[];
}

export type PlatformCloudExtensionSessionVerifier = (
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformCloudExtensionRoute,
) => Promise<PlatformCloudExtensionSessionContext>;

const PLATFORM_CLOUD_EXTENSION_AUTHENTICATED_HEADER =
  "x-takosumi-cloud-authenticated";
const PLATFORM_CLOUD_EXTENSION_SUBJECT_HEADER = "x-takosumi-cloud-subject";
const PLATFORM_CLOUD_EXTENSION_AUTH_KIND_HEADER = "x-takosumi-cloud-auth-kind";
const PLATFORM_CLOUD_EXTENSION_SCOPES_HEADER = "x-takosumi-cloud-scopes";
const PLATFORM_CLOUD_EXTENSION_INSTALLATION_ID_HEADER =
  "x-takosumi-cloud-installation-id";
const PLATFORM_CLOUD_EXTENSION_SPACE_ID_HEADER = "x-takosumi-cloud-space-id";
const PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER =
  "x-takosumi-cloud-billing-workspace-id";
const PLATFORM_CLOUD_EXTENSION_BILLING_INSTALLATION_ID_HEADER =
  "x-takosumi-cloud-billing-installation-id";

const PLATFORM_CLOUD_EXTENSION_RAW_CREDENTIAL_HEADERS = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-auth-email",
  "x-auth-key",
  "x-auth-user-service-key",
  "x-takosumi-account-session",
] as const;

const PLATFORM_CLOUD_EXTENSION_TRUSTED_CONTEXT_HEADERS = [
  PLATFORM_CLOUD_EXTENSION_AUTHENTICATED_HEADER,
  PLATFORM_CLOUD_EXTENSION_SUBJECT_HEADER,
  PLATFORM_CLOUD_EXTENSION_AUTH_KIND_HEADER,
  PLATFORM_CLOUD_EXTENSION_SCOPES_HEADER,
  PLATFORM_CLOUD_EXTENSION_INSTALLATION_ID_HEADER,
  PLATFORM_CLOUD_EXTENSION_SPACE_ID_HEADER,
] as const;

const PLATFORM_CLOUD_EXTENSION_BILLING_CONTEXT_HEADERS = [
  PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER,
  PLATFORM_CLOUD_EXTENSION_BILLING_INSTALLATION_ID_HEADER,
] as const;

async function platformCloudExtensionAuthContext(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformCloudExtensionRoute | undefined,
  sessionVerifier: PlatformCloudExtensionSessionVerifier,
): Promise<
  | {
      readonly ok: true;
      readonly request: Request;
      readonly session: PlatformCloudExtensionSessionContext;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const session = await sessionVerifier(request, env, route);
  const headers = new Headers(request.headers);
  for (const header of PLATFORM_CLOUD_EXTENSION_RAW_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  for (const header of PLATFORM_CLOUD_EXTENSION_TRUSTED_CONTEXT_HEADERS) {
    headers.delete(header);
  }
  for (const header of PLATFORM_CLOUD_EXTENSION_BILLING_CONTEXT_HEADERS) {
    headers.delete(header);
  }
  // Descriptor-level scope enforcement applies only to token-based auth
  // (service token / personal access token); a full human session is allowed
  // through and the bound Cloud service performs any finer authorization.
  const requiredScopes = route?.requiredScopes ?? [];
  if (
    requiredScopes.length > 0 &&
    (session.authKind === "service-token" ||
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
      ok: true,
      request: clonePlatformCloudExtensionRequest(request, headers),
      session,
    };
  }
  const verifiedSession = await platformCloudExtensionVerifiedBillingSession(
    request,
    env,
    session,
  );
  if (!verifiedSession.ok) return verifiedSession;
  const sessionContext = verifiedSession.session;
  headers.set(PLATFORM_CLOUD_EXTENSION_AUTHENTICATED_HEADER, "1");
  if (sessionContext.authKind) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_AUTH_KIND_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.authKind),
    );
  }
  if (sessionContext.scopes && sessionContext.scopes.length > 0) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SCOPES_HEADER,
      sessionContext.scopes.map(safeCloudExtensionHeaderValue).join(" "),
    );
  }
  if (sessionContext.subject) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SUBJECT_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.subject),
    );
  }
  if (sessionContext.installationId) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_INSTALLATION_ID_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.installationId),
    );
    headers.set(
      PLATFORM_CLOUD_EXTENSION_BILLING_INSTALLATION_ID_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.installationId),
    );
  }
  if (sessionContext.spaceId) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SPACE_ID_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.spaceId),
    );
    headers.set(
      PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER,
      safeCloudExtensionHeaderValue(sessionContext.spaceId),
    );
  }
  return {
    ok: true,
    request: clonePlatformCloudExtensionRequest(request, headers),
    session: sessionContext,
  };
}

async function platformCloudExtensionVerifiedBillingSession(
  request: Request,
  env: CloudflareWorkerEnv,
  session: PlatformCloudExtensionSessionContext,
): Promise<
  | {
      readonly ok: true;
      readonly session: PlatformCloudExtensionSessionContext;
    }
  | { readonly ok: false; readonly response: Response }
> {
  const requested = platformCloudExtensionRequestedBillingContext(request);
  let verifiedSpaceId = safePlatformCloudExtensionContextId(session.spaceId);
  let verifiedInstallationId = safePlatformCloudExtensionContextId(
    session.installationId,
  );

  if (requested.spaceId) {
    if (verifiedSpaceId && requested.spaceId !== verifiedSpaceId) {
      return platformCloudExtensionUsageFailure("usage_workspace_id_mismatch");
    }
    if (!verifiedSpaceId) {
      if (
        session.authKind !== "session" ||
        !(await platformCloudExtensionSessionCanAccessWorkspace(
          request,
          env,
          requested.spaceId,
        ))
      ) {
        return platformCloudExtensionUsageFailure(
          "usage_workspace_id_mismatch",
        );
      }
      verifiedSpaceId = requested.spaceId;
    }
  }

  if (requested.installationId) {
    if (
      verifiedInstallationId &&
      requested.installationId !== verifiedInstallationId
    ) {
      return platformCloudExtensionUsageFailure("usage_workspace_id_mismatch");
    }
    if (!verifiedInstallationId) {
      if (
        !verifiedSpaceId ||
        session.authKind !== "session" ||
        !(await platformCloudExtensionSessionCanAccessInstallation(
          request,
          env,
          requested.installationId,
          verifiedSpaceId,
        ))
      ) {
        return platformCloudExtensionUsageFailure(
          "usage_workspace_id_mismatch",
        );
      }
      verifiedInstallationId = requested.installationId;
    }
  }

  const {
    spaceId: _spaceId,
    installationId: _installationId,
    ...rest
  } = session;
  return {
    ok: true,
    session: {
      ...rest,
      ...(verifiedSpaceId ? { spaceId: verifiedSpaceId } : {}),
      ...(verifiedInstallationId
        ? { installationId: verifiedInstallationId }
        : {}),
    },
  };
}

function platformCloudExtensionRequestedBillingContext(request: Request): {
  readonly spaceId?: string;
  readonly installationId?: string;
} {
  const spaceId = safePlatformCloudExtensionContextId(
    request.headers.get(PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER),
  );
  const installationId = safePlatformCloudExtensionContextId(
    request.headers.get(
      PLATFORM_CLOUD_EXTENSION_BILLING_INSTALLATION_ID_HEADER,
    ),
  );
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(installationId ? { installationId } : {}),
  };
}

async function platformCloudExtensionSessionCanAccessWorkspace(
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

async function platformCloudExtensionSessionCanAccessInstallation(
  request: Request,
  env: CloudflareWorkerEnv,
  installationId: string,
  workspaceId: string,
): Promise<boolean> {
  const headers = sessionMirrorHeaders(request);
  if (!headers) return false;
  try {
    const response = await accountsWorker.fetch(
      new Request(
        new URL(
          `/api/v1/installations/${encodeURIComponent(installationId)}`,
          request.url,
        ),
        { method: "GET", headers },
      ),
      env,
    );
    if (!response.ok) return false;
    const body = await response.json().catch(() => undefined);
    const installation = objectRecord(objectRecord(body).installation);
    const resolvedWorkspaceId = safePlatformCloudExtensionContextId(
      valueString(installation.workspaceId) ??
        valueString(installation.spaceId),
    );
    return resolvedWorkspaceId === workspaceId;
  } catch {
    return false;
  }
}

function clonePlatformCloudExtensionRequest(
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

export type PlatformCloudExtensionUsageRecorder = (
  spaceId: string,
  input: RecordMeteredUsageInput,
) => Promise<void>;

async function responseForPlatformCloudExtensionClient(
  request: Request,
  response: Response,
  env: CloudflareWorkerEnv,
  route: PlatformCloudExtensionRoute,
  session: PlatformCloudExtensionSessionContext,
  usageRecorder: PlatformCloudExtensionUsageRecorder,
): Promise<Response> {
  const usageResult = await recordPlatformCloudExtensionUsage(
    request,
    response,
    env,
    route,
    session,
    usageRecorder,
  );
  if (!usageResult.ok) return usageResult.response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: platformCloudExtensionClientHeaders(response.headers),
  });
}

// Cloud-extension response metering (intentional forward infra, NOT accidental complexity).
// This is the Seam-A path that reads `x-takosumi-cloud-usage-*` headers off a bound Cloud
// extension's response and writes the OSS showback usage ledger via recordMeteredUsage. It is
// dormant in OSS standalone (no extension bound -> no emitter sends these headers), but it is
// live-wired through `export default { fetch }`, so do not delete it as unreachable.
const PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER =
  "x-takosumi-cloud-usage-space-id";
const PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER =
  "x-takosumi-cloud-usage-period-start";
const PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER =
  "x-takosumi-cloud-usage-period-end";
const PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER =
  "x-takosumi-cloud-usage-meters";
const PLATFORM_CLOUD_EXTENSION_USAGE_HEADERS = [
  PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER,
] as const;

interface PlatformCloudUsageMeter {
  readonly installationId?: string;
  readonly meterId: string;
  readonly resourceFamily?: string;
  readonly resourceId?: string;
  readonly operation?: string;
  readonly resourceMetadata?: UsageResourceMetadata;
  readonly kind: string;
  readonly quantity: number;
  readonly usdMicros?: number;
  readonly credits?: number;
}

interface PlatformCloudUsagePriceBook {
  readonly minimumGrossMarginBps: number;
  readonly meters: readonly PlatformCloudUsagePriceBookMeter[];
}

interface PlatformCloudUsagePriceBookMeter {
  readonly meterId?: string;
  readonly meterIdPrefix?: string;
  readonly kind: string;
  readonly chargeUsdMicrosPerUnit?: number;
  readonly chargeUsdMicrosPerMillionUnits?: number;
  readonly estimatedCostUsdMicrosPerUnit?: number;
  readonly estimatedCostUsdMicrosPerMillionUnits?: number;
  readonly minimumChargeUsdMicros?: number;
}

async function recordPlatformCloudExtensionUsage(
  request: Request,
  response: Response,
  env: CloudflareWorkerEnv,
  route: PlatformCloudExtensionRoute,
  session: PlatformCloudExtensionSessionContext,
  usageRecorder: PlatformCloudExtensionUsageRecorder,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly response: Response }
> {
  if (!response.ok) return { ok: true };
  const usage = platformCloudExtensionUsageEnvelope(
    request,
    response,
    route,
    session,
  );
  if (!usage) return { ok: true };
  const { rawMeters, spaceId, periodStart, periodEnd } = usage;
  if (!spaceId) {
    return platformCloudExtensionUsageFailure("usage_workspace_id_missing");
  }
  if (session.spaceId && session.spaceId !== spaceId) {
    return platformCloudExtensionUsageFailure("usage_workspace_id_mismatch");
  }
  if (
    !periodStart ||
    !periodEnd ||
    Date.parse(periodEnd) < Date.parse(periodStart)
  ) {
    return platformCloudExtensionUsageFailure("usage_period_invalid");
  }
  const meters = parsePlatformCloudUsageMeters(rawMeters);
  if (!meters.ok) return platformCloudExtensionUsageFailure(meters.error);
  const priceBook = parsePlatformCloudUsagePriceBook(
    env.TAKOSUMI_CLOUD_USAGE_PRICE_BOOK,
  );
  if (!priceBook.ok) return platformCloudExtensionUsageFailure(priceBook.error);

  for (const [index, meter] of meters.value.entries()) {
    const kind = platformCloudUsageEventKind(meter.kind);
    if (!kind) {
      return platformCloudExtensionUsageFailure("usage_kind_unsupported");
    }
    const usdMicros = pricePlatformCloudUsageMeter(meter, priceBook.value);
    if (!usdMicros.ok) {
      return platformCloudExtensionUsageFailure(usdMicros.error);
    }
    const input: RecordMeteredUsageInput = {
      ...(meter.installationId ? { installationId: meter.installationId } : {}),
      meterId: meter.meterId,
      ...(meter.resourceFamily ? { resourceFamily: meter.resourceFamily } : {}),
      ...(meter.resourceId ? { resourceId: meter.resourceId } : {}),
      ...(meter.operation ? { operation: meter.operation } : {}),
      ...(meter.resourceMetadata
        ? { resourceMetadata: meter.resourceMetadata }
        : {}),
      kind,
      quantity: meter.quantity,
      usdMicros: usdMicros.value,
      source: "resource_meter",
      spendRequired: true,
      idempotencyKey: [
        "cloud-extension",
        route.basePath,
        spaceId,
        periodStart,
        periodEnd,
        index,
        meter.meterId,
      ].join(":"),
      createdAt: periodEnd,
    };
    try {
      await usageRecorder(spaceId, input);
    } catch (error) {
      return platformCloudExtensionUsageFailure(
        platformCloudExtensionUsageRecordFailureReason(error),
      );
    }
  }
  return { ok: true };
}

interface PlatformCloudUsageEnvelope {
  readonly rawMeters: string;
  readonly spaceId?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

function platformCloudExtensionUsageEnvelope(
  request: Request,
  response: Response,
  route: PlatformCloudExtensionRoute,
  session: PlatformCloudExtensionSessionContext,
): PlatformCloudUsageEnvelope | undefined {
  const rawMeters = response.headers.get(
    PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER,
  );
  if (rawMeters) {
    return {
      rawMeters,
      spaceId: platformCloudExtensionUsageSpaceId(request, response, session),
      periodStart: isoHeaderValue(
        response.headers.get(
          PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
        ),
      ),
      periodEnd: isoHeaderValue(
        response.headers.get(PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER),
      ),
    };
  }

  const meter = fallbackPlatformCloudUsageMeter(request, route, session);
  if (!meter) return undefined;
  const periodEndMs = Date.now();
  return {
    rawMeters: JSON.stringify([meter]),
    spaceId:
      session.spaceId ??
      safePlatformCloudExtensionContextId(
        request.headers.get(
          PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER,
        ),
      ),
    periodStart: new Date(periodEndMs - 1).toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
  };
}

function platformCloudExtensionUsageSpaceId(
  request: Request,
  response: Response,
  session: PlatformCloudExtensionSessionContext,
): string | undefined {
  return (
    safePlatformCloudExtensionContextId(
      response.headers.get(PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER),
    ) ??
    session.spaceId ??
    safePlatformCloudExtensionContextId(
      request.headers.get(PLATFORM_CLOUD_EXTENSION_BILLING_WORKSPACE_ID_HEADER),
    )
  );
}

function fallbackPlatformCloudUsageMeter(
  request: Request,
  route: PlatformCloudExtensionRoute,
  session: PlatformCloudExtensionSessionContext,
): PlatformCloudUsageMeter | undefined {
  const rules = route.fallbackUsage ?? [];
  if (rules.length === 0) return undefined;
  const url = new URL(request.url);
  const suffix = url.pathname.slice(route.basePath.length) || "/";
  const method = request.method.toUpperCase();
  for (const rule of rules) {
    if (rule.methods && !rule.methods.includes(method)) continue;
    const match = matchPlatformCloudExtensionUsageTemplate(
      suffix,
      rule.pathTemplate,
    );
    if (!match) continue;
    const operation = rule.operationByMethod?.[method] ?? method.toLowerCase();
    const resourceIdParam = rule.resourceIdParam ?? "resourceId";
    const rawResourceId = match[resourceIdParam];
    const installationId =
      session.installationId ??
      safePlatformCloudExtensionContextId(
        request.headers.get(
          PLATFORM_CLOUD_EXTENSION_BILLING_INSTALLATION_ID_HEADER,
        ),
      );
    return {
      meterId: `${rule.meterIdPrefix}${operation}`,
      ...(rule.resourceFamily ? { resourceFamily: rule.resourceFamily } : {}),
      ...(rawResourceId
        ? {
            resourceId: `${rule.resourceIdPrefix ?? ""}${rawResourceId}`,
          }
        : {}),
      operation,
      kind: rule.kind,
      quantity: rule.quantity,
      ...(installationId ? { installationId } : {}),
    };
  }
  return undefined;
}

function matchPlatformCloudExtensionUsageTemplate(
  suffix: string,
  template: string,
): Record<string, string> | undefined {
  const pathSegments = pathSegmentsForUsageMatch(suffix);
  const templateSegments = pathSegmentsForUsageMatch(template);
  if (pathSegments.length !== templateSegments.length) return undefined;
  const params: Record<string, string> = {};
  for (const [index, templateSegment] of templateSegments.entries()) {
    const pathSegment = pathSegments[index];
    if (pathSegment === undefined) return undefined;
    if (templateSegment === "*") continue;
    if (templateSegment.startsWith(":")) {
      const key = templateSegment.slice(1);
      if (!key) return undefined;
      params[key] = pathSegment;
      continue;
    }
    if (templateSegment !== pathSegment) return undefined;
  }
  return params;
}

function pathSegmentsForUsageMatch(path: string): readonly string[] {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function platformCloudExtensionClientHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  for (const header of PLATFORM_CLOUD_EXTENSION_USAGE_HEADERS) {
    headers.delete(header);
  }
  return headers;
}

function platformCloudExtensionUsageFailure(reason: string): {
  readonly ok: false;
  readonly response: Response;
} {
  const mapped = platformCloudExtensionUsageFailureResponse(reason);
  return {
    ok: false,
    response: Response.json(
      {
        error: mapped.error,
        reason,
      },
      { status: mapped.status },
    ),
  };
}

function platformCloudExtensionUsageFailureResponse(reason: string): {
  readonly error: string;
  readonly status: number;
} {
  switch (reason) {
    case "usage_workspace_id_missing":
      return {
        error: "cloud_extension_billing_context_required",
        status: 402,
      };
    case "usage_workspace_id_mismatch":
      return {
        error: "cloud_extension_billing_context_mismatch",
        status: 403,
      };
    case "insufficient_credits":
      return {
        error: "cloud_extension_insufficient_credits",
        status: 402,
      };
    default:
      return {
        error: "cloud_extension_usage_metering_failed",
        status: 502,
      };
  }
}

function platformCloudExtensionUsageRecordFailureReason(
  error: unknown,
): string {
  if (error instanceof OpenTofuControllerError) {
    const details = objectRecord(error.details);
    if (
      error.code === "failed_precondition" &&
      details.reason === "insufficient_credits"
    ) {
      return "insufficient_credits";
    }
  }
  return "usage_record_failed";
}

function parsePlatformCloudUsageMeters(raw: string):
  | { readonly ok: true; readonly value: readonly PlatformCloudUsageMeter[] }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "usage_meters_invalid_json" };
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) {
    return { ok: false, error: "usage_meters_invalid" };
  }
  const meters: PlatformCloudUsageMeter[] = [];
  for (const entry of parsed) {
    const record = objectRecord(entry);
    const meterId = optionalMeterString(record.meterId);
    const kind = optionalMeterString(record.kind);
    const quantity = numberValue(record.quantity);
    if (!meterId || !kind || quantity === undefined || quantity < 0) {
      return { ok: false, error: "usage_meter_invalid" };
    }
    const resourceMetadata = usageMetadata(record.resourceMetadata);
    if (
      resourceMetadata === undefined &&
      record.resourceMetadata !== undefined
    ) {
      return { ok: false, error: "usage_resource_metadata_invalid" };
    }
    const meter: PlatformCloudUsageMeter = {
      meterId,
      kind,
      quantity,
      ...(safePlatformCloudExtensionContextId(
        valueString(record.installationId),
      )
        ? {
            installationId: safePlatformCloudExtensionContextId(
              valueString(record.installationId),
            ),
          }
        : {}),
      ...(optionalMeterString(record.resourceFamily)
        ? { resourceFamily: optionalMeterString(record.resourceFamily) }
        : {}),
      ...(optionalMeterString(record.resourceId)
        ? { resourceId: optionalMeterString(record.resourceId) }
        : {}),
      ...(optionalMeterString(record.operation)
        ? { operation: optionalMeterString(record.operation) }
        : {}),
      ...(resourceMetadata ? { resourceMetadata } : {}),
      ...(nonNegativeSafeInteger(record.usdMicros)
        ? { usdMicros: Number(record.usdMicros) }
        : {}),
      ...(numberValue(record.credits) !== undefined
        ? { credits: numberValue(record.credits) }
        : {}),
    };
    meters.push(meter);
  }
  return { ok: true, value: meters };
}

function parsePlatformCloudUsagePriceBook(raw: unknown):
  | { readonly ok: true; readonly value: PlatformCloudUsagePriceBook }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, error: "usage_price_book_missing" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "usage_price_book_invalid_json" };
  }
  const record = objectRecord(parsed);
  const minimumGrossMarginBps = nonNegativeSafeInteger(
    record.minimumGrossMarginBps,
  )
    ? Number(record.minimumGrossMarginBps)
    : 0;
  if (minimumGrossMarginBps >= 10_000) {
    return { ok: false, error: "usage_price_book_margin_invalid" };
  }
  const rawMeters = record.meters;
  if (!Array.isArray(rawMeters) || rawMeters.length === 0) {
    return { ok: false, error: "usage_price_book_meters_missing" };
  }
  const meters: PlatformCloudUsagePriceBookMeter[] = [];
  for (const entry of rawMeters) {
    const row = objectRecord(entry);
    const meterId = optionalMeterString(row.meterId);
    const meterIdPrefix = optionalMeterString(row.meterIdPrefix);
    const kind = optionalMeterString(row.kind);
    if (!kind || Boolean(meterId) === Boolean(meterIdPrefix)) {
      return { ok: false, error: "usage_price_book_meter_invalid" };
    }
    const chargePerUnit = optionalNonNegativeInteger(
      row.chargeUsdMicrosPerUnit,
    );
    const chargePerMillion = optionalNonNegativeInteger(
      row.chargeUsdMicrosPerMillionUnits,
    );
    const costPerUnit = optionalNonNegativeInteger(
      row.estimatedCostUsdMicrosPerUnit,
    );
    const costPerMillion = optionalNonNegativeInteger(
      row.estimatedCostUsdMicrosPerMillionUnits,
    );
    if (
      (chargePerUnit === undefined) === (chargePerMillion === undefined) ||
      (costPerUnit === undefined) === (costPerMillion === undefined)
    ) {
      return { ok: false, error: "usage_price_book_meter_invalid" };
    }
    const charge = chargePerUnit ?? chargePerMillion ?? 0;
    const cost = costPerUnit ?? costPerMillion ?? 0;
    if (!grossMarginAllowed(charge, cost, minimumGrossMarginBps)) {
      return { ok: false, error: "usage_price_book_margin_too_low" };
    }
    meters.push({
      ...(meterId ? { meterId } : {}),
      ...(meterIdPrefix ? { meterIdPrefix } : {}),
      kind,
      ...(chargePerUnit !== undefined
        ? { chargeUsdMicrosPerUnit: chargePerUnit }
        : {}),
      ...(chargePerMillion !== undefined
        ? { chargeUsdMicrosPerMillionUnits: chargePerMillion }
        : {}),
      ...(costPerUnit !== undefined
        ? { estimatedCostUsdMicrosPerUnit: costPerUnit }
        : {}),
      ...(costPerMillion !== undefined
        ? { estimatedCostUsdMicrosPerMillionUnits: costPerMillion }
        : {}),
      ...(optionalNonNegativeInteger(row.minimumChargeUsdMicros) !== undefined
        ? {
            minimumChargeUsdMicros: optionalNonNegativeInteger(
              row.minimumChargeUsdMicros,
            ),
          }
        : {}),
    });
  }
  return { ok: true, value: { minimumGrossMarginBps, meters } };
}

function pricePlatformCloudUsageMeter(
  meter: PlatformCloudUsageMeter,
  priceBook: PlatformCloudUsagePriceBook,
):
  | { readonly ok: true; readonly value: number }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  const entry = priceBook.meters.find(
    (candidate) =>
      candidate.kind === meter.kind &&
      (candidate.meterId === meter.meterId ||
        (candidate.meterIdPrefix !== undefined &&
          meter.meterId.startsWith(candidate.meterIdPrefix))),
  );
  if (!entry) return { ok: false, error: "usage_price_missing" };
  const raw =
    entry.chargeUsdMicrosPerUnit !== undefined
      ? Math.ceil(meter.quantity * entry.chargeUsdMicrosPerUnit)
      : Math.ceil(
          (meter.quantity * (entry.chargeUsdMicrosPerMillionUnits ?? 0)) /
            1_000_000,
        );
  const minimum = meter.quantity > 0 ? (entry.minimumChargeUsdMicros ?? 0) : 0;
  const usdMicros = Math.max(raw, minimum);
  if (!Number.isSafeInteger(usdMicros) || usdMicros < 0) {
    return { ok: false, error: "usage_price_invalid" };
  }
  return { ok: true, value: usdMicros };
}

function grossMarginAllowed(
  chargeUsdMicros: number,
  estimatedCostUsdMicros: number,
  minimumGrossMarginBps: number,
): boolean {
  return (
    chargeUsdMicros * (10_000 - minimumGrossMarginBps) >=
    estimatedCostUsdMicros * 10_000
  );
}

function platformCloudUsageEventKind(
  value: string,
): UsageEventKind | undefined {
  switch (value) {
    case "runner_minute":
    case "artifact_storage_gb_hour":
    case "backup_storage_gb_hour":
    case "egress_gb":
    case "operation":
    case "gateway_compute":
    case "gateway_storage_gb_hour":
    case "ai_request":
    case "ai_input_token":
    case "ai_output_token":
      return value;
  }
  return undefined;
}

function usageMetadata(value: unknown): UsageResourceMetadata | undefined {
  if (value === undefined) return {};
  const record = objectRecord(value);
  if (record !== value) return undefined;
  const normalized: Record<string, UsageResourceMetadataValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!key.trim()) return undefined;
    if (
      entry !== null &&
      typeof entry !== "string" &&
      typeof entry !== "number" &&
      typeof entry !== "boolean"
    ) {
      return undefined;
    }
    if (typeof entry === "number" && !Number.isFinite(entry)) {
      return undefined;
    }
    normalized[key] = entry;
  }
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalMeterString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 256 ? trimmed : undefined;
}

function safePlatformCloudExtensionContextId(
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

function isoHeaderValue(value: string | null): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function valueString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return nonNegativeSafeInteger(value) ? Number(value) : undefined;
}

export async function verifyPlatformCloudExtensionSession(
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformCloudExtensionRoute,
): Promise<PlatformCloudExtensionSessionContext> {
  const serviceToken = platformCloudExtensionServiceAccessToken(request);
  if (serviceToken) {
    const serviceSession = await verifyPlatformCloudExtensionServiceAccessToken(
      request,
      env,
      serviceToken,
      route,
    );
    if (serviceSession.authenticated) return serviceSession;
  }

  const patToken = platformCloudExtensionPersonalAccessToken(request);
  if (patToken) {
    const patSession = await verifyPlatformCloudExtensionPersonalAccessToken(
      request,
      env,
      patToken,
      route,
    );
    if (patSession.authenticated) return patSession;
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

export type PlatformCloudExtensionIntrospectFetch = (
  request: Request,
  env: CloudflareWorkerEnv,
) => Promise<Response>;

export async function verifyPlatformCloudExtensionServiceAccessToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  route?: PlatformCloudExtensionRoute,
  introspectFetch: PlatformCloudExtensionIntrospectFetch = defaultPlatformCloudExtensionIntrospectFetch,
): Promise<PlatformCloudExtensionSessionContext> {
  return await introspectPlatformCloudExtensionToken(
    request,
    env,
    token,
    "service-token",
    route,
    introspectFetch,
  );
}

export async function verifyPlatformCloudExtensionPersonalAccessToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  routeOrIntrospectFetch?:
    PlatformCloudExtensionRoute | PlatformCloudExtensionIntrospectFetch,
  maybeIntrospectFetch?: PlatformCloudExtensionIntrospectFetch,
): Promise<PlatformCloudExtensionSessionContext> {
  const route =
    typeof routeOrIntrospectFetch === "function"
      ? undefined
      : routeOrIntrospectFetch;
  const introspectFetch =
    typeof routeOrIntrospectFetch === "function"
      ? routeOrIntrospectFetch
      : (maybeIntrospectFetch ?? defaultPlatformCloudExtensionIntrospectFetch);
  return await introspectPlatformCloudExtensionToken(
    request,
    env,
    token,
    "personal-access-token",
    route,
    introspectFetch,
  );
}

async function introspectPlatformCloudExtensionToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  authKind: "service-token" | "personal-access-token",
  route: PlatformCloudExtensionRoute | undefined,
  introspectFetch: PlatformCloudExtensionIntrospectFetch,
): Promise<PlatformCloudExtensionSessionContext> {
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
    const scope = typeof record.scope === "string" ? record.scope : "";
    const scopes = platformCloudExtensionScopes(scope);
    if (!platformCloudExtensionScopesAllowAccess(scopes, route)) {
      return { authenticated: false };
    }
    const subject = record.sub;
    const takosumi = platformCloudExtensionTakosumiMetadata(record);
    return typeof subject === "string" && subject.length > 0
      ? { authenticated: true, authKind, subject, ...takosumi, scopes }
      : { authenticated: true, authKind, ...takosumi, scopes };
  } catch {
    return { authenticated: false };
  }
}

function platformCloudExtensionScopesAllowAccess(
  scopes: readonly string[],
  route?: PlatformCloudExtensionRoute,
): boolean {
  const required = route?.requiredScopes ?? [];
  if (required.length === 0) return true;
  return required.every(
    (scope) => scopes.includes(scope) || scopes.includes("admin"),
  );
}

function platformCloudExtensionScopes(scope: string): string[] {
  return scope.split(/\s+/u).filter(Boolean);
}

function platformCloudExtensionTakosumiMetadata(
  record: Record<string, unknown>,
): { readonly installationId?: string; readonly spaceId?: string } {
  const takosumi = record.takosumi;
  if (!takosumi || typeof takosumi !== "object" || Array.isArray(takosumi)) {
    return {};
  }
  const metadata = takosumi as Record<string, unknown>;
  const installationId =
    typeof metadata.installation_id === "string" &&
    metadata.installation_id.trim()
      ? metadata.installation_id.trim()
      : undefined;
  const spaceId =
    typeof metadata.space_id === "string" && metadata.space_id.trim()
      ? metadata.space_id.trim()
      : undefined;
  return {
    ...(installationId ? { installationId } : {}),
    ...(spaceId ? { spaceId } : {}),
  };
}

async function defaultPlatformCloudExtensionIntrospectFetch(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  return await accountsWorker.fetch(request, env);
}

function platformCloudExtensionPersonalAccessToken(
  request: Request,
): string | undefined {
  const token = bearerValue(request.headers.get("authorization"));
  return token?.startsWith("takpat_") ? token : undefined;
}

function platformCloudExtensionServiceAccessToken(
  request: Request,
): string | undefined {
  const token = bearerValue(request.headers.get("authorization"));
  return token?.startsWith("taksrv_") ? token : undefined;
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

function safeCloudExtensionHeaderValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, "");
}

interface PlatformCloudExtensionBinding {
  fetch(request: Request): Response | Promise<Response>;
}

function platformCloudExtensionBinding(
  env: CloudflareWorkerEnv,
  bindingName: string,
): PlatformCloudExtensionBinding | undefined {
  const binding = (env as Record<string, unknown>)[bindingName];
  if (
    !binding ||
    typeof binding !== "object" ||
    typeof (binding as { fetch?: unknown }).fetch !== "function"
  ) {
    return undefined;
  }
  return binding as PlatformCloudExtensionBinding;
}

const HARDENING_GATE_REF_PREFIX = "git+";
const HARDENING_GATE_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}#/i;
const HARDENING_GATE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ProductionHardeningGateResult {
  readonly ok: boolean;
  readonly enforced: boolean;
  readonly checks: {
    readonly containerSmoke: ProductionHardeningCheck;
    readonly platformControlPlaneSmoke: ProductionHardeningCheck;
    readonly egressEnforcement: ProductionHardeningCheck;
    readonly restoreRehearsal: ProductionHardeningCheck;
    readonly providerCatalog: ProductionHardeningCheck;
    readonly costAttribution: ProductionHardeningCheck;
    readonly secretBoundary: ProductionHardeningCheck;
  };
}

export interface ProductionHardeningCheck {
  readonly ok: boolean;
  readonly evidenceRef?: string;
  readonly evidenceDigest?: string;
  readonly reason?: string;
}

export function evaluateProductionHardeningGates(
  env: CloudflareWorkerEnv,
): ProductionHardeningGateResult {
  const enforced = env.TAKOSUMI_PRODUCTION_HARDENING_GATE === "enforce";
  const checks = {
    containerSmoke: evidenceCheck(
      env.TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_REF,
      env.TAKOSUMI_CLOUDFLARE_CONTAINER_SMOKE_EVIDENCE_DIGEST,
    ),
    platformControlPlaneSmoke: evidenceCheck(
      env.TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_REF,
      env.TAKOSUMI_PLATFORM_CONTROL_PLANE_SMOKE_EVIDENCE_DIGEST,
    ),
    egressEnforcement: evidenceCheck(
      env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF,
      env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST,
    ),
    restoreRehearsal: evidenceCheck(
      env.TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_REF,
      env.TAKOSUMI_RESTORE_REHEARSAL_EVIDENCE_DIGEST,
    ),
    providerCatalog: evidenceCheck(
      env.TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_REF,
      env.TAKOSUMI_PROVIDER_REGISTRY_EVIDENCE_DIGEST,
    ),
    costAttribution: evidenceCheck(
      env.TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_REF,
      env.TAKOSUMI_COST_ATTRIBUTION_EVIDENCE_DIGEST,
    ),
    secretBoundary: evidenceCheck(
      env.TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF,
      env.TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST,
    ),
  };
  return {
    ok:
      checks.containerSmoke.ok &&
      checks.platformControlPlaneSmoke.ok &&
      checks.egressEnforcement.ok &&
      checks.restoreRehearsal.ok &&
      checks.providerCatalog.ok &&
      checks.costAttribution.ok &&
      checks.secretBoundary.ok,
    enforced,
    checks,
  };
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

function evidenceCheck(
  rawRef: unknown,
  rawDigest: unknown,
): ProductionHardeningCheck {
  const evidenceRef = typeof rawRef === "string" ? rawRef.trim() : "";
  const evidenceDigest = typeof rawDigest === "string" ? rawDigest.trim() : "";
  if (!evidenceRef) return { ok: false, reason: "missing_evidence_ref" };
  if (!evidenceRef.startsWith(HARDENING_GATE_REF_PREFIX)) {
    return {
      ok: false,
      evidenceRef,
      reason: "evidence_ref_must_be_git_ref",
    };
  }
  if (!HARDENING_GATE_COMMIT_PIN_PATTERN.test(evidenceRef)) {
    return {
      ok: false,
      evidenceRef,
      reason: "evidence_ref_must_be_commit_pinned",
    };
  }
  if (!evidenceDigest) {
    return { ok: false, evidenceRef, reason: "missing_evidence_digest" };
  }
  if (!HARDENING_GATE_DIGEST_PATTERN.test(evidenceDigest)) {
    return {
      ok: false,
      evidenceRef,
      evidenceDigest,
      reason: "evidence_digest_must_be_sha256",
    };
  }
  return { ok: true, evidenceRef, evidenceDigest };
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

async function handleSourceWebhook(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  const operations = await deployControlSeam(
    env as unknown as DeployControlEnv,
  ).operations();
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
const SCHEDULED_SOURCE_POLL_BATCH = 50;

async function runScheduledSourcePoll(env: DeployControlEnv): Promise<void> {
  const operations = await deployControlSeam(env).operations();
  await pollAutoSyncSources(operations, SCHEDULED_SOURCE_POLL_BATCH);
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
    listActiveInstallations: (limit) =>
      operations.controller.listActiveInstallations(limit),
    createSpaceDriftCheck: (spaceId, options) =>
      operations.runGroups.createSpaceDriftCheck(spaceId, options),
  };
  await driftSweep(driftOps, { limit: SCHEDULED_DRIFT_SWEEP_LIMIT });
}
