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
import {
  TAKOSUMI_BILLING_USAGE_SYNC_TOKEN_HEADER,
  type ControlPlaneOperations,
} from "@takosjp/takosumi-accounts-service";
import { TAKOSUMI_ACCOUNTS_STRIPE_USAGE_INVOICE_ITEMS_PATH } from "@takosjp/takosumi-accounts-contract";
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
  GatewayResourceUsageMeter,
} from "takosumi-contract/billing";
import {
  TAKOSUMI_CLOUD_EXTENSION_USAGE_METERS_HEADER,
  TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER,
  TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
  TAKOSUMI_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER,
  usageMeterNameLeaksInternalWorkersBackend,
} from "takosumi-contract/billing";
import {
  AI_GATEWAY_BASE_PATH,
  CLOUDFLARE_COMPAT_BASE_PATH,
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  pathIsUnderBase,
  platformCloudExtensionRouteById,
  platformCloudExtensionServiceTokenClientId,
  platformCloudExtensionServiceTokenRequiredScopes,
  PLATFORM_CLOUD_EXTENSION_ROUTES,
  type PlatformCloudExtensionKind,
  type PlatformCloudExtensionRoute,
} from "./cloud_extensions.ts";
export {
  AI_GATEWAY_BASE_PATH,
  CLOUDFLARE_COMPAT_BASE_PATH,
  isPlatformCloudExtensionCatalogPath,
  matchPlatformCloudExtensionRoute,
  pathIsUnderBase,
  PLATFORM_CLOUD_EXTENSION_CATALOG_PATH,
  PLATFORM_CLOUD_EXTENSION_ROUTES,
  platformCloudExtensionRouteById,
  platformCloudExtensionServiceTokenClientId,
  platformCloudExtensionServiceTokenRequiredScopes,
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

async function platformCloudExtensionUsageOperationsFor(
  env: CloudflareWorkerEnv,
  requestUrl: string,
): Promise<PlatformCloudExtensionUsageOperations> {
  const operations = (await deployControlSeam(
    env,
  ).operations()) as PlatformCloudExtensionUsageOperations;
  return {
    recordGatewayResourceUsage: (spaceId, input) =>
      operations.recordGatewayResourceUsage(spaceId, input),
    recordBillingUsageReports: async (input) => {
      if (input.usageEvents.length === 0) return;
      const token = platformBillingUsageSyncToken(env);
      if (!token) {
        throw new Error("billing_usage_sync_token_missing");
      }
      const response = await accountsWorker.fetch(
        new Request(
          new URL(
            TAKOSUMI_ACCOUNTS_STRIPE_USAGE_INVOICE_ITEMS_PATH,
            requestUrl,
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [TAKOSUMI_BILLING_USAGE_SYNC_TOKEN_HEADER]: token,
            },
            body: JSON.stringify({ usageEvents: input.usageEvents }),
          },
        ),
        env,
      );
      if (!response.ok) {
        throw new Error("billing_usage_report_import_failed");
      }
    },
  };
}

