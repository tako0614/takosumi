/**
 * Capsule current-resource inventory projection.
 *
 * The module follows one exact, already-applied lineage:
 * Capsule.currentStateVersionId -> StateVersion.createdByRunId (ApplyRun) ->
 * ApplyRun.planRunId (PlanRun) -> PlanRun.planResourceChanges. It intentionally
 * has no provider adapter and never reads Resource Shape rows or plan values.
 */

import type {
  ApplyRun,
  PlanResourceChange,
  PlanRun,
} from "@takosumi/internal/deploy-control-api";
import type { Capsule } from "takosumi-contract/capsules";
import {
  CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND,
  type CapsuleCurrentResourceInventory,
  type CapsuleCurrentResourceInventoryResource,
  type CapsuleCurrentResourceInventoryResponse,
} from "takosumi-contract/current-resource-inventory";
import type { StateVersion } from "takosumi-contract/state-versions";
import { OpenTofuControllerError, requireNonEmptyString } from "./errors.ts";
import type { OpenTofuControlStore } from "./store.ts";

/** Deterministic response bound for one current Capsule inventory. */
export const MAX_CURRENT_RESOURCE_INVENTORY_ITEMS = 1_000;

export const CURRENT_RESOURCE_INVENTORY_LINEAGE_MISMATCH_REASON =
  "current_resource_inventory_lineage_mismatch" as const;
export const CURRENT_RESOURCE_INVENTORY_UNKNOWN_ACTION_REASON =
  "current_resource_inventory_unknown_action" as const;
export const CURRENT_RESOURCE_INVENTORY_OVERFLOW_REASON =
  "current_resource_inventory_overflow" as const;

const KNOWN_ACTIONS = new Set([
  "no-op",
  "read",
  "create",
  "update",
  "delete",
]);

/** Read the complete current inventory for one Capsule. */
export async function getCurrentResourceInventory(
  store: OpenTofuControlStore,
  capsuleId: string,
): Promise<CapsuleCurrentResourceInventoryResponse> {
  requireNonEmptyString(capsuleId, "capsuleId");
  const capsule = await store.getCapsule(capsuleId);
  if (!capsule) {
    throw new OpenTofuControllerError(
      "not_found",
      `capsule ${capsuleId} not found`,
    );
  }

  const workspace = await store.getWorkspace(capsule.workspaceId);
  if (!workspace || workspace.id !== capsule.workspaceId) {
    throw lineageMismatch("Capsule Workspace identity is not available");
  }

  const stateVersionId = capsule.currentStateVersionId;
  if (!stateVersionId || capsule.currentStateGeneration < 1) {
    throw lineageMismatch("Capsule has no current StateVersion lineage");
  }
  const stateVersion = await store.getStateVersion(stateVersionId);
  if (!stateVersion) {
    throw lineageMismatch("Capsule current StateVersion is not available");
  }
  assertStateVersionLineage(capsule, stateVersion);

  const applyRun = await store.getApplyRun(stateVersion.createdByRunId);
  if (!applyRun) {
    throw lineageMismatch("StateVersion creating ApplyRun is not available");
  }
  assertApplyRunLineage(capsule, stateVersion, applyRun);

  const planRun = await store.getPlanRun(applyRun.planRunId);
  if (!planRun) {
    throw lineageMismatch("ApplyRun reviewed PlanRun is not available");
  }
  assertPlanRunLineage(capsule, applyRun, planRun);

  const base = {
    kind: CAPSULE_CURRENT_RESOURCE_INVENTORY_KIND,
    capsuleId: capsule.id,
    workspaceId: capsule.workspaceId,
    environment: capsule.environment,
    stateVersionId: stateVersion.id,
    generation: stateVersion.generation,
    applyRunId: applyRun.id,
    planRunId: planRun.id,
    recordedAt: stateVersion.createdAt,
  } as const;

  // Older PlanRuns did not persist the value-free change projection. This is
  // distinct from a recorded empty array: callers must not infer emptiness.
  if (planRun.planResourceChanges === undefined) {
    return {
      inventory: { ...base, availability: "legacy_unavailable" },
    };
  }
  if (!Array.isArray(planRun.planResourceChanges)) {
    throw lineageMismatch("PlanRun resource inventory projection is malformed");
  }

  const resources = projectResources(planRun.planResourceChanges);
  return {
    inventory: { ...base, availability: "recorded", resources },
  };
}

function assertStateVersionLineage(
  capsule: Capsule,
  stateVersion: StateVersion,
): void {
  if (
    stateVersion.id !== capsule.currentStateVersionId ||
    stateVersion.workspaceId !== capsule.workspaceId ||
    stateVersion.capsuleId !== capsule.id ||
    stateVersion.environment !== capsule.environment ||
    stateVersion.generation !== capsule.currentStateGeneration
  ) {
    throw lineageMismatch("StateVersion does not match the current Capsule");
  }
}

