/**
 * Stage two of the two-stage uninstall: the scheduled finalizer.
 *
 * Each tick reads the Capsules whose grace period has ended and advances each
 * one through a small state machine. The Capsule row is the only authority:
 * every step re-reads it and writes through a revision compare-and-set, so a
 * cancel, a newer request, or a concurrent tick turns the remaining steps of
 * this tick into no-ops. Nothing here bypasses the ordinary teardown pipeline.
 *
 * 1. Export once. The backups lane writes a Capsule-scoped export and the
 *    outcome (`exported` / `failed` / `skipped`) is recorded on the request. A
 *    failed or unavailable export does not stop the teardown. The attempt is
 *    claimed before creating artifacts; an uncertain interrupted attempt
 *    blocks automatic teardown instead of exporting again.
 * 2. Plan. The Plan id and request time are recorded first, then the destroy
 *    Plan is created with that exact id. A Plan that is still missing after
 *    {@link DESTROY_PLAN_CREATION_WINDOW_MS} counts as a failed attempt, so a
 *    concurrent tick never mints a second teardown for one attempt.
 * 3. Verify and commit. A completed Plan must be this Capsule's destroy at the
 *    current execution epoch, policy-passed, with known delete-only changes.
 *    The request then moves to `destroying`; from there the owner can cancel
 *    only if the finalizer blocks before anything was dispatched.
 * 4. Approve and apply. The finalizer records an approval naming the request
 *    and creates the Apply with an exact id. Apply admission re-checks every
 *    ordinary precondition (state cursor, execution authority, policy).
 *
 * Anything the finalizer cannot continue unattended is recorded as
 * `blockedReason`; the Capsule stays `uninstalled` for the owner to cancel or
 * delete immediately. Repeated unexpected errors also end in `blockedReason`,
 * so one request can never hold the head of the due queue forever.
 */

import type {
  Capsule,
  CapsulePreDestroyExport,
  CapsuleUninstall,
} from "takosumi-contract/capsules";
import type { BackupRecord } from "takosumi-contract/backups";
import type {
  ApplyRun,
  ApplyRunResponse,
  CreateApplyRunRequest,
  PlanRun,
  PlanRunResponse,
} from "@takosumi/internal/deploy-control-api";
import type { Run } from "takosumi-contract/runs";
import type {
  OpenTofuControlStore,
  WorkspaceManagementAuthority,
} from "../deploy-control/store.ts";
import type { ActivityRecorder } from "../activity/mod.ts";
import { NOOP_ACTIVITY_RECORDER } from "../activity/mod.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import { applyExpectedGuardFromPlanRun } from "../deploy-control/mod.ts";
import type { CapsulesService } from "./mod.ts";
import {
  scheduledUninstallAuthorizationFailure,
  UNINSTALL_AUTHORIZATION_REASONS,
  type UninstallRequesterValidator,
} from "./uninstall_authorization.ts";

/** Actor recorded on every Run and approval the finalizer creates. */
export const SCHEDULED_UNINSTALL_ACTOR = "system:scheduled-uninstall";

/** Destroy Plan attempts per uninstall request before it is left to the owner. */
export const MAX_SCHEDULED_DESTROY_ATTEMPTS = 3;

/** Unexpected finalizer errors per request before it is left to the owner. */
export const MAX_UNINSTALL_FINALIZE_FAILURES = 6;

/**
 * How long a recorded teardown Plan id may stay without a Plan row before the
 * attempt counts as failed. Covers a concurrent tick that is still creating it.
 */
export const DESTROY_PLAN_CREATION_WINDOW_MS = 15 * 60 * 1000;

/** An export claim without a result beyond this window requires reconciliation. */
export const PRE_DESTROY_EXPORT_WINDOW_MS = 15 * 60 * 1000;

/** Capsules read per tick. Each one may take several bounded steps. */
export const DEFAULT_UNINSTALL_FINALIZE_LIMIT = 10;

const MAX_STEPS_PER_CAPSULE = 6;

