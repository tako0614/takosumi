import { runGetWithinDeadline } from "./run-read-deadline.ts";
/**
 * Session-authed Run (`/api/v1/runs`) and RunGroup (`/api/v1/run-groups`)
 * control routes: read, approve, apply, logs/events/cancel/cost, grouped-run
 * read/approve. Extracted from `control-routes.ts` (P3 god-file split).
 */
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
  requireWorkspaceAccess,
  resolveProviderBindings,
} from "./shared.ts";
import {
  booleanValue,
  connectionCredentialFiles,
  connectionScopeHints,
  isJsonValue,
  isPlainJsonObject,
  jsonRecordValue,
  modulePathValue,
  outputAllowlistValue,
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
import { measureRequestPhaseOperation } from "../request-phase-diagnostics.ts";

export async function handleRuns(
  ctx: ControlDispatchContext,
  segments: readonly string[],
  method: string,
): Promise<Response | undefined> {
  const { request, url, operations, store } = ctx;
  // /api/v1/runs/:id ; .../apply ; .../approve ; .../logs ; .../cost
  if (segments[0] === "runs" && segments.length >= 2) {
    const runId = decodeURIComponent(segments[1] ?? "");
    if (segments.length === 2 && method === "GET") {
      const read = async (deadlineAssertActive: () => void): Promise<Response> => {
        const assertActive = (): void => {
          ctx.assertActive?.();
          deadlineAssertActive();
        };
        assertActive();
        const run = await measureRequestPhaseOperation(
          ctx.diagnostics,
          "run_get_read",
          () => operations.getRun(runId),
        );
        assertActive();
        const auth = await measureRequestPhaseOperation(
          ctx.diagnostics,
          "run_get_access",
          () => requireWorkspaceAccess({
            operations,
            store,
            workspaceId: run.workspaceId,
            ...(run.capsuleId ? { capsuleId: run.capsuleId } : {}),
            session: ctx.session,
            assertActive,
            ...(ctx.diagnostics ? { diagnostics: ctx.diagnostics } : {}),
          }),
        );
        assertActive();
        if (!auth.ok) return auth.response;
        const publicValue = await publicRun(operations, run, assertActive);
        assertActive();
        return json({ run: publicValue });
      };
      return ctx.withinRunReadDeadline
        ? await ctx.withinRunReadDeadline(read)
        : await runGetWithinDeadline(read);
    }
    const run = await operations.getRun(runId);
    const auth = await requireWorkspaceAccess({
      operations,
      store,
      workspaceId: run.workspaceId,
      ...(run.capsuleId ? { capsuleId: run.capsuleId } : {}),
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
      // A long-lived stream needs a way to renew the authentication decision.
      // In-process authenticated callers currently have request-local identity
      // only; they may use the ordinary one-shot Run read instead.
      if (!ctx.session.reauthorizeBearer)
        return errorJson("forbidden", "Run stream requires revalidation.", 403);
      // Real-time run status over SSE: one server-held connection per viewer
      // that pushes the run on every status/heartbeat/summary change and closes
      // at a terminal status — so the dashboard subscribes instead of polling.
      // The stream repeats Workspace access checks while the request is open.
      return runStatusStream(ctx, runId, run, ctx.runStreamTiming);
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

const RUN_STREAM_REAUTH_MS = 60 * 1000;

function waitForRunPoll(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** SSE stream of a run's status. Reads the controller projection for this
 * viewer, periodically rechecks Workspace access, and closes on revocation,
 * error, cancellation, a terminal status, or the lifetime cap. The optional
 * clock/poll seam allows deterministic tests without process-wide fake timers. */
export function runStatusStream(
  ctx: ControlDispatchContext,
  runId: string,
  initialRun: Awaited<
    ReturnType<ControlDispatchContext["operations"]["getRun"]>
  >,
  timing: {
    readonly now: () => number;
    readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  } = { now: Date.now, wait: waitForRunPoll },
): Response {
  const { operations, request, store, session } = ctx;
  const workspaceId = initialRun.workspaceId;
  const encoder = new TextEncoder();
  // Cost guard: this is a per-viewer server-side read loop, so keep the D1
  // reads bounded — start modest, back off while nothing changes (deploys take
  // minutes), reset to responsive on a change, and hard-cap the lifetime so a
  // stream can never leak into an unbounded read loop (the client reconnects).
  const MIN_MS = 2500;
  const MAX_INTERVAL_MS = 8000;
  const MAX_MS = 8 * 60 * 1000;
  let cancelled = false;
  const pollAbort = new AbortController();
  let removeRequestAbortListener: (() => void) | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = () => {
        cancelled = true;
        pollAbort.abort();
        try {
          controller.close();
        } catch {
          /* already closed or cancelled */
        }
      };
      request.signal.addEventListener("abort", stop, { once: true });
      removeRequestAbortListener = () =>
        request.signal.removeEventListener("abort", stop);
      const send = (payload: unknown): boolean => {
        if (cancelled || controller.desiredSize === null || controller.desiredSize <= 0)
          return false;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
        return true;
      };
      const isTerminal = (status: string) => TERMINAL_RUN_STATUSES.has(status);
      const startedAt = timing.now();
      let nextReauthAt = startedAt;
      const stillAuthorized = async (force = false): Promise<boolean> => {
        if (cancelled) return false;
        if (!force && timing.now() < nextReauthAt) return true;
        try {
          if (!session.reauthorizeBearer || !(await session.reauthorizeBearer()))
            return false;
          const auth = await requireWorkspaceAccess({
            operations,
            store,
            workspaceId,
            ...(initialRun.capsuleId ? { capsuleId: initialRun.capsuleId } : {}),
            session,
          });
          if (!auth.ok || cancelled) return false;
          nextReauthAt = timing.now() + RUN_STREAM_REAUTH_MS;
          return true;
        } catch {
          return false;
        }
      };
      try {
        if (request.signal.aborted || !(await stillAuthorized())) return;
        let last = await publicRun(operations, initialRun);
        if (!(await stillAuthorized(true)) || !send({ run: last })) return;
        let interval = MIN_MS;
        while (
          !cancelled &&
          !isTerminal(last.status) &&
          timing.now() - startedAt < MAX_MS
        ) {
          await timing.wait(interval, pollAbort.signal);
          if (cancelled || timing.now() - startedAt >= MAX_MS) break;
          if (!(await stillAuthorized())) break;
          let run;
          try {
            run = await operations.getRun(runId);
          } catch {
            break;
          }
          // A run must never change ownership under an already authorized
          // stream, even if a broken store returns a different projection.
          if (cancelled || run.workspaceId !== workspaceId) break;
          let current;
          try {
            current = await publicRun(operations, run);
          } catch {
            break;
          }
          if (cancelled || timing.now() - startedAt >= MAX_MS) break;
          const changed =
            current.status !== last.status ||
            current.heartbeatAt !== last.heartbeatAt ||
            runSummaryKey(current.summary) !== runSummaryKey(last.summary);
          if (!(await stillAuthorized(changed))) break;
          if (changed) {
            if (!send({ run: current })) break;
            last = current;
            interval = MIN_MS; // responsive again right after a change
          } else {
            if (controller.desiredSize === null || controller.desiredSize <= 0) break;
            controller.enqueue(encoder.encode(`: ping\n\n`));
            interval = Math.min(MAX_INTERVAL_MS, Math.round(interval * 1.4));
          }
        }
      } catch {
        // SSE has already returned HTTP 200; fail closed without exposing
        // internal projection/authentication details in a frame.
      } finally {
        cancelled = true;
        pollAbort.abort();
        removeRequestAbortListener?.();
        removeRequestAbortListener = undefined;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true;
      pollAbort.abort();
      removeRequestAbortListener?.();
      removeRequestAbortListener = undefined;
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
      ...(existing.runs.length > 0 && existing.runs.every((run) => run.capsuleId === existing.runs[0]?.capsuleId) && existing.runs[0]?.capsuleId
        ? { capsuleId: existing.runs[0].capsuleId }
        : {}),
      session: ctx.session,
    });
    if (!auth.ok) return auth.response;
    if (segments.length === 2) {
      if (method !== "GET") return methodNotAllowed("GET");
      return json(existing);
    }
    if (segments[2] === "approve" && segments.length === 3) {
      if (method !== "POST") return methodNotAllowed("POST");
      return await approveRunGroup(operations, runGroupId, ctx.session.subject);
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
  const auth = await requireWorkspaceAccess({
    operations,
    store,
    workspaceId: planRun.workspaceId,
    ...(planRun.capsuleId ? { capsuleId: planRun.capsuleId } : {}),
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
    ...(planRun.capsuleExecutionAuthorityEpoch !== undefined
      ? {
          capsuleExecutionAuthorityEpoch:
            planRun.capsuleExecutionAuthorityEpoch,
        }
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
  actorAccountId: string,
): Promise<Response> {
  const result = await operations.runGroups.approveRunGroup(runGroupId, actorAccountId);
  if (!result) return errorJson("not_found", "not found", 404);
  return json(result);
}
