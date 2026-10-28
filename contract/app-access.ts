export type AppRole = "owner" | "member";

export interface AppAccess {
  readonly capsuleId: string;
  readonly role: AppRole;
  readonly ownerAccountId: string;
  readonly ownershipEpoch: number;
}

export interface AppAccessResolver {
  /** undefined = no management access (the person may still USE the app via its own URL). */
  resolveAppAccess(accountId: string, capsuleId: string): Promise<AppAccess | undefined>;
  listAccessibleApps(accountId: string, page?: { cursor?: string; limit?: number }):
    Promise<{ apps: readonly AppAccess[]; nextCursor?: string }>;
}

export type AppAction =
  | "view" | "change_settings" | "update" | "rollback" | "choose_connection" | "change_interface_link"
  | "uninstall" | "transfer_ownership" | "manage_members";

export function appActionAllowed(role: AppRole, action: AppAction): boolean {
  switch (role) {
    case "owner":
      return true;
    case "member":
      return action !== "uninstall" && action !== "transfer_ownership" && action !== "manage_members";
    default:
      return false;
  }
}
