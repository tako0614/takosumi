/**
 * Accounts-owned Cloudflare D1 migration catalog.
 *
 * The canonical checksum body is the ordered JSON array of `{sql,params}`
 * statements. Generated receipt inserts, their `applied_at` value, and the
 * migration's own checksum are deliberately outside that body.
 */

export type D1AccountsMigrationParameter = string | number | null;

export interface D1AccountsMigrationStatement {
  readonly sql: string;
  readonly params: readonly D1AccountsMigrationParameter[];
}

export interface D1AccountsMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly body: readonly D1AccountsMigrationStatement[];
}

export type D1AccountsLedgerShape =
  | "absent"
  | "legacy"
  | "checksummed"
  | "drifted";

export interface D1AccountsSchemaObject {
  readonly type: "index" | "table";
  readonly name: string;
  readonly tableName: string;
  readonly sql: string;
}

export interface D1AccountsSchemaClosure {
  readonly headVersion: number;
  readonly ledgerShape: "legacy" | "checksummed";
  readonly objects: readonly D1AccountsSchemaObject[];
  readonly digest: string;
}

export interface D1AccountsPreLedgerPolicy {
  readonly kind: "takosumi.accounts.d1-pre-ledger-policy@v1";
  readonly bucket: "oidc_clients";
  readonly cursorColumn: "key";
  readonly chunkSize: 100;
  readonly inventorySql: string;
  readonly candidateSql: string;
  readonly exactV3FenceSql: string;
  readonly exactV3FenceParams: readonly D1AccountsMigrationParameter[];
  readonly updateSql: string;
  readonly selectedMissingCountSql: string;
  readonly missingCountSql: string;
}

export interface D1AccountsMigrationCatalog {
  readonly migrations: readonly D1AccountsMigration[];
  readonly headVersion: number;
  readonly digest: string;
  readonly schemaClosures: readonly D1AccountsSchemaClosure[];
  readonly preLedgerPolicy: D1AccountsPreLedgerPolicy;
  readonly policyDigest: string;
}

export interface D1AccountsMigrationPreparedStatement {
  bind(...values: readonly unknown[]): D1AccountsMigrationPreparedStatement;
  run(): Promise<D1AccountsMigrationResult>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1AccountsMigrationResult<T>>;
}

export interface D1AccountsMigrationResult<T = unknown> {
  readonly success?: boolean;
  readonly results?: readonly T[];
  readonly error?: string;
}

export interface D1AccountsMigrationDatabase {
  prepare(sql: string): D1AccountsMigrationPreparedStatement;
  batch<T = unknown>(
    statements: readonly D1AccountsMigrationPreparedStatement[],
  ): Promise<readonly D1AccountsMigrationResult<T>[]>;
}

export class D1AccountsMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "D1AccountsMigrationError";
  }
}

export interface D1AccountsMigrationState {
  readonly ledgerShape: D1AccountsLedgerShape;
  readonly headVersion: number | null;
  readonly exactPrefixLength: number | null;
  readonly ledgerDigest: string;
  readonly schemaDigest: string;
  readonly missingActivationDigestCount: number | null;
  readonly issues: readonly string[];
}

export interface D1AccountsActivationDigestBackfillReport {
  readonly inventoryCount: number;
  readonly candidateCount: number;
  readonly chunkCount: number;
  readonly lostAcknowledgementReconciledChunks: number;
  readonly cutoverReconciled: boolean;
  readonly missingAfter: number;
}

export interface D1AccountsWorkerStateAssessment {
  readonly compatible: boolean;
  readonly headVersion: 3 | 4 | null;
  readonly issues: readonly string[];
}

export const D1_ACCOUNTS_MIGRATIONS_TABLE =
  "takosumi_accounts_schema_migrations" as const;

/**
 * Transient feature bridge. The later tightening commit changes only this
 * accepted-head constant from `[3, 4]` to `[4]`.
 */
export const D1_ACCOUNTS_WORKER_ACCEPTED_HEADS = [3, 4] as const;

const LEGACY_LEDGER_SQL =
  "CREATE TABLE IF NOT EXISTS takosumi_accounts_schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)";

