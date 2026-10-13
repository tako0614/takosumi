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
 *    failed or unavailable export does not stop the teardown.
 * 2. Plan. The request id is recorded first, then the destroy Plan is created
 *    with that exact id, so a crash between the two cannot start a second
 *    teardown for the same attempt. Failed Plans are retried a bounded number
 *    of times.
 * 3. Verify and commit. A completed Plan must be the Capsule's teardown and
 *    delete-only. The request then moves to `destroying`, after which the owner
 *    can no longer cancel.
 * 4. Approve and apply. The finalizer records an approval naming the request
 *    and creates the Apply with an exact id. Apply admission re-checks every
 *    ordinary precondition (state cursor, execution authority, policy).
 *
 * Anything the finalizer cannot continue unattended is recorded as
 * `blockedReason`; the Capsule stays `uninstalled` for the owner to cancel or
 * delete immediately.
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

/** Actor recorded on every Run and approval the finalizer creates. */
export const SCHEDULED_UNINSTALL_ACTOR = "system:scheduled-uninstall";

/** Destroy Plan attempts per uninstall request before it is left to the owner. */
export const MAX_SCHEDULED_DESTROY_ATTEMPTS = 3;

/** Capsules read per tick. Each one may take several bounded steps. */
export const DEFAULT_UNINSTALL_FINALIZE_LIMIT = 10;

const MAX_STEPS_PER_CAPSULE = 6;

/** Stable `blockedReason` tokens. */
export const SCHEDULED_DESTROY_BLOCKED_REASONS = {
  planFailed: "destroy_plan_failed",
  planNotDeleteOnly: "destroy_plan_not_delete_only",
  planUnverifiable: "destroy_plan_unverifiable",
  planMissing: "destroy_plan_missing",
  applyFailed: "destroy_apply_failed",
} as const;

export interface CapsuleUninstallFinalizerDependencies {
  readonly store: Pick<
    OpenTofuControlStore,
    "listDueCapsuleUninstalls" | "getPlanRun" | "getApplyRun"
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
        if (outcome === "waiting") totals.waiting += 1;
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
  if (uninstall.preDestroyExport === undefined) {
    await recordPreDestroyExport(deps, capsule, uninstall, now);
    return "export_recorded";
  }
  const plan = uninstall.destroyPlanRunId === undefined
    ? undefined
    : await deps.store.getPlanRun(uninstall.destroyPlanRunId);
  if (plan === undefined || planIsTerminalFailure(plan)) {
    return await createTeardownPlan(deps, capsule, uninstall);
  }
  if (plan.status === "queued" || plan.status === "running") return "waiting";
  if (plan.appliedApplyRunId !== undefined) {
    // Someone applied the finalizer's Plan by hand; its commit decides.
    return "waiting";
  }
  const verification = verifyTeardownPlan(plan, capsule);
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
): Promise<void> {
  const backups = deps.backups;
  let evidence: CapsulePreDestroyExport;
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
  await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    { preDestroyExport: evidence },
  );
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
      ...(evidence.reason ? { reason: evidence.reason } : {}),
    },
  });
}

async function createTeardownPlan(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
): Promise<StepOutcome> {
  const attempt = (uninstall.destroyAttempts ?? 0) + 1;
  if (attempt > MAX_SCHEDULED_DESTROY_ATTEMPTS) {
    await block(
      deps,
      capsule,
      uninstall,
      SCHEDULED_DESTROY_BLOCKED_REASONS.planFailed,
    );
    return "blocked";
  }
  const planRunId = scheduledDestroyRunId("plan", uninstall.id, attempt);
  // Marker first: once this commits, a crashed or repeated tick can only
  // re-use this exact Plan id for this attempt.
  const marked = await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    { destroyPlanRunId: planRunId, destroyAttempts: attempt },
  );
  const response = await deps.controller.createCapsuleDestroyPlan(
    capsule.id,
    { actor: SCHEDULED_UNINSTALL_ACTOR },
    { planRunId },
  );
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
      await block(
        deps,
        capsule,
        uninstall,
        SCHEDULED_DESTROY_BLOCKED_REASONS.applyFailed,
      );
      return "blocked";
    }
    return "waiting";
  }
  if (plan.appliedApplyRunId !== undefined) return "waiting";
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
  await deps.controller.createApplyRun(
    {
      planRunId: approved.id,
      expected: applyExpectedGuardFromPlanRun(approved),
    },
    { actor: SCHEDULED_UNINSTALL_ACTOR },
    { applyRunId },
  );
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
      planRunId: approved.id,
      applyRunId,
      preDestroyExport: uninstall.preDestroyExport?.status ?? "skipped",
    },
  });
  return "destroy_started";
}

/**
 * The finalizer approves only the teardown it would have asked the owner to
 * review: this Capsule's destroy Plan, policy-passed, with known changes that
 * are all deletions. Returns a blocked reason, or `undefined` when it passes.
 */
export function verifyTeardownPlan(
  plan: PlanRun,
  capsule: Capsule,
): string | undefined {
  if (
    plan.operation !== "destroy" ||
    plan.capsuleId !== capsule.id ||
    plan.workspaceId !== capsule.workspaceId ||
    plan.driftCheck === true ||
    plan.policy.status !== "passed" ||
    (plan.capsuleCurrentStateVersionId ?? null) !==
      (capsule.currentStateVersionId ?? null)
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

function planIsTerminalFailure(plan: PlanRun): boolean {
  return (
    plan.status === "failed" ||
    plan.status === "cancelled" ||
    plan.status === "expired"
  );
}

function applyIsTerminalFailure(apply: ApplyRun): boolean {
  return (
    apply.status === "failed" ||
    apply.status === "cancelled" ||
    apply.status === "expired"
  );
}

async function block(
  deps: CapsuleUninstallFinalizerDependencies,
  capsule: Capsule,
  uninstall: CapsuleUninstall,
  reason: string,
): Promise<void> {
  await deps.capsules.advanceCapsuleUninstall(
    capsule.id,
    { uninstallId: uninstall.id, revision: uninstall.revision },
    { blockedReason: reason },
  );
  await recordActivity(deps, {
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
      ...(uninstall.destroyPlanRunId
        ? { planRunId: uninstall.destroyPlanRunId }
        : {}),
    },
  });
}

function exportFailureReason(error: unknown): string {
  if (error instanceof OpenTofuControllerError) {
    const details = error.details;
    const reason = typeof details === "object" && details !== null
      ? (details as { readonly reason?: unknown }).reason
      : undefined;
    if (typeof reason === "string" && /^[a-z0-9_]{1,64}$/u.test(reason)) {
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
