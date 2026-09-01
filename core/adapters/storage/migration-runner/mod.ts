import {
  postgresStorageMigrationStatements,
  retiredStorageMigrations,
} from "../migrations.ts";
import type {
  RetiredStorageMigration,
  StorageMigrationStatement,
} from "../migrations.ts";
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
  /**
   * Applied ids whose ledger row still carries the pre-canonical checksum.
   * They are accepted, but `applyPending` rewrites them to the canonical
   * digest so later editorial changes (description, fixture-reset SQL,
   * comments) stop invalidating the ledger. See
   * {@link canonicalStorageMigrationChecksum}.
   */
  readonly legacyChecksumIds: readonly string[];
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
  /** Ledger rows rewritten from the pre-canonical digest during this run. */
  readonly reconciledChecksumIds: readonly string[];
}

export interface StorageMigrationLock {
  runExclusive<T>(
    client: SqlClient,
    fn: () => T | Promise<T>,
  ): Promise<T>;
}

export interface StorageMigrationRunnerOptions {
  readonly migrations?: readonly StorageMigrationStatement[];
  /**
   * Released migrations that have been removed from the catalog on purpose.
   * Their ledger rows stay valid instead of permanently rejecting the
   * database. Defaults to {@link retiredStorageMigrations}.
   */
  readonly retired?: readonly RetiredStorageMigration[];
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
  readonly #retired: readonly RetiredStorageMigration[];
  readonly #lock: StorageMigrationLock;

  constructor(client: SqlClient, options: StorageMigrationRunnerOptions = {}) {
    this.#client = client;
    this.#retired = options.retired ?? retiredStorageMigrations;
    this.#migrations = normalizeCatalog(
      options.migrations ?? postgresStorageMigrationStatements,
      this.#retired,
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
    if (dryRun) {
      return {
        ...await this.plan(),
        dryRun,
        appliedNow: [],
        reconciledChecksumIds: [],
      };
    }

    return await this.#lock.runExclusive(this.#client, async () => {
      // Rewrite pre-canonical ledger rows first. This is the only writer that
      // may touch an already-applied row, and it never changes schema: it
      // re-records the same migration under the canonical digest so editorial
      // changes stop invalidating the ledger.
      const reconciledChecksumIds = await this.#reconcileLegacyChecksums();
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

      return { ...plan, dryRun, appliedNow, reconciledChecksumIds };
    });
  }

  async #reconcileLegacyChecksums(): Promise<readonly string[]> {
    const applied = await this.listAppliedMigrations();
    const canonical = await checksumCatalog(this.#migrations);
    const legacy = await legacyChecksumCatalog(this.#migrations);
    const reconciled: string[] = [];
    for (const row of applied) {
      const expected = canonical.get(row.id);
      if (!expected || row.checksum === expected) continue;
      if (row.checksum !== legacy.get(row.id)) continue;
      await this.#client.query(
        `update storage_migrations set checksum = :checksum
           where id = :id and checksum = :legacy`,
        { checksum: expected, id: row.id, legacy: row.checksum },
      );
      reconciled.push(row.id);
    }
    return reconciled;
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
    const legacyChecksums = await legacyChecksumCatalog(this.#migrations);
    validateAppliedCatalog(applied, this.#migrations, this.#retired);
    const legacyChecksumIds = validateAppliedChecksums(
      applied,
      checksums,
      legacyChecksums,
    );
    const appliedIds = new Set(applied.map((migration) => migration.id));
    const pending = this.#migrations
      .filter((migration) => !appliedIds.has(migration.id))
      .map((migration) => ({
        migration,
        checksum: checksums.get(migration.id) ?? "",
      }));
    return { applied, pending, legacyChecksumIds };
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
        await canonicalStorageMigrationChecksum(migration),
      ] as const
    ),
  );
  return new Map(entries);
}

async function legacyChecksumCatalog(
  migrations: readonly StorageMigrationStatement[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    migrations.map(async (migration) =>
      [
        migration.id,
        await legacyStorageMigrationChecksum(migration),
      ] as const
    ),
  );
  return new Map(entries);
}

