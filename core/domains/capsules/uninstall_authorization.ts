import type { Capsule, CapsuleUninstallRequester } from "takosumi-contract/capsules";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import { workspaceAccountAuthorityAllowed } from "../deploy-control/store.ts";
import type { AppOwnershipStore } from "../app-ownership/store.ts";

/** PATs need a six-hour buffer beyond the scheduled uninstall deadline. */
export const UNINSTALL_PAT_EXPIRY_MARGIN_MS = 6 * 60 * 60 * 1_000;

/** Accounts owns account/grant activity; Core checks the captured management authority. */
export type UninstallRequesterValidator = (
  requester: CapsuleUninstallRequester,
  workspaceId: string,
) => Promise<boolean>;

/**
 * Reservation admission asks hosts to check the exact grant at validAtMs.
 * For PATs, Core supplies the millisecond before its inclusive post-deadline
 * expiry threshold to preserve Accounts' strict expiresAt > validAtMs rule.
 * Hosts must re-read Accounts authority; a current-time finalizer validator
 * cannot substitute for this capability.
 */
export type UninstallRequesterAtValidator = (
  requester: CapsuleUninstallRequester,
  workspaceId: string,
  validAtMs: number,
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
  appOwnership?: Pick<AppOwnershipStore, "getOwnership">,
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
    // Read current management authority after the Accounts await. A captured
    // role before an asynchronous exact-grant lookup cannot authorize teardown.
    if (!(await validateRequester(requester, capsule.workspaceId))) {
      return UNINSTALL_AUTHORIZATION_REASONS.denied;
    }
    return await scheduledUninstallManagementFailure(store, capsule, appOwnership);
  } catch {
    return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  }
}

/** Reused under lifecycle admission before a new app-authorized reservation commits. */
export async function scheduledUninstallManagementFailure(
  store: Pick<OpenTofuControlStore, "getWorkspace" | "getWorkspaceMember">,
  capsule: Capsule,
  appOwnership?: Pick<AppOwnershipStore, "getOwnership">,
): Promise<string | undefined> {
  const requester = capsule.uninstall?.requester;
  if (!requester || typeof requester.subject !== "string" || !requester.subject.trim()) {
    return UNINSTALL_AUTHORIZATION_REASONS.missing;
  }
  const authority = requester.managementAuthority;
  if (authority !== undefined && authority !== "workspace" && authority !== "app" &&
    authority !== "app-and-workspace") return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  const epoch = requester.appOwnershipEpoch;
  if (epoch !== undefined && (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)) {
    return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  }
  const appRequired = authority === "app" || authority === "app-and-workspace";
  if (appRequired && (!appOwnership || epoch === undefined)) return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  try {
    const workspace = await store.getWorkspace(capsule.workspaceId);
    if (!workspace || workspace.id !== capsule.workspaceId) {
      return UNINSTALL_AUTHORIZATION_REASONS.denied;
    }
    if (authority !== "app") {
      const member = await store.getWorkspaceMember(capsule.workspaceId, requester.subject);
      if (!workspaceAccountAuthorityAllowed({
        actorAccountId: requester.subject,
        expectedWorkspace: workspace,
        expectedActor: member,
        ...(authority === "app-and-workspace" ? { requireCurrentMembership: true } : {}),
      })) return UNINSTALL_AUTHORIZATION_REASONS.denied;
    }
    if (appRequired) {
      const ownership = await appOwnership?.getOwnership(capsule.id);
      if (!ownership || ownership.capsuleId !== capsule.id ||
        ownership.managementState !== "active" ||
        ownership.ownerAccountId !== requester.subject ||
        ownership.ownershipEpoch !== requester.appOwnershipEpoch) {
        return UNINSTALL_AUTHORIZATION_REASONS.denied;
      }
    }
    return undefined;
  } catch {
    // Do not persist exception text: a credential backend may include secrets.
    return UNINSTALL_AUTHORIZATION_REASONS.unavailable;
  }
}
