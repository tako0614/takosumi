import type { WorkspaceMember } from "../../../contract/workspaces.ts";
import type { CapsuleMember, CapsuleOwnership } from "./store.ts";
import { isMissingOwnershipSchemaError } from "./store.ts";
import type { OwnershipBackfillContext } from "./backfill.ts";

/**
 * Read-only comparison for the Phase 6b authorization cutover. For every
 * (account, live Capsule) pair — and every (account, Source) pair of a Source
 * used by live Capsules — that has management access under either rule, it
 * reports where the legacy Workspace decision and the per-app decision
 * differ. It evaluates what the live code decides: a Capsule with an
 * ownership row uses exactly that row's owner and active `capsule_members`;
 * only Capsules without a row are projected with the backfill's inference
 * (Workspace owner becomes the owner, active owner/admin members become
 * members). A Source belongs to its `ownerCapsuleId` (an uninstalled owner app
 * by its retained row and roster, as the live decision reads them), or to
 * every live Capsule built from it, and needs EVERY such app to allow under that app's own rule,
 * as the live code decides: an app with a row by its roster; an app without a
 * row by the backfill projection, which is what its row will say once the
 * backfill reaches it (until then the live code uses the legacy Workspace
 * decision for that app; the runbook runs this check after the backfill).
 * Such a Source is reported with `ownershipSource: "mixed"`. Nothing is written.
 */
export type AccessClass = "view" | "manage" | "owner_only";

export type AccessCutoverDifferenceReason =
  /** An active Workspace member/viewer (or role-less active member) could read; not an app member. */
  | "workspace_reader_not_app_member"
  /** A Workspace owner/admin who is an app member loses owner-only actions. */
  | "workspace_manager_not_app_owner"
  /** A Workspace owner/admin outside the app's roster loses the app. */
  | "workspace_manager_not_app_member"
  /** A Workspace member/viewer who is an app owner/member gains management. */
  | "app_role_beyond_workspace_role"
  /** An app owner/member without Workspace membership gains the app. */
  | "app_role_without_workspace_role";

export interface AccessCutoverDifference {
  readonly workspaceId: string;
  readonly capsuleId?: string;
  readonly sourceId?: string;
  readonly accountId: string;
  readonly accessClass: AccessClass;
  readonly workspaceDecision: boolean;
  readonly appDecision: boolean;
  readonly appRole: "owner" | "member" | null;
  readonly ownershipSource: "ownership_row" | "backfill_projection" | "mixed";
  readonly reason: AccessCutoverDifferenceReason;
  /**
   * Installed-app OAuth tokens and `requireCurrentMembership` compositions
   * need both decisions, so they lose access exactly where the Workspace
   * decision allowed and the app decision does not.
   */
  readonly affectsBothRequiredCredentials: boolean;
}

export interface AccessCutoverReport {
  readonly capsulesChecked: number;
  readonly capsulesProjectedFromBackfill: number;
  readonly sourcesChecked: number;
  readonly pairsChecked: number;
  readonly differenceCount: number;
  readonly differencesByClass: Readonly<Record<AccessClass, number>>;
  readonly differences: readonly AccessCutoverDifference[];
}

const CLASSES: readonly AccessClass[] = ["view", "manage", "owner_only"];

type WorkspaceRole = "owner" | "manager" | "reader" | null;
type AppRole = "owner" | "member" | null;

/** The legacy session rule: any active member reads; owner/admin members and the owner manage. */
function workspaceRole(ownerUserId: string, accountId: string, member: WorkspaceMember | undefined): WorkspaceRole {
  if (accountId === ownerUserId) return "owner";
  if (member?.status !== "active") return null;
  return member.roles.some((role) => role === "owner" || role === "admin") ? "manager" : "reader";
}

function workspaceAllows(role: WorkspaceRole, accessClass: AccessClass): boolean {
  if (role === null) return false;
  return accessClass === "view" ? true : role !== "reader";
}

function appAllows(role: AppRole, accessClass: AccessClass): boolean {
  if (role === null) return false;
  return accessClass === "owner_only" ? role === "owner" : true;
}

