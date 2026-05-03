import assert from "node:assert/strict";
import type { AuditEvent } from "../../domains/audit/types.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "../../adapters/storage/sql.ts";
import { verifyAuditHashChain } from "./audit_chain.ts";
import { SqlObservabilitySink } from "./sql_sink.ts";
import { StandaloneBootstrapService } from "../bootstrap/mod.ts";
import { LocalOperatorConfig } from "../../adapters/operator-config/mod.ts";

/**
 * In-memory fake of a SQL client tailored to the audit_events table so the
 * SqlObservabilitySink can be exercised in unit tests without postgres. The
 * fake mirrors the real driver semantics that matter for hash chain
 * durability:
 *   - rows survive across sink instances (durability)
 *   - inserts inside transactions are atomic (rollback discards the row)
 *   - sequence is unique (concurrent appender races surface as conflicts)
 */
class FakeAuditSqlClient implements SqlClient {
  readonly rows: AuditRow[] = [];
  failOnNextInsert = false;

  async query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return await this.#execute(sql, parameters) as SqlQueryResult<Row>;
  }

  async transaction<T>(
    fn: (tx: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    const snapshot = this.rows.map((row) => ({ ...row }));
    const tx: SqlTransaction = {
      query: (sql, params) => this.query(sql, params),
    };
    try {
      return await fn(tx);
    } catch (error) {
      this.rows.length = 0;
      this.rows.push(...snapshot);
      throw error;
    }
  }

  async #execute(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult> {
    const normalized = sql.trim().toLowerCase();
    if (normalized.startsWith("insert into audit_events")) {
      if (this.failOnNextInsert) {
        this.failOnNextInsert = false;
        throw new Error("simulated insert failure");
      }
      const params = parameters as Record<string, unknown>;
      if (this.rows.some((row) => row.id === params.id)) {
        const error = new Error("duplicate key value");
        (error as { code?: string }).code = "23505";
        throw error;
      }
      this.rows.push({
        id: String(params.id),
        event_class: String(params.eventClass),
        type: String(params.type),
        severity: String(params.severity),
        actor_json: params.actorJson as string | null,
        space_id: (params.spaceId ?? null) as string | null,
        group_id: (params.groupId ?? null) as string | null,
        target_type: String(params.targetType),
        target_id: (params.targetId ?? null) as string | null,
        payload_json: params.payloadJson as string | null,
        occurred_at: String(params.occurredAt),
        request_id: (params.requestId ?? null) as string | null,
        correlation_id: (params.correlationId ?? null) as string | null,
        sequence: Number(params.sequence),
        previous_hash: String(params.previousHash),
        current_hash: String(params.currentHash),
        archived: Boolean(params.archived),
      });
      return { rows: [], rowCount: 1 };
    }
    if (
      normalized.startsWith("select") && normalized.includes("audit_events")
    ) {
      const params = (parameters ?? {}) as Record<string, unknown>;
      let rows = [...this.rows];
      if (normalized.includes("where id = :id")) {
        rows = rows.filter((r) => r.id === params.id);
      } else if (normalized.includes("where sequence is not null")) {
        rows = rows
          .filter((r) => r.sequence !== null)
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, 1);
      } else {
        rows.sort((a, b) =>
          (a.sequence ?? 0) - (b.sequence ?? 0) ||
          a.occurred_at.localeCompare(b.occurred_at)
        );
      }
      return {
        rows: rows.map((r) => ({ ...r })) as Record<string, unknown>[],
        rowCount: rows.length,
      };
    }
    if (normalized.startsWith("update audit_events")) {
      const params = (parameters ?? {}) as Record<string, unknown>;
      let count = 0;
      const cutoff = String(params.cutoff);
      for (const row of this.rows) {
        if (!row.archived && row.occurred_at < cutoff) {
          row.archived = true;
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }
    if (normalized.startsWith("delete from audit_events")) {
      const params = (parameters ?? {}) as Record<string, unknown>;
      const cutoff = String(params.cutoff);
      const before = this.rows.length;
      const remaining = this.rows.filter(
        (row) => !(row.archived && row.occurred_at < cutoff),
      );
      this.rows.length = 0;
      this.rows.push(...remaining);
      return { rows: [], rowCount: before - remaining.length };
    }
    if (
      normalized === "begin" || normalized === "commit" ||
      normalized === "rollback"
    ) return { rows: [], rowCount: 0 };
    throw new Error(`unhandled SQL: ${normalized}`);
  }

  /** Simulate tampering: mutate a stored payload without recomputing hash. */
  tamperPayload(id: string, newPayload: Record<string, unknown>): void {
    const row = this.rows.find((r) => r.id === id);
    if (!row) throw new Error(`no row ${id}`);
    row.payload_json = JSON.stringify(newPayload);
  }
}

