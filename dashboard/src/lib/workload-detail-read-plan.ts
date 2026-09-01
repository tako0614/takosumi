export type WorkloadDetailTab =
  | "overview"
  | "deploys"
  | "settings"
  | "danger";

export interface WorkloadDetailReadContext {
  readonly tab: WorkloadDetailTab;
  readonly capsuleId: string;
  readonly workspaceId?: string | null;
  readonly currentStateVersionId?: string | null;
}

/**
 * Supplemental reads whose data is shared across workload-detail sections.
 * Tab-owned reads such as Sources and Provider Connections stay with their
 * existing resources; this plan owns only the evidence/usage reads that can
 * otherwise run invisibly on every route.
 */
export interface WorkloadDetailSupplementalReadPlan {
  readonly stateVersionId: string | null;
  readonly activityWorkspaceId: string | null;
  readonly usageCapsuleId: string | null;
}

export function planWorkloadDetailSupplementalReads(
  context: WorkloadDetailReadContext,
): WorkloadDetailSupplementalReadPlan {
  const readsRuntimeEvidence =
    context.tab === "overview" || context.tab === "deploys";
  const stateVersionId = readsRuntimeEvidence
    ? (context.currentStateVersionId ?? null)
    : null;
  return {
    stateVersionId,
    activityWorkspaceId:
      context.workspaceId &&
      (context.tab === "deploys" ||
        (context.tab === "overview" && Boolean(stateVersionId)))
        ? context.workspaceId
        : null,
    usageCapsuleId: context.tab === "overview" ? context.capsuleId : null,
  };
}
