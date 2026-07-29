import type { AuditEvent } from "../../core/domains/audit/types.ts";
import {
  chainAuditEvent,
  type ChainedAuditEvent,
  type ObservabilitySink,
  verifyAuditHashChain,
} from "../../core/domains/observability/mod.ts";
import type {
  MetricEvent,
  MetricEventQuery,
  TraceSpanEvent,
  TraceSpanQuery,
} from "../../core/domains/observability/types.ts";
import type { JsonObject } from "takosumi-contract/reference/compat";
import type { D1Database } from "./bindings.ts";

const OBSERVABILITY_QUERY_LIMIT = 5000;
const RETENTION_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Durable Cloudflare Worker observability sink.
 *
 * Worker isolates do not share process memory. Audit records, metrics, and
 * traces therefore all live in D1; a production request must never silently
 * fall back to an isolate-local compliance ledger. Audit appends use an
 * optimistic sequence insert. Concurrent writers that choose the same next
 * sequence conflict, reload the durable chain head, and recompute the hash.
 */
export class CloudflareD1ObservabilitySink implements ObservabilitySink {
  readonly #db: D1Database;
  readonly #now: () => number;
  #nextRetentionSweepAt = 0;

  constructor(input: { readonly db: D1Database; readonly now?: () => number }) {
    this.#db = input.db;
    this.#now = input.now ?? Date.now;
  }

  async appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const previousRow = await this.#db
        .prepare(
          `select sequence, event_json, previous_hash, hash
             from takosumi_observability_audit
            order by sequence desc limit 1`,
        )
        .first<AuditRow>();
      const previous = previousRow
        ? auditRecordFromRow(previousRow)
        : undefined;
      const record = await chainAuditEvent(event, previous);
      try {
        await this.#db
          .prepare(
            `insert into takosumi_observability_audit
              (sequence, event_id, event_json, previous_hash, hash, occurred_at)
             values (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            record.sequence,
            record.event.id,
            JSON.stringify(record.event),
            record.previousHash,
            record.hash,
            record.event.occurredAt,
          )
          .run();
        return structuredClone(record);
      } catch (error) {
        if (attempt === 7 || !isAuditSequenceConflict(error)) throw error;
      }
    }
    throw new Error("failed to append durable audit record");
  }

  async listAudit(): Promise<readonly ChainedAuditEvent[]> {
    const rows = await this.#db
      .prepare(
        `select sequence, event_json, previous_hash, hash
           from takosumi_observability_audit
          order by sequence asc`,
      )
      .all<AuditRow>();
    return (rows.results ?? []).map(auditRecordFromRow);
  }

  async verifyAuditChain(): Promise<boolean> {
    return (await verifyAuditHashChain(await this.listAudit())).valid;
  }

  async recordMetric(event: MetricEvent): Promise<MetricEvent> {
    await this.#db
      .prepare(
        `insert or replace into takosumi_observability_metrics
          (id, name, kind, value, unit, tags_json, space_id, group_id,
           actor_json, payload_json, observed_at, request_id, correlation_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.name,
        event.kind,
        event.value,
        event.unit ?? null,
        event.tags ? JSON.stringify(event.tags) : null,
        event.workspaceId ?? null,
        event.runGroupId ?? null,
        event.actor ? JSON.stringify(event.actor) : null,
        event.payload ? JSON.stringify(event.payload) : null,
        event.observedAt,
        event.requestId ?? null,
        event.correlationId ?? null,
      )
      .run();
    await this.#sweepRetentionIfDue();
    return structuredClone(event);
  }

  async listMetrics(
    query: MetricEventQuery = {},
  ): Promise<readonly MetricEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.name) {
      where.push("name = ?");
      params.push(query.name);
    }
    if (query.kind) {
      where.push("kind = ?");
      params.push(query.kind);
    }
    if (query.workspaceId) {
      where.push("space_id = ?");
      params.push(query.workspaceId);
    }
    if (query.runGroupId) {
      where.push("group_id = ?");
      params.push(query.runGroupId);
    }
    if (query.since) {
      where.push("observed_at >= ?");
      params.push(query.since);
    }
    if (query.until) {
      where.push("observed_at <= ?");
      params.push(query.until);
    }
    const sql =
      `select id, name, kind, value, unit, tags_json, space_id, group_id,
              actor_json, payload_json, observed_at, request_id, correlation_id
         from (
           select id, name, kind, value, unit, tags_json, space_id, group_id,
                  actor_json, payload_json, observed_at, request_id,
                  correlation_id
             from takosumi_observability_metrics` +
      (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
      ` order by observed_at desc, id desc
            limit ${OBSERVABILITY_QUERY_LIMIT}
         )
        order by observed_at asc, id asc`;
    const rows = await this.#db
      .prepare(sql)
      .bind(...params)
      .all<MetricRow>();
    return (rows.results ?? []).map(metricEventFromRow);
  }