/** Stable `blockedReason` tokens. */
export const SCHEDULED_DESTROY_BLOCKED_REASONS = {
  planFailed: "destroy_plan_failed",
  planCancelled: "destroy_plan_cancelled",
  planRefused: "destroy_plan_refused",
  planNotDeleteOnly: "destroy_plan_not_delete_only",
  planUnverifiable: "destroy_plan_unverifiable",
  planMissing: "destroy_plan_missing",
  applyRefused: "destroy_apply_refused",
  applyFailed: "destroy_apply_failed",
  finalizeFailed: "finalize_failed",
  exportIncomplete: "pre_destroy_export_incomplete",
} as const;

/**
 * Refusals that clear on their own (a draining Workspace, a busy lifecycle
 * lease) are retried on a later tick instead of blocking the request.
 */
const TRANSIENT_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  "workspace_management_admission_conflict",
  "capsule_lifecycle_busy",
]);

export interface CapsuleUninstallFinalizerDependencies {
  readonly store: Pick<
    OpenTofuControlStore,
    | "listDueCapsuleUninstalls"
    | "getPlanRun"
    | "getApplyRun"
    | "getCapsuleExecutionAuthorityEpoch"
    | "getWorkspace"
    | "getWorkspaceMember"
  >;
  readonly capsules: Pick<
    CapsulesService,
    "getCapsule" | "advanceCapsuleUninstall"
  >;
  readonly controller: {
    createCapsuleDestroyPlan(
      capsuleId: string,
      context: { readonly actor?: string },
      internal: { readonly planRunId?: string },
    ): Promise<PlanRunResponse>;
    approveRun(
      id: string,
      input: { readonly approvedBy?: string; readonly reason?: string },
    ): Promise<Run>;
    createApplyRun(
      request: CreateApplyRunRequest,
      context: { readonly actor?: string },
      internal: { readonly applyRunId?: string },
    ): Promise<ApplyRunResponse>;
  };
  /** Absent or disabled backups record an honest `skipped` export. */
  readonly backups?: {
    readonly enabled: boolean;
    captureManagementAuthority(
      workspaceId: string,
    ): Promise<WorkspaceManagementAuthority>;
    createBackup(request: {
      readonly workspaceId: string;
      readonly capsuleId: string;
      readonly environment: string;
      readonly scope: "capsule";
      readonly expectedWorkspaceManagementAuthority: WorkspaceManagementAuthority;
    }): Promise<BackupRecord>;
  };
  readonly activity?: ActivityRecorder;
  readonly validateUninstallRequester?: UninstallRequesterValidator;
  readonly now?: () => Date;
  readonly onError?: (error: unknown, capsuleId: string) => void;
}

export interface CapsuleUninstallFinalizeResult {
  readonly scanned: number;
  readonly exportsRecorded: number;
  readonly destroyPlansCreated: number;
  readonly destroysStarted: number;
  readonly blocked: number;
  readonly waiting: number;
  readonly failures: number;
}

type StepOutcome =
  | "progressed"
  | "plan_created"
  | "export_recorded"
  | "destroy_started"
  | "blocked"
  | "waiting"
  | "done";

/**
 * Advances every due uninstall by at most a few bounded steps. Failures are
 * isolated per Capsule; the durable request is the retry authority.
 */
export async function finalizeDueCapsuleUninstalls(
  deps: CapsuleUninstallFinalizerDependencies,
  options: { readonly limit?: number } = {},
): Promise<CapsuleUninstallFinalizeResult> {
  const now = deps.now ?? (() => new Date());
  const limit = Number.isSafeInteger(options.limit) && options.limit! > 0
    ? options.limit!
    : DEFAULT_UNINSTALL_FINALIZE_LIMIT;
  const due = await deps.store.listDueCapsuleUninstalls({
    now: now().toISOString(),
    limit,
  });
  const totals = {
    scanned: due.length,
    exportsRecorded: 0,
    destroyPlansCreated: 0,
    destroysStarted: 0,
    blocked: 0,
    waiting: 0,
    failures: 0,
  };
  for (const listed of due) {
    try {
      for (let step = 0; step < MAX_STEPS_PER_CAPSULE; step += 1) {
        const outcome = await advanceOnce(deps, listed.id, now);
        if (outcome === "export_recorded") totals.exportsRecorded += 1;
        if (outcome === "plan_created") totals.destroyPlansCreated += 1;
        if (outcome === "destroy_started") totals.destroysStarted += 1;
        if (outcome === "blocked") totals.blocked += 1;
        if (outcome === "waiting") {
          totals.waiting += 1;
          await rotateWaitingRequest(deps, listed.id, listed.uninstall!.id, now);
        }
        if (
          outcome === "blocked" ||
          outcome === "waiting" ||
          outcome === "done" ||
          outcome === "destroy_started"
        ) {
          break;
        }
      }
    } catch (error) {
      totals.failures += 1;
      deps.onError?.(error, listed.id);
      if (await recordFinalizeFailure(deps, listed.id, error)) {
        totals.blocked += 1;
      }
    }
  }
  return totals;
}

