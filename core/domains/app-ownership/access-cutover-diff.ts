import type { WorkspaceMember } from "../../../contract/workspaces.ts";
import type { CapsuleMember, CapsuleOwnership } from "./store.ts";
import { isMissingOwnershipSchemaError } from "./store.ts";
import type { OwnershipBackfillContext } from "./backfill.ts";

/**
 * Read-only comparison for the Phase 6b authorization cutover. For every
 * (account, live Capsule) pair that has management access under either rule,
 * it reports where the legacy Workspace decision and the per-app decision
 * would differ once the ownership backfill has run. Capsules without an
 * ownership row are projected with the backfill's own inference: the
 * Workspace owner becomes the owner and active owner/admin members become
 * members. Nothing is written.
 */
export type AccessClass = "view" | "manage" | "owner_only";

export type AccessCutoverDifferenceReason =
  /** Workspace member/viewer roles could read; they are not app members. */
  | "workspace_reader_not_app_member"
  /** A Workspace owner/admin who is not the app owner loses owner-only actions. */
  | "workspace_manager_not_app_owner"
  /** A Workspace owner/admin outside an explicit app roster loses the app. */
  | "workspace_manager_not_app_member"
  /** An app owner/member without Workspace membership gains the app. */
  | "app_role_without_workspace_role";

export interface AccessCutoverDifference {
  readonly workspaceId: string;
  readonly capsuleId: string;
  readonly accountId: string;
  readonly accessClass: AccessClass;
  readonly workspaceDecision: boolean;
  readonly appDecision: boolean;
  readonly appRole: "owner" | "member" | null;
  readonly ownershipSource: "ownership_row" | "backfill_projection";
  readonly reason: AccessCutoverDifferenceReason;
}

export interface AccessCutoverReport {
  readonly capsulesChecked: number;
  readonly capsulesProjectedFromBackfill: number;
  readonly pairsChecked: number;
  readonly differenceCount: number;
  readonly differencesByClass: Readonly<Record<AccessClass, number>>;
  readonly differences: readonly AccessCutoverDifference[];
}

const CLASSES: readonly AccessClass[] = ["view", "manage", "owner_only"];

type WorkspaceRole = "owner" | "manager" | "reader" | null;

function workspaceRole(ownerUserId: string, accountId: string, member: WorkspaceMember | undefined): WorkspaceRole {
  if (accountId === ownerUserId) return "owner";
  if (member?.status !== "active") return null;
  if (member.roles.some((role) => role === "owner" || role === "admin")) return "manager";
  return member.roles.some((role) => role === "member" || role === "viewer") ? "reader" : null;
}

/** The legacy rule: readers read; the Workspace owner and owner/admin members do everything. */
function workspaceAllows(role: WorkspaceRole, accessClass: AccessClass): boolean {
  if (role === null) return false;
  return accessClass === "view" ? true : role !== "reader";
}

function appAllows(role: "owner" | "member" | null, accessClass: AccessClass): boolean {
  if (role === null) return false;
  return accessClass === "owner_only" ? role === "owner" : true;
}

async function readOwnership(context: OwnershipBackfillContext, capsuleId: string): Promise<CapsuleOwnership | undefined> {
  try {
    if (context.ownership.readOwnershipFence) {
      return (await context.ownership.readOwnershipFence(capsuleId)).ownership;
    }
    return await context.ownership.getOwnership(capsuleId);
  } catch (error) {
    if (isMissingOwnershipSchemaError(error)) return undefined;
    throw error;
  }
}

export async function planAppAccessCutoverDiff(context: OwnershipBackfillContext): Promise<AccessCutoverReport> {
  const differences: AccessCutoverDifference[] = [];
  let capsulesChecked = 0;
  let capsulesProjectedFromBackfill = 0;
  let pairsChecked = 0;
  const workspaces = [...await context.control.listWorkspaces()].sort((a, b) => a.id.localeCompare(b.id));
  const capsules = [...await context.control.listCapsules()].sort((a, b) => a.id.localeCompare(b.id));
  for (const workspace of workspaces) {
    if (!workspace.ownerUserId) throw new Error("Access comparison requires a Workspace owner");
    const members = [...await context.control.listWorkspaceMembers(workspace.id)]
      .filter((row) => row.workspaceId === workspace.id);
    const memberByAccount = new Map(members.map((row) => [row.accountId, row]));
    const legacyRoot = (capsuleId: string) => `workspaces/${workspace.id}/capsules/${capsuleId}`;
    for (const capsule of capsules) {
      if (capsule.workspaceId !== workspace.id || capsule.status === "destroyed") continue;
      capsulesChecked++;
      const existing = await readOwnership(context, capsule.id);
      const ownerAccountId = existing?.ownerAccountId ?? workspace.ownerUserId;
      const roster = new Set<string>();
      if (existing) {
        const current: readonly CapsuleMember[] = await context.ownership.listMembers(capsule.id);
        for (const row of current) if (row.status === "active") roster.add(row.accountId);
      } else {
        capsulesProjectedFromBackfill++;
      }
      // Same rule as planAppOwnershipBackfill: only a missing or untouched
      // legacy-default owner row receives the Workspace owner/admin roster.
      if (!existing || (existing.ownerAccountId === workspace.ownerUserId && existing.ownershipEpoch === 0 &&
        existing.storageRoot === legacyRoot(capsule.id))) {
        for (const row of members) {
          if (row.status === "active" && row.accountId !== ownerAccountId &&
            row.roles.some((role) => role === "owner" || role === "admin")) roster.add(row.accountId);
        }
      }
      roster.delete(ownerAccountId);
      const accounts = new Set<string>([workspace.ownerUserId, ownerAccountId, ...roster,
        ...members.map((row) => row.accountId)]);
      for (const accountId of [...accounts].sort()) {
        const wsRole = workspaceRole(workspace.ownerUserId, accountId, memberByAccount.get(accountId));
        const appRole = accountId === ownerAccountId ? "owner" : roster.has(accountId) ? "member" : null;
        if (wsRole === null && appRole === null) continue;
        pairsChecked++;
        for (const accessClass of CLASSES) {
          const workspaceDecision = workspaceAllows(wsRole, accessClass);
          const appDecision = appAllows(appRole, accessClass);
          if (workspaceDecision === appDecision) continue;
          differences.push({
            workspaceId: workspace.id,
            capsuleId: capsule.id,
            accountId,
            accessClass,
            workspaceDecision,
            appDecision,
            appRole,
            ownershipSource: existing ? "ownership_row" : "backfill_projection",
            reason: !workspaceDecision ? "app_role_without_workspace_role"
              : wsRole === "reader" ? "workspace_reader_not_app_member"
              : appRole === null ? "workspace_manager_not_app_member"
              : "workspace_manager_not_app_owner",
          });
        }
      }
    }
  }
  const differencesByClass = { view: 0, manage: 0, owner_only: 0 };
  for (const row of differences) differencesByClass[row.accessClass]++;
  return {
    capsulesChecked,
    capsulesProjectedFromBackfill,
    pairsChecked,
    differenceCount: differences.length,
    differencesByClass,
    differences,
  };
}
