import type {
  CoreConditionReason,
  GroupSummaryStatus,
} from "takosumi-contract";
import type {
  DependencyLayerStatus,
  DesiredLayerStatus,
  GroupSummaryStatusProjection,
  GroupSummaryStatusProjectionInput,
  ProviderLayerProjection,
  SecurityLayerStatus,
  ServingLayerStatus,
  StatusLayerProjection,
} from "./types.ts";
import {
  condition,
  layer,
  projectConditions,
  validateProjectionConditionReasons,
  withCatalogReason,
} from "./_layer_helpers.ts";
import {
  escalateServingFromProviders,
  projectProviderLayer,
} from "./_provider_layer.ts";
import {
  checkProviderMaterializationConvergence,
  conditionFromProviderObservation,
} from "./_materialization_convergence.ts";

export interface GroupSummaryStatusProjector {
  project(
    input: GroupSummaryStatusProjectionInput,
  ): GroupSummaryStatusProjection;
}

export class DefaultGroupSummaryStatusProjector
  implements GroupSummaryStatusProjector {
  readonly #clock: () => Date;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  project(
    input: GroupSummaryStatusProjectionInput,
  ): GroupSummaryStatusProjection {
    const projectedAt = input.projectedAt ?? this.#clock().toISOString();
    const desired = projectDesiredLayer(input);
    const providers = projectProviderLayer(input);
    const serving = projectServingLayer(input, providers);
    const dependencies = projectDependencyLayer(input);
    const security = projectSecurityLayer(input);
    const status = summarizeGroupStatus({
      desired: desired.status,
      serving: serving.status,
      dependencies: dependencies.status,
      security: security.status,
      providers,
    });

    return validateProjectionConditionReasons(Object.freeze({
      spaceId: input.spaceId,
      groupId: input.groupId,
      activationId: input.activationPointer?.activationId,
      status,
      projectedAt,
      desired,
      serving,
      dependencies,
      security,
      providers: Object.freeze(providers),
      conditions: Object.freeze([
        ...desired.conditions,
        ...serving.conditions,
        ...dependencies.conditions,
        ...security.conditions,
        ...providers.flatMap((projection) => projection.conditions),
      ]),
    }));
  }
}

export function projectDesiredLayer(
  input: GroupSummaryStatusProjectionInput,
): StatusLayerProjection<DesiredLayerStatus> {
  if (input.deleted) {
    return layer("deleted", condition("DesiredDeleted", "true"));
  }
  if (input.suspended) {
    return layer("suspended", condition("DesiredSuspended", "true"));
  }
  if (!input.activationPointer) {
    return layer(
      "empty",
      condition(
        "ActivationCommitted",
        "false",
        "ActivationPrimaryMissing",
      ),
    );
  }

  switch (input.activation?.status) {
    case "pending":
      return layer(
        "planning",
        condition("ActivationCommitted", "false", "ServingMaterializing"),
      );
    case "running":
      return layer(
        "applying",
        condition("ActivationCommitted", "false", "ServingMaterializing"),
      );
    case "failed":
    case "cancelled":
      return layer(
        "failed",
        condition("ActivationCommitted", "false", "ActivationPreviewFailed"),
      );
    case "succeeded":
      return layer(
        "committed",
        condition("ActivationCommitted", "true", "ActivationCommitted"),
      );
    case undefined:
      return layer(
        "applying",
        condition(
          "ActivationCommitted",
          "false",
          "ServingConvergenceUnknown",
        ),
      );
  }
}

