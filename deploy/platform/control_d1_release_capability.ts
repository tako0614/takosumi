import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  applyControlD1Schema,
  buildControlD1SchemaPlan,
  SqliteControlD1Database,
} from "./control_d1_schema.ts";
import {
  CloudflareControlD1RestDatabase,
  ControlD1RestError,
} from "./control_d1_schema_rest.ts";

/**
 * Read-only owner proof consumed by hosted staging orchestration.
 *
 * The transcript is intentionally produced by running the real OSS REST
 * adapter against a local SQLite target. It does not call Cloudflare and it
 * never accepts an account, database, or token. The observed transport facts
 * are kept next to the source/test digests that prove which implementation
 * produced them.
 */
export const CONTROL_D1_RELEASE_CAPABILITY_KIND =
  "takosumi.oss-control-d1-release-sql-capability@v1" as const;
export const CONTROL_D1_RELEASE_CAPABILITY_VERSION = 1 as const;
export const CONTROL_D1_RELEASE_CAPABILITY_QUERY_LIMIT_BYTES = 100_000 as const;
export const CONTROL_D1_RELEASE_CAPABILITY_COMMAND =
  "bun scripts/control-d1-schema.ts release-capability" as const;

const SOURCE_FILE_PATH = "deploy/platform/control_d1_schema_rest.ts" as const;
const SCHEMA_SOURCE_FILE_PATH = "deploy/platform/control_d1_schema.ts" as const;
const CAPABILITY_SOURCE_FILE_PATH =
  "deploy/platform/control_d1_release_capability.ts" as const;
const TEST_FILE_PATH = "tests/deploy/platform/control_d1_schema_test.ts" as const;
const CAPABILITY_TEST_FILE_PATH =
  "tests/deploy/platform/control_d1_release_capability_test.ts" as const;
const SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

type JsonRecord = Record<string, unknown>;

export interface ControlD1ReleaseCapabilityFileDigest {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ControlD1ReleaseCapabilityQueryEvidence {
  readonly endpoint: "/client/v4/accounts/:accountId/d1/database/:databaseId/query";
  readonly requestCount: number;
  readonly statementCount: number;
  readonly maxActualStatementBytes: number;
  readonly limitBytes: typeof CONTROL_D1_RELEASE_CAPABILITY_QUERY_LIMIT_BYTES;
  readonly maxStatementDigest: string;
}

export interface ControlD1ReleaseCapabilityDropTriggerEvidence {
  readonly statementCount: number;
  readonly queryRequestCount: number;
  readonly importInitCount: number;
  readonly importUploadCount: number;
  readonly importIngestCount: number;
  readonly importPollCount: number;
  readonly uploadedSqlDigest: string;
  readonly routedToAtomicSqlFileImport: true;
  readonly rollbackProof: true;
}

export interface ControlD1ReleaseCapabilityImportPollEvidence {
  readonly returnedAtBookmarkCount: number;
  readonly requestedCurrentBookmarkCount: number;
  readonly returnedAtBookmarkDigest: string;
  readonly requestedCurrentBookmarkDigest: string;
  readonly bookmarkSequenceDigest: string;
  readonly carriesEveryReturnedAtBookmark: true;
}

export interface ControlD1ReleaseCapabilitySchemaReleaseEvidence {
  readonly status: "ready";
  readonly maintenanceStatus: "released";
  readonly plan: {
    readonly manifestDigest: string;
    readonly expectedLatestMigrationVersion: number;
    readonly expectedMigrationCount: number;
  };
  readonly verification: {
    readonly status: "ready";
    readonly schemaDigest: string;
    readonly ledgerDigest: string;
    readonly latestMigrationVersion: number;
    readonly migrationCount: number;
    readonly tableCount: number;
  };
  readonly imports: {
    readonly count: number;
    readonly pollCount: number;
    readonly dropTriggerStatementCount: number;
    readonly dropTriggerImportCount: number;
    readonly dropTriggerQueryRequestCount: number;
    readonly dropTriggerImportDigest: string;
    readonly importTranscriptDigest: string;
  };
  readonly zeroQueryDropTriggerRequests: true;
  readonly digest: string;
}

export interface ControlD1ReleaseCapability {
  readonly kind: typeof CONTROL_D1_RELEASE_CAPABILITY_KIND;
  readonly status: "ready";
  readonly version: typeof CONTROL_D1_RELEASE_CAPABILITY_VERSION;
  readonly capabilityVersion: typeof CONTROL_D1_RELEASE_CAPABILITY_VERSION;
  readonly sourceCommit: string;
  readonly source: {
    readonly commit: string;
    readonly files: readonly ControlD1ReleaseCapabilityFileDigest[];
    readonly digest: string;
  };
  readonly test: {
    readonly path: string;
    readonly sha256: string;
    readonly digest: string;
  };
  readonly tool: {
    readonly name: "bun";
    readonly version: string;
    readonly packageVersion: string;
    readonly command: typeof CONTROL_D1_RELEASE_CAPABILITY_COMMAND;
  };
  readonly transport: {
    readonly query: ControlD1ReleaseCapabilityQueryEvidence;
    readonly schemaRelease: ControlD1ReleaseCapabilitySchemaReleaseEvidence;
    readonly dropTriggerBatch: ControlD1ReleaseCapabilityDropTriggerEvidence;
    readonly importPoll: ControlD1ReleaseCapabilityImportPollEvidence;
    readonly digest: string;
  };
  readonly digest: string;
}

export class ControlD1ReleaseCapabilityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ControlD1ReleaseCapabilityError";
  }
}

