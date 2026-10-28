/**
 * Server-side state of one installed app (`GET /api/v1/capsules/:id/app`).
 *
 * The Dashboard used to infer an app's state from Workspace-wide windows (the
 * newest 100 Runs and Activity events). This pure function computes it from
 * per-Capsule facts the control plane reads exactly: the Capsule row, its
 * newest lifecycle Run, whether an install or revision coordinator is still
 * preparing its Plan, the health of the ProviderConnections its bindings use, the
 * current generation's screen materialization ledger, and whether the uninstall
 * commands would admit a cancel right now.
 *
 * It returns one state, one primary action and the ordered problem list. The
 * mapping is documented on the contract types (`CAPSULE_APP_STATES`,
 * `CAPSULE_APP_ACTIONS`, `CAPSULE_APP_PROBLEM_CODES`).
 */

import type {
  Capsule,
  CapsuleAppAction,
  CapsuleAppConnectionStatus,
  CapsuleAppProblem,
  CapsuleAppProblemCode,
  CapsuleAppRunSummary,
  CapsuleAppScreenFailure,
  CapsuleAppState,
  CapsuleUninstall,
} from "takosumi-contract/capsules";
import { CAPSULE_APP_PROBLEM_CODES } from "takosumi-contract/capsules";
import type { RunPolicyStatus, RunType } from "takosumi-contract/runs";

/** A never-applied app with no progress this long needs the person. */
export const CAPSULE_APP_INSTALL_STALL_AFTER_MS = 30 * 60 * 1000;

/** Run types whose newest row decides an app's lifecycle state. */
export const CAPSULE_APP_LIFECYCLE_RUN_TYPES: readonly RunType[] = [
  "plan",
  "apply",
  "destroy_plan",
  "destroy_apply",
];

export interface CapsuleAppLatestRun extends CapsuleAppRunSummary {
  readonly policyStatus?: RunPolicyStatus;
}

export interface CapsuleAppConnectionIssue {
  readonly provider: string;
  readonly connectionId?: string;
  readonly status: CapsuleAppConnectionStatus;
}

type CapsuleFacts = Pick<
  Capsule,
  | "status"
  | "currentStateVersionId"
  | "currentStateGeneration"
  | "uninstall"
  | "updatedAt"
>;

export interface CapsuleAppFacts {
  readonly capsule: CapsuleFacts;
  /** The newest lifecycle Run ({@link CAPSULE_APP_LIFECYCLE_RUN_TYPES}). */
  readonly latestRun?: CapsuleAppLatestRun;
  /**
   * An install or revision coordinator bound to this Capsule is still
   * preparing its Plan (no Plan Run yet; an install attempt only for a
   * never-applied Capsule and only until it stalls), so it owns the next
   * plan: the app reads as in progress and offers no action that would plan.
   */
  readonly revisionPreparing: boolean;
  readonly connectionIssues: readonly CapsuleAppConnectionIssue[];
  /** A dead-lettered screen materialization of the current generation. */
  readonly screenFailure?: CapsuleAppScreenFailure;
  /** Launchable screens; `undefined` when the screen read failed. */
  readonly screenCount?: number;
  /** Whether the cancel-uninstall command would admit a cancel now. */
  readonly uninstallCancellable: boolean;
  readonly now: number;
}

export interface CapsuleAppStatus {
  readonly state: CapsuleAppState;
  readonly primaryAction: CapsuleAppAction;
  readonly problems: readonly CapsuleAppProblem[];
}

const PROBLEM_ACTION: Readonly<
  Record<
    Exclude<CapsuleAppProblemCode, "uninstall_scheduled" | "uninstall_blocked">,
    CapsuleAppAction
  >
> = {
  connection_unavailable: "fix_connection",
  uninstall_failed: "retry",
  policy_blocked: "review",
  run_failed: "retry",
  capsule_error: "retry",
  install_incomplete: "continue_install",
  screen_unavailable: "retry_screen",
};

const PROBLEM_PRIORITY = new Map<CapsuleAppProblemCode, number>(
  CAPSULE_APP_PROBLEM_CODES.map((code, index) => [code, index]),
);