export function projectServingLayer(
  input: GroupSummaryStatusProjectionInput,
  providers: readonly ProviderLayerProjection[] = projectProviderLayer(input),
): StatusLayerProjection<ServingLayerStatus> {
  // Phase 18.2: when per-provider projections are populated, escalate the
  // serving layer based on the multi-cloud roll-up before falling through to
  // the single-cloud convergence path. A non-optional provider with `outage`
  // takes the whole serving layer to `outage`; otherwise critical-path
  // failures degrade and optional-only failures merely degrade.
  if (providers.length > 0) {
    const escalation = escalateServingFromProviders(providers);
    if (escalation) return escalation;
  }
  const activationId = input.activationPointer?.activationId;
  if (!activationId) {
    return layer(
      "empty",
      condition("ServingConverged", "false", "ActivationPrimaryMissing"),
    );
  }

  const materialization = input.runtimeMaterialization;
  if (!materialization || materialization.activationId !== activationId) {
    return layer(
      "converging",
      condition(
        "ServingConverged",
        "false",
        "ServingMaterializing",
      ),
    );
  }
  if (materialization.status === "failed") {
    return layer(
      "failed",
      condition(
        "ServingConverged",
        "false",
        "ProviderMaterializationFailed",
        materialization.message,
      ),
    );
  }
  if (materialization.status === "pending") {
    return layer(
      "converging",
      condition("ServingConverged", "false", "ServingMaterializing"),
    );
  }

  const providerMaterializations = materialization.providerMaterializations ??
    [];
  const providerObservations = [
    ...(materialization.providerObservations ?? []),
    ...(materialization.providerObservation
      ? [materialization.providerObservation]
      : []),
  ];
  const providerCheck = checkProviderMaterializationConvergence({
    activationId,
    desiredStateId: materialization.desiredStateId,
    materializationId: materialization.materializationId,
    providerMaterializations,
    providerObservations,
  });
  if (providerCheck) {
    return providerCheck;
  }

  const providerObservation = materialization.providerObservation;
  if (!providerObservation && providerMaterializations.length === 0) {
    return layer(
      "converging",
      condition("ServingConverged", "false", "ServingConvergenceUnknown"),
    );
  }
  if (
    providerObservation &&
    materialization.materializationId &&
    providerObservation.materializationId !== materialization.materializationId
  ) {
    return layer(
      "converging",
      condition("ServingConverged", "false", "ServingConvergenceUnknown"),
    );
  }
  if (providerObservation) {
    const providerCondition = conditionFromProviderObservation(
      providerObservation,
    );
    if (providerCondition) {
      return layer(
        providerObservation.observedState === "unknown"
          ? "unknown"
          : "degraded",
        providerCondition,
      );
    }
  }

  const observed = input.runtimeObserved;
  if (!observed || observed.activationId !== activationId) {
    return layer(
      "converging",
      condition("ServingConverged", "false", "RuntimeReadinessUnknown"),
    );
  }
  if (
    materialization.desiredStateId && observed.desiredStateId &&
    materialization.desiredStateId !== observed.desiredStateId
  ) {
    return layer(
      "converging",
      condition("ServingConverged", "false", "ProviderConfigDrift"),
    );
  }

  const diagnostics = observed.diagnostics ?? [];
  const degradedWorkload = observed.workloads.find((workload) =>
    workload.phase === "degraded" || workload.phase === "stopped" ||
    workload.phase === "unknown"
  );
  const degradedResource = observed.resources.find((resource) =>
    resource.phase === "degraded" || resource.phase === "deleted" ||
    resource.phase === "unknown"
  );
  const unreadyRoute = observed.routes.find((route) => !route.ready);

  if (
    degradedWorkload || degradedResource || unreadyRoute ||
    diagnostics.length > 0
  ) {
    return layer(
      "degraded",
      condition(
        "ServingConverged",
        "false",
        servingDegradedReason({
          degradedWorkload,
          degradedResource,
          unreadyRoute: Boolean(unreadyRoute),
          diagnostics,
        }),
        degradedWorkload?.message ?? degradedResource?.message ??
          unreadyRoute?.message ?? diagnostics[0],
      ),
    );
  }

  const pendingWorkload = observed.workloads.find((workload) =>
    workload.phase !== "running"
  );
  const pendingResource = observed.resources.find((resource) =>
    resource.phase !== "ready"
  );
  if (pendingWorkload || pendingResource) {
    return layer(
      "converging",
      condition(
        "ServingConverged",
        "false",
        "ServingMaterializing",
        pendingWorkload?.message ?? pendingResource?.message,
      ),
    );
  }

  return layer(
    "converged",
    condition("ServingConverged", "true", "ServingConverged"),
  );
}

export function projectDependencyLayer(
  input: GroupSummaryStatusProjectionInput,
): StatusLayerProjection<DependencyLayerStatus> {
  const conditions = [
    ...(input.resourceConditions ?? []),
    ...(input.outputConditions ?? []),
  ].map((condition) =>
    withCatalogReason(condition, "ResourceCompatibilityFailed")
  );
  return layer(
    projectConditions(conditions, "ready", "degraded", "failed"),
    ...conditions,
  );
}

export function projectSecurityLayer(
  input: GroupSummaryStatusProjectionInput,
): StatusLayerProjection<SecurityLayerStatus> {
  const conditions = (input.securityConditions ?? []).map((condition) =>
    withCatalogReason(condition, "PolicyDenied")
  );
  return layer(
    projectConditions(conditions, "trusted", "warning", "blocked"),
    ...conditions,
  );
}

export function summarizeGroupStatus(input: {
  readonly desired: DesiredLayerStatus;
  readonly serving: ServingLayerStatus;
  readonly dependencies: DependencyLayerStatus;
  readonly security: SecurityLayerStatus;
  readonly providers?: readonly ProviderLayerProjection[];
}): GroupSummaryStatus {
  if (input.desired === "deleted") return "deleted";
  if (input.desired === "suspended") return "suspended";
  if (input.desired === "empty") return "empty";
  if (input.desired === "planning") return "planning";
  if (input.desired === "applying") return "applying";
  if (input.desired === "failed") return "failed";

  // Revoked trust blocks new plan/apply boundaries, but an already committed
  // activation is degraded rather than marked failed by projection alone.
  if (input.serving === "failed" || input.dependencies === "failed") {
    return "failed";
  }
  // Phase 18.2 SLA-aware roll-up: per-provider outage on a critical-path
  // (non-optional) provider escalates to `outage`; recovering rolls up to
  // `recovering`; otherwise we fall through to the single-cloud rules.
  if (input.serving === "outage") return "outage";
  if (input.serving === "recovering") return "recovering";
  if (
    input.serving === "converged" && input.dependencies === "ready" &&
    input.security === "trusted"
  ) {
    return "active";
  }
  if (input.serving === "converging") return "applying";
  return "degraded";
}

function servingDegradedReason(input: {
  readonly degradedWorkload: unknown;
  readonly degradedResource: unknown;
  readonly unreadyRoute: boolean;
  readonly diagnostics: readonly string[];
}): CoreConditionReason {
  if (input.degradedWorkload) return "RuntimeNotReady";
  if (input.degradedResource) return "ResourceCompatibilityFailed";
  if (input.unreadyRoute) return "OutputRouteUnavailable";
  return input.diagnostics.length > 0
    ? "RuntimeReadinessUnknown"
    : "ServingDegraded";
}
