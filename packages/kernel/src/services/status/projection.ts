import type {
  CoreConditionReason,
  GroupSummaryStatus,
} from "takosumi-contract";
import { isCoreConditionReason } from "takosumi-contract";
import type { ProviderMaterializationReference } from "../../adapters/provider/mod.ts";
import type { ProviderObservation as RuntimeProviderObservation } from "../../domains/runtime/mod.ts";
import type {
  DependencyLayerStatus,
  DesiredLayerStatus,
  GroupSummaryStatusProjection,
  GroupSummaryStatusProjectionInput,
  ProviderLayerProjection,
  ProviderLayerStatus,
  SecurityLayerStatus,
  ServingLayerStatus,
  StatusConditionDto,
  StatusLayerProjection,
} from "./types.ts";

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

/**
 * Phase 18.2: project a per-provider status map from runtime materialization
 * provider observations. For every provider id in the materialisation graph
 * we compute an independent `ProviderLayerStatus`, then walk the dependency
 * DAG (provider -> upstream provider ids) so dependents of a failed provider
 * are marked `degraded`. Optional providers (e.g. CDN in
 * `composite.web-app-with-cdn@v1`) never escalate the cross-provider rollup
 * to `outage`; they only ever degrade.
 */
export function projectProviderLayer(
  input: GroupSummaryStatusProjectionInput,
): readonly ProviderLayerProjection[] {
  const materialization = input.runtimeMaterialization;
  if (!materialization) return [];
  const providerObservations = [
    ...(materialization.providerObservations ?? []),
    ...(materialization.providerObservation
      ? [materialization.providerObservation]
      : []),
  ];
  const providerMaterializations = materialization.providerMaterializations ??
    [];

  const providerInfo = new Map<string, {
    optional: boolean;
    dependsOn: Set<string>;
  }>();
  for (const reference of providerMaterializations) {
    const providerId = reference.providerId;
    if (!providerId) continue;
    const entry = providerInfo.get(providerId) ??
      { optional: true, dependsOn: new Set<string>() };
    // A provider is optional only when *every* materialisation for it is
    // optional. Any required materialisation makes the provider critical.
    if (!reference.optional) entry.optional = false;
    for (const upstream of reference.dependsOnProviderIds ?? []) {
      if (upstream !== providerId) entry.dependsOn.add(upstream);
    }
    providerInfo.set(providerId, entry);
  }

  const observationsByProvider = new Map<
    string,
    RuntimeProviderObservation[]
  >();
  for (const observation of providerObservations) {
    const providerId = observation.providerId;
    if (!providerId) continue;
    const list = observationsByProvider.get(providerId) ?? [];
    list.push(observation);
    observationsByProvider.set(providerId, list);
    // Observations may carry their own optional/dependsOn metadata in
    // adapter-only flows (no per-materialisation reference). Fold those in.
    const entry = providerInfo.get(providerId) ??
      { optional: true, dependsOn: new Set<string>() };
    if (observation.optional === false) entry.optional = false;
    for (const upstream of observation.dependsOnProviderIds ?? []) {
      if (upstream !== providerId) entry.dependsOn.add(upstream);
    }
    providerInfo.set(providerId, entry);
  }

  if (providerInfo.size === 0) return [];

  // Direct status per provider from its observations.
  const direct = new Map<string, ProviderLayerStatus>();
  for (const [providerId, info] of providerInfo) {
    const observations = observationsByProvider.get(providerId) ?? [];
    direct.set(providerId, providerStatusFromObservations(observations, info));
  }

  // Walk the dependency DAG: any provider depending on an `outage` upstream
  // becomes at least `degraded`. Optional upstreams never propagate.
  const propagated = new Map(direct);
  let changed = true;
  let iterations = 0;
  const maxIterations = providerInfo.size + 1;
  while (changed && iterations < maxIterations) {
    changed = false;
    iterations += 1;
    for (const [providerId, info] of providerInfo) {
      for (const upstream of info.dependsOn) {
        const upstreamInfo = providerInfo.get(upstream);
        if (!upstreamInfo || upstreamInfo.optional) continue;
        const upstreamStatus = propagated.get(upstream) ?? "unknown";
        if (upstreamStatus !== "outage") continue;
        const current = propagated.get(providerId) ?? "unknown";
        if (current === "serving" || current === "unknown") {
          propagated.set(providerId, "degraded");
          changed = true;
        }
      }
    }
  }

  const sortedIds = [...providerInfo.keys()].sort();
  return sortedIds.map((providerId) => {
    const info = providerInfo.get(providerId)!;
    const status = propagated.get(providerId) ?? "unknown";
    const observations = observationsByProvider.get(providerId) ?? [];
    return Object.freeze({
      providerId,
      status,
      optional: info.optional,
      dependsOnProviderIds: Object.freeze([...info.dependsOn].sort()),
      conditions: Object.freeze(
        observations
          .map((observation) =>
            providerLayerCondition(providerId, observation, info.optional)
          )
          .filter((c): c is StatusConditionDto => c !== undefined),
      ),
    });
  });
}