function platformBillingUsageSyncToken(
  env: CloudflareWorkerEnv,
): string | undefined {
  return (
    optionalString(env.TAKOSUMI_ACCOUNTS_BILLING_USAGE_SYNC_TOKEN) ??
    optionalString(env.TAKOSUMI_DEPLOY_CONTROL_TOKEN)
  );
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
    const cloudExtensionRoute = matchPlatformCloudExtensionRoute(url.pathname);
    if (cloudExtensionRoute) {
      return await handlePlatformCloudExtensionRouteRequest(
        request,
        env,
        cloudExtensionRoute,
        verifyPlatformCloudExtensionSession,
        async () => platformCloudExtensionUsageOperationsFor(env, request.url),
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

function isOperatorBillingPath(pathname: string): boolean {
  return (
    spaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_SPACE_BILLING_SUFFIX,
    ) !== undefined ||
    spaceIdFromInternalPlatformPath(
      pathname,
      INTERNAL_PLATFORM_SPACE_SUBSCRIPTION_CHANGE_SUFFIX,
    ) !== undefined
  );
}

export interface OperatorBillingOperations {
  getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: unknown;
    };
  }>;
  changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
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
    const result = await operations.getSpaceBilling(billingSpaceId);
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return Response.json(result, { status: 200 });
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
    await operations.changeSpaceSubscription(subscriptionSpaceId, {
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
  if (value.mode === "enforce") {
    if (value.provider !== "stripe" && value.provider !== "manual") {
      return {
        ok: false,
        error: "enforced billing requires stripe or manual provider",
      };
    }
    if (value.reservationRequired !== true) {
      return {
        ok: false,
        error: "enforced billing requires reservationRequired true",
      };
    }
    return {
      ok: true,
      value: {
        mode: "enforce",
        provider: value.provider,
        reservationRequired: true,
      },
    };
  }
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
  readonly id: string;
  readonly kind: PlatformCloudExtensionKind;
  readonly provider?: string;
  readonly protocol: string;
  readonly basePath: `/${string}`;
  readonly configured: boolean;
  readonly capabilities: readonly string[];
  readonly smokeChecks: readonly string[];
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
  const extensions = PLATFORM_CLOUD_EXTENSION_ROUTES.map((route) => ({
    id: route.id,
    kind: route.kind,
    ...(route.provider ? { provider: route.provider } : {}),
    protocol: route.protocol,
    basePath: route.basePath,
    configured:
      platformCloudExtensionBinding(env, route.bindingName) !== undefined,
    capabilities: route.capabilities,
    smokeChecks: route.smokeChecks,
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
  usageOperations?: PlatformCloudExtensionUsageOperations,
): Promise<Response | undefined> {
  const route = matchPlatformCloudExtensionRoute(new URL(request.url).pathname);
  if (!route) return undefined;
  return await handlePlatformCloudExtensionRouteRequest(
    request,
    env,
    route,
    verifyPlatformCloudExtensionSession,
    usageOperations,
  );
}

export async function handlePlatformCloudExtensionRouteRequest(
  request: Request,
  env: CloudflareWorkerEnv,
  route: PlatformCloudExtensionRoute,
  sessionVerifier: PlatformCloudExtensionSessionVerifier = verifyPlatformCloudExtensionSession,
  usageOperations?: PlatformCloudExtensionUsageOperationsInput,
): Promise<Response> {
  const binding = platformCloudExtensionBinding(env, route.bindingName);
  if (!binding) return Response.json({ error: "not found" }, { status: 404 });
  const authenticatedRequest =
    await requestWithPlatformCloudExtensionAuthContext(
      request,
      env,
      route,
      sessionVerifier,
    );
  const upstreamResponse = await binding.fetch(
    requestForPlatformCloudExtensionBinding(authenticatedRequest, route),
  );
  const usageResult = await recordPlatformCloudExtensionUsage(
    upstreamResponse,
    usageOperations,
  );
  if (!usageResult.ok) return usageResult.response;
  return responseForPlatformCloudExtensionClient(
    request,
    route,
    upstreamResponse,
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

export interface PlatformCloudExtensionUsageOperations {
  recordGatewayResourceUsage(
    spaceId: string,
    input: {
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly meters: readonly GatewayResourceUsageMeter[];
    },
  ): Promise<{ readonly usageEvents: readonly unknown[] }>;
  recordBillingUsageReports?(input: {
    readonly usageEvents: readonly unknown[];
  }): Promise<void>;
}

type PlatformCloudExtensionUsageOperationsInput =
  | PlatformCloudExtensionUsageOperations
  | (() => Promise<PlatformCloudExtensionUsageOperations>);

export const PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER =
  TAKOSUMI_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER;
export const PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER =
  TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER;
export const PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER =
  TAKOSUMI_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER;
export const PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER =
  TAKOSUMI_CLOUD_EXTENSION_USAGE_METERS_HEADER;

const PLATFORM_CLOUD_EXTENSION_USAGE_HEADERS = [
  PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER,
  PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER,
] as const;

const PLATFORM_CLOUD_EXTENSION_AUTHENTICATED_HEADER =
  "x-takosumi-cloud-authenticated";
const PLATFORM_CLOUD_EXTENSION_SUBJECT_HEADER = "x-takosumi-cloud-subject";
const PLATFORM_CLOUD_EXTENSION_AUTH_KIND_HEADER = "x-takosumi-cloud-auth-kind";
const PLATFORM_CLOUD_EXTENSION_SCOPES_HEADER = "x-takosumi-cloud-scopes";
const PLATFORM_CLOUD_EXTENSION_INSTALLATION_ID_HEADER =
  "x-takosumi-cloud-installation-id";
const PLATFORM_CLOUD_EXTENSION_SPACE_ID_HEADER = "x-takosumi-cloud-space-id";
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

export async function requestWithPlatformCloudExtensionAuthContext(
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformCloudExtensionRoute,
  sessionVerifier: PlatformCloudExtensionSessionVerifier = verifyPlatformCloudExtensionSession,
): Promise<Request> {
  const session = await sessionVerifier(request, env, route);
  const headers = new Headers(request.headers);
  for (const header of PLATFORM_CLOUD_EXTENSION_RAW_CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  for (const header of PLATFORM_CLOUD_EXTENSION_TRUSTED_CONTEXT_HEADERS) {
    headers.delete(header);
  }
  if (!session.authenticated) {
    return clonePlatformCloudExtensionRequest(request, headers);
  }
  headers.set(PLATFORM_CLOUD_EXTENSION_AUTHENTICATED_HEADER, "1");
  if (session.authKind) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_AUTH_KIND_HEADER,
      safeCloudExtensionHeaderValue(session.authKind),
    );
  }
  if (session.scopes && session.scopes.length > 0) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SCOPES_HEADER,
      session.scopes.map(safeCloudExtensionHeaderValue).join(" "),
    );
  }
  if (session.subject) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SUBJECT_HEADER,
      safeCloudExtensionHeaderValue(session.subject),
    );
  }
  if (session.installationId) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_INSTALLATION_ID_HEADER,
      safeCloudExtensionHeaderValue(session.installationId),
    );
  }
  if (session.spaceId) {
    headers.set(
      PLATFORM_CLOUD_EXTENSION_SPACE_ID_HEADER,
      safeCloudExtensionHeaderValue(session.spaceId),
    );
  }
  return clonePlatformCloudExtensionRequest(request, headers);
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

async function recordPlatformCloudExtensionUsage(
  response: Response,
  operationsInput?: PlatformCloudExtensionUsageOperationsInput,
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly response: Response }
> {
  let usage:
    | {
        readonly spaceId: string;
        readonly periodStart: string;
        readonly periodEnd: string;
        readonly meters: readonly GatewayResourceUsageMeter[];
      }
    | undefined;
  try {
    usage = platformCloudExtensionUsageReportFromHeaders(response.headers);
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          error: "invalid usage metering report",
          error_description:
            "Cloud extension returned a malformed usage report.",
        },
        { status: 502 },
      ),
    };
  }
  if (!usage) return { ok: true };
  if (!response.ok) return { ok: true };
  if (!operationsInput) {
    return {
      ok: false,
      response: Response.json(
        {
          error: "usage metering unavailable",
          error_description:
            "Cloud extension reported usage, but the platform usage ledger is not wired.",
        },
        { status: 502 },
      ),
    };
  }
  try {
    const operations =
      typeof operationsInput === "function"
        ? await operationsInput()
        : operationsInput;
    const result = await operations.recordGatewayResourceUsage(usage.spaceId, {
      periodStart: usage.periodStart,
      periodEnd: usage.periodEnd,
      meters: usage.meters,
    });
    if (operations.recordBillingUsageReports) {
      await operations.recordBillingUsageReports({
        usageEvents: result.usageEvents,
      });
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      response: Response.json(
        {
          error: "usage metering failed",
          error_description:
            "Cloud extension usage could not be recorded, so the request was not returned as a billable success.",
        },
        { status: 502 },
      ),
    };
  }
}

