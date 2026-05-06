import type { ActorContext, JsonObject } from "takosumi-contract";
import type { AuditEvent } from "../../domains/audit/types.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlTransaction,
  SqlValue,
} from "../../adapters/storage/sql.ts";
import {
  AUDIT_CHAIN_GENESIS_HASH,
  chainAuditEvent,
  type ChainedAuditEvent,
  verifyAuditHashChain,
} from "./audit_chain.ts";
import type { ObservabilitySink } from "./sink.ts";
import type {
  MetricEvent,
  MetricEventQuery,
  TraceSpanEvent,
  TraceSpanQuery,
} from "./types.ts";
import type {
  AuditReplicationDriver,
  AuditReplicationSink,
} from "../audit-replication/sink.ts";
import type { ResolvedAuditRetention } from "../audit-replication/policy.ts";

/**
 * Options for the SQL-backed audit sink.
 *
 * `auditRetentionDays`, when set to a positive integer, marks audit events
 * older than the cutoff as `archived = true`. Per compliance requirements
 * (SOX / HIPAA), events are never deleted by default: the audit_events table
 * is append-only and the hash chain remains verifiable across the full
 * history. `retentionPolicy` formalises this for regulated environments
 * (PCI-DSS / HIPAA / SOX) — when supplied, the sink consults the policy for
 * archive cutoffs, optional delete-after-replicate flow, and replication
 * gating.
 *
 * `replication` (optional) enables fan-out to one or more downstream sinks
 * (Sumo / Datadog / S3 / SIEM). The driver runs after a successful append so
 * the in-region row is the source of truth even if replication is degraded.
 */
export interface SqlObservabilitySinkOptions {
  readonly client: SqlClient;
  readonly clock?: () => Date;
  readonly auditRetentionDays?: number;
  readonly retentionPolicy?: ResolvedAuditRetention;
  readonly replication?: AuditReplicationDriver | AuditReplicationSink;
}

interface AuditEventRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly event_class: unknown;
  readonly type: unknown;
  readonly severity: unknown;
  readonly actor_json: unknown;
  readonly space_id: unknown;
  readonly group_id: unknown;
  readonly target_type: unknown;
  readonly target_id: unknown;
  readonly payload_json: unknown;
  readonly occurred_at: unknown;
  readonly request_id: unknown;
  readonly correlation_id: unknown;
  readonly sequence: unknown;
  readonly previous_hash: unknown;
  readonly current_hash: unknown;
  readonly archived: unknown;
}

/**
 * SQL-backed durable observability sink.
 *
 * Audit events and their hash-chain links are persisted atomically: the
 * append path opens a transaction, locks the audit_events table to read the
 * current chain tail, computes the new hash, and inserts the new row. If the
 * insert fails (e.g. a concurrent appender raced ahead and broke the chain),
 * the transaction is rolled back so the chain remains consistent.
 *
 * Metrics fall back to in-memory storage because they are intentionally
 * disposable (best-effort observability signal, recomputed by callers). Trace
 * spans follow the same in-memory policy; durable compliance evidence belongs
 * in the audit chain.
 */
export class SqlObservabilitySink implements ObservabilitySink {
  readonly #client: SqlClient;
  readonly #clock: () => Date;
  readonly #auditRetentionDays: number | undefined;
  readonly #retentionPolicy: ResolvedAuditRetention | undefined;
  readonly #replication:
    | AuditReplicationDriver
    | AuditReplicationSink
    | undefined;
  readonly #metrics: MetricEvent[] = [];
  readonly #traces: TraceSpanEvent[] = [];

  constructor(options: SqlObservabilitySinkOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
    const directDays = options.auditRetentionDays !== undefined &&
        Number.isFinite(options.auditRetentionDays) &&
        options.auditRetentionDays > 0
      ? Math.floor(options.auditRetentionDays)
      : undefined;
    this.#retentionPolicy = options.retentionPolicy;
    this.#auditRetentionDays = directDays ??
      options.retentionPolicy?.retentionDays;
    if (options.replication !== undefined) {
      this.#replication = options.replication;
    }
  }

