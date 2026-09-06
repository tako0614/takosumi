import type { Capsule, Run } from "./control-api.ts";

type RetryRun = Pick<
  Run,
  | "capsuleId"
  | "workspaceId"
  | "type"
  | "baseStateGeneration"
  | "sourceSnapshotId"
  | "compatibilityReportId"
>;
type RetryCapsule = Pick<
  Capsule,
  | "id"
  | "workspaceId"
  | "status"
  | "currentStateGeneration"
  | "currentStateVersionId"
  | "compatibilityReportId"
>;

/**
 * A first-install retry reuses the Capsule's reviewed snapshot/report pair.
 * Failure alone does not mean the source is stale. Both the visible action and
 * its fresh pre-request read use this predicate; the server still owns Plan
 * authorization and validates the immutable pair before creating a Run.
 */
export function initialPlanRetryReport(
  run: RetryRun | undefined,
  capsule: RetryCapsule | undefined,
): string | undefined {
  if (
    !run ||
    !capsule ||
    run.type !== "plan" ||
    run.baseStateGeneration !== 0 ||
    capsule.id !== run.capsuleId ||
    capsule.workspaceId !== run.workspaceId ||
    capsule.currentStateGeneration !== 0 ||
    capsule.currentStateVersionId ||
    (capsule.status !== "pending" && capsule.status !== "error") ||
    typeof run.sourceSnapshotId !== "string" ||
    !run.sourceSnapshotId.trim() ||
    typeof run.compatibilityReportId !== "string" ||
    !run.compatibilityReportId.trim() ||
    capsule.compatibilityReportId !== run.compatibilityReportId
  ) {
    return undefined;
  }
  return run.compatibilityReportId;
}
