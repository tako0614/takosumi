import type { JsonObject, JsonValue } from "takosumi-contract/reference/compat";
import { and, eq, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { jsonb, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import { log } from "../../shared/log.ts";
import type {
  TakosumiAppliedResourceRecord,
  TakosumiDeploymentRecord,
  TakosumiDeploymentRecordStore,
  TakosumiDeploymentStatus,
  TakosumiDeploymentUpsertInput,
} from "./deployment_record_store.ts";

/**
 * SQL-backed implementation of `TakosumiDeploymentRecordStore` so artifact
 * retention and revoke cleanup evidence survives service restarts. Backs the
 * existing `takosumi_deployment_records` table created by migration
 * `20260430000020_takosumi_deployment_records` and the
 * `takosumi_deployment_record_locks` table created by migration
 * `20260430000022_takosumi_deployment_record_locks`.
 *
 * Locking strategy:
 *  - In-process: a per-(tenant, name) Promise chain serialises concurrent
 *    `acquireLock` callers within ONE service process.
 *  - Cross-process: a SQL lease row in `takosumi_deployment_record_locks` fences
 *    same-key apply / destroy calls across service pods. The holder renews
 *    `locked_until` until `releaseLock`; if the process dies, another pod
 *    can take over after the lease expires.
 */
export class SqlTakosumiDeploymentRecordStore
  implements TakosumiDeploymentRecordStore {
  readonly #client: SqlClient;
  readonly #db: DrizzleSqlBuilder;
  readonly #idFactory: () => string;
  readonly #lockLeaseMs: number;
  readonly #lockHeartbeatMs: number;
  readonly #lockPollMs: number;
  /**
   * Per-key in-process lock chain. While a holder owns the entry, its
   * `tail` Promise blocks any same-process acquirer until the holder
   * calls `releaseLock`. Mirrors the in-memory store's lock chain so same-key
   * evidence updates cannot interleave within one service process.
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
    this.#db = createDrizzleSqlBuilder();
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
    const result = await this.#drizzleQuery<TakosumiDeploymentRow>(
      this.#db.insert(takosumiDeploymentRecords).values({
        id,
        tenantId: input.tenantId,
        name: input.name,
        sourceEvidenceJson: input.sourceEvidence,
        appliedResourcesJson: input.appliedResources,
        status: input.status,
        createdAt: input.now,
        updatedAt: input.now,
      }).onConflictDoUpdate({
        target: [
          takosumiDeploymentRecords.tenantId,
          takosumiDeploymentRecords.name,
        ],
        set: {
          sourceEvidenceJson: sql`excluded.source_evidence_json`,
          appliedResourcesJson: sql`excluded.applied_resources_json`,
          status: sql`excluded.status`,
          updatedAt: sql`excluded.updated_at`,
        },
      }).returning(),
    );
    const row = requireRow(result, "upsert");
    return rowToRecord(row);
  }

  async get(
    tenantId: string,
    name: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const result = await this.#drizzleQuery<TakosumiDeploymentRow>(
      this.#db.select().from(takosumiDeploymentRecords).where(
        and(
          eq(takosumiDeploymentRecords.tenantId, tenantId),
          eq(takosumiDeploymentRecords.name, name),
        ),
      ),
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async list(
    tenantId: string,
  ): Promise<readonly TakosumiDeploymentRecord[]> {
    const result = await this.#drizzleQuery<TakosumiDeploymentRow>(
      this.#db.select().from(takosumiDeploymentRecords).where(
        eq(takosumiDeploymentRecords.tenantId, tenantId),
      ).orderBy(takosumiDeploymentRecords.createdAt),
    );
    return result.rows.map(rowToRecord);
  }

  async markDestroyed(
    tenantId: string,
    name: string,
    now: string,
  ): Promise<TakosumiDeploymentRecord | undefined> {
    const result = await this.#drizzleQuery<TakosumiDeploymentRow>(
      this.#db.update(takosumiDeploymentRecords).set({
        status: "destroyed",
        appliedResourcesJson: [],
        updatedAt: now,
      }).where(
        and(
          eq(takosumiDeploymentRecords.tenantId, tenantId),
          eq(takosumiDeploymentRecords.name, name),
        ),
      ).returning(),
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async remove(tenantId: string, name: string): Promise<boolean> {
    const result = await this.#drizzleQuery<{ id: string }>(
      this.#db.delete(takosumiDeploymentRecords).where(
        and(
          eq(takosumiDeploymentRecords.tenantId, tenantId),
          eq(takosumiDeploymentRecords.name, name),
        ),
      ).returning({ id: takosumiDeploymentRecords.id }),
    );
    return result.rows.length > 0;
  }

  async listReferencedArtifactHashes(): Promise<Set<string>> {
    const result = await this.#drizzleQuery<
      Pick<TakosumiDeploymentRow, "source_evidence_json" | "applied_resources_json">
    >(
      this.#db.select({
        source_evidence_json: takosumiDeploymentRecords.sourceEvidenceJson,
        applied_resources_json: takosumiDeploymentRecords.appliedResourcesJson,
      }).from(takosumiDeploymentRecords),
    );
    const hashes = new Set<string>();
    for (const row of result.rows) {
      collectArtifactHashes(parseJson(row.source_evidence_json) as JsonValue, hashes);
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
      await this.#drizzleQuery(
        this.#db.delete(takosumiDeploymentRecordLocks).where(
          and(
            eq(takosumiDeploymentRecordLocks.tenantId, tenantId),
            eq(takosumiDeploymentRecordLocks.name, name),
            eq(takosumiDeploymentRecordLocks.ownerToken, held.ownerToken),
          ),
        ),
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
      const result = await this.#drizzleQuery<{ owner_token: string }>(
        this.#db.insert(takosumiDeploymentRecordLocks).values({
          tenantId,
          name,
          ownerToken,
          lockedUntil: leaseUntil(this.#lockLeaseMs),
          createdAt: sql`now()`,
          updatedAt: sql`now()`,
        }).onConflictDoUpdate({
          target: [
            takosumiDeploymentRecordLocks.tenantId,
            takosumiDeploymentRecordLocks.name,
          ],
          set: {
            ownerToken: sql`excluded.owner_token`,
            lockedUntil: sql`excluded.locked_until`,
            updatedAt: sql`now()`,
          },
          setWhere: lte(takosumiDeploymentRecordLocks.lockedUntil, sql`now()`),
        }).returning({
          owner_token: takosumiDeploymentRecordLocks.ownerToken,
        }),
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
        log.error("service.deploy.sql_lock_renew_failed", {
          tenantId,
          deploymentName: name,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }, this.#lockHeartbeatMs);
  }

  async #renewSqlLease(
    tenantId: string,
    name: string,
    ownerToken: string,
  ): Promise<void> {
    const result = await this.#drizzleQuery(
      this.#db.update(takosumiDeploymentRecordLocks).set({
        lockedUntil: leaseUntil(this.#lockLeaseMs),
        updatedAt: sql`now()`,
      }).where(
        and(
          eq(takosumiDeploymentRecordLocks.tenantId, tenantId),
          eq(takosumiDeploymentRecordLocks.name, name),
          eq(takosumiDeploymentRecordLocks.ownerToken, ownerToken),
        ),
      ),
    );
    if (result.rowCount === 0) {
      throw new Error("deploy lock lease is no longer held by this process");
    }
  }

  #drizzleQuery<Row extends Record<string, unknown> = Record<string, unknown>>(
    query: DrizzleQuery,
  ): Promise<SqlQueryResult<Row>> {
    const { sql: queryText, params } = query.toSQL();
    return this.#client.query<Row>(queryText, params as SqlParameters);
  }
}

const takosumiDeploymentRecords = pgTable("takosumi_deployment_records", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  name: text("name").notNull(),
  sourceEvidenceJson: jsonb("source_evidence_json").$type<unknown>().notNull(),
  appliedResourcesJson: jsonb("applied_resources_json").$type<unknown>()
    .notNull(),
  status: text("status").notNull(),
  createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
    .notNull(),
  updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
    .notNull(),
}, (table) => [
  uniqueIndex("takosumi_deployment_records_tenant_name_unique").on(
    table.tenantId,
    table.name,
  ),
]);

const takosumiDeploymentRecordLocks = pgTable(
  "takosumi_deployment_record_locks",
  {
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    ownerToken: text("owner_token").notNull(),
    lockedUntil: timestamp("locked_until", {
      mode: "string",
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { mode: "string", withTimezone: true })
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "string", withTimezone: true })
      .notNull(),
  },
);

type DrizzleSqlBuilder = ReturnType<typeof createDrizzleSqlBuilder>;
type DrizzleQuery = {
  toSQL(): { readonly sql: string; readonly params: readonly unknown[] };
};

function createDrizzleSqlBuilder() {
  return drizzle(async () => ({ rows: [] }), {
    schema: {
      takosumiDeploymentRecords,
      takosumiDeploymentRecordLocks,
    },
  });
}

function leaseUntil(leaseMs: number) {
  return sql`now() + (${leaseMs}::integer * interval '1 millisecond')`;
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
  readonly source_evidence_json: unknown;
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
      `takosumi_deployment_records.status carries unknown value: ${row.status}`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    sourceEvidence: parseJson(row.source_evidence_json) as JsonObject,
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
      `takosumi_deployment_records ${operation} returned no row; check INSERT/UPDATE statement`,
    );
  }
  return row;
}

function lockKey(tenantId: string, name: string): string {
  return JSON.stringify([tenantId, name]);
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
