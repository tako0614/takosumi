import type { ActorContext, JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type MetricEventId = string;
export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricEvent {
  readonly id: MetricEventId;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Record<string, string>;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly actor?: ActorContext;
  readonly payload?: JsonObject;
  readonly observedAt: IsoTimestamp;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface MetricEventQuery {
  readonly name?: string;
  readonly kind?: MetricKind;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
}

export type TraceSpanId = string;
export type TraceId = string;
export type TraceSpanKind =
  | "internal"
  | "server"
  | "client"
  | "producer"
  | "consumer";
export type TraceSpanStatus = "unset" | "ok" | "error";

export interface TraceSpanEvent {
  readonly id: TraceSpanId;
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: TraceSpanKind;
  readonly status: TraceSpanStatus;
  readonly statusMessage?: string;
  readonly startTime: IsoTimestamp;
  readonly endTime: IsoTimestamp;
  readonly attributes?: Record<string, string | number | boolean>;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface TraceSpanQuery {
  readonly traceId?: TraceId;
  readonly spanId?: string;
  readonly name?: string;
  readonly kind?: TraceSpanKind;
  readonly status?: TraceSpanStatus;
  readonly spaceId?: string;
  readonly groupId?: string;
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
}