async function advanceOnce(
  deps: CapsuleUninstallFinalizerDependencies,
  capsuleId: string,
  now: () => Date,
): Promise<StepOutcome> {
  const capsule = await deps.capsules.getCapsule(capsuleId);
  const uninstall = capsule.uninstall;
  if (
    capsule.status !== "uninstalled" ||
    uninstall === undefined ||
    uninstall.phase === "cancelled" ||
    uninstall.blockedReason !== undefined ||
    uninstall.scheduledDestroyAt > now().toISOString()
  ) {
    return "done";
  }
  if (uninstall.phase === "destroying") {
    return await startTeardown(deps, capsule, uninstall);
  }
  if (await blockUnauthorizedRequester(deps, capsule, uninstall)) return "blocked";
  if (uninstall.preDestroyExport === undefined) {
    if (uninstall.preDestroyExportStartedAt !== undefined) {
      if (
        now().getTime() - Date.parse(uninstall.preDestroyExportStartedAt) <
          PRE_DESTROY_EXPORT_WINDOW_MS
      ) return "waiting";
      await block(
        deps,
        capsule,
        uninstall,
        SCHEDULED_DESTROY_BLOCKED_REASONS.exportIncomplete,
      );
      return "blocked";
    }
    return await recordPreDestroyExport(deps, capsule, uninstall, now);
  }
  const plan = uninstall.destroyPlanRunId === undefined
    ? undefined
    : await deps.store.getPlanRun(uninstall.destroyPlanRunId);
  if (plan === undefined) {
    if (
      uninstall.destroyPlanRunId !== undefined &&
      planCreationMayStillBeInFlight(uninstall, now)
    ) {
      return "waiting";
    }
    return await createTeardownPlan(deps, capsule, uninstall, now);
  }
  if (plan.status === "cancelled") {
    // Someone stopped the teardown Plan on purpose; do not plan around them.
    await block(
      deps,
      capsule,
      uninstall,
      SCHEDULED_DESTROY_BLOCKED_REASONS.planCancelled,
    );
    return "blocked";
  }
  if (plan.status === "failed" || plan.status === "expired") {
    return await createTeardownPlan(deps, capsule, uninstall, now);
  }
  if (plan.status === "queued" || plan.status === "running") return "waiting";
  if (plan.appliedApplyRunId !== undefined) {
    // Someone applied the finalizer's Plan by hand; its commit decides.
    return "waiting";
  }
  const verification = verifyTeardownPlan(
    plan,
    capsule,
    await deps.store.getCapsuleExecutionAuthorityEpoch(capsule.id),
  );
  if (verification !== undefined) {
    await block(deps, capsule, uninstall, verification);
    return "blocked";
  }
  await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    { phase: "destroying", destroyStartedAt: now().toISOString() },
  );
  return "progressed";
}

