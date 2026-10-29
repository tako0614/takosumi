import { errorJson } from "./http-helpers.ts";

/**
 * Operator kill switch for per-app ownership writers: member add/remove/leave
 * and ownership-transfer create/accept/cancel. A rollout sets it `frozen`
 * until the ownership backfill is verified, because a transfer accepted
 * mid-backfill leaves that app's payer-less usage permanently unattributed
 * and member writes race the backfill's own member rows. Unset means
 * `enabled`, so self-hosted deployments keep their behavior.
 */
export const APP_OWNERSHIP_MUTATIONS_ENV = "TAKOSUMI_APP_OWNERSHIP_MUTATIONS" as const;

/** `details.reason` of the 409 `failed_precondition` a frozen mutation returns. */
const APP_OWNERSHIP_MUTATIONS_FROZEN_REASON = "app_ownership_mutations_frozen";

export function parseAppOwnershipMutationsFrozen(value?: string): boolean {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized === "" || normalized === "enabled") return false;
  if (normalized === "frozen") return true;
  throw new TypeError(`${APP_OWNERSHIP_MUTATIONS_ENV} must be one of: frozen, enabled`);
}

export function appOwnershipMutationsFrozenResponse(request?: Request): Response {
  return errorJson(
    "failed_precondition",
    "App member and ownership changes are temporarily paused by the operator.",
    409,
    request,
    { "cache-control": "no-store" },
    { reason: APP_OWNERSHIP_MUTATIONS_FROZEN_REASON },
  );
}