// Immutable account-plane schema migration catalog begins.
// Historical billing field names below are migration input only, never current
// Accounts authority.
const PREFIX_DEFINITIONS: readonly {
  readonly version: number;
  readonly name: string;
  readonly body: readonly D1AccountsMigrationStatement[];
}[] = [
  {
    version: 0,
    name: "bootstrap_accounts_store",
    body: statements([
      LEGACY_LEDGER_SQL,
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_documents (bucket TEXT NOT NULL, key TEXT NOT NULL, document TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (bucket, key))",
      "CREATE TABLE IF NOT EXISTS takosumi_accounts_indexes (index_name TEXT NOT NULL, index_key TEXT NOT NULL, bucket TEXT NOT NULL, document_key TEXT NOT NULL, sort_key INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (index_name, index_key, bucket, document_key))",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_lookup ON takosumi_accounts_indexes (index_name, index_key, sort_key)",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_indexes_document ON takosumi_accounts_indexes (bucket, document_key)",
    ]),
  },
  {
    version: 1,
    name: "generalize_billing_provider_storage",
    body: statements([
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerCustomerId', json_extract(document, '$.stripeCustomerId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerCustomerId') IS NULL AND json_type(document, '$.stripeCustomerId') IS NOT NULL",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerSubscriptionId', json_extract(document, '$.stripeSubscriptionId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerSubscriptionId') IS NULL AND json_type(document, '$.stripeSubscriptionId') IS NOT NULL",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerPriceId', json_extract(document, '$.stripePriceId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerPriceId') IS NULL AND json_type(document, '$.stripePriceId') IS NOT NULL",
      "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.providerDefaultPaymentMethodId', json_extract(document, '$.stripeDefaultPaymentMethodId')) WHERE bucket = 'billing_accounts' AND json_type(document, '$.providerDefaultPaymentMethodId') IS NULL AND json_type(document, '$.stripeDefaultPaymentMethodId') IS NOT NULL",
      "UPDATE takosumi_accounts_documents SET document = json_remove(document, '$.stripeCustomerId', '$.stripeSubscriptionId', '$.stripePriceId', '$.stripeDefaultPaymentMethodId') WHERE bucket = 'billing_accounts'",
      "INSERT OR IGNORE INTO takosumi_accounts_indexes (index_name, index_key, bucket, document_key, sort_key) SELECT 'billing_accounts_by_provider_customer', index_key, bucket, document_key, sort_key FROM takosumi_accounts_indexes WHERE index_name = 'billing_accounts_by_stripe_customer'",
      "DELETE FROM takosumi_accounts_indexes WHERE index_name = 'billing_accounts_by_stripe_customer'",
    ]),
  },
  {
    version: 2,
    name: "remove_commercial_billing_persistence",
    body: statements([
      "DELETE FROM takosumi_accounts_indexes WHERE bucket IN ('billing_accounts', 'billing_webhook_events', 'billing_usage_records')",
      "DELETE FROM takosumi_accounts_documents WHERE bucket IN ('billing_accounts', 'billing_webhook_events', 'billing_usage_records')",
    ]),
  },
  {
    version: 3,
    name: "refresh_chain_retention_indexes",
    body: statements([
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_refresh_chain_links_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'refresh_chain_links'",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_refresh_chain_access_tokens_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'refresh_chain_access_tokens'",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_revoked_refresh_roots_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.revokedAt') AS INTEGER), key) WHERE bucket = 'revoked_refresh_roots'",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_consumed_authorization_codes_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.consumedAt') AS INTEGER), key) WHERE bucket = 'consumed_authorization_codes'",
      "CREATE INDEX IF NOT EXISTS takosumi_accounts_auth_code_token_links_retention ON takosumi_accounts_documents(CAST(json_extract(document, '$.createdAt') AS INTEGER), key) WHERE bucket = 'auth_code_token_links'",
    ]),
  },
];
// Immutable account-plane schema migration catalog ends.

let catalogPromise: Promise<D1AccountsMigrationCatalog> | undefined;

export function loadD1AccountsMigrationCatalog(): Promise<D1AccountsMigrationCatalog> {
  catalogPromise ??= buildCatalog();
  return catalogPromise;
}

export function canonicalD1AccountsMigrationBody(
  body: readonly D1AccountsMigrationStatement[],
): string {
  return JSON.stringify(
    body.map((statement) => ({
      sql: statement.sql,
      params: [...statement.params],
    })),
  );
}

export function d1AccountsMigrationBatchStatements(
  migration: D1AccountsMigration,
  appliedAt: number,
): readonly D1AccountsMigrationStatement[] {
  if (!Number.isSafeInteger(appliedAt) || appliedAt < 0) {
    throw new D1AccountsMigrationError("applied_at_invalid");
  }
  const receipt: D1AccountsMigrationStatement =
    migration.version === 4
      ? {
          sql: "INSERT INTO takosumi_accounts_schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)",
          params: [
            migration.version,
            migration.name,
            migration.checksum,
            appliedAt,
          ],
        }
      : {
          sql: "INSERT INTO takosumi_accounts_schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          params: [migration.version, migration.name, appliedAt],
        };
  return [...migration.body, receipt];
}