  async recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    await this.#db
      .prepare(
        `insert or replace into takosumi_observability_traces
          (id, trace_id, span_id, name, kind, status, space_id, group_id,
           start_time, end_time, event_json)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        event.id,
        event.traceId,
        event.spanId,
        event.name,
        event.kind,
        event.status,
        event.workspaceId ?? null,
        event.runGroupId ?? null,
        event.startTime,
        event.endTime,
        JSON.stringify(event),
      )
      .run();
    await this.#sweepRetentionIfDue();
    return structuredClone(event);
  }

  async listTraces(
    query: TraceSpanQuery = {},
  ): Promise<readonly TraceSpanEvent[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    addWhere(where, params, "trace_id", query.traceId);
    addWhere(where, params, "span_id", query.spanId);
    addWhere(where, params, "name", query.name);
    addWhere(where, params, "kind", query.kind);
    addWhere(where, params, "status", query.status);
    addWhere(where, params, "space_id", query.workspaceId);
    addWhere(where, params, "group_id", query.runGroupId);
    if (query.since) {
      where.push("start_time >= ?");
      params.push(query.since);
    }
    if (query.until) {
      where.push("end_time <= ?");
      params.push(query.until);
    }
    const sql =
      `select event_json
         from (
           select event_json, start_time, id
             from takosumi_observability_traces` +
      (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
      ` order by start_time desc, id desc
            limit ${OBSERVABILITY_QUERY_LIMIT}
         )
        order by start_time asc, id asc`;
    const rows = await this.#db
      .prepare(sql)
      .bind(...params)
      .all<TraceRow>();
    return (rows.results ?? []).map((row) =>
      traceEventFromJson(row.event_json),
    );
  }

  async #sweepRetentionIfDue(): Promise<void> {
    const now = this.#now();
    if (now < this.#nextRetentionSweepAt) return;
    this.#nextRetentionSweepAt = now + RETENTION_SWEEP_INTERVAL_MS;
    try {
      await Promise.all([
        this.#db
          .prepare(
            "delete from takosumi_observability_metrics where observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')",
          )
          .run(),
        this.#db
          .prepare(
            "delete from takosumi_observability_traces where start_time < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')",
          )
          .run(),
      ]);
    } catch (error) {
      this.#nextRetentionSweepAt = 0;
      throw error;
    }
  }
}

interface AuditRow extends Record<string, unknown> {
  readonly sequence: number;
  readonly event_json: string;
  readonly previous_hash: string;
  readonly hash: string;
}

interface TraceRow extends Record<string, unknown> {
  readonly event_json: string;
}

interface MetricRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly value: number;
  readonly unit: string | null;
  readonly tags_json: string | null;
  readonly space_id: string | null;
  readonly group_id: string | null;
  readonly actor_json: string | null;
  readonly payload_json: string | null;
  readonly observed_at: string;
  readonly request_id: string | null;
  readonly correlation_id: string | null;
}

function metricEventFromRow(row: MetricRow): MetricEvent {
  return {
    id: row.id,
    name: row.name,
    kind: metricKind(row.kind),
    value: Number(row.value),
    ...(row.unit ? { unit: row.unit } : {}),
    ...(row.tags_json ? { tags: parseJsonRecord(row.tags_json) } : {}),
    ...(row.space_id ? { workspaceId: row.space_id } : {}),
    ...(row.group_id ? { runGroupId: row.group_id } : {}),
    ...(row.actor_json
      ? {
          actor: parseJsonObject(
            row.actor_json,
          ) as unknown as MetricEvent["actor"],
        }
      : {}),
    ...(row.payload_json ? { payload: parseJsonObject(row.payload_json) } : {}),
    observedAt: row.observed_at,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
  } as MetricEvent;
}

function metricKind(value: string): MetricEvent["kind"] {
  return value === "counter" || value === "histogram" ? value : "gauge";
}

function auditRecordFromRow(row: AuditRow): ChainedAuditEvent {
  return {
    sequence: Number(row.sequence),
    event: auditEventFromJson(row.event_json),
    previousHash: row.previous_hash,
    hash: row.hash,
  };
}

function auditEventFromJson(value: string): AuditEvent {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("stored audit event is not an object");
  }
  return parsed as AuditEvent;
}

function traceEventFromJson(value: string): TraceSpanEvent {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("stored trace event is not an object");
  }
  return parsed as TraceSpanEvent;
}

function addWhere(
  where: string[],
  params: unknown[],
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  where.push(`${column} = ?`);
  params.push(value);
}

function isAuditSequenceConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /unique|primary key|constraint/i.test(message) && /sequence/i.test(message)
  );
}

function parseJsonRecord(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).map(([key, item]) => [
      key,
      typeof item === "string" ? item : JSON.stringify(item),
    ]),
  );
}

function parseJsonObject(value: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as JsonObject;
}
