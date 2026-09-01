import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
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
    async transaction<T>(
      run: (transaction: PostgresQueryClient) => Promise<T>,
    ): Promise<T> {
      const client = await pool.connect();
      const transactionClient: PostgresQueryClient = {
        async queryObject<Row>(
          sql: string,
          args: readonly unknown[] = [],
        ): Promise<{ rows: Row[] }> {
          const result = await client.query<Row>(sql, [...args]);
          return { rows: result.rows };
        },
        transaction: async (nested) => await nested(transactionClient),
      };
      try {
        await client.query("BEGIN");
        const result = await run(transactionClient);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the lifecycle failure and release the broken connection.
        }
        throw error;
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

/**
 * Plan + report shape for the `accounts migrate-d1` subcommand.
 *
 * Cloudflare D1 is the SQLite-backed Workers binding used by the Cloudflare
 * reference distribution (`deploy/accounts-cloudflare/`). Unlike the Postgres
 * `applyAccountsMigrations` path — which streams the
 * `accounts/service/migrations/*.sql` files directly — D1 ships its
 * accounts schema through `D1_ACCOUNTS_STORE_INIT_SQL` (a single-line,
 * idempotent `CREATE TABLE IF NOT EXISTS` script that the D1AccountsStore
 * runs on first request). The CLI command exists to:
 *
 *   - Apply that bootstrap SQL ahead of the first deploy so the operator can
 *     verify the schema lands before traffic arrives, and
 *   - Record the applied version into the
 *     `takosumi_accounts_schema_migrations` table that mirrors the Postgres
 *     tracking shape, so future schema changes can be applied in order
 *     without dropping or recreating the database.
 *
 * Version numbering is shared with the Cloudflare Worker's
 * `EXPECTED_D1_SCHEMA_VERSION` gate (`deploy/accounts-cloudflare/src/handler.ts`).
 * The bootstrap mirrors `D1_ACCOUNTS_STORE_INIT_SQL`, which the Worker also
 * self-applies via `D1AccountsStore.initialize()`, so the bootstrap is the
 * baseline both sides agree on — version 0. The Worker reads the highest
 * `version` from this same table; recording version 0 here keeps a fresh
 * `migrate-d1` run consistent with the Worker baseline instead of tripping
 * the "newer than this Worker expects" gate. The first migration that adds
 * schema BEYOND the bootstrap is version 1, applied in lockstep with a bump
 * of `EXPECTED_D1_SCHEMA_VERSION` to 1.
 *
 * MVP limitations (intentional, see task description):
 *   - Forward-only. No down-migrations.
 *   - Migrations are applied via the operator-installed `wrangler` CLI; we
 *     do not call the Cloudflare D1 HTTP API directly.
 *   - No transaction wraps the per-migration exec + ledger INSERT, and D1's
 *     stateless HTTP `execute` calls cannot hold a session-scoped lock like
 *     the Postgres advisory lock. Concurrency safety therefore relies on two
 *     invariants: (a) every migration SQL is single-statement and replay-safe
 *     (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, etc.), and
 *     (b) the ledger INSERT hits a `PRIMARY KEY (version)` constraint, so a
 *     racing second runner fails loud on the duplicate insert rather than
 *     double-applying. Operators MUST NOT run `migrate-d1` concurrently
 *     against the same database; run it from a single deploy job.
 *   - Each migration SQL must itself be safe under partial replay because the
 *     CLI cannot roll back a half-applied D1 batch — if the SQL fails
 *     mid-flight the ledger row is NOT inserted, so the operator can re-run
 *     and the idempotent statements catch up.
 */
export interface D1AccountsMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const D1_SCHEMA_MIGRATIONS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);";