export interface BuildControlD1ReleaseCapabilityOptions {
  /** Absolute Takosumi OSS checkout root. Defaults to this package root. */
  readonly root?: string;
  /** Exact source commit to bind into the transcript. */
  readonly sourceCommit: string;
  /** Test-only runtime version override; production uses Bun.version. */
  readonly toolVersion?: string;
  /** Test-only package version override; production reads package.json. */
  readonly packageVersion?: string;
}

type RestQuery = {
  readonly sql: string;
  readonly params?: readonly (string | number | null)[];
};

type ImportAction =
  | { readonly action: "init"; readonly etag: string }
  | {
      readonly action: "ingest";
      readonly etag: string;
      readonly filename?: string;
    }
  | { readonly action: "poll"; readonly current_bookmark: string };

type CapabilityFetchStats = {
  queryRequests: number;
  queryStatements: { readonly sql: string; readonly bytes: number }[];
  queryDropTriggerRequests: number;
  importInitCount: number;
  importUploadCount: number;
  importIngestCount: number;
  importPollCount: number;
  uploadedSql: string[];
  returnedAtBookmarks: string[];
  requestedCurrentBookmarks: string[];
};

type ImportBookmark = {
  readonly etag: string;
  readonly remaining: number;
  readonly sequence: number;
};

/**
 * Run the source-owned transport proof and return its typed transcript.
 *
 * This intentionally requires an explicit commit. The CLI obtains it from
 * the clean source checkout, while tests may pass a fixture commit.
 */
