import type { AuditEvent } from "../../core/domains/audit/types.ts";
import {
  InMemoryObservabilitySink,
  type ChainedAuditEvent,
  type ObservabilitySink,
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
 * Cloudflare Worker observability sink that keeps compliance/audit behavior on
 * the injected fallback sink while persisting Prometheus metric samples in D1.
 *
 * Worker isolates do not guarantee that the request which records a metric and
 * the later `/metrics` scrape hit the same in-memory object. Persisting only
 * metric samples here keeps the platform scrape surface durable without
 * changing the audit-chain ownership model.
 */
export class CloudflareD1MetricObservabilitySink implements ObservabilitySink {
  readonly #db: D1Database;
  readonly #fallback: ObservabilitySink;
  #schemaReady: Promise<void> | undefined;

  constructor(input: {
    readonly db: D1Database;
    readonly fallback?: ObservabilitySink;
  }) {
    this.#db = input.db;
    this.#fallback = input.fallback ?? new InMemoryObservabilitySink();
  }

  appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    return this.#fallback.appendAudit(event);
  }

  listAudit(): Promise<readonly ChainedAuditEvent[]> {
    return this.#fallback.listAudit();
  }

  verifyAuditChain(): Promise<boolean> {
    return this.#fallback.verifyAuditChain();
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
        event.spaceId ?? null,
        event.groupId ?? null,
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
    if (query.spaceId) {
      where.push("space_id = ?");
      params.push(query.spaceId);
    }
    if (query.groupId) {
      where.push("group_id = ?");
      params.push(query.groupId);
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
    const rows = await this.#db.prepare(sql).bind(...params).all<MetricRow>();
    return (rows.results ?? []).map(metricEventFromRow);
  }

  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    return this.#fallback.recordTrace(event);
  }

  listTraces(query?: TraceSpanQuery): Promise<readonly TraceSpanEvent[]> {
    return this.#fallback.listTraces(query);
  }

  #ensureSchema(): Promise<void> {
    this.#schemaReady ??= ensureD1ObservabilityMetricsSchema(this.#db);
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

async function ensureD1ObservabilityMetricsSchema(
  db: D1Database,
): Promise<void> {
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
}

async function ensureMetricColumn(
  db: D1Database,
  column: string,
  definition: string,
): Promise<void> {
  const existing = await db
    .prepare("pragma table_info(takosumi_observability_metrics)")
    .all<{ name: string }>();
  const hasColumn = (existing.results ?? []).some((row) =>
    row.name === column
  );
  if (hasColumn) return;
  await db
    .prepare(`alter table takosumi_observability_metrics add column ${definition}`)
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
    ...(row.space_id ? { spaceId: row.space_id } : {}),
    ...(row.group_id ? { groupId: row.group_id } : {}),
    ...(row.actor_json
      ? {
        actor: parseJsonObject(row.actor_json) as unknown as MetricEvent[
          "actor"
        ],
      }
      : {}),
    ...(row.payload_json
      ? { payload: parseJsonObject(row.payload_json) }
      : {}),
    observedAt: row.observed_at,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
  } as MetricEvent;
}

function metricKind(value: string): MetricEvent["kind"] {
  return value === "counter" || value === "histogram" ? value : "gauge";
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
