// Condition builders, approval validation, and preflight helpers shared by
// the resolve / apply / rollback phases of `DeploymentService`.
//
// Extracted from `deployment_service.ts` so the orchestrator file stays
// focused on the public surface. Every function here is pure (no I/O, no
// store access); the apply / rollback phases compose them with the
// `DeploymentStore` and provider adapter at call sites.

import type {
  Deployment,
  DeploymentApproval,
  DeploymentCondition,
  DeploymentPolicyDecision,
  IsoTimestamp,
} from "takosumi-contract";
import { applyingPhaseCondition } from "../apply_orchestrator.ts";
import type { ApplyPreflightValidator } from "../deployment_service.ts";
import type { DeployBlocker } from "../types.ts";

export function blockersToConditions(
  blockers: readonly DeployBlocker[],
  observedAt: IsoTimestamp,
): readonly DeploymentCondition[] {
  return blockers.map((blocker, index) => ({
    type: blocker.code,
    status: "false" as const,
    reason: blocker.code,
    message: blocker.message,
    observed_generation: index + 1,
    last_transition_time: blocker.observedAt ?? observedAt,
    scope: { kind: "deployment" as const },
  }));
}

export function accessPathDeniedCondition(
  observedAt: IsoTimestamp,
  generation: number,
  decisions: readonly DeploymentPolicyDecision[],
): DeploymentCondition {
  const denied = decisions.filter((decision) => decision.decision === "deny");
  const subjects = denied
    .map((decision) => decision.subjectAddress ?? decision.id)
    .join(", ");
  const externalOnly = denied.every((decision) =>
    decision.ruleRef === "runtime-network-policy:external-boundary-not-allowed"
  );
  return {
    type: "Resolution",
    status: "false",
    reason: externalOnly
      ? "AccessPathExternalBoundaryRequiresPolicy"
      : "PolicyDenied",
    message: subjects
      ? `Resolution denied by policy: ${subjects}`
      : "Resolution denied by policy.",
    observed_generation: generation,
    last_transition_time: observedAt,
    scope: { kind: "deployment" },
  };
}

/**
 * H4 — Build the terminal condition emitted when an apply is rejected because
 * at least one `policy_decisions[].decision === "require-approval"` was not
 * satisfied by an attached `DeploymentApproval`. The reason matches the
 * canonical `ApprovalRequired` reason from the Core condition reason catalog.
 */
export function approvalRequiredCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
  readonly decisions: readonly DeploymentPolicyDecision[];
}): DeploymentCondition {
  const requiring = input.decisions.filter(
    (decision) => decision.decision === "require-approval",
  );
  const subjects = requiring
    .map((decision) => decision.subjectAddress ?? decision.id)
    .join(", ");
  return {
    type: "ApprovalRequired",
    status: "true",
    reason: "ApprovalRequired",
    message: subjects
      ? `apply blocked: policy decisions require approval (${subjects})`
      : "apply blocked: policy decisions require approval",
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

export function validateDeploymentApproval(
  deployment: Deployment,
  approval: DeploymentApproval,
  now: IsoTimestamp,
): void {
  if (!approval.approved_by.trim()) {
    throw new Error("deployment approval approved_by is required");
  }
  if (!Number.isFinite(Date.parse(approval.approved_at))) {
    throw new Error(
      "deployment approval approved_at must be a valid ISO timestamp",
    );
  }
  if (approval.expires_at) {
    const expiresAt = Date.parse(approval.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new Error(
        "deployment approval expires_at must be a valid ISO timestamp",
      );
    }
    if (expiresAt <= Date.parse(now)) {
      throw new Error("deployment approval has expired");
    }
  }
  const decision = (deployment.policy_decisions ?? []).find((candidate) =>
    candidate.id === approval.policy_decision_id
  );
  if (!decision) {
    throw new Error(
      `deployment approval references unknown policy decision: ${approval.policy_decision_id}`,
    );
  }
  if (decision.decision !== "require-approval") {
    throw new Error(
      `deployment approval references non-approval policy decision: ${approval.policy_decision_id}`,
    );
  }
}

export function isMissingOptionalStoreMethod(
  error: unknown,
  method: string,
): boolean {
  return error instanceof Error &&
    error.message === `storage store method not found: ${method}`;
}

/**
 * Run an apply / rollback preflight validator. Returns silently if the
 * validator is undefined or returns `ok=true`. Throws an Error keyed by the
 * supplied default reason when the validator reports a problem so the caller
 * sees a stale-precondition style failure message.
 */
export async function runPreflightValidator(
  defaultReason: string,
  validator: ApplyPreflightValidator | undefined,
  deployment: Deployment,
): Promise<void> {
  if (!validator) return;
  const finding = await validator(deployment);
  if (finding.ok) return;
  const reason = finding.reason ?? defaultReason;
  const message = finding.message ?? reason;
  throw new Error(`${reason}: ${message}`);
}

export function applyingTransition(
  current: Deployment,
  observedAt: IsoTimestamp,
): Deployment {
  return {
    ...current,
    status: "applying",
    conditions: appendCondition(
      current.conditions,
      applyingPhaseCondition({
        observedGeneration: current.conditions.length + 1,
        observedAt,
      }),
    ),
  };
}

export function appendCondition(
  conditions: readonly DeploymentCondition[],
  condition: DeploymentCondition,
): readonly DeploymentCondition[] {
  return [...conditions, condition];
}