async function recordPreDestroyExport(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
  now: () => Date,
): Promise<StepOutcome> {
  const backups = deps.backups;
  let evidence: CapsulePreDestroyExport;
  let claimStartedAt: string | undefined;
  if (backups === undefined || !backups.enabled) {
    evidence = {
      status: "skipped",
      reason: "backups_unavailable",
      at: now().toISOString(),
    };
  } else {
    // A Workspace that is not accepting management work defers the whole
    // request; that is not an export failure and must not start teardown.
    const authority = await backups.captureManagementAuthority(
      capsule.workspaceId,
    );
    claimStartedAt = now().toISOString();
    try {
      await deps.capsules.advanceCapsuleUninstall(
        capsule.id,
        { uninstallId: uninstall.id, revision: uninstall.revision },
        { preDestroyExportStartedAt: claimStartedAt },
      );
    } catch (error) {
      if (isTransientRefusal(error)) return "waiting";
      throw error;
    }
    try {
      const backup = await backups.createBackup({
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
        environment: capsule.environment,
        scope: "capsule",
        expectedWorkspaceManagementAuthority: authority,
      });
      evidence = {
        status: "exported",
        backupId: backup.id,
        includesServiceData: (backup.serviceData?.exportedCount ?? 0) > 0,
        at: now().toISOString(),
      };
    } catch (error) {
      evidence = {
        status: "failed",
        reason: exportFailureReason(error),
        at: now().toISOString(),
      };
    }
  }
  // A waiting tick may rotate this request while the export is running. Use
  // the current revision, but never attach an old result to a cancelled or
  // replacement request. A late result may add evidence to a blocked request;
  // it never clears the block or authorizes teardown.
  let recorded = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await deps.capsules.getCapsule(capsule.id);
    const record = current.uninstall;
    if (
      current.status !== "uninstalled" || record?.id !== uninstall.id ||
      record.phase === "cancelled" || record.preDestroyExport !== undefined ||
      record.preDestroyExportStartedAt !== claimStartedAt
    ) break;
    try {
      await deps.capsules.advanceCapsuleUninstall(
        capsule.id,
        { uninstallId: record.id, revision: record.revision },
        { preDestroyExport: evidence },
      );
      recorded = true;
      break;
    } catch (error) {
      // Retry only the evidence write when a waiting-marker update won; the
      // claimed export itself is never repeated. Every retry checks identity.
      if (!isTransientRefusal(error)) throw error;
    }
  }
  await recordActivity(deps, {
    workspaceId: capsule.workspaceId,
    actorId: SCHEDULED_UNINSTALL_ACTOR,
    action: `capsule.pre_destroy_export_${evidence.status}`,
    targetType: "capsule",
    targetId: capsule.id,
    metadata: {
      name: capsule.name,
      environment: capsule.environment,
      uninstallId: uninstall.id,
      ...(evidence.backupId ? { backupId: evidence.backupId } : {}),
      ...(evidence.includesServiceData !== undefined
        ? { includesServiceData: evidence.includesServiceData }
        : {}),
      ...(evidence.reason ? { reason: evidence.reason } : {}),
    },
  });
  return recorded ? "export_recorded" : "done";
}

/** Waiting requests rotate behind untouched due work, including across restarts. */
async function rotateWaitingRequest(
  deps: CapsuleUninstallFinalizerDependencies,
  capsuleId: string,
  uninstallId: string,
  now: () => Date,
): Promise<void> {
  const capsule = await deps.capsules.getCapsule(capsuleId);
  const uninstall = capsule.uninstall;
  if (
    capsule.status !== "uninstalled" || uninstall?.id !== uninstallId ||
    uninstall.phase === "cancelled" || uninstall.blockedReason !== undefined
  ) return;
  const previous = Date.parse(uninstall.lastFinalizeAttemptAt ?? uninstall.scheduledDestroyAt);
  const lastFinalizeAttemptAt = new Date(Math.max(now().getTime(), previous + 1))
    .toISOString();
  try {
    await deps.capsules.advanceCapsuleUninstall(
      capsule.id,
      { uninstallId: uninstall.id, revision: uninstall.revision },
      { lastFinalizeAttemptAt },
    );
  } catch (error) {
    // Another tick or cancellation won. This race must not exhaust the
    // request's unexpected-error budget.
    if (!isTransientRefusal(error)) throw error;
  }
}