function assertApplyRunLineage(
  capsule: Capsule,
  stateVersion: StateVersion,
  applyRun: ApplyRun,
): void {
  const expected = applyRun.expected;
  if (
    !expected ||
    typeof expected !== "object" ||
    applyRun.id !== stateVersion.createdByRunId ||
    applyRun.status !== "succeeded" ||
    applyRun.workspaceId !== capsule.workspaceId ||
    applyRun.capsuleId !== capsule.id ||
    applyRun.stateVersionId !== stateVersion.id ||
    expected.capsuleId !== capsule.id ||
    expected.planRunId !== applyRun.planRunId
  ) {
    throw lineageMismatch("ApplyRun does not match the current Capsule state");
  }
}

function assertPlanRunLineage(
  capsule: Capsule,
  applyRun: ApplyRun,
  planRun: PlanRun,
): void {
  const context = planRun.capsuleContext;
  if (
    planRun.id !== applyRun.planRunId ||
    planRun.status !== "succeeded" ||
    planRun.appliedApplyRunId !== applyRun.id ||
    planRun.workspaceId !== capsule.workspaceId ||
    planRun.capsuleId !== capsule.id ||
    planRun.operation !== applyRun.operation ||
    !context ||
    context.workspaceId !== capsule.workspaceId ||
    context.capsuleId !== capsule.id ||
    context.environment !== capsule.environment ||
    applyRun.expected.currentStateVersionId === undefined ||
    planRun.capsuleCurrentStateVersionId === undefined ||
    applyRun.expected.currentStateVersionId !==
      planRun.capsuleCurrentStateVersionId
  ) {
    throw lineageMismatch("PlanRun does not match the applied Capsule state");
  }
}

function projectResources(
  changes: readonly PlanResourceChange[],
): readonly CapsuleCurrentResourceInventoryResource[] {
  const resources: CapsuleCurrentResourceInventoryResource[] = [];
  for (const change of changes) {
    const projected = projectResourceChange(change);
    if (projected) resources.push(projected);
  }
  resources.sort((left, right) => {
    const address = compareStableStrings(left.address, right.address);
    if (address !== 0) return address;
    const type = compareStableStrings(left.type, right.type);
    if (type !== 0) return type;
    return compareStableStrings(
      left.providerSource ?? "",
      right.providerSource ?? "",
    );
  });
  if (resources.length > MAX_CURRENT_RESOURCE_INVENTORY_ITEMS) {
    throw new OpenTofuControllerError(
      "resource_exhausted",
      `current Capsule resource inventory exceeds ${MAX_CURRENT_RESOURCE_INVENTORY_ITEMS} items`,
      { reason: CURRENT_RESOURCE_INVENTORY_OVERFLOW_REASON },
    );
  }
  return resources;
}

function projectResourceChange(
  change: PlanResourceChange,
): CapsuleCurrentResourceInventoryResource | undefined {
  if (
    !change ||
    typeof change.address !== "string" ||
    change.address.trim() === "" ||
    typeof change.type !== "string" ||
    change.type.trim() === "" ||
    !Array.isArray(change.actions) ||
    change.actions.length === 0 ||
    change.actions.some(
      (action) => typeof action !== "string" || !KNOWN_ACTIONS.has(action),
    )
  ) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "current Capsule resource inventory contains an unknown OpenTofu action",
      { reason: CURRENT_RESOURCE_INVENTORY_UNKNOWN_ACTION_REASON },
    );
  }
  if (
    change.providerSource !== undefined &&
    (typeof change.providerSource !== "string" ||
      change.providerSource.trim() === "")
  ) {
    throw lineageMismatch("Current resource provider source is malformed");
  }

  const address = change.address.trim();
  const type = change.type.trim();
  // Data sources are read dependencies, not deployed survivors. OpenTofu
  // normally keeps them out of resource_changes; this guard protects against
  // malformed or legacy rows that used a data-prefixed address/type.
  if (/(?:^|\.)data\./u.test(address) || type.startsWith("data.")) {
    return undefined;
  }
  const actions = change.actions;
  const pureDelete = actions.length === 1 && actions[0] === "delete";
  const pureRead = actions.length === 1 && actions[0] === "read";
  if (pureDelete || pureRead) return undefined;
  const replacement =
    actions.length === 2 &&
    ((actions[0] === "delete" && actions[1] === "create") ||
      (actions[0] === "create" && actions[1] === "delete"));
  const survivor =
    (actions.length === 1 &&
      (actions[0] === "no-op" ||
        actions[0] === "create" ||
        actions[0] === "update")) ||
    replacement;
  if (!survivor) {
    throw new OpenTofuControllerError(
      "failed_precondition",
      "current Capsule resource inventory contains an unsupported OpenTofu action set",
      { reason: CURRENT_RESOURCE_INVENTORY_UNKNOWN_ACTION_REASON },
    );
  }
  return {
    address,
    type,
    ...(change.providerSource
      ? { providerSource: change.providerSource.trim() }
      : {}),
  };
}

function compareStableStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function lineageMismatch(message: string): OpenTofuControllerError {
  return new OpenTofuControllerError(
    "failed_precondition",
    message,
    { reason: CURRENT_RESOURCE_INVENTORY_LINEAGE_MISMATCH_REASON },
  );
}
