/**
 * Retired Workspace bulk operations and RunGroup approval (TASK-0118 stage
 * 9.1). Each app is planned, drift-checked and approved on its own, so these
 * routes answer `410` with the typed `run_group_retired` code and never read
 * the Workspace or the group. Production and staging hold no RunGroup rows.
 */

import { errorJson } from "../http-helpers.ts";

export const RUN_GROUP_RETIRED_CODE = "run_group_retired" as const;

export const RUN_GROUP_RETIRED_MESSAGE =
  "Workspace RunGroups are retired. Plan each app with POST /api/v1/capsules/{capsuleId}/plan, drift-check it with POST /api/v1/capsules/{capsuleId}/drift-check, and approve each Run on its own.";

/** `POST /api/v1/workspaces/:id/{plan-update,drift-check}` */
export function isRetiredWorkspaceBulkOperation(
  segments: readonly string[],
): boolean {
  return segments[0] === "workspaces" &&
    segments.length === 3 &&
    (segments[2] === "plan-update" || segments[2] === "drift-check");
}

/** `POST /api/v1/run-groups/:id/approve` */
export function isRetiredRunGroupApproval(
  segments: readonly string[],
): boolean {
  return segments[0] === "run-groups" &&
    segments.length === 3 &&
    segments[2] === "approve";
}

export function runGroupRetiredResponse(request?: Request): Response {
  return errorJson(
    RUN_GROUP_RETIRED_CODE,
    RUN_GROUP_RETIRED_MESSAGE,
    410,
    request,
  );
}