async function createTeardownPlan(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
  now: () => Date,
): Promise<StepOutcome> {
  const attempt = (uninstall.destroyAttempts ?? 0) + 1;
  if (attempt > MAX_SCHEDULED_DESTROY_ATTEMPTS) {
    await block(
      deps,
      capsule,
      uninstall,
      uninstall.destroyPlanRunId !== undefined &&
        (await deps.store.getPlanRun(uninstall.destroyPlanRunId)) === undefined
        ? SCHEDULED_DESTROY_BLOCKED_REASONS.planMissing
        : SCHEDULED_DESTROY_BLOCKED_REASONS.planFailed,
    );
    return "blocked";
  }
  const planRunId = scheduledDestroyRunId("plan", uninstall.id, attempt);
  // Marker first: once this commits, other ticks wait for this exact Plan id
  // instead of minting another teardown for the same request.
  const marked = await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    {
      destroyPlanRunId: planRunId,
      destroyAttempts: attempt,
      destroyPlanRequestedAt: now().toISOString(),
    },
  );
  let response: PlanRunResponse;
  try {
    response = await deps.controller.createCapsuleDestroyPlan(
      capsule.id,
      { actor: SCHEDULED_UNINSTALL_ACTOR },
      { planRunId },
    );
  } catch (error) {
    if (!isPermanentRefusal(error) || !marked.uninstall) throw error;
    await block(
      deps,
      marked,
      marked.uninstall,
      SCHEDULED_DESTROY_BLOCKED_REASONS.planRefused,
    );
    return "blocked";
  }
  if (response.planRun.id !== planRunId && marked.uninstall) {
    // Pre-v1 source-less teardown allocates its own id.
    await deps.capsules.advanceCapsuleUninstall(
      capsule.id,
      { uninstallId: uninstall.id, revision: marked.uninstall.revision },
      { destroyPlanRunId: response.planRun.id },
    );
  }
  return "plan_created";
}

async function startTeardown(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
): Promise<StepOutcome> {
  const planRunId = uninstall.destroyPlanRunId;
  const plan = planRunId === undefined
    ? undefined
    : await deps.store.getPlanRun(planRunId);
  if (plan === undefined) {
    await block(
      deps,
      capsule,
      uninstall,
      SCHEDULED_DESTROY_BLOCKED_REASONS.planMissing,
    );
    return "blocked";
  }
  const applyRunId = scheduledDestroyRunId(
    "apply",
    uninstall.id,
    uninstall.destroyAttempts ?? 1,
  );
  const existing = await deps.store.getApplyRun(applyRunId);
  if (existing !== undefined) {
    if (applyIsTerminalFailure(existing)) {
      const refusal = existing.auditEvents.find((event) =>
        event.type === "uninstall.authorization_refused" &&
        typeof event.data?.reason === "string" && isAuthorizationReason(event.data.reason));
      await block(
        deps,
        capsule,
        uninstall,
        typeof refusal?.data?.reason === "string" ? refusal.data.reason : SCHEDULED_DESTROY_BLOCKED_REASONS.applyFailed,
        refusal ? new Date(refusal.at).toISOString() : undefined,
      );
      return "blocked";
    }
    return "waiting";
  }
  if (plan.appliedApplyRunId !== undefined) return "waiting";
  if (await blockUnauthorizedRequester(deps, capsule, uninstall)) return "blocked";
  try {
    if (plan.approval === undefined) {
      await deps.controller.approveRun(plan.id, {
        approvedBy: SCHEDULED_UNINSTALL_ACTOR,
        reason: `scheduled uninstall ${uninstall.id}`,
      });
    }
    const approved = await deps.store.getPlanRun(plan.id);
    if (approved === undefined) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `scheduled teardown plan ${plan.id} disappeared after approval`,
      );
    }
    // Approval may have awaited an external store. Observe revocation again
    // before Apply admission; the Run engine checks it at dispatch as well.
    const current = await deps.capsules.getCapsule(capsule.id);
    if (current.uninstall?.id !== uninstall.id ||
      current.uninstall.revision !== uninstall.revision ||
      current.uninstall.phase !== "destroying" || current.uninstall.blockedReason) {
      return "done";
    }
    if (await blockUnauthorizedRequester(deps, current, current.uninstall)) return "blocked";
    await deps.controller.createApplyRun(
      {
        planRunId: approved.id,
        expected: applyExpectedGuardFromPlanRun(approved),
      },
      { actor: SCHEDULED_UNINSTALL_ACTOR },
      { applyRunId },
    );
  } catch (error) {
    // A refusal that will not clear by itself (for example the execution
    // authority moved) must not be retried forever with cancel unavailable.
    if (!isPermanentRefusal(error)) throw error;
    await block(
      deps,
      capsule,
      uninstall,
      authorizationReason(error) ?? SCHEDULED_DESTROY_BLOCKED_REASONS.applyRefused,
    );
    return "blocked";
  }
  await recordActivity(deps, {
    workspaceId: capsule.workspaceId,
    actorId: SCHEDULED_UNINSTALL_ACTOR,
    action: "capsule.uninstall_destroy_started",
    targetType: "capsule",
    targetId: capsule.id,
    runId: applyRunId,
    metadata: {
      name: capsule.name,
      environment: capsule.environment,
      uninstallId: uninstall.id,
      planRunId: plan.id,
      applyRunId,
      preDestroyExport: uninstall.preDestroyExport?.status ?? "skipped",
    },
  });
  return "destroy_started";
}

