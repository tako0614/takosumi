import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
} from "../../adapters/storage/sql.ts";
import type {
  DeployPublicIdempotencyRecord,
  DeployPublicIdempotencySaveInput,
  DeployPublicIdempotencyStore,
} from "./deploy_public_idempotency_store.ts";

export class SqlDeployPublicIdempotencyStore
  implements DeployPublicIdempotencyStore {
  readonly #client: SqlClient;
  readonly #idFactory: () => string;
  readonly #lockLeaseMs: number;
  readonly #lockHeartbeatMs: number;
  readonly #lockPollMs: number;
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

  async get(
    tenantId: string,
    key: string,
  ): Promise<DeployPublicIdempotencyRecord | undefined> {
    const result = await this.#query<DeployPublicIdempotencyRow>(
      "select id, tenant_id, idempotency_key, request_digest, response_status, response_body_json, created_at " +
        "from takosumi_deploy_idempotency_keys where tenant_id = $1 and idempotency_key = $2",
      [tenantId, key],
    );
    const row = result.rows[0];
    return row ? rowToRecord(row) : undefined;
  }

  async save(
    input: DeployPublicIdempotencySaveInput,
  ): Promise<DeployPublicIdempotencyRecord> {
    const id = this.#idFactory();
    const responseBodyJson = JSON.stringify(input.responseBody);
    const result = await this.#query<DeployPublicIdempotencyRow>(
      "insert into takosumi_deploy_idempotency_keys " +
        "(id, tenant_id, idempotency_key, request_digest, response_status, response_body_json, created_at) " +
        "values ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz) " +
        "on conflict (tenant_id, idempotency_key) do nothing " +
        "returning id, tenant_id, idempotency_key, request_digest, response_status, response_body_json, created_at",
      [
        id,
        input.tenantId,
        input.key,
        input.requestDigest,
        input.responseStatus,
        responseBodyJson,
        input.now,
      ],
    );
    const inserted = result.rows[0];
    if (inserted) return rowToRecord(inserted);
    const existing = await this.get(input.tenantId, input.key);
    if (existing) return existing;
    throw new Error(
      "takosumi_deploy_idempotency_keys insert conflicted but no row was readable",
    );
  }

  async acquireLock(tenantId: string, key: string): Promise<void> {
    const lockName = lockKey(tenantId, key);
    await this.#acquireLocalLock(lockName);
    const ownerToken = crypto.randomUUID();
    try {
      await this.#acquireSqlLease(tenantId, key, ownerToken);
      this.#heldSqlLocks.set(lockName, {
        ownerToken,
        renewalTimer: this.#startLeaseRenewal(tenantId, key, ownerToken),
      });
    } catch (error) {
      this.#releaseLocalLock(lockName);
      throw error;
    }
  }

  async releaseLock(tenantId: string, key: string): Promise<void> {
    const lockName = lockKey(tenantId, key);
    const held = this.#heldSqlLocks.get(lockName);
    if (!held) {
      this.#releaseLocalLock(lockName);
      return;
    }
    clearInterval(held.renewalTimer);
    this.#heldSqlLocks.delete(lockName);
    try {
      await this.#query(
        "delete from takosumi_deploy_idempotency_locks " +
          "where tenant_id = $1 and idempotency_key = $2 and owner_token = $3",
        [tenantId, key, held.ownerToken],
      );
    } finally {
      this.#releaseLocalLock(lockName);
    }
  }

  async #acquireLocalLock(lockName: string): Promise<void> {
    while (this.#localLocks.has(lockName)) {
      const existing = this.#localLocks.get(lockName);
      if (!existing) break;
      await existing.tail;
    }
    let release!: () => void;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#localLocks.set(lockName, { tail, release });
  }

  #releaseLocalLock(lockName: string): void {
    const entry = this.#localLocks.get(lockName);
    if (!entry) return;
    this.#localLocks.delete(lockName);
    entry.release();
  }

  async #acquireSqlLease(
    tenantId: string,
    key: string,
    ownerToken: string,
  ): Promise<void> {
    while (true) {
      const result = await this.#query<{ owner_token: string }>(
        "insert into takosumi_deploy_idempotency_locks " +
          "(tenant_id, idempotency_key, owner_token, locked_until, created_at, updated_at) " +
          "values ($1, $2, $3, now() + ($4::integer * interval '1 millisecond'), now(), now()) " +
          "on conflict (tenant_id, idempotency_key) do update set " +
          "owner_token = excluded.owner_token, " +
          "locked_until = excluded.locked_until, " +
          "updated_at = now() " +
          "where takosumi_deploy_idempotency_locks.locked_until <= now() " +
          "returning owner_token",
        [tenantId, key, ownerToken, this.#lockLeaseMs],
      );
      if (result.rows[0]?.owner_token === ownerToken) return;
      await delay(this.#lockPollMs);
    }
  }

  #startLeaseRenewal(
    tenantId: string,
    key: string,
    ownerToken: string,
  ): ReturnType<typeof setInterval> {
    return setInterval(() => {
      this.#renewSqlLease(tenantId, key, ownerToken).catch((error) => {
        console.error(
          `[takosumi-deploy] failed to renew SQL deploy idempotency lock tenant=${tenantId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }, this.#lockHeartbeatMs);
  }

  async #renewSqlLease(
    tenantId: string,
    key: string,
    ownerToken: string,
  ): Promise<void> {
    const result = await this.#query(
      "update takosumi_deploy_idempotency_locks set " +
        "locked_until = now() + ($4::integer * interval '1 millisecond'), " +
        "updated_at = now() " +
        "where tenant_id = $1 and idempotency_key = $2 and owner_token = $3",
      [tenantId, key, ownerToken, this.#lockLeaseMs],
    );
    if (result.rowCount === 0) {
      throw new Error(
        "deploy idempotency lock lease is no longer held by this process",
      );
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
  readonly tail: Promise<void>;
  readonly release: () => void;
}

interface HeldSqlLockEntry {
  readonly ownerToken: string;
  readonly renewalTimer: ReturnType<typeof setInterval>;
}

interface DeployPublicIdempotencyRow extends Record<string, unknown> {
  readonly id: string;
  readonly tenant_id: string;
  readonly idempotency_key: string;
  readonly request_digest: string;
  readonly response_status: number;
  readonly response_body_json: unknown;
  readonly created_at: string | Date;
}

function rowToRecord(
  row: DeployPublicIdempotencyRow,
): DeployPublicIdempotencyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    key: row.idempotency_key,
    requestDigest: row.request_digest,
    responseStatus: Number(row.response_status),
    responseBody: parseJson(row.response_body_json),
    createdAt: toIsoString(row.created_at),
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

function toIsoString(value: string | Date): string {
  if (value instanceof Date) return value.toISOString();
  const trimmed = value.trim();
  if (trimmed.includes(" ") && !trimmed.includes("T")) {
    return new Date(trimmed.replace(" ", "T")).toISOString();
  }
  return trimmed;
}

function lockKey(tenantId: string, key: string): string {
  return JSON.stringify([tenantId, key]);
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number") return undefined;
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
