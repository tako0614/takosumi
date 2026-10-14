import type { Capsule, CapsuleUninstallRequester } from "takosumi-contract/capsules";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import { workspaceAccountAuthorityAllowed } from "../deploy-control/store.ts";

/** Accounts owns account/grant activity; Core owns the current Workspace roster. */
export type UninstallRequesterValidator = (
  requester: CapsuleUninstallRequester,
  workspaceId: string,
) => Promise<boolean>;

export const UNINSTALL_AUTHORIZATION_REASONS = {
  missing: "uninstall_requester_missing",
  denied: "uninstall_requester_denied",
  unavailable: "uninstall_authorization_unavailable",
} as const;

/** No cached role or system actor can substitute for a current authorization. */
export async function scheduledUninstallAuthorizationFailure(
  store: Pick<OpenTofuControlStore, "getWorkspace" | "getWorkspaceMember">,
  capsule: Capsule,
  validateRequester?: UninstallRequesterValidator,
): Promise<string | undefined> {
  const requester = capsule.uninstall?.requester;
  if (!requester || typeof requester.subject !== "string" || !requester.subject.trim()) {
    // Legacy rows cannot prove who authorized the reservation. Neither the
    // audit actor nor today's owner can replace immutable requester evidence;
    // cancel and create a new reservation with the currently authorized user.
    return UNINSTALL_AUTHORIZATION_REASONS.missing;
  }
  if (!validateRequester) return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  try {
    const workspace = await store.getWorkspace(capsule.workspaceId);
    if (!workspace || workspace.id !== capsule.workspaceId) {
      return UNINSTALL_AUTHORIZATION_REASONS.denied;
    }
    const member = await store.getWorkspaceMember(capsule.workspaceId, requester.subject);
    if (!workspaceAccountAuthorityAllowed({
      actorAccountId: requester.subject,
      expectedWorkspace: workspace,
      expectedActor: member,
    }) || !(await validateRequester(requester, capsule.workspaceId))) {
      return UNINSTALL_AUTHORIZATION_REASONS.denied;
    }
    return undefined;
  } catch {
    // Do not persist exception text: a credential backend may include secrets.
    return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  }
}
