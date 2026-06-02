import { postgresStorageMigrationStatements } from "../migrations.ts";
import type { StorageMigrationStatement } from "../migrations.ts";
import type { SqlClient, SqlTransaction } from "../sql.ts";

export interface AppliedStorageMigration {
  readonly id: string;
  readonly version: number;
  readonly checksum: string;
  readonly appliedAt?: Date | string;
}

export interface StorageMigrationPlan {
  readonly applied: readonly AppliedStorageMigration[];
  readonly pending: readonly PlannedStorageMigration[];
}

export interface PlannedStorageMigration {
  readonly migration: StorageMigrationStatement;
  readonly checksum: string;
}

export interface ApplyStorageMigrationsOptions {
  readonly dryRun?: boolean;
}

export interface ApplyStorageMigrationsResult extends StorageMigrationPlan {
  readonly dryRun: boolean;
  readonly appliedNow: readonly PlannedStorageMigration[];
}

export interface StorageMigrationLock {
  runExclusive<T>(
    client: SqlClient,
    fn: () => T | Promise<T>,
  ): Promise<T>;
}

export interface StorageMigrationRunnerOptions {
  readonly migrations?: readonly StorageMigrationStatement[];
  readonly lock?: StorageMigrationLock;
}

export class StorageMigrationChecksumMismatchError extends Error {
  constructor(
    readonly migrationId: string,
    readonly expectedChecksum: string,
    readonly actualChecksum: string,
  ) {
    super(
      `storage migration checksum mismatch for ${migrationId}: expected ${expectedChecksum}, got ${actualChecksum}`,
    );
    this.name = "StorageMigrationChecksumMismatchError";
  }
}

export class StorageMigrationCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageMigrationCatalogError";
  }
}

export class StorageMigrationDownNotSupportedError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `storage migration ${migrationId} is forward-only (no down clause); cannot rollback past it`,
    );
    this.name = "StorageMigrationDownNotSupportedError";
  }
}

export interface RollbackStorageMigrationsOptions {
  /**
   * If set, rollback every applied migration whose `version` is strictly
   * greater than this value. The migration with version === target is kept.
   */
  readonly targetVersion?: number;
  /**
   * If set (and targetVersion is not), rollback the N most-recently applied
   * migrations.
   */
  readonly steps?: number;
  readonly dryRun?: boolean;
}

export interface PlannedStorageRollback {
  readonly migration: StorageMigrationStatement;
  readonly applied: AppliedStorageMigration;
}

export interface RollbackStorageMigrationsResult {
  readonly dryRun: boolean;
  readonly planned: readonly PlannedStorageRollback[];
  readonly rolledBackNow: readonly PlannedStorageRollback[];
}

export class StorageMigrationRunner {
  readonly #client: SqlClient;
  readonly #migrations: readonly StorageMigrationStatement[];
  readonly #lock: StorageMigrationLock;

