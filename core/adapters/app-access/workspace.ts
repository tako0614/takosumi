import type { AppAccess, AppAccessResolver } from "../../../contract/app-access.ts";
import type { Capsule } from "takosumi-contract/install-configs";
import type { Workspace, WorkspaceMember } from "takosumi-contract/workspaces";
import { pageSorted } from "takosumi-contract/pagination";

/** Temporary pre-v77 adapter. Delete after the store-backed resolver cutover. */
export interface WorkspaceAppAccessSource {
  getCapsule(id: string): Promise<Capsule | undefined>;
  getWorkspace(id: string): Promise<Workspace | undefined>;
  getWorkspaceMember(workspaceId: string, accountId: string): Promise<WorkspaceMember | undefined>;
  listWorkspacesForAccount(accountId: string): Promise<readonly Workspace[]>;
  listCapsules(workspaceId: string): Promise<readonly Capsule[]>;
}

export function createWorkspaceAppAccessResolver(source: WorkspaceAppAccessSource): AppAccessResolver {
  const resolveAppAccess = async (accountId: string, capsuleId: string): Promise<AppAccess | undefined> => {
    const capsule = await source.getCapsule(capsuleId);
    if (!capsule || capsule.status === "destroyed") return undefined;
    // Expanded records must use the canonical resolver. A Workspace fallback
    // would resurrect a removed app member from the old membership ledger.
    if (capsule.ownerAccountId !== undefined) return undefined;
    const workspace = await source.getWorkspace(capsule.workspaceId);
    if (!workspace || workspace.archivedAt || !workspace.ownerUserId) return undefined;
    if (workspace.ownerUserId === accountId) {
      return { capsuleId, role: "owner", ownerAccountId: accountId, ownershipEpoch: 0 };
    }
    const member = await source.getWorkspaceMember(workspace.id, accountId);
    if (member?.workspaceId !== workspace.id || member.accountId !== accountId ||
      member.status !== "active" || !member.roles.some((role) => role === "owner" || role === "admin")) return undefined;
    return { capsuleId, role: "member", ownerAccountId: workspace.ownerUserId, ownershipEpoch: 0 };
  };
  return {
    resolveAppAccess,
    async listAccessibleApps(accountId, page = {}) {
      const rows: { id: string; createdAt: string; access: AppAccess }[] = [];
      const seen = new Set<string>();
      for (const workspace of await source.listWorkspacesForAccount(accountId)) {
        for (const capsule of await source.listCapsules(workspace.id)) {
          if (seen.has(capsule.id)) continue;
          seen.add(capsule.id);
          const access = await resolveAppAccess(accountId, capsule.id);
          if (access) rows.push({ id: capsule.id, createdAt: capsule.createdAt, access });
        }
      }
      rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
      const result = pageSorted(rows, page);
      return { apps: result.items.map((row) => row.access), ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) };
    },
  };
}
