/**
 * Who a Provider Connection belongs to (TASK-0118 P9.1-d). A Workspace-scoped
 * connection is its owner's connection; the Workspace it records only fills
 * the retained column and confers nothing on the Workspace's other members.
 * A legacy row without an owner (the ownership backfill sets one on every
 * row it reaches) falls back to the owner of the Workspace it records, which
 * is who could create it before ownership existed. Operator connections have
 * no account owner.
 */
import type { ProviderConnection } from "takosumi-contract/connections";
import type { ControlPlaneOperations } from "../control-operations.ts";
import { controllerErrorCode } from "./shared.ts";

export async function connectionOwnerAccountId(
  operations: ControlPlaneOperations,
  connection: Pick<ProviderConnection, "scope" | "ownerAccountId" | "workspaceId">,
): Promise<string | undefined> {
  if (connection.scope === "operator") return undefined;
  if (connection.ownerAccountId) return connection.ownerAccountId;
  if (connection.scope !== "workspace" || !connection.workspaceId) return undefined;
  return await workspaceOwner(operations, connection.workspaceId);
}

/** One Workspace owner read for many rows of the same Workspace. */
export function connectionOwnerFilter(
  operations: ControlPlaneOperations,
  accountId: string,
): (connection: ProviderConnection) => Promise<boolean> {
  const owners = new Map<string, Promise<string | undefined>>();
  return async (connection) => {
    if (connection.scope === "operator") return false;
    if (connection.ownerAccountId) return connection.ownerAccountId === accountId;
    if (connection.scope !== "workspace" || !connection.workspaceId) return false;
    let owner = owners.get(connection.workspaceId);
    if (!owner) {
      owner = workspaceOwner(operations, connection.workspaceId);
      owners.set(connection.workspaceId, owner);
    }
    return (await owner) === accountId;
  };
}

async function workspaceOwner(
  operations: ControlPlaneOperations,
  workspaceId: string,
): Promise<string | undefined> {
  try {
    const workspace = await operations.workspaces.getWorkspace(workspaceId);
    return workspace.id === workspaceId ? workspace.ownerUserId : undefined;
  } catch (error) {
    if (controllerErrorCode(error) === "not_found") return undefined;
    throw error;
  }
}
