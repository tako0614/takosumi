import { errorJson } from "./http-helpers.ts";

/**
 * Phase 3 compatibility switch for retiring organization creation and membership.
 * The safe default is frozen; operators can explicitly opt out during rollback.
 */
export const WORKSPACE_MUTATIONS_FROZEN_ENV =
  "TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN" as const;

export function parseWorkspaceMutationsFrozen(value?: string): boolean {
  if (value === undefined || value.trim() === "") return true;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "on":
      return true;
    case "0":
    case "false":
    case "off":
      return false;
    default:
      throw new TypeError(
        `${WORKSPACE_MUTATIONS_FROZEN_ENV} must be one of: true, false, on, off, 1, 0`,
      );
  }
}

/** Legacy Workspace member-management surface; creation is checked after parsing its type. */
export function isWorkspaceMutationRoute(
  segments: readonly string[],
  method: string,
): boolean {
  const verb = method.toUpperCase();
  return segments[0] === "workspaces" && segments[2] === "members" && (
    (segments.length === 3 && verb === "POST") ||
    (segments.length === 4 && (verb === "PATCH" || verb === "DELETE"))
  );
}

export function workspaceFrozenResponse(request?: Request): Response {
  return errorJson(
    "workspace_frozen",
    "Organization Workspace creation and membership changes are temporarily frozen.",
    409,
    request,
  );
}
