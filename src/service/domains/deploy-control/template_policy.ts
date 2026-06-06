/**
 * Template plan-JSON policy.
 *
 * After the runner returns `planResourceChanges` (projected from
 * `tofu show -json tfplan`), a template-backed PlanRun is checked against its
 * template policy:
 *   - every changed resource `type` must be in `policy.allowedResourceTypes`;
 *   - a delete/replace change marks the plan destructive — when the template's
 *     `destructiveChanges.requireExplicitConfirmation` is set, the plan run is
 *     flagged `requiresConfirmation` so apply must pass `confirmDestructive`.
 *
 * Pure functions over contract types; no controller/store state. Non-template
 * runs never call these (current behavior is unchanged).
 */

import type {
  PlanResourceChange,
  TemplatePolicySpec,
} from "takosumi-contract/deploy-control-api";

export interface TemplatePlanPolicyResult {
  /** Resource types observed in the plan that are NOT in the allowlist. */
  readonly disallowedResourceTypes: readonly string[];
  /** True when any change is a delete or a replace (delete+create). */
  readonly hasDestructiveChange: boolean;
  /** True when a destructive change requires explicit apply-time confirmation. */
  readonly requiresConfirmation: boolean;
  /** Reasons describing allowlist violations (never includes secret values). */
  readonly reasons: readonly string[];
}

const NON_MUTATING_ACTIONS = new Set(["no-op", "read"]);

export function evaluateTemplatePlanPolicy(input: {
  readonly policy: TemplatePolicySpec;
  readonly changes: readonly PlanResourceChange[];
}): TemplatePlanPolicyResult {
  const allowed = new Set(input.policy.allowedResourceTypes);
  const disallowed = new Set<string>();
  let destructive = false;
  for (const change of input.changes) {
    const actions = change.actions ?? [];
    // A change that only no-ops/reads neither mutates nor needs allowlisting.
    const mutating = actions.some((action) => !NON_MUTATING_ACTIONS.has(action));
    if (mutating && !allowed.has(change.type)) {
      disallowed.add(change.type);
    }
    if (isDestructive(actions)) destructive = true;
  }
  const reasons: string[] = [];
  for (const type of disallowed) {
    reasons.push(`resource type ${type} is not allowed by the template policy`);
  }
  const requiresConfirmation = destructive &&
    input.policy.destructiveChanges.requireExplicitConfirmation === true;
  return {
    disallowedResourceTypes: Array.from(disallowed).sort(),
    hasDestructiveChange: destructive,
    requiresConfirmation,
    reasons,
  };
}

/**
 * A plan change is destructive when it deletes a resource — either a pure
 * `["delete"]` or a replace, which OpenTofu encodes as `["delete","create"]`
 * (or `["create","delete"]` for create-before-destroy). A pure create/update is
 * not destructive.
 */
function isDestructive(actions: readonly string[]): boolean {
  return actions.includes("delete");
}
