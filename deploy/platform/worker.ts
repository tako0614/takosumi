// THE operator-deployed Takosumi platform worker (app.takosumi.com).
//
// This single worker hosts the accounts plane (bare-origin OIDC issuer +
// dashboard SPA) and the OpenTofu-native deploy-control plane in one process.
// The accounts handler owns the public HTTP surface and serves the dashboard SPA
// from its built-in ASSETS fallback (non-API GET/HEAD). Public `/api` control
// routes are still the canonical Takosumi Space / Source / Connection /
// Installation / Dependency / SourceSnapshot / DependencySnapshot /
// StateSnapshot / Run / RunGroup / Deployment / OutputSnapshot / Backup surface, but this platform worker reaches the
// deploy-control implementation in-process through the `deployControlFetch` /
// operations seam injected below. There is no separate control-plane worker.
// The two Durable Object classes (coordination leases/alarms + the OpenTofu
// Container runner) are re-exported so the wrangler bindings/migrations can
// name them.

import {
  type CloudflareWorkerEnv,
  createCloudflareWorker,
} from "../accounts-cloudflare/src/handler.ts";
import type { ControlPlaneOperations } from "@takosjp/takosumi-accounts-service";
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
import { handleCfProxyRequest } from "../../worker/src/cf_proxy_worker.ts";
import { constantTimeEqualsString } from "../../src/service/shared/constant_time.ts";

export { CoordinationObject, OpenTofuRunnerObject };

// In-process deploy-control seam, one cached service per env, shared with the
// unified Takos worker. The accounts deploy-control proxy calls the typed
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

// Adapt the in-process `TakosumiOperations` facade to the dashboard's
// `ControlPlaneOperations` shape. The two are identical EXCEPT `getSource`:
// `TakosumiOperations.getSource` resolves the `{ source }` envelope
// (`SourceResponse`) while the control routes consume a bare `Source` (they read
// `source.spaceId` for the access check). Unwrap `.source` here so the routes do
// not silently observe `undefined` for the space binding.
async function controlPlaneOperationsFor(
  env: PlatformEnv,
): Promise<ControlPlaneOperations> {
  const operations = await deployControlSeam(env).operations();
  return {
    ...operations,
    getSource: async (id) => (await operations.getSource(id)).source,
  };
}

const accountsWorker = createCloudflareWorker({
  deployControlFetch: (env) => deployControlSeam(env).fetch,
  deployControlOperations: (env) => deployControlSeam(env).operations(),
  // The session-authed `/v1/control/*` dashboard surface (M10) reads the SAME
  // in-process operations facade the deploy-control proxy uses, adapted to the
  // `ControlPlaneOperations` shape (see `controlPlaneOperationsFor`).
  controlPlaneOperations: (env) => controlPlaneOperationsFor(env),
});

// The platform worker owns the public fetch surface (accounts handler) AND runs
// the OpenTofu run-queue consumer in-process. The consumer reaches the same
// in-process deploy-control controller the fetch seam uses, so a run dispatched
// by the create path is executed here against the same store.
const runQueueConsumer = createDeployControlQueueConsumer();

export default {
  async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/internal/platform/hardening-gates") {
      return handleHardeningGatesRequest(request, env);
    }
    // Managed cf-proxy: the cloudflare provider base_url for a managed run points
    // here so a plain `cloudflare_workers_script` is redirected into the WfP
    // dispatch namespace (the provider cannot place a script in a namespace).
    if (url.pathname.startsWith("/internal/cf-proxy/")) {
      return handleCfProxyRequest(request, url);
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
  // §28 drift sweep (one space_drift_check RunGroup per Space with active
  // Installations).
  async scheduled(_event: unknown, env: CloudflareWorkerEnv): Promise<void> {
    await runScheduledSourcePoll(env as unknown as DeployControlEnv);
    if (driftCheckEnabled(env)) {
      await runScheduledDriftSweep(env as unknown as DeployControlEnv);
    }
  },
};

const HARDENING_GATE_REF_PREFIX = "git+";
const HARDENING_GATE_COMMIT_PIN_PATTERN = /@[0-9a-f]{40,64}#/i;
const HARDENING_GATE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface ProductionHardeningGateResult {
  readonly ok: boolean;
  readonly enforced: boolean;
  readonly checks: {
    readonly containerSmoke: ProductionHardeningCheck;
    readonly egressEnforcement: ProductionHardeningCheck;
    readonly providerTemplates: ProductionHardeningCheck;
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
    egressEnforcement: evidenceCheck(
      env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_REF,
      env.TAKOSUMI_EGRESS_ENFORCEMENT_EVIDENCE_DIGEST,
    ),
    providerTemplates: evidenceCheck(
      env.TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_REF,
      env.TAKOSUMI_PROVIDER_CATALOG_EVIDENCE_DIGEST,
    ),
    secretBoundary: evidenceCheck(
      env.TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_REF,
      env.TAKOSUMI_SECRET_BOUNDARY_EVIDENCE_DIGEST,
    ),
  };
  return {
    ok:
      checks.containerSmoke.ok &&
      checks.egressEnforcement.ok &&
      checks.providerTemplates.ok &&
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
  // Adapt the two methods the sweep needs: active Installation listing from the
  // controller and grouped drift checks through the RunGroups service.
  const driftOps: DriftSweepOperations = {
    listActiveInstallations: (limit) =>
      operations.controller.listActiveInstallations(limit),
    createSpaceDriftCheck: (spaceId, options) =>
      operations.runGroups.createSpaceDriftCheck(spaceId, options),
  };
  await driftSweep(driftOps, { limit: SCHEDULED_DRIFT_SWEEP_LIMIT });
}
