import type { TakosumiSubject } from "@takosjp/takosumi-accounts-contract";
import type { Workspace } from "takosumi-contract/workspaces";
import type { ControlPlaneOperations } from "../control-operations.ts";
import type { AccountsStore } from "../store.ts";
import type { ControlSession } from "./shared.ts";
import { personalWorkspaceHandle } from "../control-personal-workspace.ts";

/** Internal namespace retained by the compat coordinator until Phase 9. */
export async function personalResourceNamespace(
  operations: ControlPlaneOperations,
  store: AccountsStore,
  session: ControlSession,
  createIfMissing = true,
): Promise<Workspace | undefined> {
  if (session.workspaceId !== undefined || session.appIds !== undefined) return undefined;
  const existing = (await operations.workspaces.listWorkspacesByOwner(session.subject))
    .filter((workspace) => workspace.type === "personal" && !workspace.archivedAt && workspace.ownerUserId === session.subject)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
  if (existing) return existing;
  if (!createIfMissing) return undefined;
  const ensure = session.requireCurrentMembership
    ? operations.workspaces.ensurePersonalWorkspaceForSharedAccount
    : operations.workspaces.ensurePersonalWorkspace;
  if (!ensure) return undefined;
  const account = await store.findAccount(session.subject as TakosumiSubject);
  if (!account) return undefined;
  const workspace = await ensure.call(operations.workspaces, session.subject, personalWorkspaceHandle({
    subject: session.subject, displayName: account.displayName, email: account.email,
  }));
  return workspace.ownerUserId === session.subject && workspace.type === "personal" && !workspace.archivedAt
    ? workspace : undefined;
}