function platformCloudExtensionUsageReportFromHeaders(headers: Headers):
  | {
      readonly spaceId: string;
      readonly periodStart: string;
      readonly periodEnd: string;
      readonly meters: readonly GatewayResourceUsageMeter[];
    }
  | undefined {
  const metersHeader = headers.get(
    PLATFORM_CLOUD_EXTENSION_USAGE_METERS_HEADER,
  );
  if (!metersHeader) return undefined;
  const spaceId = requiredUsageHeader(
    headers,
    PLATFORM_CLOUD_EXTENSION_USAGE_SPACE_ID_HEADER,
  );
  const periodStart = requiredUsageHeader(
    headers,
    PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_START_HEADER,
  );
  const periodEnd = requiredUsageHeader(
    headers,
    PLATFORM_CLOUD_EXTENSION_USAGE_PERIOD_END_HEADER,
  );
  const parsed = JSON.parse(metersHeader) as unknown;
  if (!Array.isArray(parsed)) {
    throw new TypeError("Cloud extension usage meters must be a JSON array");
  }
  return {
    spaceId,
    periodStart,
    periodEnd,
    meters: parsed.map(platformCloudExtensionUsageMeterFromJson),
  };
}

function requiredUsageHeader(headers: Headers, name: string): string {
  const value = headers.get(name)?.trim();
  if (!value) throw new TypeError(`${name} is required when usage is reported`);
  return value;
}