// Single-line, idempotent statements only — Cloudflare D1's `exec` treats
// each line as a separate statement, so multi-line SQL would fail. Keep new
// migration entries to one statement per element of `sql`.
// Immutable account-plane schema migration catalog begins. Historical field
// names inside this region are migration input only, never current authority.
const D1_ACCOUNTS_MIGRATIONS: readonly D1AccountsMigration[] = [
  {
    // Version 0 = the bootstrap baseline the Worker self-applies via
    // D1AccountsStore.initialize(). Matches EXPECTED_D1_SCHEMA_VERSION in
    // deploy/accounts-cloudflare/src/handler.ts. First post-bootstrap migration is 1.
    version: 0,
    name: "bootstrap_accounts_store",
    // Mirrors D1_ACCOUNTS_STORE_INIT_SQL from accounts-service/src/d1-store.ts.
    // Kept inline so the CLI does not pull a Worker-only module that needs
    // the @cloudflare/workers-types environment.
    sql: [
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_documents (bucket TEXT NOT NULL, key TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (bucket, key));",
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_indexes (index_name TEXT NOT NULL, index_key TEXT NOT NULL, bucket TEXT NOT NULL, document_key TEXT NOT NULL, sort_key INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (index_name, index_key, bucket, document_key));",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_lookup ON takosumi_accounts_indexes (index_name, index_key, sort_key);",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_document ON takosumi_accounts_indexes (bucket, document_key);",
    ].join("\n"),
  },
  {
    version: 1,
    name: "generalize_billing_provider_storage",
    sql: [
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerCustomerId', json_extract(document, '$.stripeCustomerId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerCustomerId') IS NULL AND json_type(document, '$.stripeCustomerId') IS NOT NULL;",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerSubscriptionId', json_extract(document, '$.stripeSubscriptionId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerSubscriptionId') IS NULL AND json_type(document, '$.stripeSubscriptionId') IS NOT NULL;",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerPriceId', json_extract(document, '$.stripePriceId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerPriceId') IS NULL AND json_type(document, '$.stripePriceId') IS NOT NULL;",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerDefaultPaymentMethodId', json_extract(document, '$.stripeDefaultPaymentMethodId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerDefaultPaymentMethodId') IS NULL AND json_type(document, '$.stripeDefaultPaymentMethodId') IS NOT NULL;",
      "UPDATE takosumi_accounts_documents SET document = json_remove(document, '$.stripeCustomerId', '$.stripeSubscriptionId', '$.stripePriceId', '$.stripeDefaultPaymentMethodId') WHERE bucket = 'billing_accounts';",
      "INSERT OR IGNORE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) SELECT 'billing_accounts_by_provider_customer', index_key, bucket, document_key, sort_key FROM takosumi_accounts_indexes WHERE index_name = 'billing_accounts_by_stripe_customer';",
      "DELETE FROM takosumi_accounts_indexes WHERE index_name = 'billing_accounts_by_stripe_customer';",
    ].join("\n"),
  },
  {
    version: 2,
    name: "remove_commercial_billing_persistence",
    sql: [
      "DELETE FROM takosumi_accounts_indexes WHERE bucket IN ('billing_accounts', 'billing_webhook_events', 'billing_usage_records');",
      "DELETE FROM takosumi_accounts_documents WHERE bucket IN ('billing_accounts', 'billing_webhook_events', 'billing_usage_records');",
    ].join("\n"),
  },
  {
    version: 3,
    name: "refresh_chain_retention_indexes",
    sql: [
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_refresh_chain_links_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'refresh_chain_links';",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_refresh_chain_access_tokens_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'refresh_chain_access_tokens';",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_revoked_refresh_roots_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.revokedAt') AS INTEGER), key) WHERE bucket = 'revoked_refresh_roots';",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_consumed_authorization_codes_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.consumedAt') AS INTEGER), key) WHERE bucket = 'consumed_authorization_codes';",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_auth_code_token_links_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'auth_code_token_links';",
    ].join("\n"),
  },
  {
    version: 4,
    name: "authorization_code_redemptions",
    sql: [
      "INSERT OR IGNORE INTO takosumi_accounts_documents (bucket, key, document, updated_at) SELECT 'authorization_code_redemptions', key, json_object('state', 'active', 'recordVersion', 'legacy-active:' || substr(key, 8, 32), 'record', json(document), 'createdAt', updated_at, 'updatedAt', updated_at), updated_at FROM takosumi_accounts_documents WHERE bucket = 'authorization_codes';",
      "INSERT INTO takosumi_accounts_documents (bucket, key, document, updated_at) SELECT 'authorization_code_redemptions', consumed.key, json_object('state', 'issued', 'recordVersion', 'legacy-issued:' || substr(consumed.key, 8, 32), 'claimId', 'legacy-claim:' || substr(consumed.key, 8, 32), 'createdAt', CAST(json_extract(consumed.document, '$.consumedAt') AS INTEGER), 'updatedAt', CAST(json_extract(consumed.document, '$.consumedAt') AS INTEGER), 'issuedAt', (CAST(strftime('%s', 'now') AS INTEGER) * 1000), 'accessTokenHash', (SELECT NULLIF(json_extract(link.document, '$.accessTokenHash'), '') FROM takosumi_accounts_documents AS link WHERE link.bucket = 'auth_code_token_links' AND json_extract(link.document, '$.codeHash') = consumed.key ORDER BY link.key LIMIT 1), 'refreshTokenHash', (SELECT NULLIF(json_extract(link.document, '$.refreshRootHash'), '') FROM takosumi_accounts_documents AS link WHERE link.bucket = 'auth_code_token_links' AND json_extract(link.document, '$.codeHash') = consumed.key ORDER BY link.key LIMIT 1)), CAST(json_extract(consumed.document, '$.consumedAt') AS INTEGER) FROM takosumi_accounts_documents AS consumed WHERE consumed.bucket = 'consumed_authorization_codes' AND 1 ON CONFLICT(bucket, key) DO UPDATE SET document = json_set(takosumi_accounts_documents.document, '$.state', 'issued', '$.recordVersion', json_extract(excluded.document, '$.recordVersion'), '$.claimId', json_extract(excluded.document, '$.claimId'), '$.updatedAt', json_extract(excluded.document, '$.updatedAt'), '$.issuedAt', COALESCE(json_extract(takosumi_accounts_documents.document, '$.issuedAt'), json_extract(excluded.document, '$.issuedAt')), '$.replayedAt', json(NULL), '$.accessTokenHash', json_extract(excluded.document, '$.accessTokenHash'), '$.refreshTokenHash', json_extract(excluded.document, '$.refreshTokenHash')), updated_at = excluded.updated_at;",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_authorization_code_redemptions_terminal_retention ON takosumi_accounts_documents(CAST(COALESCE(json_extract(document, '$.replayedAt'), json_extract(document, '$.issuedAt')) AS INTEGER), key) WHERE bucket = 'authorization_code_redemptions' AND json_extract(document, '$.state') IN ('issued', 'replayed');",
    ].join("\n"),
  },
];
// Immutable account-plane schema migration catalog ends.

