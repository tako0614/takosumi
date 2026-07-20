#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FIXTURE_KIND = "takosumi.formref-migration-replica-fixture@v1";
const PRE_FORMREF_SOURCE_COMMIT = "7ef774c316b3d619328b6887242fe0636c2b4249";
const PRE_FORMREF_SCHEMA_VERSION = 44;
const WORKSPACE_ID = "ws_formrefreplica";
const RESOURCE_KIND = "ObjectBucket";
const RESOURCE_NAME = "legacy-object-bucket";
const FIXED_TIME = "2026-07-20T00:00:00.000Z";

interface CliOptions {
  readonly predecessorCheckout: string;
  readonly sqliteOutput: string;
  readonly sqlOutput: string;
  readonly evidenceOutput: string;
}

interface D1Result<T> {
  readonly results?: readonly T[];
}

interface D1DatabaseLike {
  prepare(sql: string): {
    bind(...values: readonly unknown[]): unknown;
    all<T>(): Promise<D1Result<T>>;
    first<T>(): Promise<T | null>;
  };
  close(): void;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const predecessorCheckout = await verifiedPredecessorCheckout(
    options.predecessorCheckout,
  );
  await requireFreshOutput(options.sqliteOutput);
  await requireFreshOutput(options.sqlOutput);
  await requireFreshOutput(options.evidenceOutput);

  const schemaModule = await importPredecessor<{
    SqliteControlD1Database: new (filename: string) => D1DatabaseLike;
  }>(predecessorCheckout, "deploy/platform/control_d1_schema.ts");
  const ledgerModule = await importPredecessor<{
    ensureD1OpenTofuLedgerSchema(db: D1DatabaseLike): Promise<void>;
  }>(predecessorCheckout, "worker/src/d1_opentofu_store.ts");
  const storesModule = await importPredecessor<{
    createD1ResourceShapeStores(db: D1DatabaseLike): {
      readonly resources: {
        upsert(record: Record<string, unknown>): Promise<unknown>;
        get(id: string): Promise<Record<string, unknown> | undefined>;
      };
      readonly locks: {
        put(record: Record<string, unknown>): Promise<unknown>;
        get(id: string): Promise<Record<string, unknown> | undefined>;
      };
    };
  }>(predecessorCheckout, "core/domains/resource-shape/d1_stores.ts");
  const recordsModule = await importPredecessor<{
    formatResourceShapeId(spaceId: string, kind: string, name: string): string;
  }>(predecessorCheckout, "core/domains/resource-shape/records.ts");

