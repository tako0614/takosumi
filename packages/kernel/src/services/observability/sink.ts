import type { AuditEvent } from "../../domains/audit/types.ts";
import {
  chainAuditEvent,
  type ChainedAuditEvent,
  verifyAuditHashChain,
} from "./audit_chain.ts";
import type {
  MetricEvent,
  MetricEventQuery,
  TraceSpanEvent,
  TraceSpanQuery,
} from "./types.ts";

export interface ObservabilitySink {
  appendAudit(event: AuditEvent): Promise<ChainedAuditEvent>;
  listAudit(): Promise<readonly ChainedAuditEvent[]>;
  verifyAuditChain(): Promise<boolean>;
  recordMetric(event: MetricEvent): Promise<MetricEvent>;
  listMetrics(query?: MetricEventQuery): Promise<readonly MetricEvent[]>;
  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent>;
  listTraces(query?: TraceSpanQuery): Promise<readonly TraceSpanEvent[]>;
}

export class InMemoryObservabilitySink implements ObservabilitySink {
  readonly #auditRecords: ChainedAuditEvent[] = [];
  readonly #metrics: MetricEvent[] = [];
  readonly #traces: TraceSpanEvent[] = [];

  async appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    const previous = this.#auditRecords.at(-1);
    const record = await chainAuditEvent(event, previous);
    this.#auditRecords.push(record);
    return record;
  }

  listAudit(): Promise<readonly ChainedAuditEvent[]> {
    return Promise.resolve(this.#auditRecords.map(cloneChainedAuditEvent));
  }

  async verifyAuditChain(): Promise<boolean> {
    return (await verifyAuditHashChain(this.#auditRecords)).valid;
  }

  recordMetric(event: MetricEvent): Promise<MetricEvent> {
    this.#metrics.push(cloneMetricEvent(event));
    return Promise.resolve(event);
  }

  listMetrics(query: MetricEventQuery = {}): Promise<readonly MetricEvent[]> {
    return Promise.resolve(
      this.#metrics.filter((event) => matchesMetricQuery(event, query)).map(
        cloneMetricEvent,
      ),
    );
  }

  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    this.#traces.push(cloneTraceSpanEvent(event));
    return Promise.resolve(event);
  }

  listTraces(query: TraceSpanQuery = {}): Promise<readonly TraceSpanEvent[]> {
    return Promise.resolve(
      this.#traces.filter((event) => matchesTraceSpanQuery(event, query)).map(
        cloneTraceSpanEvent,
      ),
    );
  }
}

function matchesMetricQuery(
  event: MetricEvent,
  query: MetricEventQuery,
): boolean {
  if (query.name && event.name !== query.name) return false;
  if (query.kind && event.kind !== query.kind) return false;
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.since && event.observedAt < query.since) return false;
  if (query.until && event.observedAt > query.until) return false;
  return true;
}

function cloneChainedAuditEvent(record: ChainedAuditEvent): ChainedAuditEvent {
  return structuredClone(record);
}

function cloneMetricEvent(event: MetricEvent): MetricEvent {
  return structuredClone(event);
}

function matchesTraceSpanQuery(
  event: TraceSpanEvent,
  query: TraceSpanQuery,
): boolean {
  if (query.traceId && event.traceId !== query.traceId) return false;
  if (query.spanId && event.spanId !== query.spanId) return false;
  if (query.name && event.name !== query.name) return false;
  if (query.kind && event.kind !== query.kind) return false;
  if (query.status && event.status !== query.status) return false;
  if (query.spaceId && event.spaceId !== query.spaceId) return false;
  if (query.groupId && event.groupId !== query.groupId) return false;
  if (query.since && event.startTime < query.since) return false;
  if (query.until && event.endTime > query.until) return false;
  return true;
}

function cloneTraceSpanEvent(event: TraceSpanEvent): TraceSpanEvent {
  return structuredClone(event);
}
