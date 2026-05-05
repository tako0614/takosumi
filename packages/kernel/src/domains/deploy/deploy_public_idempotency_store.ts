export interface DeployPublicIdempotencyRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly createdAt: string;
}

export interface DeployPublicIdempotencySaveInput {
  readonly tenantId: string;
  readonly key: string;
  readonly requestDigest: string;
  readonly responseStatus: number;
  readonly responseBody: unknown;
  readonly now: string;
}

export interface DeployPublicIdempotencyStore {
  get(
    tenantId: string,
    key: string,
  ): Promise<DeployPublicIdempotencyRecord | undefined>;
  /**
   * Persist the first response for `(tenantId, key)`. Implementations must
   * not overwrite an existing row; on collision they return the existing row.
   */
  save(
    input: DeployPublicIdempotencySaveInput,
  ): Promise<DeployPublicIdempotencyRecord>;
  acquireLock(tenantId: string, key: string): Promise<void>;
  releaseLock(tenantId: string, key: string): Promise<void>;
}

interface LockEntry {
  readonly waitFor: Promise<void>;
  readonly release: () => void;
}

export class InMemoryDeployPublicIdempotencyStore
  implements DeployPublicIdempotencyStore {
  readonly #rows = new Map<string, DeployPublicIdempotencyRecord>();
  readonly #locks = new Map<string, LockEntry>();
  readonly #idFactory: () => string;

  constructor(options: { readonly idFactory?: () => string } = {}) {
    this.#idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  get(
    tenantId: string,
    key: string,
  ): Promise<DeployPublicIdempotencyRecord | undefined> {
    return Promise.resolve(this.#rows.get(naturalKey(tenantId, key)));
  }

  save(
    input: DeployPublicIdempotencySaveInput,
  ): Promise<DeployPublicIdempotencyRecord> {
    const key = naturalKey(input.tenantId, input.key);
    const existing = this.#rows.get(key);
    if (existing) return Promise.resolve(existing);
    const record: DeployPublicIdempotencyRecord = {
      id: this.#idFactory(),
      tenantId: input.tenantId,
      key: input.key,
      requestDigest: input.requestDigest,
      responseStatus: input.responseStatus,
      responseBody: input.responseBody,
      createdAt: input.now,
    };
    this.#rows.set(key, record);
    return Promise.resolve(record);
  }

  async acquireLock(tenantId: string, key: string): Promise<void> {
    const lockKey = naturalKey(tenantId, key);
    while (this.#locks.has(lockKey)) {
      const tail = this.#locks.get(lockKey);
      if (!tail) break;
      await tail.waitFor;
    }
    let release!: () => void;
    const waitFor = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(lockKey, { waitFor, release });
  }

  releaseLock(tenantId: string, key: string): Promise<void> {
    const lockKey = naturalKey(tenantId, key);
    const entry = this.#locks.get(lockKey);
    if (!entry) return Promise.resolve();
    this.#locks.delete(lockKey);
    entry.release();
    return Promise.resolve();
  }
}

function naturalKey(tenantId: string, key: string): string {
  return `${tenantId} ${key}`;
}
