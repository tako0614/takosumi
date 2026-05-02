import type {
  AppSpecComponent,
  AppSpecResource,
  AppSpecRoute,
} from "../deploy/types.ts";
import type { Digest } from "takosumi-contract";

/**
 * Provider materialization role used by adapters/observers to describe which
 * desired-side concern produced an observation. The Deployment-centric core
 * collapses materialization records into `Deployment.conditions[]`, so this
 * remains a runtime-domain enum rather than a core type alias.
 */
export type RuntimeProviderRole = "router" | "runtime" | "resource" | "access";

export type RuntimeProviderObservationState =
  | "present"
  | "missing"
  | "drifted"
  | "unknown";

export type RuntimeProviderObservationDriftReason =
  | "provider-object-missing"
  | "config-drift"
  | "status-drift"
  | "security-drift"
  | "ownership-drift"
  | "cache-drift";

export type RuntimeDesiredStateId = string;
export type RuntimeObservedStateId = string;

/**
 * Adapter-bridge observation correlated against a runtime materialization plan.
 * The Deployment-centric core records observed provider state on the
 * `ProviderObservation` stream defined by `takosumi-contract`; this
 * runtime-domain shape carries the additional fields adapters need to bridge
 * their materialization plans against the desired state.
 */
export interface ProviderObservation {
  readonly materializationId: string;
  readonly observedState: RuntimeProviderObservationState;
  readonly driftReason?: RuntimeProviderObservationDriftReason;
  readonly observedDigest?: Digest;
  readonly observedAt: string;
  readonly role?: RuntimeProviderRole;
  readonly desiredObjectRef?: string;
  readonly objectAddress?: string;
  readonly createdByOperationId?: string;
  /**
   * Phase 18.2: provider id (e.g. `aws`, `gcp`, `cloudflare`, `k8s`) that
   * produced this observation. Used by the status projector to compute
   * per-provider degradation states independently when a composite spans
   * multiple clouds.
   */
  readonly providerId?: string;
  /**
   * Phase 18.2: marks an observation as belonging to an optional provider in
   * the composite DAG (e.g. CDN in `composite.web-app-with-cdn@v1`). When set
   * the projector degrades but never escalates to `outage` for this provider.
   */
  readonly optional?: boolean;
  /**
   * Phase 18.2: ids of upstream providers this observation depends on. The
   * projector uses this to mark dependent components `degraded` when an
   * upstream provider is `failed`.
   */
  readonly dependsOnProviderIds?: readonly string[];
}
export type RuntimeWorkloadPhase =
  | "pending"
  | "starting"
  | "running"
  | "degraded"
  | "stopped"
  | "unknown";
export type RuntimeResourcePhase =
  | "pending"
  | "provisioning"
  | "ready"
  | "degraded"
  | "deleted"
  | "unknown";

export interface RuntimeMaterializationInput {
  readonly activationId: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly appSpec: {
    readonly name: string;
    readonly version?: string;
    readonly components: readonly AppSpecComponent[];
    readonly resources: readonly AppSpecResource[];
    readonly routes: readonly AppSpecRoute[];
    readonly env: Record<string, string>;
  };
  readonly materializedAt?: string;
}

export interface RuntimeWorkloadSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly componentName: string;
  readonly runtimeName: string;
  readonly type: string;
  readonly image?: string;
  readonly entrypoint?: string;
  readonly command: readonly string[];
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly depends: readonly string[];
}

export interface RuntimeResourceSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly resourceName: string;
  readonly runtimeName: string;
  readonly type: string;
  readonly env: Record<string, string>;
}

export interface RuntimeRouteBindingSpec {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly routeName: string;
  readonly targetComponentName: string;
  readonly host?: string;
  readonly path?: string;
  readonly protocol?: string;
  readonly port?: number;
  readonly targetPort?: number;
  readonly source?: string;
}

export interface RuntimeDesiredState {
  readonly id: RuntimeDesiredStateId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly appName: string;
  readonly appVersion?: string;
  readonly materializedAt: string;
  readonly workloads: readonly RuntimeWorkloadSpec[];
  readonly resources: readonly RuntimeResourceSpec[];
  readonly routes: readonly RuntimeRouteBindingSpec[];
}

export interface RuntimeObservedWorkloadState {
  readonly workloadId: string;
  readonly phase: RuntimeWorkloadPhase;
  readonly observedGeneration?: string;
  readonly message?: string;
}

export interface RuntimeObservedResourceState {
  readonly resourceId: string;
  readonly phase: RuntimeResourcePhase;
  readonly message?: string;
}

export interface RuntimeObservedRouteState {
  readonly routeId: string;
  readonly ready: boolean;
  readonly message?: string;
}

export interface RuntimeObservedStateSnapshot {
  readonly id: RuntimeObservedStateId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId?: string;
  readonly desiredStateId?: RuntimeDesiredStateId;
  readonly observedAt: string;
  readonly workloads: readonly RuntimeObservedWorkloadState[];
  readonly resources: readonly RuntimeObservedResourceState[];
  readonly routes: readonly RuntimeObservedRouteState[];
  readonly diagnostics: readonly string[];
}
