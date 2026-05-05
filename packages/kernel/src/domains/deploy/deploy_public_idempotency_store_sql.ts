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
  readonly #localLocks = new Map<string, LocalLockEntry>();

  constructor(input: {
    readonly client: SqlClient;
    readonly idFactory?: () => string;
  }) {
    this.#client = input.client;
    this.#idFactory = input.idFactory ?? (() => crypto.randomUUID());
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
    while (this.#localLocks.has(lockName)) {
      const tail = this.#localLocks.get(lockName);
      if (!tail) break;
      await tail.waitFor;
    }
    let release!: () => void;
    const waitFor = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#localLocks.set(lockName, { waitFor, release });
  }

  releaseLock(tenantId: string, key: string): Promise<void> {
    const lockName = lockKey(tenantId, key);
    const entry = this.#localLocks.get(lockName);
    if (!entry) return Promise.resolve();
    this.#localLocks.delete(lockName);
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
  readonly waitFor: Promise<void>;
  readonly release: () => void;
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
  return `${tenantId} ${key}`;
}
