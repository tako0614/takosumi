import type {
  ProviderMaterializationPlan,
  ProviderOperation,
} from "../../adapters/provider/mod.ts";
import type { AuditStore } from "../../domains/audit/mod.ts";
import type { RuntimeDesiredState } from "../../domains/runtime/mod.ts";

export type ProviderOperationRecordStatus = "running" | "succeeded" | "failed";

export type ProviderOperationFailureReason =
  | "provider_timeout"
  | "provider_unavailable"
  | "provider_conflict"
  | "provider_rejected"
  | "unknown";

export interface ProviderOperationFailureClassification {
  readonly reason: ProviderOperationFailureReason;
  readonly retryable: boolean;
  readonly message: string;
}

export interface ProviderOperationRecord {
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly desiredStateId: string;
  readonly activationId: string;
  readonly status: ProviderOperationRecordStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly materialization?: ProviderMaterializationPlan;
  readonly failure?: ProviderOperationFailureClassification;
}

export interface ProviderMaterializationStatusDto {
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly desiredStateId: string;
  readonly activationId: string;
  readonly status: ProviderOperationRecordStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly materializationPlanId?: string;
  readonly recordedOperationCount: number;
  readonly failedProviderOperationCount: number;
  readonly failureReason?: ProviderOperationFailureReason;
  readonly retryable: boolean;
  readonly message?: string;
}

export interface ProviderOperationRecordStore {
  get(idempotencyKey: string): Promise<ProviderOperationRecord | undefined>;
  put(record: ProviderOperationRecord): Promise<ProviderOperationRecord>;
}

export interface ProviderOperationServiceExecuteInput {
  readonly desiredState: RuntimeDesiredState;
  readonly idempotencyKey?: string;
  /**
   * Provider credential handles visible to this provider execution. Refs are
   * scoped by ProviderOperationService to `secret://providers/<provider>` and
   * tenant/runtime secret refs are rejected before materialization begins.
   */
  readonly credentialRefs?: readonly string[];
  readonly requestId?: string;
  readonly actorId?: string;
}

export interface ProviderOperationServiceExecuteResult {
  readonly status: ProviderMaterializationStatusDto;
  readonly record: ProviderOperationRecord;
}

export interface ProviderOperationServiceOptions {
  readonly provider: string;
  readonly materializer: {
    materialize(
      desiredState: RuntimeDesiredState,
    ): Promise<ProviderMaterializationPlan>;
  };
  readonly store?: ProviderOperationRecordStore;
  readonly auditStore?: Pick<AuditStore, "append">;
  readonly auditIdFactory?: () => string;
  readonly clock?: () => Date;
}

export type FailedProviderOperationLike = Pick<
  ProviderOperation,
  "execution" | "kind" | "targetName" | "targetId"
>;