export async function buildControlD1ReleaseCapability(
  options: BuildControlD1ReleaseCapabilityOptions,
): Promise<ControlD1ReleaseCapability> {
  const root = resolve(options.root ?? resolve(import.meta.dir, "../.."));
  const sourceCommit = validateSourceCommit(options.sourceCommit);
  const sourceFiles = await readSourceFileDigests(root);
  const packageVersion =
    options.packageVersion ?? (await readPackageVersion(root));

  const queryStats: CapabilityFetchStats = emptyFetchStats();
  const queryBacking = new SqliteControlD1Database();
  let schemaRelease: ControlD1ReleaseCapabilitySchemaReleaseEvidence;
  try {
    const queryFetch = createCapabilityFetch(queryBacking, queryStats, 2);
    const database = createRestDatabase(queryFetch);
    const plan = await buildControlD1SchemaPlan();
    const applied = await applyControlD1Schema(database, plan, {
      sourceCommit,
      environment: "test",
      activatedAt: "2026-01-01T00:00:00.000Z",
      releasedAt: () => "2026-01-01T00:00:00.000Z",
      maintenanceDrainMilliseconds: 0,
      waitForRequestDrain: async () => {},
      databaseId: "release-capability-self-test",
    });
    if (applied.verification.status !== "ready") {
      throw new ControlD1ReleaseCapabilityError(
        "schema_self_test_verification_failed",
      );
    }
    if (applied.maintenanceStatus !== "released") {
      throw new ControlD1ReleaseCapabilityError(
        "schema_self_test_maintenance_not_released",
      );
    }
    schemaRelease = buildSchemaReleaseEvidence(
      plan,
      applied.verification,
      applied.maintenanceStatus,
      queryStats,
    );
  } finally {
    queryBacking.close();
  }

  const triggerStats: CapabilityFetchStats = emptyFetchStats();
  const triggerBacking = new SqliteControlD1Database();
  let dropTriggerEvidence: ControlD1ReleaseCapabilityDropTriggerEvidence;
  try {
    const triggerFetch = createCapabilityFetch(triggerBacking, triggerStats, 2);
    const database = createRestDatabase(triggerFetch);
    triggerBacking.exec(`
      create table capability_trigger_probe (id integer primary key);
      create trigger capability_trigger_probe_insert
        before insert on capability_trigger_probe begin select 1; end;
      create trigger capability_trigger_probe_update
        before update on capability_trigger_probe begin select 1; end;
    `);
    const dropStatements = [
      database.prepare("drop trigger capability_trigger_probe_insert"),
      database.prepare("drop trigger if exists capability_trigger_probe_update"),
    ];
    await database.batch(dropStatements);
    if (triggerStats.queryDropTriggerRequests !== 0) {
      throw new ControlD1ReleaseCapabilityError(
        "drop_trigger_used_query_transport",
      );
    }
    if (triggerStats.importIngestCount !== 1) {
      throw new ControlD1ReleaseCapabilityError(
        "drop_trigger_import_count_invalid",
      );
    }
    const remaining = await triggerBacking
      .prepare(
        "select count(*) as count from sqlite_master where type = 'trigger'",
      )
      .first<{ readonly count: number }>();
    if (remaining?.count !== 0) {
      throw new ControlD1ReleaseCapabilityError(
        "drop_trigger_import_not_applied",
      );
    }

    const successfulImportCounts = {
      importInitCount: triggerStats.importInitCount,
      importUploadCount: triggerStats.importUploadCount,
      importIngestCount: triggerStats.importIngestCount,
      importPollCount: triggerStats.importPollCount,
    } as const;

    // A failed import must leave both triggers in place. This exercises the
    // same BEGIN IMMEDIATE/COMMIT/ROLLBACK transaction used by the self-test
    // import endpoint and proves that the batch is not split into queries.
    triggerBacking.exec(`
      create trigger capability_trigger_probe_insert
        before insert on capability_trigger_probe begin select 1; end;
      create trigger capability_trigger_probe_update
        before update on capability_trigger_probe begin select 1; end;
    `);
    await expectRestFailure(
      database.batch([
        database.prepare("drop trigger capability_trigger_probe_insert"),
        database.prepare("drop trigger capability_trigger_probe_missing"),
      ]),
    );
    const afterRollback = await triggerBacking
      .prepare(
        "select count(*) as count from sqlite_master where type = 'trigger'",
      )
      .first<{ readonly count: number }>();
    if (afterRollback?.count !== 2) {
      throw new ControlD1ReleaseCapabilityError(
        "drop_trigger_import_not_atomic",
      );
    }

    const successfulUploadedSql = triggerStats.uploadedSql[0];
    if (!successfulUploadedSql) {
      throw new ControlD1ReleaseCapabilityError(
        "drop_trigger_import_sql_missing",
      );
    }
    dropTriggerEvidence = {
      statementCount: 2,
      queryRequestCount: triggerStats.queryDropTriggerRequests,
      ...successfulImportCounts,
      uploadedSqlDigest: digestText(successfulUploadedSql),
      routedToAtomicSqlFileImport: true,
      rollbackProof: true,
    };
  } finally {
    triggerBacking.close();
  }

  const query = queryEvidence(queryStats);
  const importPoll = importPollEvidence(queryStats);
  const sourceDigest = digestJson(sourceFiles);
  const testFile = sourceFiles.find(
    (file) => file.path === CAPABILITY_TEST_FILE_PATH,
  );
  if (!testFile) {
    throw new ControlD1ReleaseCapabilityError("test_source_digest_missing");
  }
  const transportDigest = digestJson({
    query,
    schemaRelease,
    dropTriggerBatch: dropTriggerEvidence,
    importPoll,
  });
  const capabilityWithoutDigest = {
    kind: CONTROL_D1_RELEASE_CAPABILITY_KIND,
    status: "ready" as const,
    version: CONTROL_D1_RELEASE_CAPABILITY_VERSION,
    capabilityVersion: CONTROL_D1_RELEASE_CAPABILITY_VERSION,
    sourceCommit,
    source: { commit: sourceCommit, files: sourceFiles, digest: sourceDigest },
    test: {
      path: CAPABILITY_TEST_FILE_PATH,
      sha256: testFile.sha256,
      digest: testFile.sha256,
    },
    tool: {
      name: "bun" as const,
      version: options.toolVersion ?? Bun.version,
      packageVersion,
      command: CONTROL_D1_RELEASE_CAPABILITY_COMMAND,
    },
    transport: {
      query,
      schemaRelease,
      dropTriggerBatch: dropTriggerEvidence,
      importPoll,
      digest: transportDigest,
    },
  } as const;
  const digest = digestJson(capabilityWithoutDigest);
  return { ...capabilityWithoutDigest, digest };
}