export async function applyD1AccountsMigrationBatch(
  database: D1AccountsMigrationDatabase,
  migration: D1AccountsMigration,
  appliedAt: number,
): Promise<void> {
  const statements = d1AccountsMigrationBatchStatements(migration, appliedAt);
  const results = await database.batch(
    statements.map((statement) =>
      database.prepare(statement.sql).bind(...statement.params),
    ),
  );
  if (
    results.length !== statements.length ||
    results.some((result) => result.success !== true)
  ) {
    throw new D1AccountsMigrationError("migration_batch_result_invalid");
  }
}

const ACTIVATION_DIGEST_BACKFILL_CHUNK_SIZE = 100;
const OIDC_CLIENTS_BUCKET = "oidc_clients";
const PRE_LEDGER_V3_SCHEMA_OBJECTS = schemaObjectsAtV3();
const PRE_LEDGER_V3_OBJECT_NAMES = PRE_LEDGER_V3_SCHEMA_OBJECTS.map(
  (object) => object.name,
);
const PRE_LEDGER_V3_LEDGER_ROWS = PREFIX_DEFINITIONS.map(
  ({ version, name }) => [version, name],
);
const PRE_LEDGER_V3_OBJECT_ROWS = PRE_LEDGER_V3_SCHEMA_OBJECTS.map((object) => [
  object.type,
  object.name,
  object.tableName,
  object.sql,
]);

export const D1_ACCOUNTS_PRE_LEDGER_POLICY: D1AccountsPreLedgerPolicy = {
  kind: "takosumi.accounts.d1-pre-ledger-policy@v1",
  bucket: OIDC_CLIENTS_BUCKET,
  cursorColumn: "key",
  chunkSize: ACTIVATION_DIGEST_BACKFILL_CHUNK_SIZE,
  inventorySql:
    "SELECT key, document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key > ? ORDER BY key LIMIT 100",
  candidateSql:
    "SELECT key, document FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND key > ? AND json_type(document, '$.activationDigest') IS NULL ORDER BY key LIMIT 100",
  exactV3FenceSql: `SELECT CASE WHEN COALESCE((SELECT json_group_array(json_array(version, name)) FROM (SELECT version, name FROM takosumi_accounts_schema_migrations ORDER BY version)), '[]') = ? AND COALESCE((SELECT json_group_array(json_array(type, name, tbl_name, sql)) FROM (SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (${PRE_LEDGER_V3_OBJECT_NAMES.map(() => "?").join(", ")}) ORDER BY type, name)), '[]') = ? THEN 1 ELSE json_extract(?, '$') END AS exact_v3_ledger_and_schema`,
  exactV3FenceParams: [
    JSON.stringify(PRE_LEDGER_V3_LEDGER_ROWS),
    ...PRE_LEDGER_V3_OBJECT_NAMES,
    JSON.stringify(PRE_LEDGER_V3_OBJECT_ROWS),
    "accounts_d1_backfill_v3_fence_invalid",
  ],
  updateSql:
    "UPDATE takosumi_accounts_documents SET document = json_set(document, '$.activationDigest', NULL) WHERE bucket = ? AND key IN (SELECT value FROM json_each(?)) AND json_type(document, '$.activationDigest') IS NULL",
  selectedMissingCountSql:
    "SELECT COUNT(*) AS count FROM takosumi_accounts_documents WHERE bucket = ? AND key IN (SELECT value FROM json_each(?)) AND json_type(document, '$.activationDigest') IS NULL",
  missingCountSql:
    "SELECT COUNT(*) AS count FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND json_type(document, '$.activationDigest') IS NULL",
};

interface ActivationDigestBackfillRow {
  readonly key: unknown;
  readonly document: unknown;
}

/**
 * Bounded pre-ledger data transition while the exact-v3 Worker bridge serves.
 * The cursor and row keys remain memory-only and are never returned.
 */
