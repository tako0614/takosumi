// Rollout canary types — Deployment-centric port.
//
// Canary / progressive rollout strategy is canonically expressed via
// `Deployment.desired.activation_envelope.rollout_strategy`. This service
// drives a sequence of Deployments through the canonical lifecycle, one per
// canary step, and returns the resulting Deployment chain plus the GroupHead
// pointer that ends up in front.

import type { Deployment, GroupHead } from "takosumi-contract";
import type { PublicDeployManifest } from "../../domains/deploy/types.ts";

export type RolloutRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  /**
   * Phase 18.3 — terminal state reached when a canary step detected
   * abort-worthy drift (e.g. `security-drift`, `config-drift`) and the run
   * was halted before all steps applied. Distinct from `failed` so callers
   * can differentiate a provider apply error from a post-apply drift abort.
   */
  | "aborted";
export type RolloutStepStatus =
  | "pending"
  | "applied"
  | "failed"
  /**
   * Phase 18.3 — step applied successfully but a post-apply drift sample
   * exceeded the abort threshold. The step is recorded with its assigned
   * Deployment id so operators can audit which Deployment was reverted.
   */
  | "aborted";

export interface RolloutRunStepInput {
  readonly id: string;
  /**
   * Identifier of the canary build/release surfaced inside the per-step
   * Deployment manifest. Naming kept aligned with the manifest authoring
   * vocabulary (compute build refs).
   */
  readonly canaryAppReleaseId: string;
  /** HTTP traffic sent to the canary release for this step, in permille. */
  readonly canaryWeightPermille: number;
  readonly name?: string;
  /**
   * Phase 18.3 — runtime materializations the step's Deployment touches.
   * Used by the drift watcher to scope `ProviderObservation` lookups to the
   * step's own provider objects, so observations from earlier Deployments
   * cannot abort a fresh step.
   */
  readonly materializationIds?: readonly string[];
}

export interface RolloutRunInput {
  readonly spaceId: string;
  readonly groupId?: string;
  readonly manifest: PublicDeployManifest;
  readonly primaryAppReleaseId: string;
  readonly steps: readonly RolloutRunStepInput[];
  readonly runId?: string;
  readonly deploymentIdFactory?: (
    step: RolloutRunStepInput,
    index: number,
  ) => string;
  readonly createdAt?: string;
  readonly createdBy?: string;
  /**
   * Phase 18.3 — Deployment id the rollout should rewind to when an
   * `autoRollbackOnDrift` event fires. Typically the GroupHead before the
   * run started, surfacing the operator's intent: "if the canary drifts,
   * revert to this prior Deployment". When omitted the rollout service
   * uses the previous step's Deployment id (if any), and falls back to
   * skipping rollback when no prior Deployment exists.
   */
  readonly rollbackTargetDeploymentId?: string;
}

export interface RolloutStepResult {
  readonly id: string;
  readonly name?: string;
  readonly status: RolloutStepStatus;
  readonly canaryAppReleaseId: string;
  readonly canaryWeightPermille: number;
  readonly deploymentId?: string;
  readonly groupHead?: GroupHead;
  readonly appliedAt?: string;
  readonly error?: string;
  /**
   * Phase 18.3 — populated when the step transitioned to `aborted` because
   * the post-apply drift sample exceeded the abort threshold. Captures the
   * drift reason and (when available) the materialization id so operators
   * can correlate the abort with a specific provider object.
   */
  readonly driftAbort?: RolloutStepDriftAbort;
}

export interface RolloutStepDriftAbort {
  readonly reason: string;
  readonly materializationId?: string;
  readonly observedAt?: string;
  readonly observedDigest?: string;
  readonly providerId?: string;
  /**
   * `true` when the operator policy opted in to auto-rollback and the
   * rollback completed successfully; `false` when policy opted out or the
   * rollback hook was unavailable. Distinguishes the two halt modes:
   * "abort + leave head alone" vs "abort + revert head".
   */
  readonly autoRollbackTriggered: boolean;
  readonly rolledBackToDeploymentId?: string;
}

export interface RolloutRun {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly primaryAppReleaseId: string;
  readonly status: RolloutRunStatus;
  readonly steps: readonly RolloutStepResult[];
  readonly deployments: readonly Deployment[];
  readonly assignmentModel: HttpWeightedAssignmentModelDto;
  readonly sideEffectPolicyReport: SideEffectPolicyReport;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Phase 18.3 — populated when the run was halted by drift detection.
   * Mirrors the offending step's `driftAbort` for convenience so callers
   * inspecting the run-level summary do not need to scan steps[].
   */
  readonly driftAbort?: RolloutStepDriftAbort;
}

export interface HttpWeightedAssignmentModelDto {
  readonly kind: "http_weighted";
  readonly primaryAppReleaseId: string;
  readonly routes: readonly HttpWeightedRouteAssignmentDto[];
  /**
   * The canary model is HTTP-only. Non-HTTP delivery surfaces stay pinned to
   * the primary release until a future side-effect-aware rollout policy exists.
   */
  readonly nonHttpDefaults: NonHttpAssignmentDefaultsDto;
}

export interface HttpWeightedRouteAssignmentDto {
  readonly routeName: string;
  readonly protocol: "http" | "https";
  readonly assignments: readonly AppReleaseWeightDto[];
}

export interface AppReleaseWeightDto {
  readonly appReleaseId: string;
  readonly weightPermille: number;
}

export interface NonHttpAssignmentDefaultsDto {
  readonly events: NonHttpDefaultAssignmentDto;
  readonly publications: NonHttpDefaultAssignmentDto;
}

export interface NonHttpDefaultAssignmentDto {
  readonly defaultAppReleaseId: string;
  readonly reason: "http-only-canary";
}

export interface SideEffectPolicyReport {
  readonly status: "not_evaluated" | "passed" | "blocked";
  readonly summary: string;
  readonly checks: readonly SideEffectPolicyCheck[];
}

export interface SideEffectPolicyCheck {
  readonly id: string;
  readonly status: "pending" | "passed" | "blocked";
  readonly message: string;
  readonly enforcementPoint?: string;
}
