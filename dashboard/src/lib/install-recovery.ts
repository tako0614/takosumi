import type { GitInstallPlanResponse } from "takosumi-contract";

const PLAN_ID = /^gip_[a-f0-9]{16}$/u;

/** A URL locator is never authority to create, approve, or apply a Run. */
export function installRecoveryId(search: string): string | undefined {
  const values = new URLSearchParams(search).getAll("installPlan");
  return values.length === 1 && PLAN_ID.test(values[0] ?? "")
    ? values[0]
    : undefined;
}

export function hasInstallRecoveryLocator(search: string): boolean {
  return new URLSearchParams(search).has("installPlan");
}

export function installRecoverySearch(id: string): string {
  if (!PLAN_ID.test(id)) throw new TypeError("Invalid install plan ID");
  return `?installPlan=${encodeURIComponent(id)}`;
}

export function installRecoveryMatches(
  response: GitInstallPlanResponse,
  planId: string,
  workspaceId: string,
  principalId: string,
): boolean {
  return Boolean(
    planId &&
      workspaceId &&
      principalId &&
      response.installPlan.id === planId &&
      response.installPlan.workspaceId === workspaceId &&
      response.installPlan.createdBy === principalId,
  );
}

/** A late response cannot replace a different route or recovery locator. */
export function installRecoveryRouteMatches(
  currentPath: string,
  currentSearch: string,
  requestPath: string,
  requestSearch: string,
  planId: string,
): boolean {
  return currentPath === requestPath &&
    (currentSearch === requestSearch || installRecoveryId(currentSearch) === planId);
}
