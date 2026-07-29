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

export class StorageMigrationPendingError extends Error {
  constructor(readonly migrationIds: readonly string[]) {
    super(
      `storage schema is not current; apply pending migrations before startup: ${
        migrationIds.join(", ")
      }`,
    );
    this.name = "StorageMigrationPendingError";
  }
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
    return await this.#planForApplied(applied);
  }

  /**
   * Read-only startup verification for an already-migrated database.
   *
   * Unlike {@link plan}, this does not create or alter the migration ledger.
   * A missing ledger therefore fails through the database query instead of
   * silently turning application startup into a schema mutation. Pending
   * migrations, catalog drift, and checksum drift all reject startup.
   */
  async verifyCurrent(): Promise<StorageMigrationPlan> {
    const applied = await readAppliedMigrations(this.#client);
    const plan = await this.#planForApplied(applied);
    if (plan.pending.length > 0) {
      throw new StorageMigrationPendingError(
        plan.pending.map((entry) => entry.migration.id),
      );
    }
    return plan;
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

  async #runInTransaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return await this.#client.transaction(fn);
  }

  async #planForApplied(
    applied: readonly AppliedStorageMigration[],
  ): Promise<StorageMigrationPlan> {
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
}

export const noopStorageMigrationLock: StorageMigrationLock = Object.freeze({
  async runExclusive<T>(
    _client: SqlClient,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    return await fn();
  },
});

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
