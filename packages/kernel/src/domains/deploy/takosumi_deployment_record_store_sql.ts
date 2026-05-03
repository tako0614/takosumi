import type { JsonObject, JsonValue } from "takosumi-contract";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  TakosumiAppliedResourceRecord,
  TakosumiDeploymentRecord,
  TakosumiDeploymentRecordStore,
  TakosumiDeploymentStatus,
  TakosumiDeploymentUpsertInput,
} from "./takosumi_deployment_record_store.ts";

/**
 * SQL-backed implementation of `TakosumiDeploymentRecordStore` so that the
 * public deploy lifecycle (`POST /v1/deployments` + `takosumi status`)
 * survives kernel restarts. Backs the
 * `takosumi_deployments` table created by migration
 * `20260430000020_takosumi_deployments`.
 *
 * Locking strategy:
 *  - In-process: a per-(tenant, name) Promise chain serialises concurrent
 *    `acquireLock` callers within ONE kernel process. This is the
 *    primary correctness guarantee: the public deploy route holds the
 *    lock around `provider.apply`, the upsert and the response so two
 *    in-flight CLI submissions for the same deployment cannot race
 *    against each other or against the record-store row.
 *  - Cross-process: NOT enforced by this store. Postgres
 *    `pg_advisory_lock` is session-scoped, and a pooled SqlClient
 *    routes successive `acquireLock` / `releaseLock` queries through
 *    different sessions, leaking the held lock on the original
 *    connection. Operators that need cross-pod fencing should either
 *    run a single-writer apply tier or supply a SqlClient that pins
 *    the same connection for an `acquireLock` ... `releaseLock`
 *    bracket and use a backend-appropriate locking primitive (e.g.
 *    `SELECT ... FOR UPDATE` inside a wrapping transaction).
 *
 * Operators on non-Postgres backends should subclass this and override
 * `acquireLock` / `releaseLock` to use their backend's row-level lock
 * primitive. The non-lock methods rely only on `INSERT ... ON CONFLICT
 * DO UPDATE`, which Postgres-compatible drivers (D1, CockroachDB,
 * Yugabyte) support.
 */
export class SqlTakosumiDeploymentRecordStore
  implements TakosumiDeploymentRecordStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;
  /**
   * Per-key in-process lock chain. While a holder owns the entry, its
   * `tail` Promise blocks any same-process acquirer until the holder
   * calls `releaseLock`. Mirrors the in-memory store's lock chain so
   * that the public deploy route's `acquireLock` ... `provider.apply`
   * ... `recordStore.upsert` ... `releaseLock` sequence cannot interleave
   * against itself within one kernel process.
   */
  readonly #localLocks = new Map<string, LocalLockEntry>();

  constructor(input: {
    readonly client: SqlClient;
    readonly idFactory?: () => string;
  }) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ?? (() => crypto.randomUUID());
  }

  async upsert(
    input: TakosumiDeploymentUpsertInput,
  ): Promise<TakosumiDeploymentRecord> {
    const id = this.#idFactory();
    const manifestJson = JSON.stringify(input.manifest);
    const appliedJson = JSON.stringify(input.appliedResources);
    const sql = "insert into takosumi_deployments " +
      "(id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at) " +
      "values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7::timestamptz, $7::timestamptz) " +
      "on conflict (tenant_id, name) do update set " +
      "manifest_json = excluded.manifest_json, " +
      "applied_resources_json = excluded.applied_resources_json, " +
      "status = excluded.status, " +
      "updated_at = excluded.updated_at " +
      "returning id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at";
    const result = await this.#query<TakosumiDeploymentRow>(sql, [
      id,
      input.tenantId,
      input.name,
      manifestJson,
      appliedJson,
      input.status,
      input.now,
    ]);
    const row = requireRow(result, "upsert");
    return rowToRecord(row);
  }

  async get(
    tenantId: string,
    name: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const result = await this.#query<TakosumiDeploymentRow>(
      "select id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at " +
        "from takosumi_deployments where tenant_id = $1 and name = $2",
      [tenantId, name],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async list(
    tenantId: string,
  ): Promise<readonly TakosumiDeploymentRecord[]> {
    const result = await this.#query<TakosumiDeploymentRow>(
      "select id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at " +
        "from takosumi_deployments where tenant_id = $1 order by created_at asc",
      [tenantId],
    );
    return result.rows.map(rowToRecord);
  }

  async markDestroyed(
    tenantId: string,
    name: string,
    now: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const result = await this.#query<TakosumiDeploymentRow>(
      "update takosumi_deployments set " +
        "status = 'destroyed', " +
        "applied_resources_json = '[]'::jsonb, " +
        "updated_at = $3::timestamptz " +
        "where tenant_id = $1 and name = $2 " +
        "returning id, tenant_id, name, manifest_json, applied_resources_json, status, created_at, updated_at",
      [tenantId, name, now],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async remove(tenantId: string, name: string): Promise<boolean> {
    const result = await this.#query<{ id: string }>(
      "delete from takosumi_deployments where tenant_id = $1 and name = $2 returning id",
      [tenantId, name],
    );
    return result.rows.length > 0;
  }

  async listReferencedArtifactHashes(): Promise<Set<string>> {
    const result = await this.#query<
      Pick<TakosumiDeploymentRow, "manifest_json" | "applied_resources_json">
    >(
      "select manifest_json, applied_resources_json from takosumi_deployments",
    );
    const hashes = new Set<string>();
    for (const row of result.rows) {
      collectArtifactHashes(parseJson(row.manifest_json) as JsonValue, hashes);
      const applied = parseJson(
        row.applied_resources_json,
      ) as readonly TakosumiAppliedResourceRecord[];
      for (const entry of applied) {
        collectArtifactHashes(entry.outputs as JsonValue, hashes);
      }
    }
    return hashes;
  }

  async acquireLock(tenantId: string, name: string): Promise<void> {
    const key = lockKey(tenantId, name);
    // Wait for the previous holder (if any) to release before installing
    // our own entry. Mirrors the in-memory store's lock chain so two
    // same-process callers serialise.
    while (this.#localLocks.has(key)) {
      const existing = this.#localLocks.get(key);
      if (!existing) break;
      await existing.tail;
    }
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#localLocks.set(key, { tail, release });
  }

  releaseLock(tenantId: string, name: string): Promise<void> {
    const key = lockKey(tenantId, name);
    const entry = this.#localLocks.get(key);
    if (!entry) {
      // Idempotent: releasing an unheld lock is a no-op so callers can
      // always release in `finally` even when acquire failed.
      return Promise.resolve();
    }
    // Drop the entry BEFORE resolving so the next waiter's
    // `this.#localLocks.has(key)` re-check returns false and the waiter
    // installs its own entry on the next loop iteration. Mirrors the
    // in-memory store's release semantics.
    this.#localLocks.delete(key);
    entry.release();
    return Promise.resolve();
  }

  #query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: SqlParameters,
  ): Promise<SqlQueryResult<Row>> {
    return this.#client.query<Row>(sql, parameters);
  }
}

