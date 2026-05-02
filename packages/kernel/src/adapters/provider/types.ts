import type {
  RuntimeDesiredState,
  RuntimeProviderRole,
} from "../../domains/runtime/mod.ts";
import type { ObjectAddress } from "takosumi-contract";

export type ProviderMaterializationRole = RuntimeProviderRole;

/**
 * Adapter-bridge handle that correlates a planned provider materialization with
 * the desired-side `Deployment.desired` graph. The Deployment-centric core
 * collapses materialization records onto `Deployment.conditions[]`, so this
 * lightweight reference is owned by the provider adapter layer rather than
 * exported from `takosumi-contract`.
 */
export interface ProviderMaterializationReference {
  readonly id: string;
  readonly role: ProviderMaterializationRole;
  readonly desiredObjectRef: string;
  readonly providerTarget: string;
  readonly objectAddress: ObjectAddress;
  readonly createdByOperationId: string;
  /**
   * Phase 18.2: provider id (`aws`, `gcp`, `cloudflare`, `k8s`, ...) that
   * carries this materialisation. Surfaces multi-cloud composites to the
   * status projector so per-provider outages can be projected independently.
   */
  readonly providerId?: string;
  /**
   * Phase 18.2: optional-provider flag (e.g. CDN). The status projector
   * treats failures of optional providers as `degraded`, never as `outage`.
   */
  readonly optional?: boolean;
  /**
   * Phase 18.2: ids of upstream providers this materialisation depends on
   * (e.g. compute depends on database). The status projector walks this DAG
   * to mark dependents `degraded` when an upstream provider is `failed`.
   */
  readonly dependsOnProviderIds?: readonly string[];
}

export type ProviderOperationKind = string;

export type ProviderOperationExecutionStatus =
  | "succeeded"
  | "failed"
  | "skipped";

export interface ProviderOperationExecution {
  readonly status: ProviderOperationExecutionStatus;
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly skipped?: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface ProviderOperation {
  readonly id: string;
  readonly kind: ProviderOperationKind;
  readonly provider: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly targetName?: string;
  readonly command: readonly string[];
  readonly details: Record<string, unknown>;
  readonly recordedAt: string;
  readonly execution?: ProviderOperationExecution;
}

export interface ProviderMaterializationPlan {
  readonly id: string;
  readonly provider: string;
  readonly desiredStateId: string;
  readonly recordedAt: string;
  readonly role?: ProviderMaterializationRole;
  readonly desiredObjectRef?: string;
  readonly objectAddress?: string;
  readonly createdByOperationId?: string;
  readonly materializations?: readonly ProviderMaterializationReference[];
  readonly operations: readonly ProviderOperation[];
}

export interface ProviderMaterializer {
  materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<ProviderMaterializationPlan>;
  listRecordedOperations(): Promise<readonly ProviderOperation[]>;
  clearRecordedOperations(): Promise<void>;
}
