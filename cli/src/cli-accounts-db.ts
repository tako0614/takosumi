import { readdir, readFile } from "node:fs/promises";
import pgModule from "pg";
import {
  type AccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import {
  booleanOption,
  optionalEnvString,
  optionalStringOption,
  validatePostgresUrl,
} from "./cli-options.ts";
import { sha256Hex } from "./cli-util.ts";

/**
 * npm `pg` query result shape. Only `.rows` is consumed here; this mirrors the
 * subset that `deploy/node-postgres/src/server.ts` relies on so the CLI and the
 * node-postgres reference distribution speak to the same driver API.
 */
interface PgQueryResult<T> {
  rows: T[];
}

/**
 * The subset of the npm `pg` `PoolClient` used by this module: parameterised
 * `query` plus `release`. `pg` returns `{ rows }` from `query`, which the
 * `PostgresQueryClient` wrapper and the migration runner below adapt.
 */
interface PgPoolClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<T>>;
  release(): void;
}

interface PgPool {
  connect(): Promise<PgPoolClient>;
  end(): Promise<void>;
}

interface PgPoolConfig {
  connectionString: string;
  max?: number;
}

type PgPoolConstructor = new (config: PgPoolConfig) => PgPool;

/**
 * Resolve the npm `pg` `Pool` constructor across CJS/ESM interop shapes.
 * Identical resolution to `deploy/node-postgres/src/server.ts` so both entry
 * points behave the same regardless of how `pg` is loaded.
 */
function resolvePoolCtor(): PgPoolConstructor {
  const candidate =
    (pgModule as { default?: { Pool?: PgPoolConstructor } }).default?.Pool ??
    (pgModule as unknown as { Pool?: PgPoolConstructor }).Pool;
  if (!candidate) throw new Error("npm:pg Pool export missing");
  return candidate;
}

export interface AccountsDatabaseConfig {
  url: string;
  source: "--database-url" | "TAKOSUMI_ACCOUNTS_DATABASE_URL";
}

export interface AccountsStoreResource {
  store?: AccountsStore;
  close?: () => Promise<void>;
}

export interface AccountsMigration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export async function buildAccountsDatabaseConfig(
  options: Record<string, string | boolean>,
): Promise<AccountsDatabaseConfig | undefined> {
  if (options.databaseUrl === true) {
    throw new TypeError("--database-url requires a value");
  }
  const explicitUrl = optionalStringOption(options, "databaseUrl");
  if (explicitUrl) {
    return {
      url: validatePostgresUrl(explicitUrl, "--database-url"),
      source: "--database-url",
    };
  }
  const envUrl = await optionalEnvString("TAKOSUMI_ACCOUNTS_DATABASE_URL");
  if (!envUrl) return undefined;
  return {
    url: validatePostgresUrl(envUrl, "TAKOSUMI_ACCOUNTS_DATABASE_URL"),
    source: "TAKOSUMI_ACCOUNTS_DATABASE_URL",
  };
}

export async function createAccountsStoreResource(
  config: AccountsDatabaseConfig | undefined,
): Promise<AccountsStoreResource> {
  if (!config) return {};
  const Pool = resolvePoolCtor();
  const pool = new Pool({ connectionString: config.url, max: 10 });
  const client = await pool.connect();
  client.release();
  const queryClient: PostgresQueryClient = {
    async queryObject<T>(sql: string, args: readonly unknown[] = []) {
      const client = await pool.connect();
      try {
        const result = await client.query<T>(sql, [...args]);
        return { rows: result.rows };
      } finally {
        client.release();
      }
    },
  };
  return {
    store: new PostgresAccountsStore(queryClient),
    close: () => pool.end(),
  };
}

export async function loadAccountsMigrations(): Promise<
  readonly AccountsMigration[]