export function listD1AccountsMigrations(): readonly D1AccountsMigration[] {
  return D1_ACCOUNTS_MIGRATIONS;
}

export interface D1MigratePlan {
  readonly kind: "takosumi.accounts.migrate-d1@v1";
  readonly databaseId: string;
  readonly accountId?: string;
  readonly migrations: ReadonlyArray<{
    readonly version: number;
    readonly name: string;
  }>;
  readonly dryRun: boolean;
}

export interface D1MigrateReport extends D1MigratePlan {
  readonly applied: readonly number[];
  readonly skipped: readonly number[];
}

export interface D1ExecuteCommand {
  /**
   * Runs the supplied SQL against the D1 database. Returns the raw stdout
   * from wrangler so callers can attach it to the JSON report if needed.
   * Throws on non-zero exit so callers can surface the wrangler diagnostic.
   *
   * The default implementation shells out to `bunx wrangler d1 execute`. A
   * caller may inject an alternative implementation in tests to avoid the
   * real Cloudflare API.
   */
  execute(input: {
    readonly databaseId: string;
    readonly accountId?: string;
    readonly sql: string;
  }): Promise<{ readonly stdout: string }>;
  /**
   * Runs a `SELECT` and returns parsed rows. wrangler's `--json` flag emits
   * a structured envelope; callers normalize it into a row-only shape.
   */
  query<T>(input: {
    readonly databaseId: string;
    readonly accountId?: string;
    readonly sql: string;
  }): Promise<readonly T[]>;
}