function providerStatusFromObservations(
  observations: readonly RuntimeProviderObservation[],
  info: { optional: boolean },
): ProviderLayerStatus {
  if (observations.length === 0) return "unknown";
  let result: ProviderLayerStatus = "serving";
  for (const observation of observations) {
    switch (observation.observedState) {
      case "missing":
        // A `missing` non-optional materialisation is an outage on the
        // critical path; an optional one only degrades.
        result = info.optional ? worst(result, "degraded") : "outage";
        break;
      case "drifted":
        result = worst(result, "degraded");
        break;
      case "unknown":
        result = worst(result, "recovering");
        break;
      case "present":
        // present keeps current
        break;
    }
    if (result === "outage") return "outage";
  }
  return result;
}

function worst(
  a: ProviderLayerStatus,
  b: ProviderLayerStatus,
): ProviderLayerStatus {
  const order: Record<ProviderLayerStatus, number> = {
    serving: 0,
    recovering: 1,
    unknown: 2,
    degraded: 3,
    outage: 4,
  };
  return order[a] >= order[b] ? a : b;
}

function escalateServingFromProviders(
  providers: readonly ProviderLayerProjection[],
): StatusLayerProjection<ServingLayerStatus> | undefined {
  let criticalOutage: ProviderLayerProjection | undefined;
  let optionalOutage: ProviderLayerProjection | undefined;
  let degraded: ProviderLayerProjection | undefined;
  let recovering: ProviderLayerProjection | undefined;
  for (const provider of providers) {
    if (provider.status === "outage") {
      if (provider.optional) {
        optionalOutage ??= provider;
      } else {
        criticalOutage ??= provider;
      }
    } else if (provider.status === "degraded") {
      degraded ??= provider;
    } else if (provider.status === "recovering") {
      recovering ??= provider;
    }
  }
  if (criticalOutage) {
    return layer(
      "outage",
      condition(
        "ServingConverged",
        "false",
        "ProviderMaterializationFailed",
        `provider ${criticalOutage.providerId} outage`,
      ),
    );
  }
  if (optionalOutage || degraded) {
    const provider = optionalOutage ?? degraded!;
    return layer(
      "degraded",
      condition(
        "ServingConverged",
        "false",
        "ServingDegraded",
        `provider ${provider.providerId} ${provider.status}`,
      ),
    );
  }
  if (recovering) {
    return layer(
      "recovering",
      condition(
        "ServingConverged",
        "false",
        "ServingMaterializing",
        `provider ${recovering.providerId} recovering`,
      ),
    );
  }
  return undefined;
}

function providerLayerCondition(
  providerId: string,
  observation: RuntimeProviderObservation,
  optional: boolean,
): StatusConditionDto | undefined {
  switch (observation.observedState) {
    case "present":
      return Object.freeze({
        type: `Provider:${providerId}`,
        status: "true" as const,
        reason: "ServingConverged" as CoreConditionReason,
      });
    case "missing":
      return Object.freeze({
        type: `Provider:${providerId}`,
        status: "false" as const,
        reason: optional
          ? ("ServingDegraded" as CoreConditionReason)
          : ("ProviderObjectMissing" as CoreConditionReason),
        message: optional
          ? `optional provider ${providerId} object missing`
          : `provider ${providerId} object missing`,
      });
    case "drifted":
      return Object.freeze({
        type: `Provider:${providerId}`,
        status: "false" as const,
        reason: providerDriftReason(observation),
      });
    case "unknown":
      return Object.freeze({
        type: `Provider:${providerId}`,
        status: "unknown" as const,
        reason: "ServingConvergenceUnknown" as CoreConditionReason,
      });
  }
}