export async function backfillD1AccountsActivationDigests(
  database: D1AccountsMigrationDatabase,
): Promise<D1AccountsActivationDigestBackfillReport> {
  const inventoryCount = await inventoryD1AccountsOidcClients(database);
  let cursor = "";
  let candidateCount = 0;
  let chunkCount = 0;
  let lostAcknowledgementReconciledChunks = 0;
  let cutoverReconciled = false;
  const catalog = await loadD1AccountsMigrationCatalog();

  while (true) {
    let rows: readonly ActivationDigestBackfillRow[];
    try {
      const result = await database
        .prepare(
          D1_ACCOUNTS_PRE_LEDGER_POLICY.candidateSql,
        )
        .bind(cursor)
        .all<ActivationDigestBackfillRow>();
      assertReadResult(result);
      rows = result.results ?? [];
    } catch {
      throw new D1AccountsMigrationError(
        "activation_digest_backfill_inventory_failed",
      );
    }
    if (rows.length === 0) break;
    if (rows.length > ACTIVATION_DIGEST_BACKFILL_CHUNK_SIZE) {
      throw new D1AccountsMigrationError(
        "activation_digest_backfill_inventory_drift",
      );
    }

    const keys: string[] = [];
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length === 0 ||
        row.key <= cursor ||
        typeof row.document !== "string" ||
        !isValidOidcClientDocument(row.key, row.document)
      ) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_inventory_drift",
        );
      }
      if (keys.length > 0 && row.key <= keys[keys.length - 1]!) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_inventory_drift",
        );
      }
      keys.push(row.key);
    }

    const fence = database
      .prepare(D1_ACCOUNTS_PRE_LEDGER_POLICY.exactV3FenceSql)
      .bind(...D1_ACCOUNTS_PRE_LEDGER_POLICY.exactV3FenceParams);
    const update = database
      .prepare(D1_ACCOUNTS_PRE_LEDGER_POLICY.updateSql)
      .bind(OIDC_CLIENTS_BUCKET, JSON.stringify(keys));
    try {
      const results = await database.batch([fence, update]);
      if (
        results.length !== 2 ||
        results.some((result) => result.success !== true)
      ) {
        throw new Error("activation digest update batch failed");
      }
    } catch {
      let state: D1AccountsMigrationState;
      try {
        state = await readD1AccountsMigrationState(database, catalog);
      } catch {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_state_indeterminate",
        );
      }
      if (isExactCleanV4State(state, catalog)) {
        candidateCount += keys.length;
        chunkCount += 1;
        cutoverReconciled = true;
        return {
          inventoryCount,
          candidateCount,
          chunkCount,
          lostAcknowledgementReconciledChunks,
          cutoverReconciled,
          missingAfter: 0,
        };
      }
      if (
        state.headVersion === catalog.headVersion ||
        state.exactPrefixLength === catalog.migrations.length
      ) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_cutoff_invalid",
        );
      }
      if (!isExactV3State(state)) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_state_indeterminate",
        );
      }
      let remaining: number;
      try {
        remaining = await readMissingActivationDigestCountForKeys(
          database,
          keys,
        );
      } catch {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_state_indeterminate",
        );
      }
      if (remaining !== 0) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_retry_required",
        );
      }
      lostAcknowledgementReconciledChunks += 1;
    }

    candidateCount += keys.length;
    chunkCount += 1;
    cursor = keys[keys.length - 1]!;
  }

  let missingAfter: number;
  try {
    missingAfter = await readMissingActivationDigestCount(database);
  } catch {
    throw new D1AccountsMigrationError(
      "activation_digest_backfill_state_indeterminate",
    );
  }
  if (missingAfter !== 0) {
    throw new D1AccountsMigrationError(
      "activation_digest_backfill_retry_required",
    );
  }
  return {
    inventoryCount,
    candidateCount,
    chunkCount,
    lostAcknowledgementReconciledChunks,
    cutoverReconciled,
    missingAfter,
  };
}

function isExactV3State(state: D1AccountsMigrationState): boolean {
  return (
    state.headVersion === 3 &&
    state.exactPrefixLength === 4 &&
    state.ledgerShape === "legacy" &&
    state.issues.length === 0
  );
}

function isExactCleanV4State(
  state: D1AccountsMigrationState,
  catalog: D1AccountsMigrationCatalog,
): boolean {
  return (
    state.headVersion === catalog.headVersion &&
    state.exactPrefixLength === catalog.migrations.length &&
    state.ledgerShape === "checksummed" &&
    state.missingActivationDigestCount === 0 &&
    state.issues.length === 0
  );
}