function createRestDatabase(
  fetch: typeof globalThis.fetch,
): CloudflareControlD1RestDatabase {
  return new CloudflareControlD1RestDatabase({
    accountId: "release-capability-account",
    databaseId: "release-capability-database",
    apiToken: "self-test-token",
    fetch,
    importPollIntervalMilliseconds: 0,
    wait: async () => {},
  });
}

function emptyFetchStats(): CapabilityFetchStats {
  return {
    queryRequests: 0,
    queryStatements: [],
    queryDropTriggerRequests: 0,
    importInitCount: 0,
    importUploadCount: 0,
    importIngestCount: 0,
    importPollCount: 0,
    uploadedSql: [],
    returnedAtBookmarks: [],
    requestedCurrentBookmarks: [],
  };
}

function createCapabilityFetch(
  backing: SqliteControlD1Database,
  stats: CapabilityFetchStats,
  pendingPolls: number,
): typeof globalThis.fetch {
  const uploads = new Map<string, string>();
  const filenames = new Map<string, string>();
  const bookmarks = new Map<string, ImportBookmark>();
  const completed = new Set<string>();
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "d1-import-upload.example.test") {
      const etag = url.pathname.slice(1);
      const sql = String(init?.body ?? "");
      uploads.set(etag, sql);
      stats.importUploadCount += 1;
      stats.uploadedSql.push(sql);
      return new Response(null, {
        status: 200,
        headers: { etag: `"${etag}"` },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}")) as
      | RestQuery
      | { readonly batch: readonly RestQuery[] }
      | ImportAction;
    if (url.pathname.endsWith("/import")) {
      return handleImportRequest(
        body as ImportAction,
        backing,
        stats,
        uploads,
        filenames,
        bookmarks,
        completed,
        pendingPolls,
      );
    }
    if (!url.pathname.endsWith("/query")) {
      throw new ControlD1ReleaseCapabilityError("self_test_endpoint_invalid");
    }
    const queries = "batch" in body ? body.batch : [body];
    stats.queryRequests += 1;
    for (const query of queries) {
      const bytes = new TextEncoder().encode(query.sql).byteLength;
      stats.queryStatements.push({ sql: query.sql, bytes });
      if (leadingSqlTokens(query.sql).join(" ") === "DROP TRIGGER") {
        stats.queryDropTriggerRequests += 1;
        return Response.json(
          { success: false, errors: [{ code: 7500 }] },
          { status: 400 },
        );
      }
    }
    try {
      const results =
        "batch" in body
          ? await backing.batch(
              body.batch.map((query) =>
                backing.prepare(query.sql).bind(...(query.params ?? [])),
              ),
            )
          : [
              await backing
                .prepare(body.sql)
                .bind(...(body.params ?? []))
                .all(),
            ];
      return Response.json({ success: true, result: results });
    } catch {
      return Response.json(
        { success: false, errors: [{ code: 7500 }] },
        { status: 400 },
      );
    }
  };
}