function platformCloudExtensionUsageMeterFromJson(
  value: unknown,
): GatewayResourceUsageMeter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Cloud extension usage meter must be an object");
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (!isPlatformCloudExtensionUsageKind(kind)) {
    throw new TypeError("Cloud extension usage kind is not supported");
  }
  const quantity = record.quantity;
  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity < 0
  ) {
    throw new TypeError("Cloud extension usage quantity must be non-negative");
  }
  const credits = record.credits;
  if (
    typeof credits !== "number" ||
    !Number.isInteger(credits) ||
    credits < 0
  ) {
    throw new TypeError(
      "Cloud extension usage credits must be a non-negative integer",
    );
  }
  const meterId =
    typeof record.meterId === "string" ? record.meterId.trim() : "";
  if (!meterId)
    throw new TypeError("Cloud extension usage meterId is required");
  if (usageMeterNameLeaksInternalWorkersBackend(meterId)) {
    throw new TypeError(
      "Cloud extension usage meterId must describe the customer-facing managed resource, not the internal Workers for Platforms backend",
    );
  }
  const installationId =
    typeof record.installationId === "string" && record.installationId.trim()
      ? record.installationId.trim()
      : undefined;
  const resourceFamily = optionalCloudExtensionUsageString(
    record.resourceFamily,
    "resourceFamily",
  );
  if (resourceFamily && !/^[a-z0-9][a-z0-9_.:-]*$/u.test(resourceFamily)) {
    throw new TypeError(
      "Cloud extension usage resourceFamily must use lowercase letters, numbers, dot, underscore, colon, or dash",
    );
  }
  if (
    resourceFamily &&
    usageMeterNameLeaksInternalWorkersBackend(resourceFamily)
  ) {
    throw new TypeError(
      "Cloud extension usage resourceFamily must describe the customer-facing managed resource, not the internal Workers for Platforms backend",
    );
  }
  if (
    resourceFamily &&
    meterId.startsWith("cloudflare:workers_script:") &&
    resourceFamily !== "cloudflare.workers_script"
  ) {
    throw new TypeError(
      "Cloud extension Workers Script usage must use resourceFamily cloudflare.workers_script",
    );
  }
  const resourceId = optionalCloudExtensionUsageString(
    record.resourceId,
    "resourceId",
  );
  const operation = optionalCloudExtensionUsageString(
    record.operation,
    "operation",
  );
  const resourceMetadata = cloudExtensionUsageResourceMetadata(
    record.resourceMetadata,
  );
  return {
    ...(installationId ? { installationId } : {}),
    ...(resourceFamily ? { resourceFamily } : {}),
    ...(resourceId ? { resourceId } : {}),
    ...(operation ? { operation } : {}),
    ...(Object.keys(resourceMetadata).length > 0 ? { resourceMetadata } : {}),
    kind,
    quantity,
    credits,
    meterId,
  };
}