> {
  const migrationsDir = new URL(
    "../../accounts/service/migrations/",
    import.meta.url,
  );
  const entries = [];
  for (const entry of await readdir(migrationsDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".sql")) entries.push(entry.name);
  }
  entries.sort();
  const migrations: AccountsMigration[] = [];
  for (const [index, name] of entries.entries()) {
    const version = Number(name.slice(0, 3));
    if (!Number.isInteger(version) || version !== index + 1) {
      throw new TypeError(
        `migration ${name} must use prefix ${String(index + 1).padStart(
          3,
          "0",
        )}`,
      );
    }
    const sql = await readFile(new URL(name, migrationsDir), "utf8");
    migrations.push({
      version,
      name,
      sql,
      checksum: await sha256Hex(sql),
    });
  }
  if (migrations.length === 0) {
    throw new TypeError("no SQL migrations found");
  }
  return migrations;
}

export function accountsMigratePlan(
  databaseConfig: AccountsDatabaseConfig | undefined,
  migrations: readonly AccountsMigration[],
): Record<string, unknown> {
  return {
    kind: "takosumi.accounts.migrate@v1",
    database: databaseConfig
      ? {
          configured: true,
          driver: "postgres",
          source: databaseConfig.source,
        }
      : { configured: false },
    migrations: migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
      checksum: `sha256:${migration.checksum}`,
    })),
  };
}

/**
 * Postgres advisory lock ID for the Takosumi accounts migration runner.
 *
 * Hashed at runtime from a stable label so multiple parallel deploy jobs (CI
 * runners, blue/green promotion, manual operator) cannot race the ledger.
 *
 * Acquired before reading the ledger and released after the last migration
 * commits. This is Takosumi Accounts internal storage maintenance, not a
 * Capsule/app migration contract.
 */
const ADVISORY_LOCK_LABEL = "takosumi_accounts_migrations";
export async function applyAccountsMigrations(
  config: AccountsDatabaseConfig,
  migrations: readonly AccountsMigration[],
): Promise<{ applied: AccountsMigration[]; skipped: AccountsMigration[] }> {
  const Pool = resolvePoolCtor();
  const pool = new Pool({ connectionString: config.url, max: 1 });
  const client = await pool.connect();
  const applied: AccountsMigration[] = [];
  const skipped: AccountsMigration[] = [];
  let advisoryLockHeld = false;
  try {
    // Serialize concurrent migration runs cluster-wide via a session-scoped
    // advisory lock keyed by hashtext(label). Released in the finally block.
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, [
      ADVISORY_LOCK_LABEL,
    ]);
    advisoryLockHeld = true;
    await client.query(`CREATE SCHEMA IF NOT EXISTS accounts_v1`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS accounts_v1.schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL CHECK (checksum LIKE 'sha256:%'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )`,
    );
    const appliedRows = await client.query<AppliedMigrationRow>(
      `SELECT version, name, checksum
       FROM accounts_v1.schema_migrations
       ORDER BY version`,
    );
    const appliedByVersion = new Map(
      appliedRows.rows.map((row) => [Number(row.version), row]),
    );
    for (const migration of migrations) {
      const expectedChecksum = `sha256:${migration.checksum}`;
      const existing = appliedByVersion.get(migration.version);
      if (existing) {
        if (existing.name !== migration.name) {
          throw new Error(
            `migration ${migration.version} was applied as ${existing.name}, expected ${migration.name}`,
          );
        }
        if (existing.checksum !== expectedChecksum) {
          throw new Error(
            `migration ${migration.name} checksum changed after apply`,
          );
        }
        skipped.push(migration);
        continue;
      }
      await client.query(`BEGIN`);
      try {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO accounts_v1.schema_migrations (version, name, checksum)
           VALUES ($1, $2, $3)`,
          [migration.version, migration.name, expectedChecksum],
        );
        await client.query(`COMMIT`);
      } catch (error) {
        await client.query(`ROLLBACK`);
        throw error;
      }
      applied.push(migration);
    }
  } finally {
    if (advisoryLockHeld) {
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [
          ADVISORY_LOCK_LABEL,
        ]);
      } catch {
        // Connection may already be invalid; the lock auto-releases on
        // session end via pool.end() below.
      }
    }
    client.release();
    await pool.end();
  }
  return { applied, skipped };
}
