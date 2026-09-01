/**
 * Session-authed Run (`/api/v1/runs`) and RunGroup (`/api/v1/run-groups`)
 * control routes: read, approve, apply, logs/events/cancel/cost, grouped-run
 * read/approve. Extracted from `control-routes.ts` (P3 god-file split).
 */
import { log } from "../../../../core/shared/log.ts";
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  ListConnectionsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  Source,
  CreateSourceRequest,
  CreateSourceResponse,
  ListSourceSnapshotsResponse,
  ListSourcesResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListCredentialRecipesResponse } from "takosumi-contract/credential-recipes";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  InstallConfig,
  Capsule,
  OutputAllowlistEntry,
  PolicyConfig,
  PublicInstallConfig,
  PublicCapsule,
} from "takosumi-contract/install-configs";
import type {
  Dependency,
  DependencyMode,
  DependencyOutputMapping,
  DependencyVisibility,
} from "takosumi-contract/dependencies";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { Page, PageParams } from "takosumi-contract/pagination";
import type {
  ProviderBinding,
  ProviderBindings,
  ProviderBindingSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { AccountsStore } from "../store.ts";
import type {
  ControlPlaneOperations,
  RunGroupWithRunsLike,
  ControlWorkspaceRole,
  ControlMembershipStatus,
  PublicWorkspaceMember,
  MembershipActor,
} from "../control-operations.ts";
import {
  errorJson,
  json,
  methodNotAllowed,
  readJsonObject,
  readOptionalJsonObject,
  stringValue,
} from "../http-helpers.ts";
import {
  type ControlDispatchContext,
  type ControlSession,
  canAccessWorkspace,
  controlPlaneUnavailable,
  controllerErrorCode,
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireResourceWorkspaceAccess,
  requireWorkspaceAccess,
  resolveProviderBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  dependencyModeValue,
  dependencyVisibilityValue,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseProviderBinding,
  parseProviderBindings,
  parseLimit,
  workspaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { base64UrlEncodeBytes } from "../encoding.ts";

export async function handleRuns(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/runs/:id ; .../apply ; .../approve ; .../logs ; .../cost
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    const run = await operations.getRun(runId);
    const auth = await requireResourceWorkspaceAccess({
      operations,
      store,
      workspaceId: run.workspaceId,
      session: ctx.session,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json({ run: await publicRun(operations, run) });
    }
    const leaf = segments[2];
    if (leaf === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRun(request, operations, runId, ctx.session);
    }
    if (leaf === "apply" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await applyPlanRun(operations, store, ctx.session, runId);
    }
    if (leaf === "logs" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunLogs(runId));
    }
    if (leaf === "events" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(await operations.getRunEvents(runId));
    }
    if (leaf === "cancel" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return json({
        run: await publicRun(operations, await operations.cancelRun(runId)),
      });
    }
    if (leaf === "cost" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Public, non-secret cost projection: values the controller already
      // computed at plan time (estimated USD, showback or host-extension
      // decision, and policy reasons). Workspace-gated above.
      return json({ cost: await operations.getRunCost(runId) });
    }
    if (leaf === "stream" && segments.length === 3) {
      if (method !== "GET") return methodNotAllowed("GET");
      // Real-time run status over SSE: one server-held connection per viewer
      // that pushes the run on every status/heartbeat/summary change and closes
      // at a terminal status — so the dashboard subscribes instead of polling.
      // Workspace access was already enforced above.
      return runStatusStream(ctx, runId, run);
    }
  }
  return undefined;
}

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

/** Stable value key for a run's plan change summary. The projection rebuilds
 * the summary object on every read, so an identity compare would flag a change
 * on every poll tick (spamming SSE frames for any non-terminal run that has a
 * plan summary, e.g. waiting_approval); compare the counts instead. */
function runSummaryKey(
  summary:
    | {
        readonly add?: number;
        readonly change?: number;
        readonly destroy?: number;
      }
    | undefined,
): string {
  return summary
    ? `${summary.add ?? 0}:${summary.change ?? 0}:${summary.destroy ?? 0}`
    : "";
}

// ---------------------------------------------------------------------------
// Shared SSE fan-out (B-W4)
// ---------------------------------------------------------------------------
//
// One poll loop per (operations, runId) reads the run projection and fans the
// change out to every subscribed viewer, replacing the per-viewer D1 read
// loop (N viewers used to cost N reads per tick; now 1). Each subscriber is
// periodically RE-authorized inside the loop so a viewer whose workspace
// membership is revoked mid-stream is disconnected instead of riding the
// stream to terminal.

const SSE_MIN_MS = 2500;
const SSE_MAX_INTERVAL_MS = 8000;
/** Per-subscriber lifetime cap; the client reconnects. */
const SSE_SUBSCRIBER_MAX_MS = 8 * 60 * 1000;
/** Consecutive projection-read failures tolerated before the hub gives up. */
const SSE_READ_FAILURE_LIMIT = 3;
/** How often each subscriber's workspace access is re-verified in-loop. */
const SSE_REAUTHZ_INTERVAL_MS = 60 * 1000;

interface RunStreamSubscriber {
  enqueue(frame: Uint8Array): boolean;
  close(): void;
  reauthorize(): Promise<boolean>;
  readonly expiresAtMs: number;
  lastReauthzAtMs: number;
}

interface RunStreamHub {
  readonly subscribers: Set<RunStreamSubscriber>;
  /** Latest public projection the loop observed (joiners get it instantly). */
  last: Awaited<ReturnType<typeof publicRun>>;
  running: boolean;
}

const runStreamHubsByOperations = new WeakMap<
  object,
  Map<string, RunStreamHub>
>();

const sseEncoder = new TextEncoder();

function sseDataFrame(payload: unknown): Uint8Array {
  return sseEncoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

const SSE_PING_FRAME = new TextEncoder().encode(`: ping\n\n`);

/** Value key for live apply progress, so a new count pushes a frame. */
function runProgressKey(
  progress:
    | { readonly completed?: number; readonly inFlight?: number }
    | undefined,
): string {
  return progress ? `${progress.completed ?? 0}:${progress.inFlight ?? 0}` : "";
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

async function runStreamHubLoop(
  operations: ControlDispatchContext["operations"],
  runId: string,
  hub: RunStreamHub,
  hubs: Map<string, RunStreamHub>,
): Promise<void> {
  let interval = SSE_MIN_MS;
  let consecutiveReadFailures = 0;
  try {
    while (hub.subscribers.size > 0 && !isTerminalRunStatus(hub.last.status)) {
      await new Promise((resolve) => setTimeout(resolve, interval));
      if (hub.subscribers.size === 0) break;
      let current: Awaited<ReturnType<typeof publicRun>>;
      try {
        current = await publicRun(operations, await operations.getRun(runId));
        consecutiveReadFailures = 0;
      } catch (cause) {
        // A single transient store error used to disconnect every viewer of
        // this run, silently. Ride out a few, then give up loudly so the
        // failure is diagnosable instead of looking like a normal close.
        consecutiveReadFailures += 1;
        if (consecutiveReadFailures < SSE_READ_FAILURE_LIMIT) continue;
        log.warn("control.run_stream.read_failed", {
          runId,
          failures: consecutiveReadFailures,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        break;
      }
      const changed =
        current.status !== hub.last.status ||
        current.heartbeatAt !== hub.last.heartbeatAt ||
        runSummaryKey(current.summary) !== runSummaryKey(hub.last.summary) ||
        runProgressKey(current.applyProgress) !==
          runProgressKey(hub.last.applyProgress);
      hub.last = current;
      const frame = changed ? sseDataFrame({ run: current }) : SSE_PING_FRAME;
      interval = changed
        ? SSE_MIN_MS
        : Math.min(SSE_MAX_INTERVAL_MS, Math.round(interval * 1.4));
      const now = Date.now();
      for (const subscriber of [...hub.subscribers]) {
        if (now >= subscriber.expiresAtMs) {
          hub.subscribers.delete(subscriber);
          subscriber.close();
          continue;
        }
        if (now - subscriber.lastReauthzAtMs >= SSE_REAUTHZ_INTERVAL_MS) {
          subscriber.lastReauthzAtMs = now;
          let stillAllowed = false;
          try {
            stillAllowed = await subscriber.reauthorize();
          } catch {
            stillAllowed = false;
          }
          if (!stillAllowed) {
            hub.subscribers.delete(subscriber);
            subscriber.close();
            continue;
          }
        }
        if (!subscriber.enqueue(frame)) {
          hub.subscribers.delete(subscriber);
          subscriber.close();
        }
      }
    }
  } finally {
    for (const subscriber of hub.subscribers) subscriber.close();
    hub.subscribers.clear();
    hub.running = false;
    if (hubs.get(runId) === hub) hubs.delete(runId);
  }
}

/** SSE stream of a run's status backed by the shared per-run fan-out. */
function runStatusStream(
  ctx: ControlDispatchContext,
  runId: string,
  initialRun: Awaited<
    ReturnType<ControlDispatchContext["operations"]["getRun"]>
  >,
): Response {
  const { operations, store, request, session } = ctx;
  const workspaceId = initialRun.workspaceId;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const initial = await publicRun(operations, initialRun);
      // A terminal run needs no hub: emit the snapshot and close.
      if (isTerminalRunStatus(initial.status)) {
        controller.enqueue(sseDataFrame({ run: initial }));
        controller.close();
        return;
      }
      let hubs = runStreamHubsByOperations.get(operations);
      if (!hubs) {
        hubs = new Map();
        runStreamHubsByOperations.set(operations, hubs);
      }
      let hub = hubs.get(runId);
      if (!hub) {
        hub = { subscribers: new Set(), last: initial, running: false };
        hubs.set(runId, hub);
      }
      let closed = false;
      const subscriber: RunStreamSubscriber = {
        enqueue: (frame) => {
          if (closed) return false;
          try {
            controller.enqueue(frame);
            return true;
          } catch {
            return false;
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        },
        reauthorize: async () => {
          const auth = await requireWorkspaceAccess({
            operations,
            store,
            workspaceId,
            session,
          });
          return auth.ok;
        },
        expiresAtMs: Date.now() + SSE_SUBSCRIBER_MAX_MS,
        lastReauthzAtMs: Date.now(),
      };
      request.signal.addEventListener("abort", () => {
        hub?.subscribers.delete(subscriber);
        subscriber.close();
      });
      // The joiner sees the hub's freshest snapshot immediately.
      subscriber.enqueue(sseDataFrame({ run: hub.last }));
      hub.subscribers.add(subscriber);
      if (!hub.running) {
        hub.running = true;
        void runStreamHubLoop(operations, runId, hub, hubs);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}

export async function handleRunGroups(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/run-groups/:id ; .../approve
  if (segments[0] === "run-groups" && segments.length >= 2) {
    const runGroupId = decodeURIComponent(segments[1] ?? "");
    const existing = await operations.runGroups.getRunGroup(runGroupId);
    if (!existing) return errorJson("not_found", "not found", 404);
    const runGroupWorkspaceId = existing.runGroup.workspaceId;
    if (!runGroupWorkspaceId) return errorJson("not_found", "not found", 404);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: runGroupWorkspaceId,
      session: ctx.session,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(existing);
    }
    if (segments[2] === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRunGroup(operations, runGroupId);
    }
  }
  return undefined;
}

async function approveRun(
  request: Request,
  operations: ControlPlaneOperations,
  runId: string,
  session: ControlSession,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const reason = body ? stringValue(body.reason) : undefined;
  const run = await operations.approveRun(runId, {
    approvedBy: session.subject,
    ...(reason ? { reason } : {}),
  });
  return json({ run: await publicRun(operations, run) });
}

/**
 * Applies a reviewed PlanRun on behalf of the dashboard session (§31 GUI
 * deploy). The plan run is resolved first so the apply is Workspace-permission gated
 * via the plan's OWNING Workspace (a session may not apply another Workspace's plan);
 * only then is the reviewed apply guard rebuilt server-side from that same plan
 * and handed to the controller, which independently re-checks every apply
 * precondition (succeeded plan / passed policy / immutable plan artifact / not a
 * drift_check / apply-once / recorded approval when required).
 */
async function applyPlanRun(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  planRunId: string,
): Promise<Response> {
  const { planRun } = await operations.getPlanRun(planRunId);
  const auth = await requireResourceWorkspaceAccess({
    operations,
    store,
    workspaceId: planRun.workspaceId,
    session,
  });
  if (!auth.ok) return auth.response;
  const applyRequest: CreateApplyRunRequest = {
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
  };
  const response = await operations.createApplyRun(applyRequest);
  return jsonStatus(await publicApplyActionResponse(operations, response), 201);
}

/**
 * Rebuilds the `ApplyExpectedGuard` from the reviewed PlanRun. Mirrors the
 * service-side `applyExpectedGuardFromPlanRun` (deploy-control domain): the guard
 * pins the apply to the exact reviewed plan (digests + artifact + state guard),
 * and the controller structurally re-derives + compares it, so a tampered guard
 * cannot widen what is applied. Missing plan digest / artifact surface as a typed
 * `failed_precondition` from the controller (the plan has not completed).
 */
function applyExpectedGuardFromPlanRun(
  planRun: PublicPlanRun,
): ApplyExpectedGuard {
  // Mirror the deploy-control emit + TOCTOU digest keys EXACTLY: the guard pins
  // the Capsule's current StateVersion, keyed by
  // `capsuleId` / `currentStateVersionId`. Any divergence here from
  // APPLY_EXPECTED_GUARD_KEYS would fail every apply with a guard mismatch.
  const capsuleId = planRun.capsuleId;
  return {
    planRunId: planRun.id,
    ...(capsuleId ? { capsuleId } : {}),
    ...(capsuleId
      ? { currentStateVersionId: planRun.capsuleCurrentStateVersionId ?? null }
      : {}),
    runnerProfileId: planRun.runnerProfileId,
    sourceDigest: planRun.sourceDigest,
    variablesDigest: planRun.variablesDigest,
    policyDecisionDigest: planRun.policyDecisionDigest,
    planDigest: planRun.planDigest ?? "",
    planArtifactDigest: planRun.planArtifact?.digest ?? "",
    ...(planRun.sourceCommit ? { sourceCommit: planRun.sourceCommit } : {}),
    ...(planRun.providerLockDigest
      ? { providerLockDigest: planRun.providerLockDigest }
      : {}),
    ...(planRun.resolvedProviderBindingsDigest
      ? {
          resolvedProviderBindingsDigest:
            planRun.resolvedProviderBindingsDigest,
        }
      : {}),
  };
}

async function getRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.getRunGroup(runGroupId);
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}

async function approveRunGroup(
  operations: ControlPlaneOperations,
  runGroupId: string,
): Promise<Response> {
  const result = await operations.runGroups.approveRunGroup(runGroupId);
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}