function optionalCloudExtensionUsageString(
  value: unknown,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Cloud extension usage ${label} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256) {
    throw new TypeError(
      `Cloud extension usage ${label} must be non-empty and at most 256 characters`,
    );
  }
  return trimmed;
}

function cloudExtensionUsageResourceMetadata(
  value: unknown,
): NonNullable<GatewayResourceUsageMeter["resourceMetadata"]> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      "Cloud extension usage resourceMetadata must be an object",
    );
  }
  const normalized: Record<string, string | number | boolean | null> = {};
  for (const [key, metadataValue] of Object.entries(value)) {
    const metadataKey = key.trim();
    if (!metadataKey) {
      throw new TypeError(
        "Cloud extension usage resourceMetadata keys must be non-empty strings",
      );
    }
    if (
      metadataValue !== null &&
      typeof metadataValue !== "string" &&
      typeof metadataValue !== "boolean" &&
      (typeof metadataValue !== "number" || !Number.isFinite(metadataValue))
    ) {
      throw new TypeError(
        "Cloud extension usage resourceMetadata values must be strings, numbers, booleans, or null",
      );
    }
    normalized[metadataKey] = metadataValue;
  }
  return normalized;
}

function isPlatformCloudExtensionUsageKind(
  value: unknown,
): value is GatewayResourceUsageMeter["kind"] {
  return (
    value === "gateway_compute" ||
    value === "gateway_storage_gb_hour" ||
    value === "ai_request" ||
    value === "ai_input_token" ||
    value === "ai_output_token" ||
    value === "artifact_storage_gb_hour" ||
    value === "backup_storage_gb_hour" ||
    value === "egress_gb"
  );
}

function requestForPlatformCloudExtensionBinding(
  request: Request,
  route: PlatformCloudExtensionRoute,
): Request {
  if (route.kind !== "ai_gateway" || request.method !== "HEAD") {
    return request;
  }
  return new Request(request.url, {
    method: "GET",
    headers: request.headers,
    redirect: request.redirect,
  });
}

