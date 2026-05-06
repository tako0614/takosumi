import type { ActorContext, JsonObject } from "takosumi-contract";
import type { NotificationRecord } from "../../adapters/notification/mod.ts";
import type { AuditEventId } from "../../domains/audit/mod.ts";
import type { DomainEvent } from "../../shared/events.ts";
import type { IsoTimestamp } from "../../shared/time.ts";

export type SlaDimension =
  | "apply-latency-p50"
  | "apply-latency-p95"
  | "apply-latency-p99"
  | "activation-latency"
  | "wal-stage-duration"
  | "drift-detection-latency"
  | "revoke-debt-aging"
  | "readiness-up-ratio"
  | "rate-limit-throttle-ratio"
  | "error-rate-5xx"
  | "error-rate-4xx";

export type SlaComparator = "gt" | "gte" | "lt" | "lte";
export type SlaScope = "kernel-global" | "space" | "org";
export type SlaState = "ok" | "warning" | "breached" | "recovering";

export type SlaTransitionEventType =
  | "sla-warning-raised"
  | "sla-breach-detected"
  | "sla-recovering"
  | "sla-recovered";

export interface SlaThreshold {
  readonly id: string;
  readonly dimension: SlaDimension;
  readonly comparator: SlaComparator;
  readonly value: number;
  readonly scope: SlaScope;
  readonly targetId?: string;
  readonly windowSeconds?: number;
  readonly breachConsecutiveWindows?: number;
  readonly recoveryConsecutiveWindows?: number;
}

export interface SlaObservationInput {
  readonly dimension: SlaDimension;
  readonly observation: number;
  readonly scope?: SlaScope;
  readonly targetId?: string;
  readonly spaceId?: string;
  readonly orgId?: string;
  readonly groupId?: string;
  readonly observedAt?: IsoTimestamp;
  readonly windowStart?: IsoTimestamp;
  readonly windowEnd?: IsoTimestamp;
  readonly thresholdId?: string;
  readonly actor?: ActorContext;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface SlaObservationState {
  readonly key: string;
  readonly thresholdId: string;
  readonly dimension: SlaDimension;
  readonly scope: SlaScope;
  readonly targetId?: string;
  readonly state: SlaState;
  readonly enteredAt: IsoTimestamp;
  readonly openedAt?: IsoTimestamp;
  readonly observation: number;
  readonly consecutiveBreaches: number;
  readonly consecutiveRecoveries: number;
  readonly updatedAt: IsoTimestamp;
}

export type SlaEventPayload = JsonObject & {
  readonly thresholdId: string;
  readonly dimension: SlaDimension;
  readonly scope: SlaScope;
  readonly targetId: string | null;
  readonly state: SlaState;
  readonly previousState: SlaState;
  readonly windowSeconds: number;
  readonly observation: number;
  readonly comparator: SlaComparator;
  readonly value: number;
  readonly thresholdValue: number;
  readonly observedAt: IsoTimestamp;
  readonly breachDurationSeconds?: number;
  readonly windowStart?: IsoTimestamp;
  readonly windowEnd?: IsoTimestamp;
};

export interface SlaPublishedEvent {
  readonly type: SlaTransitionEventType;
  readonly payload: SlaEventPayload;
  readonly domainEvent: DomainEvent<SlaEventPayload>;
  readonly auditEventId?: AuditEventId;
  readonly notification?: NotificationRecord;
}

export interface SlaThresholdEvaluation {
  readonly threshold: SlaThreshold;
  readonly key: string;
  readonly breached: boolean;
  readonly previousState: SlaState;
  readonly state: SlaObservationState;
  readonly event?: SlaPublishedEvent;
}

export interface SlaEvaluationResult {
  readonly observedAt: IsoTimestamp;
  readonly evaluations: readonly SlaThresholdEvaluation[];
  readonly events: readonly SlaPublishedEvent[];
}

export interface SlaThresholdStore {
  list(input: SlaObservationInput): Promise<readonly SlaThreshold[]>;
}

export interface SlaObservationStateStore {
  get(key: string): Promise<SlaObservationState | undefined>;
  put(state: SlaObservationState): Promise<SlaObservationState>;
  list(): Promise<readonly SlaObservationState[]>;
}