function projectConditions<
  TReady extends string,
  TUnknown extends string,
  TFalse extends string,
>(
  conditions: readonly StatusConditionDto[],
  ready: TReady,
  unknown: TUnknown,
  falseStatus: TFalse,
): TReady | TUnknown | TFalse {
  if (conditions.some((condition) => condition.status === "false")) {
    return falseStatus;
  }
  if (conditions.some((condition) => condition.status === "unknown")) {
    return unknown;
  }
  return ready;
}

function layer<TStatus extends string>(
  status: TStatus,
  ...conditions: StatusConditionDto[]
): StatusLayerProjection<TStatus> {
  return Object.freeze({
    status,
    conditions: Object.freeze(conditions),
  });
}

function condition(
  type: string,
  status: StatusConditionDto["status"],
  reason?: CoreConditionReason,
  message?: string,
): StatusConditionDto {
  return Object.freeze({ type, status, reason, message });
}

function conditionFromProviderObservation(
  observation: RuntimeProviderObservation,
): StatusConditionDto | undefined {
  switch (observation.observedState) {
    case "present":
      return undefined;
    case "missing":
      return condition(
        "ServingConverged",
        "false",
        "ProviderObjectMissing",
      );
    case "drifted":
      return condition(
        "ServingConverged",
        "false",
        providerDriftReason(observation),
      );
    case "unknown":
      return condition(
        "ServingConverged",
        "unknown",
        "ServingConvergenceUnknown",
      );
  }
}

function checkProviderMaterializationConvergence(input: {
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly materializationId?: string;
  readonly providerMaterializations:
    readonly ProviderMaterializationReference[];
  readonly providerObservations: readonly RuntimeProviderObservation[];
}): StatusLayerProjection<ServingLayerStatus> | undefined {
  if (input.providerMaterializations.length === 0) return undefined;
  const requiredScope = missingRequiredProviderMaterializationScope(input);
  if (requiredScope) {
    return layer(
      "converging",
      condition(
        "ServingConverged",
        "false",
        "ServingConvergenceUnknown",
        `Missing provider materialization for ${requiredScope}.`,
      ),
    );
  }
  const observationsByMaterialization = new Map(
    input.providerObservations.map((observation) => [
      observation.materializationId,
      observation,
    ]),
  );
  for (const materialization of input.providerMaterializations) {
    const observation = observationsByMaterialization.get(materialization.id);
    if (!observation) {
      if (isManagedProjectionMaterialization(materialization)) {
        return layer(
          "degraded",
          condition(
            "ManagedProjectionHealthy",
            "false",
            "OutputProjectionFailed",
            `Managed projection ${materialization.id} has no observation.`,
          ),
        );
      }
      return layer(
        "converging",
        condition(
          "ServingConverged",
          "false",
          "ServingConvergenceUnknown",
          `Provider materialization ${materialization.id} has no observation.`,
        ),
      );
    }
    const bridgeMismatch = providerObservationBridgeMismatch(
      materialization,
      observation,
    );
    if (bridgeMismatch) {
      return layer(
        "converging",
        condition(
          "ServingConverged",
          "false",
          "ProviderConfigDrift",
          bridgeMismatch,
        ),
      );
    }
    const providerCondition = conditionFromProviderObservation(observation);
    if (providerCondition) {
      if (isManagedProjectionMaterialization(materialization)) {
        return layer(
          "degraded",
          condition(
            "ManagedProjectionHealthy",
            "false",
            "OutputProjectionFailed",
            providerCondition.message ??
              `Managed projection ${materialization.id} is not healthy.`,
          ),
        );
      }
      return layer(
        observation.observedState === "unknown" ? "unknown" : "degraded",
        providerCondition,
      );
    }
  }
  return undefined;
}

