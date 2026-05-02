import type { JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type RuntimeLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal";

export type RuntimeLogStream = "stdout" | "stderr" | "system";

export type RuntimeLogEventId = string;

export interface RuntimeLogEvent {
  readonly id: RuntimeLogEventId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly workerId: string;
  readonly stream: RuntimeLogStream;
  readonly level: RuntimeLogLevel;
  readonly message: string;
  readonly observedAt: IsoTimestamp;
  readonly deploymentId?: string;
  readonly instanceId?: string;
  readonly payload?: JsonObject;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface RuntimeLogAppendInput {
  readonly id?: RuntimeLogEventId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly workerId: string;
  readonly stream: RuntimeLogStream;
  readonly level: RuntimeLogLevel;
  readonly message: string;
  readonly observedAt: IsoTimestamp;
  readonly deploymentId?: string;
  readonly instanceId?: string;
  readonly payload?: JsonObject;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface RuntimeLogQuery {
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly workerId?: string;
  readonly deploymentId?: string;
  readonly instanceId?: string;
  readonly stream?: RuntimeLogStream;
  readonly level?: RuntimeLogLevel | readonly RuntimeLogLevel[];
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
  readonly search?: string;
  readonly limit?: number;
}

export interface RuntimeLogRetentionPolicy {
  readonly windowMs: number;
}

export interface RuntimeLogRetentionDecision {
  readonly now: IsoTimestamp;
  readonly windowMs: number;
  readonly retainAfter: IsoTimestamp;
  readonly oldestObservedAt?: IsoTimestamp;
  readonly shouldPrune: boolean;
}