export function capsuleIsApplied(
  capsule: Pick<Capsule, "currentStateVersionId" | "currentStateGeneration">,
): boolean {
  return Boolean(capsule.currentStateVersionId) ||
    capsule.currentStateGeneration > 0;
}

function runInFlight(run: CapsuleAppRunSummary | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

function isPlanType(type: RunType): boolean {
  return type === "plan" || type === "destroy_plan";
}

function isRemovalType(type: RunType): boolean {
  return type === "destroy_plan" || type === "destroy_apply";
}

/** The newest lifecycle Run when it is a plan still waiting for review. */
export function reviewablePlan(
  run: CapsuleAppRunSummary | undefined,
): CapsuleAppRunSummary | undefined {
  return run && isPlanType(run.type) &&
      (run.status === "succeeded" || run.status === "waiting_approval")
    ? run
    : undefined;
}

/**
 * The uninstall record that still describes the app. Records persist as
 * evidence after a cancel or a later recovery, so a record counts only while
 * the Capsule is `uninstalled`, or while it is `error` after a teardown that
 * reached the provider and its newest lifecycle Run is still a removal.
 */
export function liveCapsuleUninstall(
  capsule: Pick<Capsule, "status" | "uninstall">,
  latestRun: Pick<CapsuleAppRunSummary, "type"> | undefined,
): CapsuleUninstall | undefined {
  const record = capsule.uninstall;
  if (!record) return undefined;
  if (capsule.status === "uninstalled") return record;
  return capsule.status === "error" &&
      record.phase === "destroying" &&
      latestRun !== undefined &&
      isRemovalType(latestRun.type)
    ? record
    : undefined;
}

function runProblem(run: CapsuleAppLatestRun): CapsuleAppProblem {
  const policyBlocked = isPlanType(run.type) &&
    (run.policyStatus === "deny" || run.errorCode === "policy_denied");
  return {
    code: policyBlocked ? "policy_blocked" : "run_failed",
    severity: "error",
    runId: run.id,
    runType: run.type,
    ...(run.errorCode ? { errorCode: run.errorCode } : {}),
  };
}

function connectionProblems(
  issues: readonly CapsuleAppConnectionIssue[],
): CapsuleAppProblem[] {
  return issues.map((issue) => ({
    code: "connection_unavailable",
    severity: "error",
    provider: issue.provider,
    ...(issue.connectionId ? { connectionId: issue.connectionId } : {}),
    connectionStatus: issue.status,
  }));
}

function ordered(problems: readonly CapsuleAppProblem[]): CapsuleAppProblem[] {
  return problems
    .map((problem, index) => ({ problem, index }))
    .sort((a, b) =>
      (PROBLEM_PRIORITY.get(a.problem.code) ?? 0) -
        (PROBLEM_PRIORITY.get(b.problem.code) ?? 0) ||
      a.index - b.index
    )
    .map(({ problem }) => problem);
}

function actionFor(
  problems: readonly CapsuleAppProblem[],
  uninstallCancellable: boolean,
): CapsuleAppAction {
  const first = problems.find((problem) => problem.severity === "error");
  if (!first || first.code === "uninstall_scheduled") return "none";
  if (first.code === "uninstall_blocked") {
    return uninstallCancellable ? "cancel_uninstall" : "uninstall_now";
  }
  return PROBLEM_ACTION[first.code];
}

function status(
  state: CapsuleAppState,
  primaryAction: CapsuleAppAction,
  problems: readonly CapsuleAppProblem[] = [],
): CapsuleAppStatus {
  return { state, primaryAction, problems: ordered(problems) };
}

/** A Capsule inside the two-stage uninstall (`status: uninstalled`). */
function scheduledUninstallStatus(facts: CapsuleAppFacts): CapsuleAppStatus {
  const { latestRun } = facts;
  const record = facts.capsule.uninstall;
  if (runInFlight(latestRun) && latestRun && isRemovalType(latestRun.type)) {
    return status("uninstalling", "none");
  }
  const review = reviewablePlan(latestRun);
  const finalizerPlan = review !== undefined &&
    record?.destroyPlanRunId === review.id;
  // A teardown plan the person started ("uninstall now") waits for them.
  if (review && isRemovalType(review.type) && !finalizerPlan) {
    return status("uninstalling", "review");
  }
  // The finalizer records why it stopped in either phase; until someone acts
  // the resources keep running and billing.
  if (record?.blockedReason !== undefined) {
    const problems: CapsuleAppProblem[] = [{
      code: "uninstall_blocked",
      severity: "error",
      reason: record.blockedReason,
      ...(record.destroyPlanRunId
        ? { runId: record.destroyPlanRunId, runType: "destroy_plan" as const }
        : {}),
    }];
    return status(
      "needs_attention",
      actionFor(problems, facts.uninstallCancellable),
      problems,
    );
  }
  if (record?.phase === "destroying" || finalizerPlan) {
    return status("uninstalling", "none");
  }
  return status(
    "uninstall_scheduled",
    facts.uninstallCancellable ? "cancel_uninstall" : "none",
    [{ code: "uninstall_scheduled", severity: "warning" }],
  );
}

export function deriveCapsuleAppStatus(facts: CapsuleAppFacts): CapsuleAppStatus {
  const { capsule, latestRun } = facts;
  if (capsule.status === "destroyed") return status("uninstalled", "reinstall");
  if (capsule.status === "uninstalled") return scheduledUninstallStatus(facts);

  const inFlight = runInFlight(latestRun);
  const review = reviewablePlan(latestRun);
  const latestFailed = latestRun?.status === "failed" ? latestRun : undefined;

  // A teardown that reached the provider failed (`error` + `destroying`) and
  // its newest lifecycle Run is still a removal: a retry is running, waits
  // for review, or the removal failed. A cancelled or expired retry falls
  // through to the ordinary error recovery below.
  if (liveCapsuleUninstall(capsule, latestRun)) {
    const connections = connectionProblems(facts.connectionIssues);
    if (inFlight) return status("uninstalling", "none", connections);
    if (review) return status("uninstalling", "review", connections);
    if (latestFailed) {
      const problems = ordered([
        ...connections,
        {
          code: "uninstall_failed",
          severity: "error",
          runId: latestFailed.id,
          runType: latestFailed.type,
          ...(latestFailed.errorCode ? { errorCode: latestFailed.errorCode } : {}),
        },
      ]);
      return status(
        "needs_attention",
        actionFor(problems, facts.uninstallCancellable),
        problems,
      );
    }
  }

  if (capsule.status === "disabled") return status("stopped", "none");

  const applied = capsuleIsApplied(capsule);
  const preparing = facts.revisionPreparing;
  const problems: CapsuleAppProblem[] = connectionProblems(facts.connectionIssues);
  if (latestFailed) problems.push(runProblem(latestFailed));
  if (capsule.status === "error" && !latestFailed) {
    problems.push({ code: "capsule_error", severity: "error" });
  }
  if (applied && facts.screenFailure) {
    problems.push({
      code: "screen_unavailable",
      severity: "error",
      screenFailure: facts.screenFailure,
    });
  }
  if (!applied && !inFlight && !preparing && !review && !latestFailed) {
    const updatedAt = Date.parse(capsule.updatedAt);
    if (
      Number.isFinite(updatedAt) &&
      facts.now - updatedAt >= CAPSULE_APP_INSTALL_STALL_AFTER_MS
    ) {
      problems.push({ code: "install_incomplete", severity: "error" });
    }
  }
  const sorted = ordered(problems);

  if (inFlight && latestRun && isRemovalType(latestRun.type)) {
    return status("uninstalling", "none", sorted);
  }
  // Work in progress may resolve the problems; starting another change now
  // would race it (a duplicate plan or a 409).
  if (inFlight || preparing) {
    return status(applied ? "updating" : "installing", "none", sorted);
  }
  if (sorted.some((problem) => problem.severity === "error")) {
    return status(
      "needs_attention",
      actionFor(sorted, facts.uninstallCancellable),
      sorted,
    );
  }
  if (!applied) return status("installing", review ? "review" : "none", sorted);
  // An unread screen list must not downgrade Open; `incomplete` says why.
  return status(
    "installed",
    facts.screenCount === 0 ? "view_resources" : "open",
    sorted,
  );
}
