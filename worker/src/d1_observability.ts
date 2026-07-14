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
  #schemaReady: Promise<void> | undefined;

  constructor(input: { readonly db: D1Database }) {
    this.#db = input.db;
  }

  async appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    await this.#ensureSchema();
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
    await this.#ensureSchema();
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
    await this.#ensureSchema();
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
    await this.#deleteExpiredMetricSamples();
    return structuredClone(event);
  }

  async listMetrics(
    query: MetricEventQuery = {},
  ): Promise<readonly MetricEvent[]> {
    await this.#ensureSchema();
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
         from takosumi_observability_metrics` +
      (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
      " order by observed_at asc limit 5000";
    const rows = await this.#db
      .prepare(sql)
      .bind(...params)
      .all<MetricRow>();
    return (rows.results ?? []).map(metricEventFromRow);
  }

  async recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    await this.#ensureSchema();
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
    return structuredClone(event);
  }

  async listTraces(
    query: TraceSpanQuery = {},
  ): Promise<readonly TraceSpanEvent[]> {
    await this.#ensureSchema();
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
      "select event_json from takosumi_observability_traces" +
      (where.length > 0 ? ` where ${where.join(" and ")}` : "") +
      " order by start_time asc, id asc limit 5000";
    const rows = await this.#db
      .prepare(sql)
      .bind(...params)
      .all<TraceRow>();
    return (rows.results ?? []).map((row) =>
      traceEventFromJson(row.event_json),
    );
  }

  #ensureSchema(): Promise<void> {
    this.#schemaReady ??= ensureD1ObservabilitySchema(this.#db);
    return this.#schemaReady;
  }

  async #deleteExpiredMetricSamples(): Promise<void> {
    await this.#db
      .prepare(
        "delete from takosumi_observability_metrics where observed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 hours')",
      )
      .run();
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

async function ensureD1ObservabilitySchema(db: D1Database): Promise<void> {
  await db
    .prepare(
      `create table if not exists takosumi_observability_audit (
        sequence integer primary key,
        event_id text not null unique,
        event_json text not null,
        previous_hash text not null,
        hash text not null,
        occurred_at text not null,
        created_at text not null default current_timestamp
      )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_observability_audit_occurred_idx
         on takosumi_observability_audit (occurred_at, sequence)`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_observability_metrics (
        id text primary key,
        name text not null,
        kind text not null,
        value real not null,
        unit text,
        tags_json text,
        space_id text,
        group_id text,
        actor_json text,
        payload_json text,
        observed_at text not null,
        request_id text,
        correlation_id text,
        created_at text not null default current_timestamp
      )`,
    )
    .run();
  await ensureMetricColumn(db, "unit", "unit text");
  await db
    .prepare(
      `create index if not exists takosumi_observability_metrics_name_idx
         on takosumi_observability_metrics (name, observed_at)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_observability_metrics_space_idx
         on takosumi_observability_metrics (space_id, observed_at)`,
    )
    .run();
  await db
    .prepare(
      `create table if not exists takosumi_observability_traces (
        id text primary key,
        trace_id text not null,
        span_id text not null,
        name text not null,
        kind text not null,
        status text not null,
        space_id text,
        group_id text,
        start_time text not null,
        end_time text not null,
        event_json text not null,
        created_at text not null default current_timestamp
      )`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_observability_traces_trace_idx
         on takosumi_observability_traces (trace_id, start_time)`,
    )
    .run();
  await db
    .prepare(
      `create index if not exists takosumi_observability_traces_space_idx
         on takosumi_observability_traces (space_id, start_time)`,
    )
    .run();
}

async function ensureMetricColumn(
  db: D1Database,
  column: string,
  definition: string,
): Promise<void> {
  const existing = await db
    .prepare("pragma table_info(takosumi_observability_metrics)")
    .all<{ name: string }>();
  const hasColumn = (existing.results ?? []).some((row) => row.name === column);
  if (hasColumn) return;
  await db
    .prepare(
      `alter table takosumi_observability_metrics add column ${definition}`,
    )
    .run();
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