  const database = new schemaModule.SqliteControlD1Database(
    options.sqliteOutput,
  );
  const resourceId = recordsModule.formatResourceShapeId(
    WORKSPACE_ID,
    RESOURCE_KIND,
    RESOURCE_NAME,
  );
  try {
    await ledgerModule.ensureD1OpenTofuLedgerSchema(database);
    await assertPredecessorSchema(database);
    const stores = storesModule.createD1ResourceShapeStores(database);
    await stores.resources.upsert({
      id: resourceId,
      spaceId: WORKSPACE_ID,
      kind: RESOURCE_KIND,
      name: RESOURCE_NAME,
      managedBy: "opentofu",
      spec: { storageClass: "standard" },
      phase: "Ready",
      generation: 1,
      observedGeneration: 1,
      outputs: { fixture: "redacted-non-secret" },
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    await stores.locks.put({
      resourceId,
      selectedImplementation: "fixture-object-store",
      target: "fixture-target",
      locked: true,
      reason: ["reviewed-pre-formref-replica-fixture"],
      lockedAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    });
    const [resource, lock] = await Promise.all([
      stores.resources.get(resourceId),
      stores.locks.get(resourceId),
    ]);
    if (!resource || !lock || resource.id !== resourceId) {
      throw new Error(
        "predecessor fixture did not round-trip through old stores",
      );
    }
    await assertPreFormRefColumnsAbsent(database);
  } finally {
    database.close();
  }

  await chmod(options.sqliteOutput, 0o600);
  const dump = await dumpSqlite(options.sqliteOutput);
  await writeExclusive(options.sqlOutput, dump);
  const evidence = {
    kind: FIXTURE_KIND,
    status: "ready",
    predecessorSourceCommit: PRE_FORMREF_SOURCE_COMMIT,
    predecessorSchemaVersion: PRE_FORMREF_SCHEMA_VERSION,
    fixtureSource: "reviewed-predecessor-store-api",
    workspaceId: WORKSPACE_ID,
    resourceId,
    resourceKind: RESOURCE_KIND,
    sqliteSha256: await sha256File(options.sqliteOutput),
    sqlSha256: sha256(dump),
  } as const;
  await writeExclusive(
    options.evidenceOutput,
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(JSON.stringify(evidence));
}

async function verifiedPredecessorCheckout(input: string): Promise<string> {
  const checkout = await realpath(input);
  const stat = await lstat(checkout);
  if (!stat.isDirectory())
    throw new Error("predecessor checkout is not a directory");
  const [head, status] = await Promise.all([
    git(checkout, ["rev-parse", "HEAD"]),
    git(checkout, ["status", "--short", "--untracked-files=all"]),
  ]);
  if (head.trim() !== PRE_FORMREF_SOURCE_COMMIT) {
    throw new Error(
      "predecessor checkout is not the reviewed pre-FormRef commit",
    );
  }
  if (status.trim() !== "") {
    throw new Error("predecessor checkout must be clean");
  }
  return checkout;
}

async function importPredecessor<T>(
  checkout: string,
  relativePath: string,
): Promise<T> {
  const path = resolve(checkout, relativePath);
  if (!path.startsWith(`${checkout}/`))
    throw new Error("invalid predecessor module path");
  return (await import(pathToFileURL(path).href)) as T;
}

async function assertPredecessorSchema(db: D1DatabaseLike): Promise<void> {
  const latest = await db
    .prepare("select max(version) as version from schema_migrations")
    .first<{ readonly version: number }>();
  if (latest?.version !== PRE_FORMREF_SCHEMA_VERSION) {
    throw new Error("reviewed predecessor did not materialize D1 schema v44");
  }
}

async function assertPreFormRefColumnsAbsent(
  db: D1DatabaseLike,
): Promise<void> {
  for (const table of ["resource_shapes", "resolution_locks"]) {
    const columns = await db
      .prepare(`pragma table_info(${table})`)
      .all<{ readonly name: string }>();
    const names = new Set((columns.results ?? []).map(({ name }) => name));
    if (names.has("form_ref_json") || names.has("package_digest")) {
      throw new Error(
        `${table} unexpectedly contains exact Form identity columns`,
      );
    }
  }
}

async function dumpSqlite(path: string): Promise<string> {
  const child = Bun.spawn(["sqlite3", path, ".dump"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || stderr.trim() !== "") {
    throw new Error("sqlite fixture dump failed");
  }
  if (
    !stdout.includes("INSERT INTO resource_shapes") ||
    !stdout.includes("INSERT INTO resolution_locks")
  ) {
    throw new Error("sqlite fixture dump is missing the coherent legacy pair");
  }
  return stdout;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error("git predecessor verification failed");
  return stdout;
}

async function requireFreshOutput(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error("output paths must be absolute");
  await lstat(path).then(
    () => {
      throw new Error(`refusing to overwrite ${path}`);
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const parent = await realpath(dirname(path));
  const stat = await lstat(parent);
  if (!stat.isDirectory()) throw new Error("output parent is not a directory");
  const handle = await open(path, "wx", 0o600);
  await handle.close();
}

async function writeExclusive(path: string, value: string): Promise<void> {
  const current = await readFile(path);
  if (current.byteLength !== 0) throw new Error(`output ${path} changed`);
  await writeFile(path, value, { mode: 0o600, flag: "r+" });
  await chmod(path, 0o600);
}

async function sha256File(path: string): Promise<string> {
  return sha256(await readFile(path));
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(help());
    }
    if (values.has(key)) throw new Error(help());
    values.set(key, value);
  }
  const predecessorCheckout = values.get("--predecessor-checkout");
  const sqliteOutput = values.get("--sqlite-output");
  const sqlOutput = values.get("--sql-output");
  const evidenceOutput = values.get("--evidence-output");
  if (
    !predecessorCheckout ||
    !sqliteOutput ||
    !sqlOutput ||
    !evidenceOutput ||
    values.size !== 4
  ) {
    throw new Error(help());
  }
  return { predecessorCheckout, sqliteOutput, sqlOutput, evidenceOutput };
}

function help(): string {
  return "usage: generate-formref-migration-replica-fixture.ts --predecessor-checkout <clean-v44-checkout> --sqlite-output <absolute-path> --sql-output <absolute-path> --evidence-output <absolute-path>";
}

await main();