interface WranglerD1StatementResult {
  readonly results?: unknown;
  readonly success?: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the JSON emitted by `wrangler d1 execute --json` for one SELECT.
 *
 * Wrangler 4.111.0 emits an array of statement results:
 *
 *     [{ "results": [{ "version": 0 }], "success": true, "meta": {} }]
 *
 * Older Wrangler/API combinations could return the single statement result
 * without the outer array. These are the only two shapes accepted. The
 * migration query contains exactly one statement, so accepting zero or
 * multiple statement results could silently turn an unreadable migration
 * ledger into an empty ledger and reapply migrations.
 */
export function parseWranglerD1QueryRows<T>(parsed: unknown): readonly T[] {
  let statement: WranglerD1StatementResult;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) {
      throw new TypeError(
        `wrangler D1 JSON must contain exactly one statement result; received ${parsed.length}`,
      );
    }
    if (!isJsonObject(parsed[0])) {
      throw new TypeError(
        "wrangler D1 JSON statement result must be an object",
      );
    }
    statement = parsed[0];
  } else if (isJsonObject(parsed)) {
    // Explicit legacy support: a single unwrapped statement result.
    statement = parsed;
  } else {
    throw new TypeError(
      "wrangler D1 JSON must be a statement result object or a one-item array",
    );
  }

  if (statement.success !== true) {
    throw new TypeError(
      "wrangler D1 JSON statement result must declare success: true",
    );
  }
  if (!Array.isArray(statement.results)) {
    throw new TypeError(
      "wrangler D1 JSON statement result must contain a results array",
    );
  }

  return statement.results.map((row, index) => {
    if (!isJsonObject(row)) {
      throw new TypeError(
        `wrangler D1 JSON result row ${index} must be an object`,
      );
    }
    if (
      Array.isArray(row.results) &&
      ("success" in row || Object.keys(row).length === 1)
    ) {
      throw new TypeError(
        `wrangler D1 JSON result row ${index} is an ambiguous nested statement result`,
      );
    }
    return row as T;
  });
}

/**
 * Which D1 instance `wrangler d1 execute` targets.
 *
 *   - `"remote"` (default): the production/managed D1 database. This is the
 *     deploy default because the runner's whole purpose is to land schema on
 *     the database the deployed Worker binds to. (Plain `wrangler d1 execute`
 *     without a flag targets a throwaway local miniflare SQLite file, which
 *     would be a silent footgun for a migration runner.)
 *   - `"local"`: the local miniflare SQLite database, for smoke-testing the
 *     runner against a non-production database before a first deploy.
 */
export type D1ExecuteTarget = "remote" | "local";

/**
 * Build the default D1 execute command that shells out to
 * `bunx wrangler d1 execute`. Tests inject their own implementation to keep
 * the suite hermetic.
 *
 * `databaseId` is the historical field name in this CLI API. Wrangler 4's
 * `d1 execute` positional is a database name or binding, not a UUID-only
 * argument, so operators should pass the realized database name from the
 * wrangler config. `target` selects `--remote` (default) or `--local`. An
 * optional `env` passes `--env <profile>` so operators can target a wrangler
 * deploy profile (e.g. `staging`) when one is configured. `wranglerConfig`
 * points wrangler at the target Worker's rendered config when the CLI runs from
 * a sibling operator checkout.
 */
export function defaultD1ExecuteCommand(
  options: {
    readonly target?: D1ExecuteTarget;
    readonly env?: string;
    readonly wranglerConfig?: string;
  } = {},
): D1ExecuteCommand {
  const targetFlag = options.target === "local" ? "--local" : "--remote";
  const envArgs = options.env ? ["--env", options.env] : [];
  const configArgs = options.wranglerConfig
    ? ["--config", options.wranglerConfig]
    : [];
  const wranglerBin = process.env.TAKOSUMI_WRANGLER_BIN?.trim() || "bunx";
  const wranglerPrefix = wranglerBin === "wrangler" ? [] : ["wrangler"];
  async function runWrangler(
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly stdout: string }> {
    const output = await commandOutput(
      wranglerBin,
      [...wranglerPrefix, ...args],
      env,
    );
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    if (!output.success) {
      throw new Error(
        `wrangler exited with code ${output.code}: ${stderr || stdout}`,
      );
    }
    return { stdout };
  }
  return {
    async execute({ databaseId, accountId, sql }) {
      const args = [
        "d1",
        "execute",
        databaseId,
        targetFlag,
        ...envArgs,
        ...configArgs,
        "--command",
        sql,
      ];
      return await runWrangler(args, accountIdEnv(accountId));
    },
    async query<T>({
      databaseId,
      accountId,
      sql,
    }: {
      readonly databaseId: string;
      readonly accountId?: string;
      readonly sql: string;
    }): Promise<readonly T[]> {
      const args = [
        "d1",
        "execute",
        databaseId,
        targetFlag,
        ...envArgs,
        ...configArgs,
        "--json",
        "--command",
        sql,
      ];
      const { stdout } = await runWrangler(args, accountIdEnv(accountId));
      const parsed: unknown = JSON.parse(stdout);
      return parseWranglerD1QueryRows<T>(parsed);
    },
  };
}

