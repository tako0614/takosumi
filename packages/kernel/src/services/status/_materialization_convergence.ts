import type { ProviderMaterializationReference } from "../../adapters/provider/mod.ts";
import type { ProviderObservation as RuntimeProviderObservation } from "../../domains/runtime/mod.ts";
import type {
  ServingLayerStatus,
  StatusConditionDto,
  StatusLayerProjection,
} from "./types.ts";
import { condition, layer } from "./_layer_helpers.ts";
import { providerDriftReason } from "./_provider_layer.ts";

export function conditionFromProviderObservation(
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

export function checkProviderMaterializationConvergence(input: {
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