  constructor(client: SqlClient, options: StorageMigrationRunnerOptions = {}) {
    this.#client = client;
    this.#migrations = normalizeCatalog(
      options.migrations ?? postgresStorageMigrationStatements,
    );
    this.#lock = options.lock ?? noopStorageMigrationLock;
  }

  async listAppliedMigrations(): Promise<readonly AppliedStorageMigration[]> {
    await ensureMigrationLedger(this.#client);
    return await readAppliedMigrations(this.#client);
  }

  async plan(): Promise<StorageMigrationPlan> {
    const applied = await this.listAppliedMigrations();
    const checksums = await checksumCatalog(this.#migrations);
    validateAppliedCatalog(applied, this.#migrations);
    validateAppliedChecksums(applied, checksums);
    const appliedIds = new Set(applied.map((migration) => migration.id));
    const pending = this.#migrations
      .filter((migration) => !appliedIds.has(migration.id))
      .map((migration) => ({
        migration,
        checksum: checksums.get(migration.id) ?? "",
      }));
    return { applied, pending };
  }

  async applyPending(
    options: ApplyStorageMigrationsOptions = {},
  ): Promise<ApplyStorageMigrationsResult> {
    const dryRun = options.dryRun === true;
    if (dryRun) return { ...await this.plan(), dryRun, appliedNow: [] };

    return await this.#lock.runExclusive(this.#client, async () => {
      const plan = await this.plan();

      const appliedNow: PlannedStorageMigration[] = [];
      for (const pending of plan.pending) {
        await this.#runInTransaction(async (sql) => {
          await sql.query(pending.migration.sql);
          await sql.query(
            `insert into storage_migrations (id, version, checksum, applied_at)
           values (:id, :version, :checksum, now())`,
            {
              id: pending.migration.id,
              version: pending.migration.version,
              checksum: pending.checksum,
            },
          );
        });
        appliedNow.push(pending);
      }

      return { ...plan, dryRun, appliedNow };
    });
  }

  /**
   * Plan a rollback. Determines which applied migrations would be reversed
   * given the target version or step count, but does not execute anything.
   * Throws if any selected migration lacks a `down` clause (forward-only).
   */
  async planRollback(
    options: RollbackStorageMigrationsOptions = {},
  ): Promise<readonly PlannedStorageRollback[]> {
    return await this.#planRollbackUnlocked(options);
  }

  async #planRollbackUnlocked(
    options: RollbackStorageMigrationsOptions = {},
  ): Promise<readonly PlannedStorageRollback[]> {
    const applied = await this.listAppliedMigrations();
    if (applied.length === 0) return [];

    const byId = new Map(this.#migrations.map((m) => [m.id, m] as const));
    validateAppliedCatalog(applied, this.#migrations);

    // Sort applied DESC so we rollback most recent first.
    const appliedDesc = [...applied].sort((left, right) =>
      left.version === right.version
        ? right.id.localeCompare(left.id)
        : right.version - left.version
    );

    const target = options.targetVersion;
    const steps = options.steps;

    let selected: AppliedStorageMigration[];
    if (typeof target === "number") {
      selected = appliedDesc.filter((row) => row.version > target);
    } else if (typeof steps === "number" && steps > 0) {
      selected = appliedDesc.slice(0, steps);
    } else if (typeof steps === "number" && steps <= 0) {
      selected = [];
    } else {
      // Default: rollback the single most recent applied migration.
      selected = appliedDesc.slice(0, 1);
    }

    const planned: PlannedStorageRollback[] = [];
    for (const row of selected) {
      const migration = byId.get(row.id);
      if (!migration) {
        throw new StorageMigrationCatalogError(
          `applied migration ${row.id} is not present in the current catalog; refusing to rollback`,
        );
      }
      if (!migration.down || migration.down.trim().length === 0) {
        throw new StorageMigrationDownNotSupportedError(migration.id);
      }
      planned.push({ migration, applied: row });
    }
    return planned;
  }

  /**
   * Execute a rollback. Each migration's `down` SQL is run inside a
   * transaction, then the corresponding `storage_migrations` row is removed.
   * If `dryRun` is true the SQL is not run and the ledger is untouched.
   */
  async rollback(
    options: RollbackStorageMigrationsOptions = {},
  ): Promise<RollbackStorageMigrationsResult> {
    const dryRun = options.dryRun === true;
    if (dryRun) {
      const planned = await this.planRollback(options);
      return { dryRun, planned, rolledBackNow: [] };
    }

    return await this.#lock.runExclusive(this.#client, async () => {
      const planned = await this.#planRollbackUnlocked(options);
      if (planned.length === 0) return { dryRun, planned, rolledBackNow: [] };

      const rolledBackNow: PlannedStorageRollback[] = [];
      for (const entry of planned) {
        await this.#runInTransaction(async (sql) => {
          await sql.query(entry.migration.down!);
          await sql.query(
            "delete from storage_migrations where id = :id",
            { id: entry.migration.id },
          );
        });
        rolledBackNow.push(entry);
      }
      return { dryRun, planned, rolledBackNow };
    });
  }

  async #runInTransaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    if (this.#client.transaction) {
      return await this.#client.transaction(fn);
    }

    const transaction = this.#client as SqlTransaction;
    await transaction.query("begin");
    try {
      const result = await fn(transaction);
      if (transaction.commit) await transaction.commit();
      else await transaction.query("commit");
      return result;
    } catch (error) {
      if (transaction.rollback) await transaction.rollback();
      else await transaction.query("rollback");
      throw error;
    }
  }
}

