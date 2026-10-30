/**
 * The per-app decision for a Capsule-owned Interface or Interface link
 * (TASK-0118 9.1), from the app ownership and access ports a host already
 * composes: the owner or a member holding the app action (`view`,
 * `change_settings`, `change_interface_link`), checked against the current
 * ownership epoch. `undefined` means the app has no
 * ownership row yet (or the ownership schema is not there), and the caller
 * keeps the Workspace decision for it.
 */
import { appActionAllowed, type AppAccessResolver, type AppAction } from "takosumi-contract/app-access";
import { isMissingOwnershipSchemaError, type AppOwnershipStore } from "./store.ts";

export interface InterfaceAppDecisionPorts {
  readonly appOwnership: Pick<AppOwnershipStore, "getOwnership">;
  readonly appAccess: Pick<AppAccessResolver, "resolveAppAccess">;
}

export async function decideInterfaceAppAccess(
  ports: InterfaceAppDecisionPorts,
  input: {
    readonly accountId: string;
    readonly capsuleId: string;
    readonly action: Extract<AppAction, "view" | "change_settings" | "change_interface_link">;
  },
): Promise<boolean | undefined> {
  let owned: Awaited<ReturnType<InterfaceAppDecisionPorts["appOwnership"]["getOwnership"]>>;
  try {
    owned = await ports.appOwnership.getOwnership(input.capsuleId);
  } catch (error) {
    return isMissingOwnershipSchemaError(error) ? undefined : false;
  }
  if (!owned) return undefined;
  try {
    const app = await ports.appAccess.resolveAppAccess(input.accountId, input.capsuleId);
    return app !== undefined && app.capsuleId === input.capsuleId &&
      app.ownerAccountId === owned.ownerAccountId &&
      app.ownershipEpoch === owned.ownershipEpoch &&
      appActionAllowed(app.role, input.action);
  } catch {
    return false;
  }
}