async function inventoryD1AccountsOidcClients(
  database: D1AccountsMigrationDatabase,
): Promise<number> {
  let cursor = "";
  let count = 0;
  while (true) {
    let rows: readonly ActivationDigestBackfillRow[];
    try {
      const result = await database
        .prepare(D1_ACCOUNTS_PRE_LEDGER_POLICY.inventorySql)
        .bind(cursor)
        .all<ActivationDigestBackfillRow>();
      assertReadResult(result);
      rows = result.results ?? [];
    } catch {
      throw new D1AccountsMigrationError(
        "activation_digest_backfill_inventory_failed",
      );
    }
    if (rows.length === 0) return count;
    if (rows.length > D1_ACCOUNTS_PRE_LEDGER_POLICY.chunkSize) {
      throw new D1AccountsMigrationError(
        "activation_digest_backfill_inventory_drift",
      );
    }
    for (const row of rows) {
      if (
        typeof row.key !== "string" ||
        row.key.length === 0 ||
        row.key <= cursor ||
        !isValidOidcClientDocument(row.key, row.document)
      ) {
        throw new D1AccountsMigrationError(
          "activation_digest_backfill_inventory_drift",
        );
      }
      cursor = row.key;
      count += 1;
    }
  }
}

async function readMissingActivationDigestCountForKeys(
  database: D1AccountsMigrationDatabase,
  keys: readonly string[],
): Promise<number> {
  const result = await database
    .prepare(D1_ACCOUNTS_PRE_LEDGER_POLICY.selectedMissingCountSql)
    .bind(OIDC_CLIENTS_BUCKET, JSON.stringify(keys))
    .first<{ readonly count: number | string }>();
  const count = normalizedCount(result?.count);
  if (count === null) {
    throw new D1AccountsMigrationError(
      "activation_digest_backfill_state_indeterminate",
    );
  }
  return count;
}

async function readMissingActivationDigestCount(
  database: D1AccountsMigrationDatabase,
): Promise<number> {
  const result = await database
    .prepare(D1_ACCOUNTS_PRE_LEDGER_POLICY.missingCountSql)
    .first<{ readonly count: number | string }>();
  const count = normalizedCount(result?.count);
  if (count === null) {
    throw new D1AccountsMigrationError(
      "activation_digest_backfill_state_indeterminate",
    );
  }
  return count;
}

function isValidOidcClientDocument(key: string, value: unknown): boolean {
  if (typeof value !== "string") return false;
  let document: unknown;
  try {
    document = JSON.parse(value);
  } catch {
    return false;
  }
  if (
    typeof document !== "object" ||
    document === null ||
    Array.isArray(document)
  ) {
    return false;
  }
  const record = document as {
    readonly activationDigest?: unknown;
    readonly capsuleId?: unknown;
    readonly clientId?: unknown;
  };
  const capsuleId = record.capsuleId;
  const activationDigest = record.activationDigest;
  return (
    record.clientId === key &&
    typeof capsuleId === "string" &&
    capsuleId.trim().length > 0 &&
    capsuleId.length <= 512 &&
    (activationDigest === undefined ||
      activationDigest === null ||
      (typeof activationDigest === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(activationDigest)))
  );
}

interface SqliteObjectRow {
  readonly type: unknown;
  readonly name: unknown;
  readonly tbl_name: unknown;
  readonly sql: unknown;
}

interface SqliteColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

interface LedgerReadRow {
  readonly version: unknown;
  readonly name: unknown;
  readonly checksum?: unknown;
}

