/**
 * What counts as progress while following a Git plan coordinator, shared by
 * the install page and the reconcile loop the app page uses to continue an
 * install or a version change.
 */
import type { GitInstallPlanResponse, GitRevisionPlanResponse } from "takosumi-contract";

/**
 * A visible change of phase, of what the coordinator asks for, of its
 * evidence (Source sync, snapshot, compatibility, InstallConfig, Capsule,
 * Plan Run) or of its diagnostic. The generation is left out on purpose:
 * every successful reconcile claim bumps it, so it changes even while the
 * coordinator only waits on a Source sync, an analysis or a Plan Run.
 */
export function gitPlanProgressSignature(
  response: GitInstallPlanResponse | GitRevisionPlanResponse,
): string {
  const install = "installPlan" in response ? response : undefined;
  const plan = install ? install.installPlan : (response as GitRevisionPlanResponse).revisionPlan;
  const action = install?.userAction;
  return JSON.stringify([
    plan.phase,
    plan.awaitingInput ?? "",
    action?.kind ?? "",
    action?.kind === "wait" ? action.phase : "",
    action?.kind === "provide_inputs" ? action.interfaces.map((requirement) => [
      requirement.requirementKey,
      requirement.type,
      requirement.version,
      [...requirement.permissions].sort(),
      requirement.candidates.map((candidate) => [candidate.id, candidate.name, candidate.capsuleId, candidate.capsuleName]).sort(),
      requirement.choice?.kind ?? "",
      requirement.choice?.kind === "interface" ? requirement.choice.interfaceId : "",
      requirement.autoSelected,
    ]).sort() : [],
    plan.sourceSyncRunId ?? "",
    plan.sourceSnapshotId ?? "",
    plan.compatibilityCheckRunId ?? "",
    plan.compatibilityReportId ?? "",
    plan.installConfigId ?? "",
    plan.capsuleId ?? "",
    plan.planRunId ?? "",
    plan.diagnostic?.code ?? "",
    install?.invalidated ?? "",
  ]);
}
