import type { Capsule, InstallConfig, Run } from "./control-api.ts";
import { initialPlanRetryReport } from "./initial-plan-retry.ts";

// The runs endpoint has no cursor. A full page cannot prove which Plan came first.
export const INITIAL_PLAN_RUN_LOOKUP_LIMIT = 500;

function isInstallCoordinatorPlan(run: Run): boolean {
  const match = /^git-install-plan:gip_([a-f0-9]{16})$/u.exec(run.createdBy);
  return Boolean(match && run.id === `plan_${match[1]}`);
}

/** Find the original initial review, not a new revision or a retry Plan. */
export function acceptedInitialInstallPlan(
  runs: readonly Run[] | undefined,
  capsule: Capsule | undefined,
  installConfig: InstallConfig | undefined,
): Pick<Run, "id"> | undefined {
  if (
    !capsule ||
    !installConfig ||
    installConfig.id !== capsule.installConfigId ||
    installConfig.installExperience?.repositoryInstallUx?.status !== "accepted" ||
    capsule.currentStateVersionId ||
    capsule.currentStateGeneration !== 0 ||
    (capsule.status !== "pending" && capsule.status !== "error") ||
    !capsule.compatibilityReportId ||
    !runs ||
    runs.length >= INITIAL_PLAN_RUN_LOOKUP_LIMIT
  ) return undefined;

  const candidates = runs.filter((run) =>
    isInstallCoordinatorPlan(run) && initialPlanRetryReport(run, capsule) !== undefined
  );
  candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const initial = candidates[0];
  if (!initial || (candidates[1] && candidates[1].createdAt === initial.createdAt)) return undefined;
  return { id: initial.id };
}
