/**
 * Template plan-JSON policy.
 *
 * After the runner returns `planResourceChanges` (projected from
 * `tofu show -json tfplan`), a template-backed PlanRun is checked against its
 * template policy:
 *   - every changed resource `type` must be in `policy.allowedResourceTypes`
 *     (§25 layer 5, delegated to `takosumi-policy`);
 *   - a delete/replace change marks the plan destructive (§25 action policy) —
 *     when the template's `destructiveChanges.requireExplicitConfirmation` is
 *     set, the plan run is flagged `requiresConfirmation` so apply must pass
 *     `confirmDestructive`.
 *
 * Thin adapter over the layered policy package; no controller/store state.
 * Non-template runs never call these (current behavior is unchanged).
 */

import type {
  PlanResourceChange,
  TemplatePolicySpec,
} from "takosumi-contract/deploy-control-api";
import {
  evaluateActionPolicy,
  evaluateResourceAllowlist,
} from "takosumi-policy";

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

export function evaluateTemplatePlanPolicy(input: {
  readonly policy: TemplatePolicySpec;
  readonly changes: readonly PlanResourceChange[];
}): TemplatePlanPolicyResult {
  const resource = evaluateResourceAllowlist(
    input.changes,
    input.policy.allowedResourceTypes,
  );
  const action = evaluateActionPolicy(input.changes);
  const requiresConfirmation = action.requiresApproval &&
    input.policy.destructiveChanges.requireExplicitConfirmation === true;
  // The reasons surface allowlist violations only; the per-type destructive
  // wording stays a controller/apply concern (the binding's requiresConfirmation
  // gate). Keep the historical message wording for the resource-type reasons.
  const reasons = resource.disallowedResourceTypes.map(
    (type) => `resource type ${type} is not allowed by the template policy`,
  );
  return {
    disallowedResourceTypes: resource.disallowedResourceTypes,
    hasDestructiveChange: action.requiresApproval,
    requiresConfirmation,
    reasons,
  };
}
