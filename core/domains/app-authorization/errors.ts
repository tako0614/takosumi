export type AppAuthorizationErrorCode =
  | "app_access_denied" | "app_owner_only" | "ownership_transfer_pending"
  | "not_found" | "conflict" | "feature_unavailable";

export class AppAuthorizationError extends Error {
  constructor(readonly code: AppAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "AppAuthorizationError";
  }
}