async function handleImportRequest(
  body: ImportAction,
  backing: SqliteControlD1Database,
  stats: CapabilityFetchStats,
  uploads: Map<string, string>,
  filenames: Map<string, string>,
  bookmarks: Map<string, ImportBookmark>,
  completed: Set<string>,
  pendingPolls: number,
): Promise<Response> {
  if (body.action === "init") {
    stats.importInitCount += 1;
    if (completed.has(body.etag)) {
      return Response.json({
        success: true,
        result: { status: "complete", success: true },
      });
    }
    const filename = `capability-${body.etag}.sql`;
    filenames.set(filename, body.etag);
    return Response.json({
      success: true,
      result: {
        filename,
        upload_url: `https://d1-import-upload.example.test/${body.etag}`,
      },
    });
  }
  if (body.action === "ingest") {
    stats.importIngestCount += 1;
    const etag = filenames.get(body.filename ?? "");
    const sql = etag ? uploads.get(etag) : undefined;
    if (!etag || etag !== body.etag || !sql) {
      return Response.json({
        success: true,
        result: { status: "error", error: "missing upload" },
      });
    }
    try {
      backing.exec(`begin immediate;\n${sql}\ncommit;`);
    } catch {
      try {
        backing.exec("rollback;");
      } catch {
        // The transaction may already have been closed by SQLite.
      }
      return Response.json({
        success: true,
        result: { status: "error", error: "atomic import failed" },
      });
    }
    if (pendingPolls === 0) {
      completed.add(etag);
      return Response.json({
        success: true,
        result: { status: "complete", success: true },
      });
    }
    const bookmark = `bookmark-${etag}-0`;
    bookmarks.set(bookmark, { etag, remaining: pendingPolls, sequence: 0 });
    stats.returnedAtBookmarks.push(bookmark);
    return Response.json({ success: true, result: { at_bookmark: bookmark } });
  }
  stats.importPollCount += 1;
  stats.requestedCurrentBookmarks.push(body.current_bookmark);
  const current = bookmarks.get(body.current_bookmark);
  if (!current) {
    return Response.json({
      success: true,
      result: { status: "error", error: "unknown bookmark" },
    });
  }
  if (current.remaining > 1) {
    const nextBookmark = `bookmark-${current.etag}-${current.sequence + 1}`;
    bookmarks.delete(body.current_bookmark);
    bookmarks.set(nextBookmark, {
      ...current,
      remaining: current.remaining - 1,
      sequence: current.sequence + 1,
    });
    stats.returnedAtBookmarks.push(nextBookmark);
    return Response.json({
      success: true,
      result: { at_bookmark: nextBookmark },
    });
  }
  completed.add(current.etag);
  bookmarks.delete(body.current_bookmark);
  return Response.json({
    success: true,
    result: { status: "complete", success: true },
  });
}

function buildSchemaReleaseEvidence(
  plan: Awaited<ReturnType<typeof buildControlD1SchemaPlan>>,
  verification: {
    readonly status: "ready" | "mismatch";
    readonly schemaDigest: string;
    readonly ledgerDigest: string;
    readonly latestMigrationVersion: number;
    readonly migrationCount: number;
    readonly tableCount: number;
  },
  maintenanceStatus: "retained" | "released",
  stats: CapabilityFetchStats,
): ControlD1ReleaseCapabilitySchemaReleaseEvidence {
  if (verification.status !== "ready") {
    throw new ControlD1ReleaseCapabilityError(
      "schema_release_verification_not_ready",
    );
  }
  if (maintenanceStatus !== "released") {
    throw new ControlD1ReleaseCapabilityError(
      "schema_release_maintenance_not_released",
    );
  }
  const dropTriggerImports = stats.uploadedSql.filter(
    (sql) => countDropTriggerStatements(sql) > 0,
  );
  const dropTriggerStatementCount = dropTriggerImports.reduce(
    (count, sql) => count + countDropTriggerStatements(sql),
    0,
  );
  if (stats.queryDropTriggerRequests !== 0) {
    throw new ControlD1ReleaseCapabilityError(
      "schema_release_drop_trigger_used_query_transport",
    );
  }
  const body = {
    status: "ready" as const,
    maintenanceStatus: "released" as const,
    plan: {
      manifestDigest: plan.manifestDigest,
      expectedLatestMigrationVersion: plan.migrations.at(-1)?.version ?? 0,
      expectedMigrationCount: plan.migrations.length,
    },
    verification: {
      status: "ready" as const,
      schemaDigest: verification.schemaDigest,
      ledgerDigest: verification.ledgerDigest,
      latestMigrationVersion: verification.latestMigrationVersion,
      migrationCount: verification.migrationCount,
      tableCount: verification.tableCount,
    },
    imports: {
      count: stats.importIngestCount,
      pollCount: stats.importPollCount,
      dropTriggerStatementCount,
      dropTriggerImportCount: dropTriggerImports.length,
      dropTriggerQueryRequestCount: stats.queryDropTriggerRequests,
      dropTriggerImportDigest: digestJson(dropTriggerImports.map(digestText)),
      importTranscriptDigest: digestJson(stats.uploadedSql.map(digestText)),
    },
    zeroQueryDropTriggerRequests: true as const,
  };
  return { ...body, digest: digestJson(body) };
}

function countDropTriggerStatements(sql: string): number {
  const matches = sql.match(
    /(?:^|\n)\s*drop\s+trigger(?:\s+if\s+exists)?\b/giu,
  );
  return matches?.length ?? 0;
}

