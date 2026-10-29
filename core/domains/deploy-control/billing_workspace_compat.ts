/** Temporary pre-v77 adapter. Delete when every Capsule has a canonical owner. */
import type { AppBillingIdentity } from "takosumi-contract/billing";
import type { OpenTofuControlStore } from "./store.ts";
import { OpenTofuControllerError } from "./errors.ts";

export interface AppBillingOwnership {
  readonly identity: AppBillingIdentity;
  readonly ownershipEpoch: number;
}

export async function appBillingOwnership(
  store: Pick<OpenTofuControlStore, "getCapsule" | "getWorkspace" | "getAppBillingOwnership">,
  capsuleId: string | undefined,
): Promise<AppBillingOwnership> {
  if (!capsuleId) {
    throw new OpenTofuControllerError("failed_precondition", "Billing requires an app.");
  }
  const capsule = await store.getCapsule(capsuleId);
  if (!capsule) {
    throw new OpenTofuControllerError("not_found", `capsule ${capsuleId} not found`);
  }
  // Physical ownership columns are the authority. Capsule JSON can retain
  // the original owner after an ownership-store transfer/backfill.
  const row = await store.getAppBillingOwnership(capsuleId) ?? { ownershipEpoch: 0 };
  const epoch = row.ownershipEpoch ?? 0;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new OpenTofuControllerError("failed_precondition", "App billing owner is unavailable.");
  }
  if (row.ownerAccountId !== undefined) {
    if (typeof row.ownerAccountId !== "string" || !row.ownerAccountId.trim()) {
      throw new OpenTofuControllerError("failed_precondition", "App billing owner is unavailable.");
    }
    return { identity: { capsuleId: capsule.id, payerAccountId: row.ownerAccountId }, ownershipEpoch: epoch };
  }
  // A transferred or invalid owner never falls back to the old Workspace.
  if (epoch > 0) {
    throw new OpenTofuControllerError("failed_precondition", "App billing owner is unavailable.");
  }
  const workspace = await store.getWorkspace(capsule.workspaceId);
  if (!workspace?.ownerUserId?.trim()) {
    throw new OpenTofuControllerError("failed_precondition", "App billing owner is unavailable.");
  }
  return { identity: { capsuleId: capsule.id, payerAccountId: workspace.ownerUserId }, ownershipEpoch: 0 };
}

export async function appBillingIdentity(
  store: Pick<OpenTofuControlStore, "getCapsule" | "getWorkspace" | "getAppBillingOwnership">,
  capsuleId: string | undefined,
): Promise<AppBillingIdentity> {
  return (await appBillingOwnership(store, capsuleId)).identity;
}