function responseForPlatformCloudExtensionClient(
  request: Request,
  route: PlatformCloudExtensionRoute,
  response: Response,
): Response {
  const headers = new Headers(response.headers);
  for (const header of PLATFORM_CLOUD_EXTENSION_USAGE_HEADERS) {
    headers.delete(header);
  }
  if (route.kind !== "ai_gateway" || request.method !== "HEAD") {
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  headers.delete("content-length");
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function verifyPlatformCloudExtensionSession(
  request: Request,
  env: CloudflareWorkerEnv,
  route?: PlatformCloudExtensionRoute,
): Promise<PlatformCloudExtensionSessionContext> {
  const serviceToken = platformCloudExtensionServiceAccessToken(request);
  if (serviceToken && route) {
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

export async function verifyPlatformCloudExtensionServiceAccessToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  route: PlatformCloudExtensionRoute,
  introspectFetch: PlatformCloudExtensionIntrospectFetch = defaultPlatformCloudExtensionIntrospectFetch,
): Promise<PlatformCloudExtensionSessionContext> {
  const requiredScopes = platformCloudExtensionServiceTokenRequiredScopes(
    request,
    route,
  );
  if (!requiredScopes) return { authenticated: false };
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
    const expectedClientId = platformCloudExtensionServiceTokenClientId(route);
    if (!expectedClientId || record.client_id !== expectedClientId) {
      return { authenticated: false };
    }
    const scope = typeof record.scope === "string" ? record.scope : "";
    if (
      !requiredScopes.every((required) =>
        platformCloudExtensionScopeIncludes(scope, required),
      )
    ) {
      return { authenticated: false };
    }
    const subject = record.sub;
    const scopes = platformCloudExtensionScopes(scope);
    const takosumi = platformCloudExtensionTakosumiMetadata(record);
    return typeof subject === "string" && subject.length > 0
      ? {
          authenticated: true,
          authKind: "service-token",
          subject,
          ...takosumi,
          scopes,
        }
      : {
          authenticated: true,
          authKind: "service-token",
          ...takosumi,
          scopes,
        };
  } catch {
    return { authenticated: false };
  }
}

export type PlatformCloudExtensionIntrospectFetch = (
  request: Request,
  env: CloudflareWorkerEnv,
) => Promise<Response>;

export async function verifyPlatformCloudExtensionPersonalAccessToken(
  request: Request,
  env: CloudflareWorkerEnv,
  token: string,
  routeOrIntrospectFetch?:
    | PlatformCloudExtensionRoute
    | PlatformCloudExtensionIntrospectFetch,
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
    if (!platformCloudExtensionScopesAllowAccess(scope, request, route)) {
      return { authenticated: false };
    }
    const subject = record.sub;
    const scopes = platformCloudExtensionScopes(scope);
    const takosumi = platformCloudExtensionTakosumiMetadata(record);
    return typeof subject === "string" && subject.length > 0
      ? {
          authenticated: true,
          authKind: "personal-access-token",
          subject,
          ...takosumi,
          scopes,
        }
      : {
          authenticated: true,
          authKind: "personal-access-token",
          ...takosumi,
          scopes,
        };
  } catch {
    return { authenticated: false };
  }
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

function platformCloudExtensionScopesAllowAccess(
  scope: string,
  request: Request,
  route?: PlatformCloudExtensionRoute,
): boolean {
  const requiredScopes = platformCloudExtensionPersonalAccessRequiredScopes(
    request,
    route,
  );
  return requiredScopes.some((required) =>
    platformCloudExtensionScopeIncludes(scope, required),
  );
}

function platformCloudExtensionScopeIncludes(
  scope: string,
  required: string,
): boolean {
  if (
    required !== "admin" &&
    platformCloudExtensionScopes(scope).includes("admin")
  ) {
    return true;
  }
  return platformCloudExtensionScopes(scope).includes(required);
}

function platformCloudExtensionScopes(scope: string): string[] {
  return scope.split(/\s+/u).filter(Boolean);
}

function platformCloudExtensionPersonalAccessRequiredScopes(
  request: Request,
  route?: PlatformCloudExtensionRoute,
): readonly string[] {
  const resolvedRoute =
    route ?? matchPlatformCloudExtensionRoute(new URL(request.url).pathname);
  if (!resolvedRoute) return ["read", "write", "admin"];
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return ["read", "admin"];
  }
  return ["write", "admin"];
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

export function isCloudOnlyAiGatewayPath(pathname: string): boolean {
  return pathIsUnderBase(pathname, AI_GATEWAY_BASE_PATH);
}

export async function handlePlatformAiGatewayRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  const route = platformCloudExtensionRouteById("ai.openai_compatible.v1");
  if (!route) return Response.json({ error: "not found" }, { status: 404 });
  if (!pathIsUnderBase(new URL(request.url).pathname, route.basePath)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return await handlePlatformCloudExtensionRouteRequest(request, env, route);
}

export function isCloudOnlyCloudflareCompatPath(pathname: string): boolean {
  return pathIsUnderBase(pathname, CLOUDFLARE_COMPAT_BASE_PATH);
}

export async function handlePlatformCloudflareCompatRequest(
  request: Request,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  const route = platformCloudExtensionRouteById(
    "provider.cloudflare.client_v4",
  );
  if (!route) return Response.json({ error: "not found" }, { status: 404 });
  if (!pathIsUnderBase(new URL(request.url).pathname, route.basePath)) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return await handlePlatformCloudExtensionRouteRequest(request, env, route);
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
      env.TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF,
      env.TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST,
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
 * and enqueues a deduped source_sync for each (the consumer ls-remotes and only
 * writes a new snapshot when the ref moved). Best-effort and capped.
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