export async function readD1AccountsMigrationState(
  database: D1AccountsMigrationDatabase,
  catalog: D1AccountsMigrationCatalog,
): Promise<D1AccountsMigrationState> {
  try {
    const ownedNames = [
      ...new Set(
        catalog.schemaClosures.flatMap((closure) =>
          closure.objects.map((object) => object.name)
        ),
      ),
    ];
    const objectResult = await database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (${ownedNames
          .map(() => "?")
          .join(", ")}) ORDER BY type, name`,
      )
      .bind(...ownedNames)
      .all<SqliteObjectRow>();
    assertReadResult(objectResult);
    const objects = (objectResult.results ?? []).map(normalizedSchemaObject);
    const tables = new Set(
      objects.filter((row) => row.type === "table").map((row) => row.name),
    );
    let columns: readonly SqliteColumnRow[] = [];
    if (tables.has(D1_ACCOUNTS_MIGRATIONS_TABLE)) {
      const columnResult = await database
        .prepare(`PRAGMA table_info('${D1_ACCOUNTS_MIGRATIONS_TABLE}')`)
        .all<SqliteColumnRow>();
      assertReadResult(columnResult);
      columns = columnResult.results ?? [];
    }
    const ledgerShape = classifyLedgerShape(tables, columns);
    let rows: readonly LedgerReadRow[] = [];
    if (ledgerShape === "legacy") {
      const result = await database
        .prepare(
          `SELECT version, name FROM ${D1_ACCOUNTS_MIGRATIONS_TABLE} ORDER BY version`,
        )
        .all<LedgerReadRow>();
      assertReadResult(result);
      rows = result.results ?? [];
    } else if (ledgerShape === "checksummed") {
      const result = await database
        .prepare(
          `SELECT version, name, checksum FROM ${D1_ACCOUNTS_MIGRATIONS_TABLE} ORDER BY version`,
        )
        .all<LedgerReadRow>();
      assertReadResult(result);
      rows = result.results ?? [];
    }

    const ledgerIssues: string[] = [];
    const exactPrefixLength = exactCatalogPrefixLength(
      rows,
      ledgerShape,
      catalog,
      ledgerIssues,
    );
    const headVersion =
      exactPrefixLength === null || exactPrefixLength === 0
        ? null
        : exactPrefixLength - 1;
    const issues = [...ledgerIssues];
    if (headVersion !== null) {
      const expectedClosure = catalog.schemaClosures.find(
        (closure) => closure.headVersion === headVersion,
      );
      if (
        !expectedClosure ||
        expectedClosure.ledgerShape !== ledgerShape ||
        JSON.stringify(expectedClosure.objects) !== JSON.stringify(objects)
      ) {
        issues.push("schema_closure_mismatch");
      }
    }

    let missingActivationDigestCount: number | null = null;
    if (tables.has("takosumi_accounts_documents")) {
      const missingResult = await database
        .prepare(
          "SELECT COUNT(*) AS count FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND json_type(document, '$.activationDigest') IS NULL",
        )
        .first<{ readonly count: number | string }>();
      const count = normalizedCount(missingResult?.count);
      if (count === null) {
        issues.push("activation_digest_count_invalid");
      } else {
        missingActivationDigestCount = count;
      }
    }
    if (exactPrefixLength === catalog.migrations.length) {
      if (missingActivationDigestCount !== 0) {
        issues.push("activation_digest_backfill_incomplete");
      }
    }

    return {
      ledgerShape,
      headVersion,
      exactPrefixLength,
      ledgerDigest: await digestD1AccountsValue(
        rows.map((row) => ({
          version: row.version,
          name: row.name,
          ...(ledgerShape === "checksummed" ? { checksum: row.checksum } : {}),
        })),
      ),
      schemaDigest: await digestD1AccountsValue({
        objects,
      }),
      missingActivationDigestCount,
      issues,
    };
  } catch (error) {
    if (error instanceof D1AccountsMigrationError) throw error;
    throw new D1AccountsMigrationError("state_read_failed");
  }
}

export function assessD1AccountsWorkerState(
  state: D1AccountsMigrationState,
): D1AccountsWorkerStateAssessment {
  const accepted = D1_ACCOUNTS_WORKER_ACCEPTED_HEADS.includes(
    state.headVersion as 3 | 4,
  );
  const shapeMatches =
    (state.headVersion === 3 && state.ledgerShape === "legacy") ||
    (state.headVersion === 4 && state.ledgerShape === "checksummed");
  const issues = [...state.issues];
  if (!accepted) issues.push("worker_catalog_head_not_accepted");
  if (!shapeMatches) issues.push("worker_ledger_shape_not_accepted");
  return {
    compatible: issues.length === 0,
    headVersion:
      accepted && (state.headVersion === 3 || state.headVersion === 4)
        ? state.headVersion
        : null,
    issues,
  };
}

function normalizedSchemaObject(row: SqliteObjectRow): D1AccountsSchemaObject {
  if (
    (row.type !== "table" && row.type !== "index") ||
    typeof row.name !== "string" ||
    typeof row.tbl_name !== "string" ||
    typeof row.sql !== "string"
  ) {
    throw new D1AccountsMigrationError("state_read_failed");
  }
  return {
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: normalizeSqliteSchemaSql(row.sql),
  };
}

function classifyLedgerShape(
  tables: ReadonlySet<string>,
  columns: readonly SqliteColumnRow[],
): D1AccountsLedgerShape {
  if (!tables.has(D1_ACCOUNTS_MIGRATIONS_TABLE)) return "absent";
  const descriptors = columns.map((column) => ({
    name: column.name,
    type: column.type.toUpperCase(),
    notnull: column.notnull,
    pk: column.pk,
  }));
  const legacy = [
    { name: "version", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "applied_at", type: "INTEGER", notnull: 1, pk: 0 },
  ];
  if (JSON.stringify(descriptors) === JSON.stringify(legacy)) return "legacy";
  const checksummed = [
    ...legacy,
    { name: "checksum", type: "TEXT", notnull: 0, pk: 0 },
  ];
  return JSON.stringify(descriptors) === JSON.stringify(checksummed)
    ? "checksummed"
    : "drifted";
}

function exactCatalogPrefixLength(
  rows: readonly LedgerReadRow[],
  shape: D1AccountsLedgerShape,
  catalog: D1AccountsMigrationCatalog,
  issues: string[],
): number | null {
  if (shape === "absent") return 0;
  if (shape === "drifted") {
    issues.push("ledger_shape_drift");
    return null;
  }
  if (rows.length > catalog.migrations.length) {
    issues.push("ledger_newer_than_catalog");
    return null;
  }
  if (shape === "checksummed" && rows.length !== catalog.migrations.length) {
    issues.push("checksummed_ledger_partial");
    return null;
  }
  if (shape === "legacy" && rows.length > 4) {
    issues.push("legacy_ledger_newer_than_v3");
    return null;
  }
  for (const [index, row] of rows.entries()) {
    const expected = catalog.migrations[index];
    if (
      !expected ||
      row.version !== expected.version ||
      row.name !== expected.name ||
      (shape === "checksummed" && row.checksum !== expected.checksum)
    ) {
      issues.push("ledger_catalog_mismatch");
      return null;
    }
  }
  return rows.length;
}

function assertReadResult(result: {
  readonly success?: boolean;
  readonly error?: string;
}): void {
  if (result.success !== true) {
    throw new D1AccountsMigrationError("state_read_failed");
  }
}

function normalizedCount(value: unknown): number | null {
  const count =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^(0|[1-9]\d*)$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export async function digestD1AccountsValue(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function buildCatalog(): Promise<D1AccountsMigrationCatalog> {
  const migrations: D1AccountsMigration[] = [];
  for (const definition of PREFIX_DEFINITIONS) {
    migrations.push({
      ...definition,
      checksum: await digestBody(definition.body),
    });
  }

  const schemaClosures = await buildSchemaClosures();
  const v3Schema = schemaClosures.find(
    (closure) => closure.headVersion === 3,
  );
  if (!v3Schema) {
    throw new D1AccountsMigrationError("catalog_schema_closure_invalid");
  }
  const legacyRows = migrations.map(({ version, name }) => [version, name]);
  const prefixChecksums = migrations.map(({ checksum }) => checksum);
  const v3ObjectNames = v3Schema.objects.map((object) => object.name);
  const v3ObjectRows = v3Schema.objects.map((object) => [
    object.type,
    object.name,
    object.tableName,
    object.sql,
  ]);
  const v4Body: readonly D1AccountsMigrationStatement[] = [
    {
      sql: `SELECT CASE WHEN COALESCE((SELECT json_group_array(json_array(version, name)) FROM (SELECT version, name FROM takosumi_accounts_schema_migrations ORDER BY version)), '[]') = ? AND COALESCE((SELECT json_group_array(json_array(type, name, tbl_name, sql)) FROM (SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name IN (${v3ObjectNames.map(() => "?").join(", ")}) ORDER BY type, name)), '[]') = ? AND NOT EXISTS (SELECT 1 FROM takosumi_accounts_documents WHERE bucket = 'oidc_clients' AND json_type(document, '$.activationDigest') IS NULL) THEN 1 ELSE json_extract(?, '$') END AS exact_legacy_prefix_schema_and_activation_digest_complete`,
      params: [
        JSON.stringify(legacyRows),
        ...v3ObjectNames,
        JSON.stringify(v3ObjectRows),
        "accounts_d1_v4_fence_invalid",
      ],
    },
    {
      sql: "ALTER TABLE takosumi_accounts_schema_migrations ADD COLUMN checksum TEXT",
      params: [],
    },
    {
      sql: "UPDATE takosumi_accounts_schema_migrations SET checksum = CASE version WHEN 0 THEN ? WHEN 1 THEN ? WHEN 2 THEN ? WHEN 3 THEN ? ELSE checksum END WHERE version BETWEEN 0 AND 3",
      params: prefixChecksums,
    },
  ];
  migrations.push({
    version: 4,
    name: "oidc_client_activation_digest",
    checksum: await digestBody(v4Body),
    body: v4Body,
  });

  const policyDigest = await digestD1AccountsValue({
    preLedgerPolicy: D1_ACCOUNTS_PRE_LEDGER_POLICY,
    schemaClosures: schemaClosures.map(
      ({ headVersion, ledgerShape, digest }) => ({
        headVersion,
        ledgerShape,
        digest,
      }),
    ),
  });
  return {
    migrations,
    headVersion: 4,
    digest: await digestD1AccountsValue(
      migrations.map(({ version, name, checksum }) => ({
        version,
        name,
        checksum,
      })),
    ),
    schemaClosures,
    preLedgerPolicy: D1_ACCOUNTS_PRE_LEDGER_POLICY,
    policyDigest,
  };
}

async function buildSchemaClosures(): Promise<
  readonly D1AccountsSchemaClosure[]
> {
  const base = schemaObjectsFromMigration(PREFIX_DEFINITIONS[0]);
  const v3Additions = schemaObjectsFromMigration(PREFIX_DEFINITIONS[3]);
  if (!base || !v3Additions) {
    throw new D1AccountsMigrationError("catalog_schema_closure_invalid");
  }
  const v3Objects = sortedSchemaObjects([...base, ...v3Additions]);
  const v4Objects = v3Objects.map((object) =>
    object.name === D1_ACCOUNTS_MIGRATIONS_TABLE
      ? {
          ...object,
          sql: object.sql.replace(/\)$/u, ", checksum TEXT)"),
        }
      : object
  );
  const closures: D1AccountsSchemaClosure[] = [];
  for (let headVersion = 0; headVersion <= 4; headVersion += 1) {
    const objects = headVersion < 3
      ? sortedSchemaObjects(base)
      : headVersion === 3
        ? v3Objects
        : v4Objects;
    closures.push({
      headVersion,
      ledgerShape: headVersion === 4 ? "checksummed" : "legacy",
      objects,
      digest: await digestD1AccountsValue({ objects }),
    });
  }
  return closures;
}

function schemaObjectsAtV3(): readonly D1AccountsSchemaObject[] {
  const base = schemaObjectsFromMigration(PREFIX_DEFINITIONS[0]);
  const additions = schemaObjectsFromMigration(PREFIX_DEFINITIONS[3]);
  if (!base || !additions) {
    throw new D1AccountsMigrationError("catalog_schema_closure_invalid");
  }
  return sortedSchemaObjects([...base, ...additions]);
}

function schemaObjectsFromMigration(
  migration:
    | {
        readonly body: readonly D1AccountsMigrationStatement[];
      }
    | undefined,
): readonly D1AccountsSchemaObject[] | undefined {
  return migration?.body
    .map((statement) => expectedSchemaObject(statement.sql))
    .filter((object): object is D1AccountsSchemaObject => object !== undefined);
}

function expectedSchemaObject(
  sql: string,
): D1AccountsSchemaObject | undefined {
  const normalized = normalizeSqliteSchemaSql(sql);
  const table = /^CREATE TABLE ([A-Za-z0-9_]+)\b/u.exec(normalized);
  if (table?.[1]) {
    return {
      type: "table",
      name: table[1],
      tableName: table[1],
      sql: normalized,
    };
  }
  const index = /^CREATE INDEX ([A-Za-z0-9_]+) ON ([A-Za-z0-9_]+)\b/u.exec(
    normalized,
  );
  if (index?.[1] && index[2]) {
    return {
      type: "index",
      name: index[1],
      tableName: index[2],
      sql: normalized,
    };
  }
  return undefined;
}

function sortedSchemaObjects(
  objects: readonly D1AccountsSchemaObject[],
): readonly D1AccountsSchemaObject[] {
  return [...objects].sort((left, right) => {
    const leftKey = `${left.type}\0${left.name}`;
    const rightKey = `${right.type}\0${right.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function normalizeSqliteSchemaSql(sql: string): string {
  return sql
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^CREATE (TABLE|INDEX) IF NOT EXISTS /u, "CREATE $1 ");
}

function statements(sql: readonly string[]): readonly D1AccountsMigrationStatement[] {
  return sql.map((statement) => ({ sql: statement, params: [] }));
}

async function digestBody(
  body: readonly D1AccountsMigrationStatement[],
): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalD1AccountsMigrationBody(body));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}