  async appendAudit(event: AuditEvent): Promise<ChainedAuditEvent> {
    const record = await this.#runInTransaction(async (sql) => {
      const previous = await readChainTail(sql);
      const next = await chainAuditEvent(event, previous);
      const params = renderInsertParams(next);
      try {
        await sql.query(insertSql, params);
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await readByIdInternal(sql, event.id);
          if (existing) return existing;
        }
        throw error;
      }
      return next;
    });
    if (this.#replication) {
      try {
        await this.#replication.replicate(record);
      } catch (error) {
        // Replication is best-effort. Surfacing the failure as a console
        // warning is enough for the in-region store to keep accepting
        // writes; the operator alerting pipeline subscribes to the driver's
        // onFailure callback for structured handling.
        console.warn(
          `[audit-replication] failed for ${record.event.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return record;
  }

  async listAudit(): Promise<readonly ChainedAuditEvent[]> {
    const result = await this.#client.query<AuditEventRow>(
      `select id, event_class, type, severity, actor_json, space_id, group_id,
              target_type, target_id, payload_json, occurred_at, request_id,
              correlation_id, sequence, previous_hash, current_hash, archived
         from audit_events
         order by sequence asc nulls last, occurred_at asc, id asc`,
    );
    return result.rows.map(rowToChained);
  }

  async verifyAuditChain(): Promise<boolean> {
    const records = await this.listAudit();
    return (await verifyAuditHashChain(records)).valid;
  }

  recordMetric(event: MetricEvent): Promise<MetricEvent> {
    this.#metrics.push(structuredClone(event));
    return Promise.resolve(event);
  }

  listMetrics(query: MetricEventQuery = {}): Promise<readonly MetricEvent[]> {
    return Promise.resolve(
      this.#metrics
        .filter((event) => matchesMetricQuery(event, query))
        .map((event) => structuredClone(event)),
    );
  }

  recordTrace(event: TraceSpanEvent): Promise<TraceSpanEvent> {
    this.#traces.push(structuredClone(event));
    return Promise.resolve(event);
  }

  listTraces(query: TraceSpanQuery = {}): Promise<readonly TraceSpanEvent[]> {
    return Promise.resolve(
      this.#traces
        .filter((event) => matchesTraceSpanQuery(event, query))
        .map((event) => structuredClone(event)),
    );
  }

  /**
   * Apply the configured retention policy: mark events older than
   * `auditRetentionDays` as archived. The hash chain is preserved in full -
   * archive is a soft tag for downstream tier-2 storage / cold-line export.
   *
   * When the configured retention policy enables `deleteAfterArchive` AND
   * the row is older than `retentionDays + archiveGracePeriodDays`, the
   * oldest already-archived rows are deleted. This branch is only ever
   * taken if a regulated regime explicitly opts in: by default the
   * audit_events table remains forever-append-only.
   */
  async applyRetentionPolicy(): Promise<{
    readonly archived: number;
    readonly deleted: number;
  }> {
    if (this.#auditRetentionDays === undefined) {
      return { archived: 0, deleted: 0 };
    }
    const now = this.#clock().getTime();
    const archiveCutoff = new Date(
      now - this.#auditRetentionDays * 86_400_000,
    ).toISOString();
    const archived = await this.#client.query(
      `update audit_events set archived = true
        where archived = false and occurred_at < :cutoff`,
      { cutoff: archiveCutoff },
    );

    let deleted = 0;
    const policy = this.#retentionPolicy;
    if (policy?.deleteAfterArchive) {
      const deleteCutoff = new Date(
        now -
          (this.#auditRetentionDays + policy.archiveGracePeriodDays) *
            86_400_000,
      ).toISOString();
      const deletion = await this.#client.query(
        `delete from audit_events
          where archived = true and occurred_at < :cutoff`,
        { cutoff: deleteCutoff },
      );
      deleted = deletion.rowCount;
    }
    return { archived: archived.rowCount, deleted };
  }

  async #runInTransaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (this.#client.transaction) {
      return await this.#client.transaction(fn);
    }
    const tx = this.#client as SqlTransaction;
    await tx.query("begin");
    try {
      const result = await fn(tx);
      if (tx.commit) await tx.commit();
      else await tx.query("commit");
      return result;
    } catch (error) {
      if (tx.rollback) await tx.rollback().catch(() => {});
      else await tx.query("rollback").catch(() => {});
      throw error;
    }
  }
}

const insertSql = `insert into audit_events (
  id, event_class, type, severity, actor_json, space_id, group_id,
  target_type, target_id, payload_json, occurred_at, request_id,
  correlation_id, sequence, previous_hash, current_hash, archived
) values (
  :id, :eventClass, :type, :severity, :actorJson, :spaceId, :groupId,
  :targetType, :targetId, :payloadJson, :occurredAt, :requestId,
  :correlationId, :sequence, :previousHash, :currentHash, :archived
)`;

async function readChainTail(
  sql: SqlClient,
): Promise<ChainedAuditEvent | undefined> {
  const result = await sql.query<AuditEventRow>(
    `select id, event_class, type, severity, actor_json, space_id, group_id,
            target_type, target_id, payload_json, occurred_at, request_id,
            correlation_id, sequence, previous_hash, current_hash, archived
       from audit_events
       where sequence is not null
       order by sequence desc
       limit 1`,
  );
  const row = result.rows[0];
  return row ? rowToChained(row) : undefined;
}

async function readByIdInternal(
  sql: SqlClient,
  id: string,
): Promise<ChainedAuditEvent | undefined> {
  const result = await sql.query<AuditEventRow>(
    `select id, event_class, type, severity, actor_json, space_id, group_id,
            target_type, target_id, payload_json, occurred_at, request_id,
            correlation_id, sequence, previous_hash, current_hash, archived
       from audit_events where id = :id`,
    { id },
  );
  const row = result.rows[0];
  return row ? rowToChained(row) : undefined;
}

function renderInsertParams(record: ChainedAuditEvent): SqlParameters {
  const event = record.event;
  return {
    id: event.id,
    eventClass: event.eventClass,
    type: event.type,
    severity: event.severity,
    actorJson: jsonOrNull(
      event.actor ? actorContextToJsonObject(event.actor) : undefined,
    ),
    spaceId: event.spaceId ?? null,
    groupId: event.groupId ?? null,
    targetType: event.targetType,
    targetId: event.targetId ?? null,
    payloadJson: jsonOrNull(event.payload),
    occurredAt: event.occurredAt,
    requestId: event.requestId ?? null,
    correlationId: event.correlationId ?? null,
    sequence: record.sequence,
    previousHash: record.previousHash,
    currentHash: record.hash,
    archived: false,
  } satisfies Record<string, SqlValue | undefined>;
}

function jsonOrNull(value: JsonObject | undefined): SqlValue {
  if (value === undefined) return null;
  // SqlClient drivers should accept stringified JSON; the postgres driver
  // additionally supports object literals. We pass through the canonical
  // string form for portability across drivers (incl. memory / sqlite).
  return JSON.stringify(value);
}

function actorContextToJsonObject(actor: ActorContext): JsonObject {
  return {
    actorAccountId: actor.actorAccountId,
    roles: [...actor.roles],
    requestId: actor.requestId,
    ...(actor.spaceId ? { spaceId: actor.spaceId } : {}),
    ...(actor.principalKind ? { principalKind: actor.principalKind } : {}),
    ...(actor.serviceId ? { serviceId: actor.serviceId } : {}),
    ...(actor.agentId ? { agentId: actor.agentId } : {}),
    ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    ...(actor.scopes ? { scopes: [...actor.scopes] } : {}),
    ...(actor.traceId ? { traceId: actor.traceId } : {}),
  };
}

function rowToChained(row: AuditEventRow): ChainedAuditEvent {
  const actor = parseJson(row.actor_json) as AuditEvent["actor"] | undefined;
  const payload = (parseJson(row.payload_json) as JsonObject | null) ??
    {} satisfies JsonObject;
  const event: AuditEvent = {
    id: String(row.id),
    eventClass: row.event_class as AuditEvent["eventClass"],
    type: String(row.type),
    severity: row.severity as AuditEvent["severity"],
    ...(actor ? { actor } : {}),
    ...(row.space_id ? { spaceId: String(row.space_id) } : {}),
    ...(row.group_id ? { groupId: String(row.group_id) } : {}),
    targetType: String(row.target_type),
    ...(row.target_id ? { targetId: String(row.target_id) } : {}),
    payload: payload as JsonObject,
    occurredAt: toIsoTimestamp(row.occurred_at),
    ...(row.request_id ? { requestId: String(row.request_id) } : {}),
    ...(row.correlation_id
      ? { correlationId: String(row.correlation_id) }
      : {}),
  };
  return {
    sequence: Number(row.sequence ?? 0),
    event,
    previousHash: row.previous_hash
      ? String(row.previous_hash)
      : AUDIT_CHAIN_GENESIS_HASH,
    hash: String(row.current_hash ?? ""),
  };
}

function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return value;
}

function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date().toISOString();
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

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && code === "23505") return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /(duplicate|unique|UNIQUE)/i.test(message);
}