function commandOutput(
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{
  readonly code: number;
  readonly success: boolean;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    child.stdout?.on("data", (chunk: Uint8Array) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Uint8Array) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 0,
        success: (code ?? 0) === 0,
        stdout: stdout.length
          ? new Uint8Array(Buffer.concat(stdout))
          : new Uint8Array(),
        stderr: stderr.length
          ? new Uint8Array(Buffer.concat(stderr))
          : new Uint8Array(),
      });
    });
  });
}

function accountIdEnv(accountId: string | undefined): Record<string, string> {
  return accountId
    ? { CLOUDFLARE_ACCOUNT_ID: accountId, CF_ACCOUNT_ID: accountId }
    : {};
}

/**
 * Apply pending D1 migrations.
 *
 * Algorithm:
 *   1. Ensure `takosumi_accounts_schema_migrations` exists. wrangler's
 *      `execute` is idempotent — the table is created with IF NOT EXISTS.
 *   2. SELECT existing rows from `takosumi_accounts_schema_migrations`.
 *   3. For each migration in `D1_ACCOUNTS_MIGRATIONS` that does NOT appear
 *      in the existing rows: run its SQL, then INSERT a row recording the
 *      applied version, name, and timestamp.
 *
 * When `dryRun` is true, the plan is returned with empty `applied` /
 * `skipped` arrays and no wrangler calls are made.
 */
export async function applyD1AccountsMigrations(input: {
  readonly databaseId: string;
  readonly accountId?: string;
  readonly dryRun: boolean;
  readonly target?: D1ExecuteTarget;
  readonly env?: string;
  readonly wranglerConfig?: string;
  readonly command?: D1ExecuteCommand;
}): Promise<D1MigrateReport> {
  const command =
    input.command ??
    defaultD1ExecuteCommand({
      ...(input.target ? { target: input.target } : {}),
      ...(input.env ? { env: input.env } : {}),
      ...(input.wranglerConfig ? { wranglerConfig: input.wranglerConfig } : {}),
    });
  const migrations = D1_ACCOUNTS_MIGRATIONS;
  const plan: D1MigratePlan = {
    kind: "takosumi.accounts.migrate-d1@v1",
    databaseId: input.databaseId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    migrations: migrations.map((migration) => ({
      version: migration.version,
      name: migration.name,
    })),
    dryRun: input.dryRun,
  };
  if (input.dryRun) {
    return { ...plan, applied: [], skipped: [] };
  }
  const exec = command.execute.bind(command);
  const targetArgs = {
    databaseId: input.databaseId,
    ...(input.accountId ? { accountId: input.accountId } : {}),
  } as const;
  await exec({ ...targetArgs, sql: D1_SCHEMA_MIGRATIONS_TABLE_SQL });
  const existingRows = await command.query<{ version: number | string }>({
    ...targetArgs,
    sql: "SELECT version FROM takosumi_accounts_schema_migrations ORDER BY version",
  });
  const appliedVersions: number[] = [];
  for (const [index, row] of existingRows.entries()) {
    const rawVersion = row.version;
    const value =
      typeof rawVersion === "number"
        ? rawVersion
        : typeof rawVersion === "string" && /^(0|[1-9]\d*)$/.test(rawVersion)
          ? Number(rawVersion)
          : Number.NaN;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(
        `invalid applied Accounts D1 migration version at row ${index}`,
      );
    }
    if (value !== index) {
      throw new Error(
        `Accounts D1 migration ledger must be the contiguous prefix 0..n; expected version ${index}, received ${value}`,
      );
    }
    if (
      !D1_ACCOUNTS_MIGRATIONS.some((migration) => migration.version === value)
    ) {
      throw new Error(
        `Accounts D1 migration ledger contains unknown version ${value}`,
      );
    }
    appliedVersions.push(value);
  }
  const existingVersions = new Set(appliedVersions);
  const applied: number[] = [];
  const skipped: number[] = [];
  for (const migration of migrations) {
    if (existingVersions.has(migration.version)) {
      skipped.push(migration.version);
      continue;
    }
    await exec({ ...targetArgs, sql: migration.sql });
    const insertSql = `INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (${migration.version}, '${migration.name.replaceAll(
      "'",
      "''",
    )}', ${Date.now()});`;
    await exec({ ...targetArgs, sql: insertSql });
    applied.push(migration.version);
  }
  return { ...plan, applied, skipped };
}

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