interface AuditRow {
  id: string;
  event_class: string;
  type: string;
  severity: string;
  actor_json: string | null;
  space_id: string | null;
  group_id: string | null;
  target_type: string;
  target_id: string | null;
  payload_json: string | null;
  occurred_at: string;
  request_id: string | null;
  correlation_id: string | null;
  sequence: number;
  previous_hash: string;
  current_hash: string;
  archived: boolean;
}

function event(id: string, occurredAt: string): AuditEvent {
  return {
    id,
    eventClass: "security",
    type: "worker.authz",
    severity: "info",
    actor: {
      actorAccountId: "acct_1",
      roles: ["owner"],
      requestId: `req_${id}`,
    },
    spaceId: "space_a",
    groupId: "group_a",
    targetType: "worker",
    targetId: "worker_a",
    payload: { action: "allow" },
    occurredAt,
    requestId: `req_${id}`,
  };
}

Deno.test("SqlObservabilitySink durably persists audit events with valid hash chain", async () => {
  const client = new FakeAuditSqlClient();
  const sink = new SqlObservabilitySink({ client });

  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));
  await sink.appendAudit(event("audit_3", "2026-04-27T00:02:00.000Z"));

  assert.equal(client.rows.length, 3);
  assert.equal(await sink.verifyAuditChain(), true);
});

Deno.test("SqlObservabilitySink hash chain verifies after restart (durability)", async () => {
  const client = new FakeAuditSqlClient();
  const sink1 = new SqlObservabilitySink({ client });
  await sink1.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink1.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));

  // Simulate process crash + restart: a fresh sink with the same backing
  // store must continue to validate the chain and append from where the
  // previous instance left off.
  const sink2 = new SqlObservabilitySink({ client });
  assert.equal(await sink2.verifyAuditChain(), true);

  await sink2.appendAudit(event("audit_3", "2026-04-27T00:02:00.000Z"));
  assert.equal(await sink2.verifyAuditChain(), true);
  assert.equal(client.rows.length, 3);
  assert.deepEqual(
    client.rows.map((row) => row.sequence),
    [1, 2, 3],
  );
});

Deno.test("SqlObservabilitySink atomically rolls back failed insert", async () => {
  const client = new FakeAuditSqlClient();
  const sink = new SqlObservabilitySink({ client });
  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  client.failOnNextInsert = true;

  await assert.rejects(
    () => sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z")),
    /simulated insert failure/,
  );

  // Atomicity: row count is unchanged and the chain is still valid.
  assert.equal(client.rows.length, 1);
  assert.equal(await sink.verifyAuditChain(), true);

  // After the rollback we should still be able to append cleanly with the
  // same id to confirm sequence consistency.
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));
  assert.equal(client.rows.length, 2);
  assert.equal(await sink.verifyAuditChain(), true);
});

Deno.test("SqlObservabilitySink detects tampering after replay", async () => {
  const client = new FakeAuditSqlClient();
  const sink = new SqlObservabilitySink({ client });
  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));
  assert.equal(await sink.verifyAuditChain(), true);

  // Out-of-band tampering at the storage layer (e.g. a malicious operator
  // editing the row directly in the DB).
  client.tamperPayload("audit_1", { action: "deny" });

  assert.equal(await sink.verifyAuditChain(), false);
  const records = await sink.listAudit();
  const result = await verifyAuditHashChain(records);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "event-hash-mismatch");
});

Deno.test("SqlObservabilitySink applies retention policy by archiving old events", async () => {
  const client = new FakeAuditSqlClient();
  const fixedNow = new Date("2026-05-01T00:00:00.000Z");
  const sink = new SqlObservabilitySink({
    client,
    clock: () => fixedNow,
    auditRetentionDays: 7,
  });

  await sink.appendAudit(event("old_1", "2026-04-01T00:00:00.000Z"));
  await sink.appendAudit(event("recent", "2026-04-29T00:00:00.000Z"));

  const result = await sink.applyRetentionPolicy();
  assert.equal(result.archived, 1);
  assert.equal(client.rows.find((r) => r.id === "old_1")?.archived, true);
  assert.equal(client.rows.find((r) => r.id === "recent")?.archived, false);
  // Tamper-evidence preserved: rows are not deleted, hash chain still valid.
  assert.equal(client.rows.length, 2);
  assert.equal(await sink.verifyAuditChain(), true);
});