function isManagedProjectionMaterialization(
  materialization: ProviderMaterializationReference,
): boolean {
  const role = materialization.role as string;
  return role === "projection" ||
    materialization.desiredObjectRef.includes("projection") ||
    materialization.objectAddress.includes("projection");
}

function missingRequiredProviderMaterializationScope(input: {
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly materializationId?: string;
  readonly providerMaterializations:
    readonly ProviderMaterializationReference[];
}): string | undefined {
  if (
    !input.providerMaterializations.some((materialization) =>
      materialization.role === "router" &&
      materializationRefersTo(materialization, "router-config")
    )
  ) {
    return "router-config";
  }
  if (
    !input.providerMaterializations.some((materialization) =>
      materialization.role === "runtime" &&
      materializationRefersTo(materialization, "runtime-network-policy")
    )
  ) {
    return "runtime-network-policy";
  }
  if (
    !input.providerMaterializations.some((materialization) =>
      materialization.role === "runtime" &&
      (materialization.desiredObjectRef === input.desiredStateId ||
        materialization.objectAddress === `activation:${input.activationId}` ||
        materialization.objectAddress === input.activationId ||
        materialization.id === input.materializationId)
    )
  ) {
    return "activation";
  }
  return undefined;
}

function materializationRefersTo(
  materialization: ProviderMaterializationReference,
  value: string,
): boolean {
  return materialization.desiredObjectRef.includes(value) ||
    materialization.objectAddress.includes(value);
}

function providerObservationBridgeMismatch(
  materialization: ProviderMaterializationReference,
  observation: RuntimeProviderObservation,
): string | undefined {
  if (observation.role && observation.role !== materialization.role) {
    return `Provider observation role ${observation.role} does not match ${materialization.role}.`;
  }
  if (
    observation.desiredObjectRef &&
    observation.desiredObjectRef !== materialization.desiredObjectRef
  ) {
    return "Provider observation desired object reference does not match materialization.";
  }
  if (
    observation.objectAddress &&
    observation.objectAddress !== materialization.objectAddress
  ) {
    return "Provider observation object address does not match materialization.";
  }
  if (
    observation.createdByOperationId &&
    observation.createdByOperationId !== materialization.createdByOperationId
  ) {
    return "Provider observation operation reference does not match materialization.";
  }
  return undefined;
}

function providerDriftReason(
  observation: RuntimeProviderObservation,
): CoreConditionReason {
  switch (observation.driftReason) {
    case "provider-object-missing":
      return "ProviderObjectMissing";
    case "config-drift":
      return "ProviderConfigDrift";
    case "status-drift":
      return "ProviderStatusDrift";
    case "security-drift":
      return "ProviderSecurityDrift";
    case "ownership-drift":
      return "ProviderOwnershipDrift";
    case "cache-drift":
      return "ProviderCacheDrift";
    case undefined:
      return "ProviderStatusDrift";
  }
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

function withCatalogReason(
  condition: StatusConditionDto,
  fallback: CoreConditionReason,
): StatusConditionDto {
  if (!condition.reason) return condition;
  if (isCoreConditionReason(condition.reason)) {
    return condition;
  }
  return Object.freeze({ ...condition, reason: fallback });
}

function validateProjectionConditionReasons(
  projection: GroupSummaryStatusProjection,
): GroupSummaryStatusProjection {
  for (const condition of allProjectionConditions(projection)) {
    if (!condition.reason) continue;
    if (isCoreConditionReason(condition.reason)) continue;
    throw new TypeError(
      `status projection emitted non-catalog condition reason: ${condition.reason}`,
    );
  }
  return projection;
}

function allProjectionConditions(
  projection: GroupSummaryStatusProjection,
): readonly StatusConditionDto[] {
  return [
    ...projection.desired.conditions,
    ...projection.serving.conditions,
    ...projection.dependencies.conditions,
    ...projection.security.conditions,
    ...projection.conditions,
  ];
}
