import type { CoreConditionReason } from "takosumi-contract";
import type { ProviderObservation as RuntimeProviderObservation } from "../../domains/runtime/mod.ts";
import type {
  GroupSummaryStatusProjectionInput,
  ProviderLayerProjection,
  ProviderLayerStatus,
  ServingLayerStatus,
  StatusConditionDto,
  StatusLayerProjection,
} from "./types.ts";
import { condition, layer } from "./_layer_helpers.ts";

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

export function escalateServingFromProviders(
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

export function providerDriftReason(
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
