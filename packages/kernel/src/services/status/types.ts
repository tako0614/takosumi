import type {
  ConditionStatus,
  CoreConditionReason,
  GroupSummaryStatus,
} from "takosumi-contract";
import type { ProviderMaterializationReference } from "../../adapters/provider/mod.ts";
import type { ProviderObservation as RuntimeProviderObservation } from "../../domains/runtime/mod.ts";

export type StatusConditionStatus = ConditionStatus;

/**
 * Plain condition DTO accepted by the status projection service.
 *
 * This intentionally mirrors the public Condition shape without importing
 * domain-owned resource/publication/security implementations. Callers pass the
 * already-computed condition facts and the projector derives the group summary.
 */
export interface StatusConditionDto {
  readonly type: string;
  readonly status: StatusConditionStatus;
  readonly reason?: CoreConditionReason;
  readonly message?: string;
  readonly observedGeneration?: number;
  readonly lastTransitionAt?: string;
}

export interface ActivationPointerStatusDto {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly advancedAt: string;
}

export type ActivationCommitStatusDto =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface ActivationStatusDto {
  readonly id: string;
  readonly status: ActivationCommitStatusDto;
}

export type RuntimeMaterializationStatusDto =
  | "pending"
  | "materialized"
  | "failed";

export interface RuntimeMaterializationStatusInputDto {
  readonly materializationId?: string;
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly status: RuntimeMaterializationStatusDto;
  readonly materializedAt?: string;
  readonly message?: string;
  readonly providerObservation?: RuntimeProviderObservation | null;
  readonly providerObservations?: readonly RuntimeProviderObservation[];
  readonly providerMaterializations?:
    readonly ProviderMaterializationReference[];
}

export type RuntimeObservedWorkloadPhaseDto =
  | "pending"
  | "starting"
  | "running"
  | "degraded"
  | "stopped"
  | "unknown";

export type RuntimeObservedResourcePhaseDto =
  | "pending"
  | "provisioning"
  | "ready"
  | "degraded"
  | "deleted"
  | "unknown";

export interface RuntimeObservedWorkloadDto {
  readonly workloadId: string;
  readonly phase: RuntimeObservedWorkloadPhaseDto;
  readonly message?: string;
}

export interface RuntimeObservedResourceDto {
  readonly resourceId: string;
  readonly phase: RuntimeObservedResourcePhaseDto;
  readonly message?: string;
}

export interface RuntimeObservedRouteDto {
  readonly routeId: string;
  readonly ready: boolean;
  readonly message?: string;
}

export interface RuntimeObservedStateInputDto {
  readonly activationId?: string;
  readonly desiredStateId?: string;
  readonly observedAt: string;
  readonly workloads: readonly RuntimeObservedWorkloadDto[];
  readonly resources: readonly RuntimeObservedResourceDto[];
  readonly routes: readonly RuntimeObservedRouteDto[];
  readonly diagnostics?: readonly string[];
}

export type DesiredLayerStatus =
  | "empty"
  | "planning"
  | "applying"
  | "committed"
  | "failed"
  | "suspended"
  | "deleted";

export type ServingLayerStatus =
  | "empty"
  | "converging"
  | "converged"
  | "degraded"
  | "outage"
  | "recovering"
  | "failed"
  | "unknown";

/**
 * Phase 18.2: SLA-aware per-provider status projection. Independent of the
 * cross-provider rollup so a single AWS region outage can be reported as
 * `outage` for `aws` while `cloudflare` remains `serving`.
 */
export type ProviderLayerStatus =
  | "serving"
  | "degraded"
  | "outage"
  | "recovering"
  | "unknown";

export interface ProviderLayerProjection {
  readonly providerId: string;
  readonly status: ProviderLayerStatus;
  readonly optional: boolean;
  readonly dependsOnProviderIds: readonly string[];
  readonly conditions: readonly StatusConditionDto[];
}

export type DependencyLayerStatus =
  | "ready"
  | "degraded"
  | "failed"
  | "unknown";
export type SecurityLayerStatus = "trusted" | "warning" | "blocked" | "unknown";

export interface StatusLayerProjection<TStatus extends string> {
  readonly status: TStatus;
  readonly conditions: readonly StatusConditionDto[];
}

export interface GroupSummaryStatusProjectionInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationPointer?: ActivationPointerStatusDto | null;
  readonly activation?: ActivationStatusDto | null;
  readonly runtimeMaterialization?: RuntimeMaterializationStatusInputDto | null;
  readonly runtimeObserved?: RuntimeObservedStateInputDto | null;
  readonly publicationConditions?: readonly StatusConditionDto[];
  readonly resourceConditions?: readonly StatusConditionDto[];
  readonly securityConditions?: readonly StatusConditionDto[];
  readonly suspended?: boolean;
  readonly deleted?: boolean;
  readonly projectedAt?: string;
}

export interface GroupSummaryStatusProjection {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly status: GroupSummaryStatus;
  readonly projectedAt: string;
  readonly desired: StatusLayerProjection<DesiredLayerStatus>;
  readonly serving: StatusLayerProjection<ServingLayerStatus>;
  readonly dependencies: StatusLayerProjection<DependencyLayerStatus>;
  readonly security: StatusLayerProjection<SecurityLayerStatus>;
  readonly conditions: readonly StatusConditionDto[];
  /**
   * Phase 18.2 multi-cloud per-provider projections. Empty when the deployment
   * is single-provider; populated when the runtime materialisation tags
   * observations with `providerId`. The cross-provider rollup is computed by
   * `summarizeGroupStatus()` from this map plus the existing layer states.
   */
  readonly providers: readonly ProviderLayerProjection[];
}
