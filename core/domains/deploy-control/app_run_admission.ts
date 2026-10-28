import type { Capsule, PlanRun } from "@takosumi/internal/deploy-control-api";

/** The four app authority fields are an indivisible migration unit. */
export function appRunAuthority(capsule: Capsule | undefined):
  | { readonly kind: "legacy" }
  | {
    readonly kind: "owned";
    readonly ownerAccountId: string;
    readonly ownershipEpoch: number;
    readonly managementEpoch: number;
    readonly managementState: "active" | "draining" | "frozen";
  }
  | undefined {
  if (capsule === undefined) return undefined;
  const { ownerAccountId, ownershipEpoch, managementEpoch, managementState } = capsule;
  if (ownerAccountId === undefined && ownershipEpoch === undefined &&
    managementEpoch === undefined && managementState === undefined) {
    return { kind: "legacy" };
  }
  if (typeof ownerAccountId !== "string" || ownerAccountId.trim() === "" ||
    !Number.isSafeInteger(ownershipEpoch) || ownershipEpoch! < 0 ||
    !Number.isSafeInteger(managementEpoch) || managementEpoch! < 0 ||
    (managementState !== "active" && managementState !== "draining" && managementState !== "frozen")) {
    return undefined;
  }
  return {
    kind: "owned", ownerAccountId, ownershipEpoch: ownershipEpoch!,
    managementEpoch: managementEpoch!, managementState,
  };
}

export function appPlanAdmission(capsule: Capsule | undefined, run: PlanRun): boolean {
  if (capsule === undefined) {
    return run.ownershipEpoch === undefined && run.appManagementEpoch === undefined;
  }
  const authority = appRunAuthority(capsule);
  if (authority === undefined || capsule.id !== run.capsuleId ||
    capsule.workspaceId !== run.workspaceId) return false;
  if (authority.kind === "legacy") {
    return run.ownershipEpoch === undefined && run.appManagementEpoch === undefined;
  }
  return authority.managementState === "active" &&
    run.ownershipEpoch === authority.ownershipEpoch &&
    run.appManagementEpoch === authority.managementEpoch;
}

export function appApplyAdmission(capsule: Capsule | undefined, plan: PlanRun | undefined,
  apply: { readonly capsuleId?: string; readonly workspaceId: string; readonly planRunId: string }): boolean {
  if (capsule !== undefined && appRunAuthority(capsule)?.kind === "legacy") {
    return plan === undefined ||
      (plan.ownershipEpoch === undefined && plan.appManagementEpoch === undefined);
  }
  return plan !== undefined && plan.id === apply.planRunId &&
    plan.capsuleId === apply.capsuleId && plan.workspaceId === apply.workspaceId &&
    appPlanAdmission(capsule, plan);
}

/** A stale running lease may be continued only during the first drain epoch. */
export function appClaimAdmission(capsule: Capsule | undefined, plan: PlanRun | undefined,
  run: { readonly capsuleId?: string; readonly workspaceId: string; readonly status: string },
  staleRunning: boolean): boolean {
  if (capsule === undefined) {
    return plan === undefined ||
      (plan.ownershipEpoch === undefined && plan.appManagementEpoch === undefined);
  }
  const authority = appRunAuthority(capsule);
  if (authority?.kind === "legacy") {
    return plan === undefined ||
      (plan.ownershipEpoch === undefined && plan.appManagementEpoch === undefined);
  }
  if (plan === undefined || plan.capsuleId !== run.capsuleId ||
    plan.workspaceId !== run.workspaceId) return false;
  if (authority === undefined || capsule.id !== run.capsuleId ||
    capsule.workspaceId !== run.workspaceId) return false;
  if (plan.ownershipEpoch !== authority.ownershipEpoch ||
    !Number.isSafeInteger(plan.appManagementEpoch)) return false;
  if (authority.managementState === "active") {
    return authority.managementEpoch === plan.appManagementEpoch;
  }
  return staleRunning && run.status === "running" &&
    authority.managementState === "draining" &&
    authority.managementEpoch === plan.appManagementEpoch! + 1;
}
