/** Temporary legacy ownership adapter; remove with the workspace compat API. */
import { ControlApiError, getWorkspace, listAccessibleApps, listMembers, type AppRole } from "./control-api.ts";

export async function resolveAppRole(input: {
  readonly capsuleId: string;
  readonly accountId?: string;
  readonly principalId?: string;
  readonly workspaceId?: string;
}): Promise<AppRole | undefined> {
  const apps = await listAccessibleApps();
  if (apps !== undefined) return apps.find((app) => app.capsuleId === input.capsuleId)?.role;
  if (!input.workspaceId) return undefined;
  const workspace = await getWorkspace(input.workspaceId);
  if (workspace.ownerUserId === input.accountId || workspace.ownerUserId === input.principalId) return "owner";
  // Legacy viewer/member roles were deliberately not widened by the migration.
  // Only an existing active administrator becomes an app member.
  try {
    const members = await listMembers(input.workspaceId);
    const identities = new Set([input.accountId, input.principalId].filter(Boolean));
    return members.some((member) => identities.has(member.accountId) && member.status === "active" &&
      member.roles.some((role) => role === "owner" || role === "admin")) ? "member" : undefined;
  } catch (error) {
    if (error instanceof ControlApiError && error.status === 404) return undefined;
    throw error;
  }
}

export function isAppRemovalRun(type: string | undefined): boolean {
  return type === "destroy_plan" || type === "destroy_apply";
}

/** A removal retry/review is still an uninstall, even with a generic label. */
export function appPrimaryAllowed(role: AppRole | undefined, app: import("./control-api.ts").CapsuleAppView): boolean {
  if (role === "owner") return true;
  if (role === undefined) return ["none", "open", "view_resources", "reinstall"].includes(app.primaryAction);
  if (app.primaryAction === "uninstall_now" || app.primaryAction === "cancel_uninstall") return false;
  const problem = app.problems.find((entry) => entry.severity === "error");
  if (app.primaryAction === "retry" && (problem?.code === "uninstall_failed" || isAppRemovalRun(problem?.runType))) return false;
  if (app.primaryAction === "review" && isAppRemovalRun(app.progress.review?.runType ?? problem?.runType)) return false;
  return true;
}