export const noopStorageMigrationLock: StorageMigrationLock = Object.freeze({
  async runExclusive<T>(
    _client: SqlClient,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    return await fn();
  },
});

export function createPostgresAdvisoryStorageMigrationLock(
  classId = 20260430,
  objectId = 1,
): StorageMigrationLock {
  return {
    async runExclusive<T>(
      client: SqlClient,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      await client.query(
        "select pg_advisory_lock(:classId, :objectId)",
        { classId, objectId },
      );
      try {
        return await fn();
      } finally {
        await client.query(
          "select pg_advisory_unlock(:classId, :objectId)",
          { classId, objectId },
        );
      }
    },
  };
}

async function ensureMigrationLedger(client: SqlClient): Promise<void> {
  await client.query(
    `create table if not exists storage_migrations (
       id text primary key,
       version integer not null,
       checksum text not null,
       applied_at timestamptz not null default now()
     )`,
  );
  await client.query(
    "alter table storage_migrations add column if not exists checksum text",
  );
}

async function readAppliedMigrations(
  client: SqlClient,
): Promise<readonly AppliedStorageMigration[]> {
  const result = await client.query<AppliedMigrationRow>(
    "select id, version, checksum, applied_at from storage_migrations order by version asc, id asc",
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    version: Number(row.version),
    checksum: String(row.checksum),
    appliedAt: row.applied_at as Date | string | undefined,
  }));
}

interface AppliedMigrationRow extends Record<string, unknown> {
  readonly id: unknown;
  readonly version: unknown;
  readonly checksum: unknown;
  readonly applied_at?: unknown;
}

async function checksumCatalog(
  migrations: readonly StorageMigrationStatement[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    migrations.map(async (migration) =>
      [
        migration.id,
        await checksumMigration(migration),
      ] as const
    ),
  );
  return new Map(entries);
}

function validateAppliedChecksums(
  applied: readonly AppliedStorageMigration[],
  checksums: ReadonlyMap<string, string>,
): void {
  for (const migration of applied) {
    const expected = checksums.get(migration.id);
    if (expected && migration.checksum !== expected) {
      throw new StorageMigrationChecksumMismatchError(
        migration.id,
        expected,
        migration.checksum,
      );
    }
  }
}

function validateAppliedCatalog(
  applied: readonly AppliedStorageMigration[],
  migrations: readonly StorageMigrationStatement[],
): void {
  const byId = new Map(migrations.map((migration) =>
    [
      migration.id,
      migration,
    ] as const
  ));
  for (const row of applied) {
    const migration = byId.get(row.id);
    if (!migration) {
      throw new StorageMigrationCatalogError(
        `applied migration ${row.id} v${row.version} is not present in the current catalog; refusing to continue`,
      );
    }
    if (migration.version !== row.version) {
      throw new StorageMigrationCatalogError(
        `applied migration ${row.id} recorded version ${row.version}, but current catalog version is ${migration.version}; refusing to continue`,
      );
    }
  }
}

function normalizeCatalog(
  migrations: readonly StorageMigrationStatement[],
): readonly StorageMigrationStatement[] {
  const seenIds = new Set<string>();
  const seenVersions = new Set<number>();
  for (const migration of migrations) {
    if (seenIds.has(migration.id)) {
      throw new StorageMigrationCatalogError(
        `duplicate storage migration id: ${migration.id}`,
      );
    }
    if (seenVersions.has(migration.version)) {
      throw new StorageMigrationCatalogError(
        `duplicate storage migration version: ${migration.version}`,
      );
    }
    seenIds.add(migration.id);
    seenVersions.add(migration.version);
  }
  return [...migrations].sort((left, right) =>
    left.version === right.version
      ? left.id.localeCompare(right.id)
      : left.version - right.version
  );
}

async function checksumMigration(
  migration: StorageMigrationStatement,
): Promise<string> {
  const payload = JSON.stringify({
    id: migration.id,
    version: migration.version,
    domain: migration.domain,
    description: migration.description,
    sql: migration.sql,
    forwardOnly: migration.down === undefined,
    down: migration.down ?? null,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("")
  }`;
}
