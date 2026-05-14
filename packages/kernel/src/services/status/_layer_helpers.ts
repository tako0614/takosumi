import type { CoreConditionReason } from "takosumi-contract";
import { isCoreConditionReason } from "takosumi-contract";
import type {
  GroupSummaryStatusProjection,
  StatusConditionDto,
  StatusLayerProjection,
} from "./types.ts";

export function layer<TStatus extends string>(
  status: TStatus,
  ...conditions: StatusConditionDto[]
): StatusLayerProjection<TStatus> {
  return Object.freeze({
    status,
    conditions: Object.freeze(conditions),
  });
}

export function condition(
  type: string,
  status: StatusConditionDto["status"],
  reason?: CoreConditionReason,
  message?: string,
): StatusConditionDto {
  return Object.freeze({ type, status, reason, message });
}

export function projectConditions<
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

export function withCatalogReason(
  condition: StatusConditionDto,
  fallback: CoreConditionReason,
): StatusConditionDto {
  if (!condition.reason) return condition;
  if (isCoreConditionReason(condition.reason)) {
    return condition;
  }
  return Object.freeze({ ...condition, reason: fallback });
}

export function validateProjectionConditionReasons(
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
