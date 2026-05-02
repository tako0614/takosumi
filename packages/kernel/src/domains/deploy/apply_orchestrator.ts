// Apply orchestration — Phase 10D.
//
// This module sequences provider operations for a resolved Deployment using
// the projection records pinned in `Deployment.resolution.resolved_graph`.
// It is intentionally decoupled from any specific provider plugin: the
// orchestrator emits an ordered, deterministic list of `PlannedOperation`
// records which a `DeploymentProviderAdapter` materializes one by one.
//
// Per Core contract spec § 13:
//   - apply executes operations against `Deployment.desired` with idempotent
//     keys. The default key is
//     `operationKind + objectAddress + desiredDigest`.
//   - operation kinds are stable strings such as `descriptor.resolve`,
//     `component.project`, `resource.bind`, `runtime.deploy`, `router.prepare`,
//     `publication.resolve`, `access-path.materialize`, `activation.commit`,
//     `provider.materialize`.
//   - operation-level state lives in `Deployment.conditions[]` with
//     `scope.kind="operation"`.
//
// The orchestrator deliberately covers only the plan/sequence step. The
// per-operation execution result is folded back into the Deployment by
// `DeploymentService.applyDeployment` (which owns the persistence side).

import type {
  CoreProjectionRecord,
  Deployment,
  DeploymentCondition,
  DeploymentConditionStatus,
  DeploymentResolvedGraph,
  IsoTimestamp,
  ObjectAddress,
} from "takosumi-contract";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Stable operation-kind strings used by the orchestrator. Matches Core spec
 *  § 13's enumerated kinds; new kinds MUST be added in a backwards-compatible
 *  way and SHOULD also be reflected in the operation-key derivation. */
export type PlannedOperationKind =
  | "descriptor.resolve"
  | "component.project"
  | "resource.bind"
  | "runtime.deploy"
  | "router.prepare"
  | "publication.resolve"
  | "access-path.materialize"
  | "activation.commit";

/** A single provider operation in the apply plan. Carries the canonical
 *  idempotency key plus enough context for adapters to dispatch. */
export interface PlannedOperation {
  /** Stable idempotency key (`kind + objectAddress + desiredDigest`). */
  readonly key: string;
  readonly kind: PlannedOperationKind;
  readonly objectAddress: ObjectAddress;
  /** Digest of the desired-side fragment this operation targets. */
  readonly desiredDigest: string;
  /** Source projection (when derived from `resolved_graph.projections`). */
  readonly projectionType?: CoreProjectionRecord["projectionType"];
  /** Optional descriptor-resolution id for diagnostics. */
  readonly descriptorResolutionId?: string;
}

/** Outcome of materializing a single planned operation. */
export interface OperationOutcome {
  readonly success: boolean;
  /** Short reason code, surfaced verbatim into `DeploymentCondition.reason`. */
  readonly reason: string;
  readonly message?: string;
}

/** Adapter that materializes a single planned operation. Implementations
 *  delegate to provider plugins (e.g. cloudflare / aws / k8s). The orchestrator
 *  is unaware of the underlying provider — it only consumes the success/fail
 *  signal and records a condition per operation.
 *
 *  C1 — `rollback` is invoked by the apply orchestrator on multi-cloud /
 *  multi-operation partial-success failure: every operation that previously
 *  reported `success=true` is reverted in reverse order before the Deployment
 *  is finalised as `failed`. Adapters that cannot meaningfully revert an
 *  operation (e.g. a synthetic / no-op adapter) MAY return `success=true` so
 *  the caller treats the rollback as a logical no-op. Adapters that cannot
 *  safely reverse a committed operation MUST return `success=false`; the
 *  caller surfaces this as a `RolledBackPartial` condition so operators can
 *  intervene.
 */
export interface DeploymentProviderAdapter {
  materialize(
    deployment: Deployment,
    operation: PlannedOperation,
  ): Promise<OperationOutcome> | OperationOutcome;
  /**
   * Revert a previously committed operation. Optional — when omitted the
   * orchestrator treats the operation as logically irreversible and emits a
   * single `RolledBackPartial` condition. Adapters SHOULD implement this for
   * operation kinds that can be safely undone (e.g. delete a created
   * resource binding, restore a previous router config).
   */
  rollback?(
    deployment: Deployment,
    operation: PlannedOperation,
  ): Promise<OperationOutcome> | OperationOutcome;
}

// ---------------------------------------------------------------------------
// Plan derivation
// ---------------------------------------------------------------------------

