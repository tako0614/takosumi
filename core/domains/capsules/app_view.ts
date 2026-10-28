/**
 * Server-side state of one installed app (`GET /api/v1/capsules/:id/app`).
 *
 * The Dashboard used to infer an app's state from Workspace-wide windows (the
 * newest 100 Runs and Activity events). This pure function computes it from
 * per-Capsule facts the control plane reads exactly: the Capsule row, its
 * newest lifecycle Run, whether the revision coordinator is preparing a
 * change, the health of the ProviderConnections its bindings use, and the
 * current generation's screen materialization ledger.
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

export interface CapsuleAppFacts {
  readonly capsule: Pick<
    Capsule,
    | "status"
    | "currentStateVersionId"
    | "currentStateGeneration"
    | "uninstall"
    | "updatedAt"
  >;
  /** The newest lifecycle Run ({@link CAPSULE_APP_LIFECYCLE_RUN_TYPES}). */
  readonly latestRun?: CapsuleAppLatestRun;
  readonly revisionPreparing: boolean;
  readonly connectionIssues: readonly CapsuleAppConnectionIssue[];
  /** A dead-lettered screen materialization of the current generation. */
  readonly screenFailure?: CapsuleAppScreenFailure;
  readonly screenCount: number;
  readonly now: number;
}

export interface CapsuleAppStatus {
  readonly state: CapsuleAppState;
  readonly primaryAction: CapsuleAppAction;
  readonly problems: readonly CapsuleAppProblem[];
}

const PROBLEM_ACTION: Readonly<
  Record<Exclude<CapsuleAppProblemCode, "uninstall_scheduled">, CapsuleAppAction>
> = {
  connection_unavailable: "fix_connection",
  uninstall_failed: "retry",
  uninstall_blocked: "cancel_uninstall",
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

function actionFor(problems: readonly CapsuleAppProblem[]): CapsuleAppAction {
  const first = problems.find((problem) => problem.severity === "error");
  return first && first.code !== "uninstall_scheduled"
    ? PROBLEM_ACTION[first.code]
    : "none";
}

function status(
  state: CapsuleAppState,
  primaryAction: CapsuleAppAction,
  problems: readonly CapsuleAppProblem[] = [],
): CapsuleAppStatus {
  return { state, primaryAction, problems: ordered(problems) };
}

export function deriveCapsuleAppStatus(facts: CapsuleAppFacts): CapsuleAppStatus {
  const { capsule, latestRun } = facts;
  if (capsule.status === "destroyed") return status("uninstalled", "reinstall");

  const uninstall = capsule.uninstall;
  const destroying = uninstall?.phase === "destroying";
  const latestFailed = latestRun?.status === "failed" ? latestRun : undefined;

  // Two-stage uninstall: the grace period, the teardown, and its failures.
  if (capsule.status === "error" && destroying) {
    const problems: CapsuleAppProblem[] = [
      ...connectionProblems(facts.connectionIssues),
      {
        code: "uninstall_failed",
        severity: "error",
        ...(latestFailed && isRemovalType(latestFailed.type)
          ? {
              runId: latestFailed.id,
              runType: latestFailed.type,
              ...(latestFailed.errorCode ? { errorCode: latestFailed.errorCode } : {}),
            }
          : {}),
      },
    ];
    const sorted = ordered(problems);
    return status("needs_attention", actionFor(sorted), sorted);
  }
  if (capsule.status === "uninstalled" || destroying) {
    if (destroying && uninstall?.blockedReason === undefined) {
      return status("uninstalling", "none");
    }
    if (destroying) {
      return status("needs_attention", "cancel_uninstall", [
        { code: "uninstall_blocked", severity: "error" },
      ]);
    }
    return status(
      "uninstall_scheduled",
      uninstall?.phase === "scheduled" ? "cancel_uninstall" : "none",
      [{ code: "uninstall_scheduled", severity: "warning" }],
    );
  }

  if (capsule.status === "disabled") return status("stopped", "none");

  const applied = capsuleIsApplied(capsule);
  const inFlight = runInFlight(latestRun);
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
  const review = reviewablePlan(latestRun);
  if (!applied && !inFlight && !review && !latestFailed) {
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
  if (inFlight || (applied && facts.revisionPreparing)) {
    return status(applied ? "updating" : "installing", "none", sorted);
  }
  if (sorted.some((problem) => problem.severity === "error")) {
    return status("needs_attention", actionFor(sorted), sorted);
  }
  if (!applied) return status("installing", review ? "review" : "none", sorted);
  return status(
    "installed",
    facts.screenCount > 0 ? "open" : "view_resources",
    sorted,
  );
}