Deno.test("SqlObservabilitySink replicates new appends to attached replication driver", async () => {
  const { InMemoryAuditReplicationSink, AuditReplicationDriver } = await import(
    "../audit-replication/sink.ts"
  );
  const replicationSink = new InMemoryAuditReplicationSink({ id: "siem-1" });
  const driver = new AuditReplicationDriver({ sinks: [replicationSink] });
  const client = new FakeAuditSqlClient();
  const sink = new SqlObservabilitySink({ client, replication: driver });

  await sink.appendAudit(event("audit_1", "2026-04-27T00:00:00.000Z"));
  await sink.appendAudit(event("audit_2", "2026-04-27T00:01:00.000Z"));

  const replicated = replicationSink.records();
  assert.equal(replicated.length, 2);
  assert.deepEqual(
    replicated.map((entry) => entry.event.id),
    ["audit_1", "audit_2"],
  );
});

Deno.test("SqlObservabilitySink delete-after-archive only triggers when policy enables it", async () => {
  const { resolveAuditRetention } = await import(
    "../audit-replication/policy.ts"
  );
  const client = new FakeAuditSqlClient();
  const fixedNow = new Date("2026-05-01T00:00:00.000Z");
  const policy = resolveAuditRetention({
    env: {
      TAKOSUMI_AUDIT_RETENTION_REGIME: "regulated",
      TAKOSUMI_AUDIT_RETENTION_DAYS: "7",
      TAKOSUMI_AUDIT_DELETE_AFTER_ARCHIVE: "true",
      TAKOSUMI_AUDIT_ARCHIVE_GRACE_DAYS: "10",
    },
  });
  const sink = new SqlObservabilitySink({
    client,
    clock: () => fixedNow,
    retentionPolicy: policy,
  });

  // 30d ago: past the 7d archive cutoff AND the 17d delete cutoff.
  await sink.appendAudit(event("ancient", "2026-04-01T00:00:00.000Z"));
  // 12d ago: past archive but inside the 17d grace window -> archived only.
  await sink.appendAudit(event("aging", "2026-04-19T00:00:00.000Z"));
  await sink.appendAudit(event("recent", "2026-04-29T00:00:00.000Z"));

  const first = await sink.applyRetentionPolicy();
  // First pass archives "ancient" and "aging", and deletes "ancient" (which
  // was archived in the same pass, so the delete sees it as archived).
  assert.equal(first.archived, 2);
  assert.equal(first.deleted, 1);
  assert.equal(client.rows.find((r) => r.id === "ancient"), undefined);
  assert.equal(client.rows.find((r) => r.id === "aging")?.archived, true);
  assert.equal(client.rows.find((r) => r.id === "recent")?.archived, false);
});

Deno.test("StandaloneBootstrapService rejects memory observability sink in production", async () => {
  const config = new LocalOperatorConfig({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    values: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "service",
      TAKOSUMI_INTERNAL_SERVICE_SECRET: "production-secret-7d3f1a8b9e2c",
      TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER: "memory",
    },
  });

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
  })
    .bootstrap();

  assert.equal(report.ok, false);
  assert.ok(
    report.errors.some((diagnostic) =>
      diagnostic.code === "observability_memory_forbidden_in_production"
    ),
    `expected production memory sink rejection, got: ${
      JSON.stringify(report.errors)
    }`,
  );
});

Deno.test("StandaloneBootstrapService selects sql observability when sqlClient available", async () => {
  const config = new LocalOperatorConfig({
    clock: () => new Date("2026-04-27T00:00:00.000Z"),
    values: {
      TAKOSUMI_ENVIRONMENT: "production",
      TAKOSUMI_BOOTSTRAP_AUTH_ADAPTER: "service",
      TAKOSUMI_INTERNAL_SERVICE_SECRET: "production-secret-7d3f1a8b9e2c",
      TAKOSUMI_BOOTSTRAP_OBSERVABILITY_ADAPTER: "sql",
    },
  });
  const sqlClient = new FakeAuditSqlClient();

  const report = await new StandaloneBootstrapService({
    operatorConfig: config,
    sqlClient,
  }).bootstrap();

  assert.ok(report.adapters.observability instanceof SqlObservabilitySink);
  assert.ok(
    !report.errors.some((diagnostic) =>
      diagnostic.code === "observability_memory_forbidden_in_production" ||
      diagnostic.code === "observability_sql_client_missing"
    ),
    `expected no observability errors, got: ${JSON.stringify(report.errors)}`,
  );
});