/**
 * The finalizer approves only the teardown it would have asked the owner to
 * review: this Capsule's destroy Plan at its current execution epoch,
 * policy-passed, with known changes that are all deletions. Returns a blocked
 * reason, or `undefined` when it passes.
 */
export function verifyTeardownPlan(
  plan: PlanRun,
  capsule: Capsule,
  currentExecutionAuthorityEpoch: number | undefined,
): string | undefined {
  if (
    plan.operation !== "destroy" ||
    plan.capsuleId !== capsule.id ||
    plan.workspaceId !== capsule.workspaceId ||
    plan.driftCheck === true ||
    plan.policy.status !== "passed" ||
    (plan.capsuleCurrentStateVersionId ?? null) !==
      (capsule.currentStateVersionId ?? null) ||
    (plan.capsuleExecutionAuthorityEpoch ?? 1) !==
      currentExecutionAuthorityEpoch
  ) {
    return SCHEDULED_DESTROY_BLOCKED_REASONS.planUnverifiable;
  }
  if (plan.status !== "waiting_approval" && plan.status !== "succeeded") {
    return SCHEDULED_DESTROY_BLOCKED_REASONS.planUnverifiable;
  }
  if (plan.planResourceChanges === undefined) {
    return SCHEDULED_DESTROY_BLOCKED_REASONS.planUnverifiable;
  }
  for (const change of plan.planResourceChanges) {
    if (
      change.importing === true ||
      change.actions.some((action) => action !== "delete" && action !== "no-op")
    ) {
      return SCHEDULED_DESTROY_BLOCKED_REASONS.planNotDeleteOnly;
    }
  }
  return undefined;
}

/** Run ids derived from the request so a repeated tick re-uses them. */
export function scheduledDestroyRunId(
  kind: "plan" | "apply",
  uninstallId: string,
  attempt: number,
): string {
  return `${kind}_${uninstallId.replace(/[^0-9a-zA-Z]/gu, "")}a${attempt}`;
}

function planCreationMayStillBeInFlight(
  uninstall: CapsuleUninstall,
  now: () => Date,
): boolean {
  const requestedAt = Date.parse(uninstall.destroyPlanRequestedAt ?? "");
  return Number.isFinite(requestedAt) &&
    now().getTime() - requestedAt < DESTROY_PLAN_CREATION_WINDOW_MS;
}

function applyIsTerminalFailure(apply: ApplyRun): boolean {
  return (
    apply.status === "failed" ||
    apply.status === "cancelled" ||
    apply.status === "expired"
  );
}

/** A typed refusal of this exact request that a later tick cannot change. */
function isPermanentRefusal(error: unknown): boolean {
  if (!(error instanceof OpenTofuControllerError)) return false;
  if (
    error.code !== "failed_precondition" &&
    error.code !== "invalid_argument" &&
    error.code !== "not_found"
  ) {
    return false;
  }
  const reason = errorReason(error);
  return reason === undefined || !TRANSIENT_REFUSAL_REASONS.has(reason);
}

function isTransientRefusal(error: unknown): boolean {
  return error instanceof OpenTofuControllerError &&
    TRANSIENT_REFUSAL_REASONS.has(errorReason(error) ?? "");
}

/**
 * Counts an unexpected error against the request and blocks it once the
 * budget is spent. Returns whether this call blocked it. Never throws: the
 * request may have moved on, or its Workspace may not accept writes now.
 */