function reasonFor(
  wsRole: WorkspaceRole,
  appRole: AppRole,
  workspaceDecision: boolean,
): AccessCutoverDifferenceReason {
  if (!workspaceDecision) return wsRole === null ? "app_role_without_workspace_role" : "app_role_beyond_workspace_role";
  if (wsRole === "reader") return "workspace_reader_not_app_member";
  return appRole === null ? "workspace_manager_not_app_member" : "workspace_manager_not_app_owner";
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

interface AppRoster {
  readonly ownerAccountId: string;
  readonly members: ReadonlySet<string>;
  readonly projected: boolean;
}

export async function planAppAccessCutoverDiff(context: OwnershipBackfillContext): Promise<AccessCutoverReport> {
  const differences: AccessCutoverDifference[] = [];
  let capsulesChecked = 0;
  let capsulesProjectedFromBackfill = 0;
  let sourcesChecked = 0;
  let pairsChecked = 0;
  const workspaces = [...await context.control.listWorkspaces()].sort((a, b) => a.id.localeCompare(b.id));
  const capsules = [...await context.control.listCapsules()].sort((a, b) => a.id.localeCompare(b.id));
  for (const workspace of workspaces) {
    if (!workspace.ownerUserId) throw new Error("Access comparison requires a Workspace owner");
    const members = [...await context.control.listWorkspaceMembers(workspace.id)]
      .filter((row) => row.workspaceId === workspace.id);
    const memberByAccount = new Map(members.map((row) => [row.accountId, row]));
    const rosters = new Map<string, AppRoster>();
    const live = capsules.filter((capsule) => capsule.workspaceId === workspace.id && capsule.status !== "destroyed");
    const buildRoster = async (capsuleId: string): Promise<AppRoster> => {
      const existing = await readOwnership(context, capsuleId);
      const roster = new Set<string>();
      let ownerAccountId: string;
      if (existing) {
        // Exactly what the live resolver reads: the owner row and active members.
        ownerAccountId = existing.ownerAccountId;
        const current: readonly CapsuleMember[] = await context.ownership.listMembers(capsuleId);
        for (const row of current) if (row.status === "active") roster.add(row.accountId);
      } else {
        ownerAccountId = workspace.ownerUserId;
        for (const row of members) {
          if (row.status === "active" && row.roles.some((role) => role === "owner" || role === "admin")) roster.add(row.accountId);
        }
      }
      roster.delete(ownerAccountId);
      return { ownerAccountId, members: roster, projected: !existing };
    };
    for (const capsule of live) {
      capsulesChecked++;
      const roster = await buildRoster(capsule.id);
      if (roster.projected) capsulesProjectedFromBackfill++;
      rosters.set(capsule.id, roster);
    }
    // An uninstalled owner app keeps its ownership row and roster (the backfill
    // writes destroyed apps too); the live decision on its Source uses them.
    const sourceOwnerRoster = async (capsuleId: string): Promise<AppRoster | undefined> => {
      const known = rosters.get(capsuleId);
      if (known) return known;
      const capsule = capsules.find((row) => row.id === capsuleId);
      if (!capsule || capsule.workspaceId !== workspace.id || capsule.status !== "destroyed") return undefined;
      const roster = await buildRoster(capsuleId);
      rosters.set(capsuleId, roster);
      return roster;
    };
    const roleIn = (roster: AppRoster, accountId: string): AppRole =>
      accountId === roster.ownerAccountId ? "owner" : roster.members.has(accountId) ? "member" : null;
    const compare = (
      target: { readonly capsuleId?: string; readonly sourceId?: string },
      apps: readonly AppRoster[],
    ): void => {
      const accounts = new Set<string>([workspace.ownerUserId, ...members.map((row) => row.accountId)]);
      for (const roster of apps) {
        accounts.add(roster.ownerAccountId);
        for (const id of roster.members) accounts.add(id);
      }
      const ownershipSource = apps.every((roster) => roster.projected) ? "backfill_projection"
        : apps.every((roster) => !roster.projected) ? "ownership_row" : "mixed";
      for (const accountId of [...accounts].sort()) {
        const wsRole = workspaceRole(workspace.ownerUserId, accountId, memberByAccount.get(accountId));
        const roles = apps.map((roster) => roleIn(roster, accountId));
        // A resource of several apps needs each app; report the weakest role.
        const appRole: AppRole = roles.every((role) => role === "owner") ? "owner"
          : roles.every((role) => role !== null) ? "member" : null;
        if (wsRole === null && roles.every((role) => role === null)) continue;
        pairsChecked++;
        for (const accessClass of CLASSES) {
          const workspaceDecision = workspaceAllows(wsRole, accessClass);
          const appDecision = roles.every((role) => appAllows(role, accessClass));
          if (workspaceDecision === appDecision) continue;
          differences.push({
            workspaceId: workspace.id,
            ...target,
            accountId,
            accessClass,
            workspaceDecision,
            appDecision,
            appRole,
            ownershipSource,
            reason: reasonFor(wsRole, appRole, workspaceDecision),
            affectsBothRequiredCredentials: workspaceDecision && !appDecision,
          });
        }
      }
    };
    for (const capsule of live) compare({ capsuleId: capsule.id }, [rosters.get(capsule.id)!]);
    // Sources: the owner Capsule, or every live Capsule built from an ownerless Source.
    const sources = [...await context.control.listSources(workspace.id)].sort((a, b) => a.id.localeCompare(b.id));
    for (const source of sources) {
      const owner = source.ownerCapsuleId ? await sourceOwnerRoster(source.ownerCapsuleId) : undefined;
      const apps = source.ownerCapsuleId
        ? owner ? [owner] : []
        : live.filter((capsule) => capsule.sourceId === source.id).map((capsule) => rosters.get(capsule.id)!);
      if (!apps.length) continue;
      sourcesChecked++;
      compare({ sourceId: source.id }, apps);
    }
  }
  const differencesByClass = { view: 0, manage: 0, owner_only: 0 };
  for (const row of differences) differencesByClass[row.accessClass]++;
  return {
    capsulesChecked,
    capsulesProjectedFromBackfill,
    sourcesChecked,
    pairsChecked,
    differenceCount: differences.length,
    differencesByClass,
    differences,
  };
}
