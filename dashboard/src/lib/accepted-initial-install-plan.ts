import type { Capsule, InstallConfig, Run } from "./control-api.ts";
import { initialPlanRetryReport } from "./initial-plan-retry.ts";

// GET /workspaces/:id/runs has a hard maximum of 500 and no cursor/total.
export const INITIAL_PLAN_RUN_LOOKUP_LIMIT = 500;

/**
 * Find the original review Run for an accepted repository install UX that has
 * not produced a StateVersion yet. The Capsule's initial compatibility report
 * is the public evidence tying the Run to initial installation; snapshot IDs
 * are checked only for completeness and are never presented to the user.
 *
 * Retries may reuse that same report. The earliest matching generation-zero
 * Plan is therefore the original install Plan. Tied timestamps are ambiguous
 * and deliberately produce no link.
 */
export function acceptedInitialInstallPlan(
  runs: readonly Run[] | undefined,
  capsule: Capsule | undefined,
  installConfig: InstallConfig | undefined,
): Pick<Run, "id"> | undefined {
  if (
    !capsule ||
    !installConfig ||
    installConfig.id !== capsule.installConfigId ||
    installConfig.installExperience?.repositoryInstallUx?.status !==
      "accepted" ||
    capsule.currentStateVersionId ||
    capsule.currentStateGeneration !== 0 ||
    (capsule.status !== "pending" && capsule.status !== "error") ||
    !capsule.compatibilityReportId ||
    !runs ||
    runs.length >= INITIAL_PLAN_RUN_LOOKUP_LIMIT
  ) {
    return undefined;
  }

  const candidates = runs.filter(
    (run) => initialPlanRetryReport(run, capsule) !== undefined,
  );
  candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const initial = candidates[0];
  if (
    !initial ||
    (candidates[1] && candidates[1].createdAt === initial.createdAt)
  ) {
    return undefined;
  }
  return { id: initial.id };
}
