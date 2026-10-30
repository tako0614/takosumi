import type {
  ActorContext,
  JsonObject,
} from "takosumi-contract/reference/compat";
import type { IsoTimestamp } from "../../shared/time.ts";

export type MetricEventId = string;
export type MetricKind = "counter" | "gauge" | "histogram";

/**
 * Tag naming the app (Capsule) a metric is about (TASK-0118 P9.1-g). It is the
 * only tenant label new metric events carry; the Workspace is no longer
 * recorded. Its cardinality is bounded by the installed apps: the Prometheus
 * exposition drops it from every series, and OTLP exports it as the
 * `takosumi.capsule_id` attribute. Never put Run, request or other per-event
 * ids in tags.
 */
export const METRIC_CAPSULE_LABEL = "capsule_id";

/**
 * Tags that never become a series label or an OTLP data-point attribute: a
 * legacy Workspace and per-run ids would make cardinality unbounded. The
 * Prometheus exposition and the OTLP exporter drop the same set.
 */
export const METRIC_DROPPED_TAGS: readonly string[] = [
  "workspace_id",
  "run_group_id",
  "run_id",
];

export interface MetricEvent {
  readonly id: MetricEventId;
  readonly name: string;
  readonly kind: MetricKind;
  readonly value: number;
  readonly unit?: string;
  readonly tags?: Record<string, string>;
  /**
   * Legacy Workspace of events recorded before TASK-0118 P9.1-g. New events
   * leave it unset and name their app with {@link METRIC_CAPSULE_LABEL}; no
   * exporter emits it.
   */
  readonly workspaceId?: string;
  readonly runGroupId?: string;
  readonly actor?: ActorContext;
  readonly payload?: JsonObject;
  readonly observedAt: IsoTimestamp;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface MetricEventQuery {
  readonly name?: string;
  readonly kind?: MetricKind;
  readonly workspaceId?: string;
  readonly runGroupId?: string;
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
}

export type TraceSpanId = string;
export type TraceId = string;
export type TraceSpanKind =
  "internal" | "server" | "client" | "producer" | "consumer";
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
  /** Legacy Workspace; no exporter emits it (TASK-0118 P9.1-g). */
  readonly workspaceId?: string;
  readonly runGroupId?: string;
  readonly requestId?: string;
  readonly correlationId?: string;
}

export interface TraceSpanQuery {
  readonly traceId?: TraceId;
  readonly spanId?: string;
  readonly name?: string;
  readonly kind?: TraceSpanKind;
  readonly status?: TraceSpanStatus;
  readonly workspaceId?: string;
  readonly runGroupId?: string;
  readonly since?: IsoTimestamp;
  readonly until?: IsoTimestamp;
}
