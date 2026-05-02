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