interface LocalLockEntry {
  /** Promise the next acquirer awaits. Resolves when the holder releases. */
  readonly tail: Promise<void>;
  /** Resolver for `tail`; called from `releaseLock`. */
  readonly release: () => void;
}

interface TakosumiDeploymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly manifest_json: unknown;
  readonly applied_resources_json: unknown;
  readonly status: string;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function rowToRecord(row: TakosumiDeploymentRow): TakosumiDeploymentRecord {
  const status = row.status as TakosumiDeploymentStatus;
  if (
    status !== "applied" && status !== "destroyed" && status !== "failed"
  ) {
    throw new Error(
      `takosumi_deployments.status carries unknown value: ${row.status}`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    manifest: parseJson(row.manifest_json) as JsonObject,
    appliedResources: parseJson(
      row.applied_resources_json,
    ) as readonly TakosumiAppliedResourceRecord[],
    status,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * Postgres `jsonb` columns deserialize as parsed JS objects via `node-pg`;
 * Cloudflare D1 / sqlite drivers return TEXT, which we have to JSON.parse.
 * Accept both shapes so the store works against any compatible driver.
 */
function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "") return null;
    return JSON.parse(value);
  }
  return value;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  // Postgres `timestamptz` round-trips as ISO 8601 already; unify the
  // format so consumers do not have to handle two shapes.
  const trimmed = value.trim();
  // Accept space-separated PG default ("2026-05-02 00:00:00+00") by
  // letting Date parse it then re-serialising.
  if (trimmed.includes(" ") && !trimmed.includes("T")) {
    return new Date(trimmed.replace(" ", "T")).toISOString();
  }
  return trimmed;
}

function requireRow(
  result: SqlQueryResult<TakosumiDeploymentRow>,
  operation: string,
): TakosumiDeploymentRow {
  const row = result.rows[0];
  if (!row) {
    throw new Error(
      `takosumi_deployments ${operation} returned no row; check INSERT/UPDATE statement`,
    );
  }
  return row;
}

function lockKey(tenantId: string, name: string): string {
  return `${tenantId} ${name}`;
}

const ARTIFACT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Mirror of `collectArtifactHashes` from the in-memory store: walk a JSON
 * tree and add every literal `sha256:<64-hex>` string to `into`. Liberal
 * by design — false positives only retain artifacts past their useful
 * life (storage cost) while a false negative would race-delete a still-
 * pinned blob and silently break the next apply.
 */
function collectArtifactHashes(value: JsonValue, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (ARTIFACT_HASH_REGEX.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectArtifactHashes(entry, into);
    return;
  }
  if (typeof value === "object") {
    for (const inner of Object.values(value)) {
      collectArtifactHashes(inner as JsonValue, into);
    }
  }
}
