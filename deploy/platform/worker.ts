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
import { TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY } from "@takosjp/takosumi-accounts-contract";
import { TAKOSUMI_AI_GATEWAY_BASE_PATH } from "takosumi-contract/ai-gateway";
import {
  D1AccountsStore,
  requireCurrentServiceGraphServiceAccessToken,
  type ControlPlaneOperations,
} from "@takosjp/takosumi-accounts-service";
import {
  type CloudflareWorkerEnv as DeployControlEnv,
  createDeployControlQueueConsumer,
  createInProcessDeployControlSeam,
  type QueueBatch,
  CoordinationObject,
  OpenTofuRunnerObject,
} from "../../worker/src/handler.ts";
import {
  driftSweep,
  type DriftSweepOperations,
} from "../../worker/src/scheduled/drift.ts";
import { constantTimeEqualsString } from "../../core/shared/constant_time.ts";
import {
  aiGatewayInsufficientScopeResponse,
  aiGatewayUnauthorizedResponse,
  createTakosumiAiGatewayConfigFromEnv,
  handleTakosumiAiGatewayRequest,
} from "../../core/domains/ai-gateway/openai_compatible.ts";
import type { BillingSettings } from "takosumi-contract/billing";

export { CoordinationObject, OpenTofuRunnerObject };

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
    const url = new URL(request.url);
    if (url.pathname === "/internal/platform/hardening-gates") {
      return handleHardeningGatesRequest(request, env);
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
    // Operator-provided AI Gateway. Installed services receive this endpoint as
    // Service Graph material and call it with a rotated `takosumi.ai.gateway`
    // service token. The upstream provider API keys stay in operator env vars.
    if (
      url.pathname === TAKOSUMI_AI_GATEWAY_BASE_PATH ||
      url.pathname.startsWith(`${TAKOSUMI_AI_GATEWAY_BASE_PATH}/`)
    ) {
      return await handlePlatformAiGatewayRequest(request, url, env);
    }
    // Source webhook surface (Core Specification §6). This is a NEW top-level
    // prefix the accounts handler does not own; handle it here via the
    // deploy-control service seam BEFORE delegating to the accounts handler.
    if (url.pathname.startsWith("/hooks/sources/")) {
      return await handleSourceWebhook(request, url, env);
    }
    return accountsWorker.fetch(request, env);
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

const SPACE_ID_PATTERN = /^space_[0-9a-zA-Z]{8,64}$/;
const INTERNAL_PLATFORM_SPACE_PREFIX = "/internal/platform/spaces/";
const INTERNAL_PLATFORM_SPACE_BILLING_SUFFIX = "/billing";
const INTERNAL_PLATFORM_SPACE_SUBSCRIPTION_CHANGE_SUFFIX =
  "/subscription/change";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handlePlatformAiGatewayRequest(
  request: Request,
  url: URL,
  env: CloudflareWorkerEnv,
): Promise<Response> {
  let config: ReturnType<typeof createTakosumiAiGatewayConfigFromEnv>;
  try {
    config = createTakosumiAiGatewayConfigFromEnv(
      env as unknown as Record<string, unknown>,
    );
  } catch {
    return Response.json(
      {
        error: {
          message: "AI Gateway is not configured",
          type: "server_error",
          code: "ai_gateway_not_configured",
        },
      },
      { status: 503 },
    );
  }
  if (config.profiles.length === 0) {
    return Response.json(
      {
        error: {
          message: "AI Gateway is not configured",
          type: "server_error",
          code: "ai_gateway_not_configured",
        },
      },
      { status: 503 },
    );
  }

  return await handleTakosumiAiGatewayRequest(request, url, {
    config,
    authorize: async (authorizedRequest, auth) => {
      if (!env.TAKOSUMI_ACCOUNTS_DB) {
        return { ok: false, response: aiGatewayUnauthorizedResponse() };
      }
      const result = await requireCurrentServiceGraphServiceAccessToken({
        request: authorizedRequest,
        store: new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB),
        serviceId: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_AI_GATEWAY,
        capability: "ai.model",
        requiredScopes: auth.requiredScopes,
      });
      if (result.ok) {
        return {
          ok: true,
          context: {
            subject: result.record.subject,
            installationId: result.record.installationId,
            spaceId: result.record.spaceId,
            scopes: result.record.scope.split(/\s+/).filter(Boolean),
          },
        };
      }
      return {
        ok: false,
        response:
          result.response.status === 403
            ? aiGatewayInsufficientScopeResponse(
                auth.requiredScopes[0] ?? "ai.model",
              )
            : aiGatewayUnauthorizedResponse(),
      };
    },
  });
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