function queryEvidence(
  stats: CapabilityFetchStats,
): ControlD1ReleaseCapabilityQueryEvidence {
  const max = stats.queryStatements.reduce(
    (current, statement) =>
      statement.bytes > current.bytes ? statement : current,
    { sql: "", bytes: 0 },
  );
  if (stats.queryStatements.length === 0 || max.bytes === 0) {
    throw new ControlD1ReleaseCapabilityError("query_transport_not_exercised");
  }
  if (max.bytes > CONTROL_D1_RELEASE_CAPABILITY_QUERY_LIMIT_BYTES) {
    throw new ControlD1ReleaseCapabilityError("query_statement_over_limit");
  }
  return {
    endpoint: "/client/v4/accounts/:accountId/d1/database/:databaseId/query",
    requestCount: stats.queryRequests,
    statementCount: stats.queryStatements.length,
    maxActualStatementBytes: max.bytes,
    limitBytes: CONTROL_D1_RELEASE_CAPABILITY_QUERY_LIMIT_BYTES,
    maxStatementDigest: digestText(max.sql),
  };
}

function importPollEvidence(
  stats: CapabilityFetchStats,
): ControlD1ReleaseCapabilityImportPollEvidence {
  const returned = stats.returnedAtBookmarks;
  const requested = stats.requestedCurrentBookmarks;
  if (
    returned.length === 0 ||
    requested.length === 0 ||
    returned.length !== requested.length
  ) {
    throw new ControlD1ReleaseCapabilityError("import_poll_not_exercised");
  }
  const carriesEveryReturnedAtBookmark = requested.every(
    (bookmark, index) => bookmark === returned[index],
  );
  if (!carriesEveryReturnedAtBookmark) {
    throw new ControlD1ReleaseCapabilityError(
      "import_poll_bookmark_not_advanced",
    );
  }
  return {
    returnedAtBookmarkCount: returned.length,
    requestedCurrentBookmarkCount: requested.length,
    returnedAtBookmarkDigest: digestJson(returned.map(digestText)),
    requestedCurrentBookmarkDigest: digestJson(requested.map(digestText)),
    bookmarkSequenceDigest: digestJson(
      returned.map((bookmark, index) => ({
        sequence: index,
        returnedAtBookmarkDigest: digestText(bookmark),
        requestedCurrentBookmarkDigest: digestText(requested[index]!),
        carried: bookmark === requested[index],
      })),
    ),
    carriesEveryReturnedAtBookmark: true,
  };
}

function leadingSqlTokens(sql: string): readonly string[] {
  const tokens: string[] = [];
  for (let index = 0; index < sql.length && tokens.length < 3;) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) return tokens;
      index = end + 2;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(sql.slice(index));
    if (!match) return tokens;
    tokens.push(match[0].toUpperCase());
    index += match[0].length;
  }
  return tokens;
}

async function expectRestFailure(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch (error) {
    if (error instanceof ControlD1RestError) return;
  }
  throw new ControlD1ReleaseCapabilityError("atomic_import_failure_not_observed");
}

async function readSourceFileDigests(
  root: string,
): Promise<readonly ControlD1ReleaseCapabilityFileDigest[]> {
  const paths = [
    SOURCE_FILE_PATH,
    SCHEMA_SOURCE_FILE_PATH,
    CAPABILITY_SOURCE_FILE_PATH,
    TEST_FILE_PATH,
    CAPABILITY_TEST_FILE_PATH,
  ] as const;
  const files: ControlD1ReleaseCapabilityFileDigest[] = [];
  for (const path of paths) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(resolve(root, path)));
    } catch {
      throw new ControlD1ReleaseCapabilityError("source_file_missing");
    }
    files.push({ path, sha256: digestBytes(bytes), bytes: bytes.byteLength });
  }
  return files;
}

async function readPackageVersion(root: string): Promise<string> {
  try {
    const packageJson = JSON.parse(
      await readFile(resolve(root, "package.json"), "utf8"),
    ) as JsonRecord;
    if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
      throw new Error("version missing");
    }
    return packageJson.version;
  } catch {
    throw new ControlD1ReleaseCapabilityError("package_version_missing");
  }
}

function validateSourceCommit(value: string): string {
  const normalized = value.trim();
  if (!SOURCE_COMMIT_PATTERN.test(normalized)) {
    throw new ControlD1ReleaseCapabilityError("source_commit_invalid");
  }
  return normalized;
}

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function digestText(value: string): string {
  return digestBytes(new TextEncoder().encode(value));
}

function digestJson(value: unknown): string {
  return digestText(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