/** Plan provider operations from a resolved Deployment. The output is
 *  deterministic: identical Deployments yield byte-identical operation lists.
 *
 *  Operation ordering follows Core spec § 13's apply pipeline:
 *    1. descriptor.resolve     — re-affirm closure entries
 *    2. component.project      — project component contracts onto runtime
 *    3. resource.bind          — declare resources before bindings
 *    4. access-path.materialize— materialise resource access paths
 *    5. publication.resolve    — resolve publication declarations
 *    6. runtime.deploy         — deploy component runtimes
 *    7. router.prepare         — prepare exposure routers
 *    8. activation.commit      — final commit (single op per deployment)
 *
 *  `activation.commit` is appended unconditionally so apply always has a
 *  terminal operation that records the activation envelope on conditions[]. */
export function planProviderOperations(
  deployment: Deployment,
): readonly PlannedOperation[] {
  const graph = deployment.resolution.resolved_graph;
  const buckets: Record<PlannedOperationKind, PlannedOperation[]> = {
    "descriptor.resolve": [],
    "component.project": [],
    "resource.bind": [],
    "access-path.materialize": [],
    "publication.resolve": [],
    "runtime.deploy": [],
    "router.prepare": [],
    "activation.commit": [],
  };

  for (const projection of graph.projections) {
    const kind = projectionToOperationKind(projection.projectionType);
    if (!kind) continue;
    buckets[kind].push({
      key: operationKey(
        kind,
        projection.objectAddress,
        projection.digest,
      ),
      kind,
      objectAddress: projection.objectAddress,
      desiredDigest: projection.digest,
      projectionType: projection.projectionType,
      descriptorResolutionId: projection.descriptorResolutionId,
    });
  }

  // Activation commit op — single-use, derived from the activation envelope
  // digest so re-applies share the same key.
  buckets["activation.commit"].push({
    key: operationKey(
      "activation.commit",
      deployment.desired.activation_envelope.primary_assignment
        .componentAddress,
      deployment.desired.activation_envelope.envelopeDigest,
    ),
    kind: "activation.commit",
    objectAddress: deployment.desired.activation_envelope.primary_assignment
      .componentAddress,
    desiredDigest: deployment.desired.activation_envelope.envelopeDigest,
  });

  // Deterministic ordering: sort each bucket by objectAddress so manifest
  // re-ordering does not alter the operation sequence.
  for (const list of Object.values(buckets)) {
    list.sort((a, b) => a.objectAddress.localeCompare(b.objectAddress));
  }

  // Concat in canonical kind order.
  const ORDER: readonly PlannedOperationKind[] = [
    "descriptor.resolve",
    "component.project",
    "resource.bind",
    "access-path.materialize",
    "publication.resolve",
    "runtime.deploy",
    "router.prepare",
    "activation.commit",
  ];
  return ORDER.flatMap((kind) => buckets[kind]);
}

function projectionToOperationKind(
  projectionType: CoreProjectionRecord["projectionType"],
): PlannedOperationKind | undefined {
  switch (projectionType) {
    case "runtime-claim":
      return "runtime.deploy";
    case "resource-claim":
      return "resource.bind";
    case "exposure-target":
      return "router.prepare";
    case "publication-declaration":
      return "publication.resolve";
    case "binding-request":
      return "component.project";
    case "access-path-request":
      return "access-path.materialize";
    default:
      return undefined;
  }
}

/** Canonical idempotency key per Core spec § 13. Lifted to a free function
 *  so worker / repair / smoke tests can derive the same key without a
 *  service instance. */
export function operationKey(
  kind: PlannedOperationKind,
  objectAddress: ObjectAddress,
  desiredDigest: string,
): string {
  return `${kind}|${objectAddress}|${desiredDigest}`;
}

// ---------------------------------------------------------------------------
// Condition emission
// ---------------------------------------------------------------------------

/** Build a per-operation `DeploymentCondition`. The orchestrator does not
 *  persist conditions itself; the caller (DeploymentService) is responsible
 *  for appending these to `Deployment.conditions[]`. */
export function operationCondition(input: {
  readonly operation: PlannedOperation;
  readonly outcome: OperationOutcome;
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
}): DeploymentCondition {
  const status: DeploymentConditionStatus = input.outcome.success
    ? "true"
    : "false";
  return {
    type: conditionTypeFor(input.operation.kind, input.outcome.success),
    status,
    reason: input.outcome.reason,
    message: input.outcome.message,
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "operation", ref: input.operation.objectAddress },
  };
}

/** Build the `Applying` phase boundary condition. */
export function applyingPhaseCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
}): DeploymentCondition {
  return {
    type: "Applying",
    status: "true",
    reason: "ApplyPhaseStarted",
    message: "Provider operations begun.",
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "phase", ref: "apply" },
  };
}

/** Build the terminal `ActivationCommitted` condition. Appended after the
 *  final activation.commit operation succeeds. */