async function recordFinalizeFailure(
  deps: CapsuleUninstallFinalizerDependencies,
  capsuleId: string,
  error: unknown,
): Promise<boolean> {
  if (
    error instanceof OpenTofuControllerError &&
    TRANSIENT_REFUSAL_REASONS.has(errorReason(error) ?? "")
  ) {
    return false;
  }
  try {
    const capsule = await deps.capsules.getCapsule(capsuleId);
    const uninstall = capsule.uninstall;
    if (
      capsule.status !== "uninstalled" ||
      uninstall === undefined ||
      uninstall.phase === "cancelled" ||
      uninstall.blockedReason !== undefined
    ) {
      return false;
    }
    const failures = (uninstall.finalizeFailures ?? 0) + 1;
    const exhausted = failures >= MAX_UNINSTALL_FINALIZE_FAILURES;
    await deps.capsules.advanceCapsuleUninstall(
      capsule.id,
      { uninstallId: uninstall.id, revision: uninstall.revision },
      {
        finalizeFailures: failures,
        ...(exhausted
          ? { blockedReason: SCHEDULED_DESTROY_BLOCKED_REASONS.finalizeFailed }
          : {}),
      },
    );
    if (exhausted) {
      await recordActivity(deps, blockedActivity(
        capsule,
        uninstall,
        SCHEDULED_DESTROY_BLOCKED_REASONS.finalizeFailed,
      ));
    }
    return exhausted;
  } catch {
    return false;
  }
}

async function block(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
  reason: string,
  rejectedAt?: string,
): Promise<void> {
  const updated = await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    {
      blockedReason: reason,
      ...(isAuthorizationReason(reason)
        ? { authorizationRejectedAt: rejectedAt ?? (deps.now ?? (() => new Date()))().toISOString() }
        : {}),
    },
  );
  await recordActivity(deps, blockedActivity(updated, updated.uninstall ?? uninstall, reason));
}

function blockedActivity(
  capsule: Capsule,
  uninstall: CapsuleUninstall,
  reason: string,
): Parameters<ActivityRecorder["record"]>[0] {
  return {
    workspaceId: capsule.workspaceId,
    actorId: SCHEDULED_UNINSTALL_ACTOR,
    action: "capsule.uninstall_blocked",
    targetType: "capsule",
    targetId: capsule.id,
    metadata: {
      name: capsule.name,
      environment: capsule.environment,
      uninstallId: uninstall.id,
      reason,
      ...(uninstall.requester ? { requesterSubject: uninstall.requester.subject } : {}),
      ...(isAuthorizationReason(reason)
        ? { rejectedAt: capsule.uninstall?.authorizationRejectedAt }
        : {}),
      ...(uninstall.destroyPlanRunId
        ? { planRunId: uninstall.destroyPlanRunId }
        : {}),
    },
  };
}

async function blockUnauthorizedRequester(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
): Promise<boolean> {
  const reason = await scheduledUninstallAuthorizationFailure(
    deps.store, capsule, deps.validateUninstallRequester,
  );
  if (reason === undefined) return false;
  await block(deps, capsule, uninstall, reason);
  return true;
}

function isAuthorizationReason(reason: string): boolean {
  return Object.values(UNINSTALL_AUTHORIZATION_REASONS).some((value) => value === reason);
}

function authorizationReason(error: unknown): string | undefined {
  const reason = error instanceof OpenTofuControllerError ? errorReason(error) : undefined;
  return reason && isAuthorizationReason(reason) ? reason : undefined;
}

function errorReason(error: OpenTofuControllerError): string | undefined {
  const details = error.details;
  const reason = typeof details === "object" && details !== null
    ? (details as { readonly reason?: unknown }).reason
    : undefined;
  return typeof reason === "string" ? reason : undefined;
}

function exportFailureReason(error: unknown): string {
  if (error instanceof OpenTofuControllerError) {
    const reason = errorReason(error);
    if (reason !== undefined && /^[a-z0-9_]{1,64}$/u.test(reason)) {
      return reason;
    }
    return `backup_${error.code}`;
  }
  return "backup_failed";
}

async function recordActivity(
  deps: CapsuleUninstallFinalizerDependencies,
  event: Parameters<ActivityRecorder["record"]>[0],
): Promise<void> {
  try {
    await (deps.activity ?? NOOP_ACTIVITY_RECORDER).record(event);
  } catch {
    // Activity is audit, not authority; the request already committed.
  }
}
