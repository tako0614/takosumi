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
 * `20260430000020_takosumi_deployments` and the
 * `takosumi_deploy_locks` table created by migration
 * `20260430000022_takosumi_deploy_locks`.
 *
 * Locking strategy:
 *  - In-process: a per-(tenant, name) Promise chain serialises concurrent
 *    `acquireLock` callers within ONE kernel process.
 *  - Cross-process: a SQL lease row in `takosumi_deploy_locks` fences
 *    same-key apply / destroy calls across kernel pods. The holder renews
 *    `locked_until` until `releaseLock`; if the process dies, another pod
 *    can take over after the lease expires.
 */
export class SqlTakosumiDeploymentRecordStore
  implements TakosumiDeploymentRecordStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;
  readonly #lockLeaseMs: number;
  readonly #lockHeartbeatMs: number;
  readonly #lockPollMs: number;
  /**
   * Per-key in-process lock chain. While a holder owns the entry, its
   * `tail` Promise blocks any same-process acquirer until the holder
   * calls `releaseLock`. Mirrors the in-memory store's lock chain so
   * that the public deploy route's `acquireLock` ... `provider.apply`
   * ... `recordStore.upsert` ... `releaseLock` sequence cannot interleave
   * against itself within one kernel process.
   */
  readonly #localLocks = new Map<string, LocalLockEntry>();
  readonly #heldSqlLocks = new Map<string, HeldSqlLockEntry>();

  constructor(input: {
    readonly client: SqlClient;
    readonly idFactory?: () => string;
    readonly lockLeaseMs?: number;
    readonly lockHeartbeatMs?: number;
    readonly lockPollMs?: number;
  }) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ?? (() => crypto.randomUUID());
    this.#lockLeaseMs = positiveInteger(input.lockLeaseMs) ?? 30_000;
    const defaultHeartbeatMs = Math.max(1, Math.floor(this.#lockLeaseMs / 3));
    const configuredHeartbeatMs = positiveInteger(input.lockHeartbeatMs);
    this.#lockHeartbeatMs = configuredHeartbeatMs &&
        configuredHeartbeatMs < this.#lockLeaseMs
      ? configuredHeartbeatMs
      : defaultHeartbeatMs;
    this.#lockPollMs = positiveInteger(input.lockPollMs) ?? 100;
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
    await this.#acquireLocalLock(key);
    const ownerToken = this.#idFactory();
    try {
      await this.#acquireSqlLease(tenantId, name, ownerToken);
      this.#heldSqlLocks.set(key, {
        ownerToken,
        renewalTimer: this.#startLeaseRenewal(tenantId, name, ownerToken),
      });
    } catch (error) {
      this.#releaseLocalLock(key);
      throw error;
    }
  }

  async releaseLock(tenantId: string, name: string): Promise<void> {
    const key = lockKey(tenantId, name);
    const held = this.#heldSqlLocks.get(key);
    if (!held) {
      this.#releaseLocalLock(key);
      return;
    }
    clearInterval(held.renewalTimer);
    this.#heldSqlLocks.delete(key);
    try {
      await this.#query(
        "delete from takosumi_deploy_locks " +
          "where tenant_id = $1 and name = $2 and owner_token = $3",
        [tenantId, name, held.ownerToken],
      );
    } finally {
      this.#releaseLocalLock(key);
    }
  }

  async #acquireLocalLock(key: string): Promise<void> {
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

  #releaseLocalLock(key: string): void {
    const entry = this.#localLocks.get(key);
    if (!entry) {
      // Idempotent: releasing an unheld lock is a no-op so callers can
      // always release in `finally` even when acquire failed.
      return;
    }
    // Drop the entry BEFORE resolving so the next waiter's
    // `this.#localLocks.has(key)` re-check returns false and the waiter
    // installs its own entry on the next loop iteration. Mirrors the
    // in-memory store's release semantics.
    this.#localLocks.delete(key);
    entry.release();
  }

  async #acquireSqlLease(
    tenantId: string,
    name: string,
    ownerToken: string,
  ): Promise<void> {
    while (true) {
      const result = await this.#query<{ owner_token: string }>(
        "insert into takosumi_deploy_locks " +
          "(tenant_id, name, owner_token, locked_until, created_at, updated_at) " +
          "values ($1, $2, $3, now() + ($4::integer * interval '1 millisecond'), now(), now()) " +
          "on conflict (tenant_id, name) do update set " +
          "owner_token = excluded.owner_token, " +
          "locked_until = excluded.locked_until, " +
          "updated_at = now() " +
          "where takosumi_deploy_locks.locked_until <= now() " +
          "returning owner_token",
        [tenantId, name, ownerToken, this.#lockLeaseMs],
      );
      if (result.rows[0]?.owner_token === ownerToken) return;
      await delay(this.#lockPollMs);
    }
  }

  #startLeaseRenewal(
    tenantId: string,
    name: string,
    ownerToken: string,
  ): ReturnType<typeof setInterval> {
    return setInterval(() => {
      this.#renewSqlLease(tenantId, name, ownerToken).catch((error) => {
        console.error(
          `[takosumi-deploy] failed to renew SQL deploy lock tenant=${tenantId} name=${name}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.#lockHeartbeatMs);
  }

  async #renewSqlLease(
    tenantId: string,
    name: string,
    ownerToken: string,
  ): Promise<void> {
    const result = await this.#query(
      "update takosumi_deploy_locks set " +
        "locked_until = now() + ($4::integer * interval '1 millisecond'), " +
        "updated_at = now() " +
        "where tenant_id = $1 and name = $2 and owner_token = $3",
      [tenantId, name, ownerToken, this.#lockLeaseMs],
    );
    if (result.rowCount === 0) {
      throw new Error("deploy lock lease is no longer held by this process");
    }
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

interface HeldSqlLockEntry {
  readonly ownerToken: string;
  readonly renewalTimer: ReturnType<typeof setInterval>;
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

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ARTIFACT_HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * Mirror of `collectArtifactHashes` from the in-memory store: walk a JSON
 * tree and add every literal `sha256:<64-hex>` string to `into`. Liberal
 * intentionally — false positives only retain artifacts past their useful
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