/** @returns applied ids still recorded under the pre-canonical digest. */
function validateAppliedChecksums(
  applied: readonly AppliedStorageMigration[],
  checksums: ReadonlyMap<string, string>,
  legacyChecksums: ReadonlyMap<string, string>,
): readonly string[] {
  const legacyIds: string[] = [];
  for (const migration of applied) {
    const expected = checksums.get(migration.id);
    if (!expected || migration.checksum === expected) continue;
    if (migration.checksum === legacyChecksums.get(migration.id)) {
      legacyIds.push(migration.id);
      continue;
    }
    throw new StorageMigrationChecksumMismatchError(
      migration.id,
      expected,
      migration.checksum,
    );
  }
  return legacyIds;
}

function validateAppliedCatalog(
  applied: readonly AppliedStorageMigration[],
  migrations: readonly StorageMigrationStatement[],
  retired: readonly RetiredStorageMigration[],
): void {
  const byId = new Map(migrations.map((migration) =>
    [
      migration.id,
      migration,
    ] as const
  ));
  const retiredById = new Map(retired.map((entry) =>
    [
      entry.id,
      entry,
    ] as const
  ));
  for (const row of applied) {
    const migration = byId.get(row.id);
    if (!migration) {
      const retiredEntry = retiredById.get(row.id);
      if (!retiredEntry) {
        throw new StorageMigrationCatalogError(
          `applied migration ${row.id} v${row.version} is not present in the current catalog; refusing to continue. If it was removed on purpose, declare it in retiredStorageMigrations`,
        );
      }
      if (retiredEntry.version !== row.version) {
        throw new StorageMigrationCatalogError(
          `retired migration ${row.id} recorded version ${row.version}, but the retirement record declares version ${retiredEntry.version}; refusing to continue`,
        );
      }
      continue;
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
  retired: readonly RetiredStorageMigration[],
): readonly StorageMigrationStatement[] {
  const retiredIds = new Set(retired.map((entry) => entry.id));
  const retiredVersions = new Map(
    retired.map((entry) => [entry.version, entry.id] as const),
  );
  const seenIds = new Set<string>();
  const seenVersions = new Set<number>();
  for (const entry of retired) {
    if (seenIds.has(entry.id)) {
      throw new StorageMigrationCatalogError(
        `duplicate retired storage migration id: ${entry.id}`,
      );
    }
    seenIds.add(entry.id);
  }
  seenIds.clear();
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
    if (retiredIds.has(migration.id)) {
      throw new StorageMigrationCatalogError(
        `storage migration id ${migration.id} is declared retired; a retired id must never be reused`,
      );
    }
    const retiredVersionOwner = retiredVersions.get(migration.version);
    if (retiredVersionOwner !== undefined) {
      throw new StorageMigrationCatalogError(
        `storage migration version ${migration.version} was released as retired migration ${retiredVersionOwner}; a retired version must never be reused`,
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

/**
 * Reduce migration SQL to what the database actually executed.
 *
 * Full-line `--` comments, trailing whitespace, and blank lines carry no
 * schema meaning, so they are removed before hashing. Everything else —
 * including indentation inside `$$` bodies and every string literal — is
 * preserved byte for byte: a change there is a real change to what runs.
 */
export function normalizeMigrationSqlForChecksum(sql: string): string {
  return sql
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .filter((line) => line.length > 0 && !line.trimStart().startsWith("--"))
    .join("\n");
}

/**
 * Canonical migration identity: the ordered position plus the executable SQL.
 *
 * `description` and the fixture-reset `down` SQL are deliberately excluded.
 * They are editorial: neither reaches a protected database, so neither may
 * invalidate a ledger row that already recorded a successful apply. This
 * mirrors the D1 control adapter, where the checksum is taken over a declared
 * source rather than over the whole migration object.
 */
export async function canonicalStorageMigrationChecksum(
  migration: StorageMigrationStatement,
): Promise<string> {
  return await sha256Hex(JSON.stringify({
    id: migration.id,
    version: migration.version,
    sql: normalizeMigrationSqlForChecksum(migration.sql),
  }));
}

/**
 * Digest shape used before the canonical scheme. Retained only so ledgers
 * written by an older runner keep verifying until `applyPending` rewrites
 * them; remove once every environment reports no `legacyChecksumIds`.
 */
export async function legacyStorageMigrationChecksum(
  migration: StorageMigrationStatement,
): Promise<string> {
  return await sha256Hex(JSON.stringify({
    id: migration.id,
    version: migration.version,
    domain: migration.domain,
    description: migration.description,
    sql: migration.sql,
    forwardOnly: migration.down === undefined,
    down: migration.down ?? null,
  }));
}

async function sha256Hex(payload: string): Promise<string> {
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
