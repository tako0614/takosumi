import { postgresStorageMigrationStatements } from "../migrations.ts";
import type { StorageMigrationStatement } from "../migrations.ts";
import {
  noopStorageMigrationLock,
  StorageMigrationCatalogError,
  StorageMigrationRunner,
} from "./mod.ts";
import type {
  AppliedStorageMigration,
  StorageMigrationLock,
} from "./mod.ts";
import type { SqlClient, SqlTransaction } from "../sql.ts";

export type StorageMigrationFixtureScope =
  | "local"
  | "development"
  | "test";

export class StorageMigrationFixtureScopeError extends Error {
  constructor(readonly scope: string) {
    super(
      `storage migration fixture reset is limited to local/development/test, got ${scope}; protected production schemas are forward-only`,
    );
    this.name = "StorageMigrationFixtureScopeError";
  }
}

export class StorageMigrationFixtureResetUnsupportedError extends Error {
  constructor(readonly migrationId: string) {
    super(
      `storage migration ${migrationId} has no fixture reset SQL; cannot reset past it`,
    );
    this.name = "StorageMigrationFixtureResetUnsupportedError";
  }
}

export interface StorageMigrationFixtureResetterOptions {
  /**
   * Runtime checked rather than trusted through the TypeScript type so an
   * untyped caller cannot relabel a protected environment accidentally.
   */
  readonly scope: string;
  readonly migrations?: readonly StorageMigrationStatement[];
  readonly lock?: StorageMigrationLock;
}

export interface ResetStorageMigrationFixturesOptions {
  /**
   * Reset every applied fixture migration whose version is greater than this
   * value. The migration with version === target is retained.
   */
  readonly targetVersion?: number;
  /**
   * Reset the N most-recently applied fixture migrations.
   */
  readonly steps?: number;
  readonly dryRun?: boolean;
}

export interface PlannedStorageFixtureReset {
  readonly migration: StorageMigrationStatement;
  readonly applied: AppliedStorageMigration;
}

export interface ResetStorageMigrationFixturesResult {
  readonly dryRun: boolean;
  readonly planned: readonly PlannedStorageFixtureReset[];
  readonly resetNow: readonly PlannedStorageFixtureReset[];
}

/**
 * Reverse SQL exists solely to rebuild disposable fixtures. This helper owns
 * no connection-string resolver or production credential path; callers must
 * inject a local/test SqlClient and an explicit non-production scope.
 */
export class StorageMigrationFixtureResetter {
  readonly #client: SqlClient;
  readonly #migrations: readonly StorageMigrationStatement[];
  readonly #lock: StorageMigrationLock;
  readonly #runner: StorageMigrationRunner;

  constructor(
    client: SqlClient,
    options: StorageMigrationFixtureResetterOptions,
  ) {
    assertFixtureScope(options.scope);
    this.#client = client;
    this.#migrations = [
      ...(options.migrations ?? postgresStorageMigrationStatements),
    ].sort((left, right) =>
      left.version === right.version
        ? left.id.localeCompare(right.id)
        : left.version - right.version
    );
    this.#lock = options.lock ?? noopStorageMigrationLock;
    this.#runner = new StorageMigrationRunner(client, {
      migrations: this.#migrations,
      lock: this.#lock,
    });
  }

  async planReset(
    options: ResetStorageMigrationFixturesOptions = {},
  ): Promise<readonly PlannedStorageFixtureReset[]> {
    return await this.#planResetUnlocked(options);
  }

  async reset(
    options: ResetStorageMigrationFixturesOptions = {},
  ): Promise<ResetStorageMigrationFixturesResult> {
    const dryRun = options.dryRun === true;
    if (dryRun) {
      const planned = await this.planReset(options);
      return { dryRun, planned, resetNow: [] };
    }

    return await this.#lock.runExclusive(this.#client, async () => {
      const planned = await this.#planResetUnlocked(options);
      if (planned.length === 0) {
        return { dryRun, planned, resetNow: [] };
      }

      const resetNow: PlannedStorageFixtureReset[] = [];
      for (const entry of planned) {
        await this.#runInTransaction(async (sql) => {
          await sql.query(entry.migration.down!);
          await sql.query(
            "delete from storage_migrations where id = :id",
            { id: entry.migration.id },
          );
        });
        resetNow.push(entry);
      }
      return { dryRun, planned, resetNow };
    });
  }

  async #planResetUnlocked(
    options: ResetStorageMigrationFixturesOptions,
  ): Promise<readonly PlannedStorageFixtureReset[]> {
    const applied = (await this.#runner.plan()).applied;
    if (applied.length === 0) return [];

    const byId = new Map(
      this.#migrations.map((migration) => [migration.id, migration] as const),
    );
    const appliedDesc = [...applied].sort((left, right) =>
      left.version === right.version
        ? right.id.localeCompare(left.id)
        : right.version - left.version
    );

    let selected: AppliedStorageMigration[];
    if (typeof options.targetVersion === "number") {
      selected = appliedDesc.filter(
        (row) => row.version > options.targetVersion!,
      );
    } else if (typeof options.steps === "number" && options.steps > 0) {
      selected = appliedDesc.slice(0, options.steps);
    } else if (typeof options.steps === "number") {
      selected = [];
    } else {
      selected = appliedDesc.slice(0, 1);
    }

    return selected.map((row) => {
      const migration = byId.get(row.id);
      if (!migration) {
        throw new StorageMigrationCatalogError(
          `applied fixture migration ${row.id} is not present in the current catalog; refusing to reset`,
        );
      }
      if (!migration.down || migration.down.trim().length === 0) {
        throw new StorageMigrationFixtureResetUnsupportedError(migration.id);
      }
      return { migration, applied: row };
    });
  }

  async #runInTransaction<T>(
    fn: (transaction: SqlTransaction) => T | Promise<T>,
  ): Promise<T> {
    return await this.#client.transaction(fn);
  }
}

export function assertFixtureScope(
  scope: string,
): asserts scope is StorageMigrationFixtureScope {
  if (scope !== "local" && scope !== "development" && scope !== "test") {
    throw new StorageMigrationFixtureScopeError(scope);
  }
}
