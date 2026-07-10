/**
 * Session-authed Run (`/api/v1/runs`) and RunGroup (`/api/v1/run-groups`)
 * control routes: read, approve, apply, logs/events/cancel/cost, grouped-run
 * read/approve. Extracted from `control-routes.ts` (P3 god-file split).
 */
import type {
  ApplyExpectedGuard,
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  ConnectionScopeHints,
  CreateApplyRunRequest,
  CreateConnectionFile,
  CreateConnectionRequest,
  DeployControlErrorCode,
  Deployment,
  InternalDeployRequest,
  ListConnectionsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  OpenTofuModuleSource,
  PlanRunResponse,
  PublicPlanRun,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  ArtifactSnapshotRequest,
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
  DeployResponse,
  PublicDeployResponse,
} from "takosumi-contract/deploy";
import type {
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
  PublicCapsuleCompatibilityReportResponse,
} from "takosumi-contract/capsules";
import type { ListProvidersResponse } from "takosumi-contract/providers";
import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import type {
  CapsuleProviderEnvBindingSet,
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
  CapsuleProviderConnectionBinding,
  CapsuleProviderConnectionBindings,
  CapsuleProviderEnvBinding,
  CapsuleProviderEnvBindings,
  CapsuleProviderConnectionSet,
  ProviderConnection,
} from "takosumi-contract/connections";
import type {
  ProviderResolution,
  PublicProviderResolution,
} from "takosumi-contract/provider-resolution";
import type { OutputShare, OutputShareEntry } from "takosumi-contract/outputs";
import type { PublicDeployment } from "takosumi-contract/deployments";
import type {
  BackupRecord,
  CreateBackupResponse,
  CreateRestoreRequest,
  ListBackupsResponse,
} from "takosumi-contract/backups";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  ListRunsResponse,
  Run,
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
  PublicRun,
} from "takosumi-contract/runs";
import type { JsonValue } from "takosumi-contract";
import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type {
  AppCapsuleMode,
  AppCapsuleStatus,
  CapsuleRecord,
  WorkspaceKind,
} from "../ledger.ts";
import type { SharedCellRuntimeAllocator } from "../runtime.ts";
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
  canAccessWorkspace,
  controlPlaneUnavailable,
  controllerErrorCode,
  controllerErrorResponse,
  isRecord,
  jsonStatus,
  parseControlPageParams,
  publicApplyActionResponse,
  publicCompatibilityReportResponse,
  publicDeployResponse,
  publicDeployment,
  publicCapsule,
  publicPlanActionResponse,
  publicRun,
  requireWorkspaceAccess,
  resolveProviderConnectionBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  connectionScopeHintsFromValues,
  dependencyModeValue,
  dependencyVisibilityValue,
  isGoogleCloudProvider,
  isJsonValue,
  isOutputsMapping,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
  outputShareEntries,
  outputShareSensitivePolicy,
  parseCapsuleProviderConnectionBinding,
  parseCapsuleProviderConnectionBindings,
  parseLimit,
  spaceTypeValue,
  stringRecord,
  stringRecordValue,
} from "./parse.ts";
import {
  deployProjectionModeValue,
  saveProjectionStatusChange,
  syncDeployControlProjectionFromApply,
  syncDeployControlProjectionFromDeploy,
  syncDeployControlProjectionStatusFromRun,
} from "./projection.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/install_config_bootstrap.ts";
import { stableJsonDigest } from "../../../../core/adapters/source/digest.ts";
import { decodeCursor, pageSorted } from "takosumi-contract/pagination";
import { appendLedgerEvent } from "../installation-ledger-events.ts";
import { base64UrlEncodeBytes } from "../encoding.ts";
import { canTransitionAppCapsuleStatus } from "../ledger.ts";