export function activationCommittedCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
}): DeploymentCondition {
  return {
    type: "ActivationCommitted",
    status: "true",
    reason: "DeploymentApplied",
    message: "GroupHead advanced to this Deployment.",
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

/** Build the terminal `ApplyFailed` condition emitted when at least one
 *  required operation reports `success=false`. */
export function applyFailedCondition(input: {
  readonly operation: PlannedOperation;
  readonly outcome: OperationOutcome;
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
}): DeploymentCondition {
  return {
    type: "ApplyFailed",
    status: "true",
    reason: input.outcome.reason || "ProviderMaterializationFailed",
    message: input.outcome.message ??
      `provider materialization failed for ${input.operation.objectAddress}`,
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

/** Build the rolled-back terminal condition appended to the previously
 *  current Deployment when GroupHead is reverted. */
export function rolledBackCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
  readonly reason?: string;
}): DeploymentCondition {
  return {
    type: "RolledBack",
    status: "true",
    reason: input.reason ?? "GroupHeadReverted",
    message:
      "GroupHead pointer reverted; this Deployment is no longer current.",
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

/**
 * C1 — Per-operation revert condition, appended to `Deployment.conditions[]`
 * after the orchestrator successfully reverts a previously committed
 * operation as part of multi-cloud partial-success cleanup.
 */
export function operationRolledBackCondition(input: {
  readonly operation: PlannedOperation;
  readonly outcome: OperationOutcome;
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
}): DeploymentCondition {
  const status: DeploymentConditionStatus = input.outcome.success
    ? "true"
    : "false";
  return {
    type: input.outcome.success
      ? "OperationRolledBack"
      : "OperationRollbackFailed",
    status,
    reason: input.outcome.reason || "OperationReverted",
    message: input.outcome.message ??
      `provider operation ${input.operation.kind} on ${input.operation.objectAddress} reverted`,
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "operation", ref: input.operation.objectAddress },
  };
}

/**
 * C1 — Terminal `RolledBack` condition emitted when an apply failure triggers
 * a multi-operation revert. `partial=true` indicates at least one committed
 * operation could NOT be reverted (adapter declined / errored).
 */
export function applyRolledBackCondition(input: {
  readonly observedGeneration: number;
  readonly observedAt: IsoTimestamp;
  readonly partial: boolean;
  readonly revertedCount: number;
  readonly failedRevertCount: number;
}): DeploymentCondition {
  const reason = input.partial ? "RolledBackPartial" : "RolledBack";
  const message = input.partial
    ? `apply failure rolled back ${input.revertedCount} operation(s); ${input.failedRevertCount} could not be reverted`
    : `apply failure rolled back ${input.revertedCount} committed operation(s)`;
  return {
    type: "RolledBack",
    status: "true",
    reason,
    message,
    observed_generation: input.observedGeneration,
    last_transition_time: input.observedAt,
    scope: { kind: "deployment" },
  };
}

function conditionTypeFor(
  kind: PlannedOperationKind,
  success: boolean,
): string {
  // `Materializing` for in-flight, `Materialized` for success, `Failed`
  // suffix for failure. Per spec § 13 the type strings are stable so
  // dashboards / observability can pivot on them.
  if (!success) return `${pascalCaseKind(kind)}Failed`;
  return `${pascalCaseKind(kind)}Materialized`;
}

function pascalCaseKind(kind: PlannedOperationKind): string {
  return kind.split(/[.\-]/).map((segment) =>
    segment.charAt(0).toUpperCase() + segment.slice(1)
  ).join("");
}

// ---------------------------------------------------------------------------
// Default no-op adapter (used when no provider is wired)
// ---------------------------------------------------------------------------

/** Default adapter — succeeds for every operation. Used when no provider
 *  plugin is wired (unit tests, in-memory bootstrap). Provides the synthetic
 *  apply path so a Deployment can transition resolved → applied without a
 *  real cloud round-trip. */
export const SYNTHETIC_PROVIDER_ADAPTER: DeploymentProviderAdapter = {
  materialize(_deployment, _operation): OperationOutcome {
    return {
      success: true,
      reason: "Synthetic",
      message: "no provider adapter wired; operation marked as succeeded",
    };
  },
  rollback(_deployment, _operation): OperationOutcome {
    return {
      success: true,
      reason: "Synthetic",
      message: "no provider adapter wired; rollback treated as no-op",
    };
  },
};

/** Compute the desired-side projection digest covered by the resolved graph.
 *  Exposed as a helper for tests / dashboards that re-derive the apply read
 *  set without re-running `planProviderOperations`. */
export function resolvedGraphCoveredDigest(
  graph: DeploymentResolvedGraph,
): string {
  return graph.digest;
}