export async function handleRuns(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  const staleSourceSyncRunRead =
    segments[0] === "source-sync-runs" && segments.length === 2;
  // Stale dashboard assets from before the Run route consolidation polled
  // /api/v1/source-sync-runs/:id. Keep this read-only alias so already-open
  // production tabs do not spin on 404s during source sync waits. New clients
  // use /api/v1/runs/:id; this route intentionally has no leaf actions.
  if (staleSourceSyncRunRead) {
    if (method !== "GET") return methodNotAllowed("GET");
    const runId = decodeURIComponent(segments[1] ?? "");
    const run = await operations.getRun(runId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: run.workspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    return json({ run: await publicRun(operations, run) });
  }
  // /api/v1/runs/:id ; .../apply ; .../approve ; .../logs ; .../cost
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    const run = await operations.getRun(runId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: run.workspaceId,
      subject: ctx.session.subject,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      await syncDeployControlProjectionStatusFromRun({ store, run });
      return json({ run: await publicRun(operations, run) });
    }
    const leaf = segments[2];
    if (leaf === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRun(request, operations, runId, ctx.session.subject);
    }
    if (leaf === "apply" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await applyPlanRun(
        request,
        operations,
        store,
        ctx.session.subject,
        runId,
      );
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
      // Public, non-secret cost projection: the billing reservation values the
      // controller already computed at plan time (estimated / available credits,
      // reservation status, credit-shortfall reasons). Workspace-gated above.
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

/** SSE stream of a run's status. Reads the in-process controller projection and
 * emits the run only when it changes; keeps the connection warm with comments;
 * closes on a terminal status or after a safety cap (the client reconnects). */
function runStatusStream(
  ctx: ControlDispatchContext,
  runId: string,
  initialRun: Awaited<
    ReturnType<ControlDispatchContext["operations"]["getRun"]>
  >,
): Response {
  const { operations, request } = ctx;
  const encoder = new TextEncoder();
  // Cost guard: this is a per-viewer server-side read loop, so keep the D1
  // reads bounded — start modest, back off while nothing changes (deploys take
  // minutes), reset to responsive on a change, and hard-cap the lifetime so a
  // stream can never leak into an unbounded read loop (the client reconnects).
  const MIN_MS = 2500;
  const MAX_INTERVAL_MS = 8000;
  const MAX_MS = 8 * 60 * 1000;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const onAbort = () => {
        cancelled = true;
      };
      request.signal.addEventListener("abort", onAbort);
      const send = (payload: unknown) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };
      const isTerminal = (status: string) => TERMINAL_RUN_STATUSES.has(status);
      try {
        let last = await publicRun(operations, initialRun);
        send({ run: last });
        const startedAt = Date.now();
        let interval = MIN_MS;
        while (
          !cancelled &&
          !isTerminal(last.status) &&
          Date.now() - startedAt < MAX_MS
        ) {
          await new Promise((resolve) => setTimeout(resolve, interval));
          if (cancelled) break;
          let current;
          try {
            current = await publicRun(
              operations,
              await operations.getRun(runId),
            );
          } catch {
            break;
          }
          if (
            current.status !== last.status ||
            current.heartbeatAt !== last.heartbeatAt ||
            runSummaryKey(current.summary) !== runSummaryKey(last.summary)
          ) {
            send({ run: current });
            last = current;
            interval = MIN_MS; // responsive again right after a change
          } else {
            controller.enqueue(encoder.encode(`: ping\n\n`));
            interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * 1.4));
          }
        }
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true;
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
      subject: ctx.session.subject,
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
  sessionSubject: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const reason = body ? stringValue(body.reason) : undefined;
  const run = await operations.approveRun(runId, {
    approvedBy: sessionSubject,
    ...(reason ? { reason } : {}),
  });
  return json({ run: await publicRun(operations, run) });
}

/**
 * Applies a reviewed PlanRun on behalf of the dashboard session (§31 GUI
 * deploy). The plan run is resolved first so the apply is space-permission gated
 * via the plan's OWNING Workspace (a session may not apply another Workspace's plan);
 * only then is the reviewed apply guard rebuilt server-side from that same plan
 * and handed to the controller, which independently re-checks every apply
 * precondition (succeeded plan / passed policy / immutable plan artifact / not a
 * drift_check / apply-once / destructive confirmation).
 */
async function applyPlanRun(
  request: Request,
  operations: ControlPlaneOperations,
  store: AccountsStore,
  sessionSubject: string,
  planRunId: string,
): Promise<Response> {
  const body = await readJsonObject(request.clone()).catch(() => null);
  const confirmDestructive = body?.confirmDestructive === true;
  const { planRun } = await operations.getPlanRun(planRunId);
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: planRun.workspaceId,
    subject: sessionSubject,
  });
  if (!auth.ok) return auth.response;
  const applyRequest: CreateApplyRunRequest = {
    planRunId: planRun.id,
    expected: applyExpectedGuardFromPlanRun(planRun),
    ...(confirmDestructive ? { confirmDestructive: true } : {}),
  };
  const response = await operations.createApplyRun(applyRequest);
  const projectionError = await syncDeployControlProjectionFromApply({
    operations,
    store,
    sessionSubject: sessionSubject as TakosumiSubject,
    planRun,
    response,
  });
  if (projectionError) return projectionError;
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
  // the Capsule's current StateVersion (Deployment ledger retired), keyed by
  // `capsuleId` / `currentStateVersionId`. Any divergence here from
  // APPLY_EXPECTED_GUARD_KEYS would fail every apply with a guard mismatch.
  const capsuleId = planRun.capsuleId ?? planRun.installationId;
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
    ...(planRun.resolvedProviderEnvBindingsDigest
      ? {
          resolvedProviderEnvBindingsDigest:
            planRun.resolvedProviderEnvBindingsDigest,
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
