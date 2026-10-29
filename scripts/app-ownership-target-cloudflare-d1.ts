/**
 * Supported operator adapter for `scripts/backfill-app-ownership.ts` and
 * `scripts/verify-app-access-cutover.ts` against a Cloudflare D1 Control
 * database through the Cloudflare REST API. Pass this file's absolute path as
 * `--adapter=`; it exports `openOwnershipBackfill()`.
 *
 * Configuration comes only from the operator's environment. Each value may be
 * given directly or as an absolute `_FILE` path (not both); the API token is
 * never printed, logged, put in a URL or included in an error:
 *
 *   TAKOSUMI_OWNERSHIP_TARGET_MODE        read-only (default) | apply
 *   TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID[_FILE]
 *   TAKOSUMI_OWNERSHIP_D1_DATABASE_ID[_FILE]
 *   TAKOSUMI_OWNERSHIP_D1_API_TOKEN[_FILE]
 *   TAKOSUMI_OWNERSHIP_D1_DATABASE_NAME   optional; refuses a different database
 *   TAKOSUMI_OWNERSHIP_FREEZE_WORKERS[_FILE]   apply only, JSON:
 *     [{"script":"<Worker name>","versionId":"<expected serving Version id>"}]
 *
 * read-only: every statement must be a SELECT/WITH read or a read-only schema
 * PRAGMA; anything else is refused before it is sent. Reads are retried on
 * 429/5xx. `workspaceMutationsFrozen` is never set, so backfill apply refuses.
 *
 * apply: before returning `workspaceMutationsFrozen: true` the adapter proves
 * the Workspace mutation freeze from Cloudflare itself. Every listed Worker
 * must serve exactly its expected Version at 100 percent, bind this database,
 * and resolve `TAKOSUMI_ACCOUNTS_WORKSPACE_MUTATIONS_FROZEN` to frozen; no
 * unlisted Worker in the account may serve a Version bound to this database.
 * The proof is repeated before a write once it is older than 30 seconds. The
 * Control store stays on the read-only client; only the ownership store
 * writes, limited to the backfill's column-scoped updates and inserts on
 * `capsules`, `capsule_members`, `connections`, `usage_events` and
 * `account_billing_bindings`. Writes are never retried.
 */
import { isAbsolute } from "node:path";
import { readFileSync } from "node:fs";

import { WORKSPACE_MUTATIONS_FROZEN_ENV, parseWorkspaceMutationsFrozen } from "../accounts/service/src/workspace-mutations-freeze.ts";
import { D1AppOwnershipStore } from "../core/domains/app-ownership/store.ts";
import type { OwnershipBackfillContext } from "../core/domains/app-ownership/backfill.ts";
import { CloudflareD1RestTransport } from "../deploy/cloudflare/d1-rest-transport.ts";
import type { D1Database, D1PreparedStatement, D1Result } from "../worker/src/bindings.ts";
import { CloudflareD1OpenTofuControlStore } from "../worker/src/d1_opentofu_store.ts";

export class OwnershipTargetRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OwnershipTargetRefusal";
  }
}

function refuse(code: string): never {
  throw new OwnershipTargetRefusal(code);
}

// --- statement policy ------------------------------------------------------

/** Lowercased SQL with comments removed and quoted text/identifiers blanked. */
export function ownershipTargetSqlShape(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length;) {
    const character = sql[i]!;
    if (character === "'" || character === '"' || character === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] === character) {
          if (sql[i + 1] === character) { i += 2; continue; }
          break;
        }
        i++;
      }
      if (i >= sql.length) return ";unterminated";
      i++;
      out += character === "'" ? "''" : '""';
    } else if (character === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (character === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return ";unterminated";
      i = end + 2;
      out += " ";
    } else {
      out += character;
      i++;
    }
  }
  return out.replace(/\s+/gu, " ").trim().toLowerCase().replace(/;$/u, "").trim();
}

const READ_START = /^(?:select|with)\b/u;
const READ_PRAGMA = /^pragma (?:table_info|table_xinfo|index_list|index_xinfo|index_info|foreign_key_list) ?\( ?(?:[a-z0-9_]+|""|'') ?\)$/u;
const WRITE_OR_CONTROL = /\b(?:insert|update|delete|drop|alter|create|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|upsert|pragma)\b|\breplace into\b/u;
const SCHEMA_OR_CONTROL = /\b(?:drop|alter|create|attach|detach|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release|pragma)\b|\breplace into\b/u;
const UPDATE_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  capsules: new Set(["owner_account_id", "ownership_epoch", "management_state", "management_epoch", "storage_root"]),
  connections: new Set(["owner_account_id"]),
  usage_events: new Set(["payer_account_id"]),
};

export function isOwnershipTargetRead(shape: string): boolean {
  if (shape.includes(";")) return false;
  if (READ_PRAGMA.test(shape)) return true;
  return READ_START.test(shape) && !WRITE_OR_CONTROL.test(shape);
}

/** The backfill's ownership writes only: column-scoped, table-allowlisted. */
export function isOwnershipTargetWrite(shape: string): boolean {
  if (shape.includes(";") || SCHEMA_OR_CONTROL.test(shape)) return false;
  const update = /^update ([a-z_]+) set (.+?) where /u.exec(shape);
  if (update) {
    const allowed = UPDATE_COLUMNS[update[1]!];
    if (!allowed) return false;
    const columns = update[2]!.split(",").map((assignment) => /^ ?([a-z_]+) ?= ?\? ?$/u.exec(assignment)?.[1]);
    return columns.length > 0 && columns.every((column) => column !== undefined && allowed.has(column));
  }
  return /^insert into (?:capsule_members|account_billing_bindings) ?\(/u.test(shape) ||
    /^delete from capsule_members where /u.test(shape);
}

type Policy = "read-only" | "ownership-write";

interface TargetStats {
  statements: number;
  writes: number;
  refused: number;
  freezeChecks: number;
}

class GuardedD1 implements D1Database {
  constructor(
    readonly inner: CloudflareD1RestTransport,
    readonly policy: Policy,
    readonly stats: TargetStats,
    readonly beforeWrite: () => Promise<void>,
  ) {}

  prepare(query: string): D1PreparedStatement {
    return new GuardedStatement(this, this.inner.prepare(query), query);
  }

  async batch<T = unknown>(statements: readonly D1PreparedStatement[]): Promise<readonly D1Result<T>[]> {
    const inner: D1PreparedStatement[] = [];
    let writes = 0;
    for (const statement of statements) {
      if (!(statement instanceof GuardedStatement) || statement.database !== this) refuse("ownership_target_batch_statement_invalid");
      const guarded = statement as GuardedStatement;
      if (this.classify(guarded.sql) === "write") writes++;
      inner.push(guarded.inner);
    }
    if (writes > 0) await this.beforeWrite();
    this.stats.statements += statements.length;
    this.stats.writes += writes;
    return await this.inner.batch<T>(inner);
  }

  classify(sql: string): "read" | "write" {
    const shape = ownershipTargetSqlShape(sql);
    if (isOwnershipTargetRead(shape)) return "read";
    if (this.policy === "ownership-write" && isOwnershipTargetWrite(shape)) return "write";
    this.stats.refused++;
    return refuse(this.policy === "read-only" ? "ownership_target_read_only_refused" : "ownership_target_statement_refused");
  }

  async admit(sql: string): Promise<void> {
    const kind = this.classify(sql);
    if (kind === "write") await this.beforeWrite();
    this.stats.statements++;
    if (kind === "write") this.stats.writes++;
  }
}

class GuardedStatement implements D1PreparedStatement {
  constructor(
    readonly database: GuardedD1,
    readonly inner: D1PreparedStatement,
    readonly sql: string,
  ) {}

  bind(...values: readonly unknown[]): D1PreparedStatement {
    return new GuardedStatement(this.database, this.inner.bind(...values), this.sql);
  }

  async first<T = unknown>(): Promise<T | null> {
    await this.database.admit(this.sql);
    return await this.inner.first<T>();
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    await this.database.admit(this.sql);
    return await this.inner.all<T>();
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    await this.database.admit(this.sql);
    return await this.inner.run<T>();
  }

  /** Drizzle's mapped SELECTs read positional rows. */
  async raw<T = unknown[]>(options?: { readonly columnNames?: boolean }): Promise<T[]> {
    await this.database.admit(this.sql);
    const raw = (this.inner as { raw?: (options?: { readonly columnNames?: boolean }) => Promise<T[]> }).raw;
    if (!raw) return refuse("ownership_target_raw_unavailable");
    return await raw.call(this.inner, options);
  }
}

// --- Cloudflare API --------------------------------------------------------

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

function retryingFetch(base: typeof fetch, sleep: (milliseconds: number) => Promise<void>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await base(input, init);
      } catch (error) {
        if (attempt >= 3) throw error;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!RETRY_STATUSES.has(response.status) || attempt >= 3) return response;
      await response.body?.cancel();
      await sleep(500 * 2 ** attempt);
    }
  }) as typeof fetch;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class CloudflareApi {
  constructor(
    readonly accountId: string,
    readonly apiToken: string,
    readonly fetch: typeof fetch,
  ) {}

  async get(path: string): Promise<unknown> {
    const url = new URL(`/client/v4/accounts/${encodeURIComponent(this.accountId)}${path}`, "https://api.cloudflare.com");
    let response: Response;
    try {
      response = await this.fetch(url, { method: "GET", headers: { authorization: `Bearer ${this.apiToken}` } });
    } catch {
      return refuse("ownership_freeze_api_request_failed");
    }
    const body = await response.json().catch(() => undefined);
    if (!response.ok || !record(body) || body.success !== true) refuse(`ownership_freeze_api_failed:${response.status}`);
    return (body as Record<string, unknown>).result;
  }
}

interface FreezeWorker {
  readonly script: string;
  readonly versionId: string;
}

const WORKER_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/u;
const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function parseFreezeWorkers(value: string): readonly FreezeWorker[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse("ownership_freeze_workers_invalid");
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 32) refuse("ownership_freeze_workers_invalid");
  const seen = new Set<string>();
  return (parsed as unknown[]).map((entry) => {
    if (!record(entry) || Object.keys(entry).some((key) => key !== "script" && key !== "versionId") ||
      typeof entry.script !== "string" || !WORKER_NAME.test(entry.script) || seen.has(entry.script) ||
      typeof entry.versionId !== "string" || !VERSION_ID.test(entry.versionId)) {
      refuse("ownership_freeze_workers_invalid");
    }
    seen.add(entry.script as string);
    return { script: entry.script as string, versionId: entry.versionId as string };
  });
}

async function servingVersions(api: CloudflareApi, script: string): Promise<readonly { versionId: string; percentage: number }[]> {
  const result = await api.get(`/workers/scripts/${encodeURIComponent(script)}/deployments`);
  const deployments = record(result) && Array.isArray(result.deployments) ? result.deployments : refuse(`ownership_freeze_deployments_invalid:${script}`);
  const latest = deployments[0];
  if (latest === undefined) return [];
  if (!record(latest) || !Array.isArray(latest.versions)) refuse(`ownership_freeze_deployments_invalid:${script}`);
  return ((latest as Record<string, unknown>).versions as unknown[]).map((version) => {
    if (!record(version) || typeof version.version_id !== "string" || typeof version.percentage !== "number") {
      refuse(`ownership_freeze_deployments_invalid:${script}`);
    }
    return { versionId: (version as Record<string, unknown>).version_id as string, percentage: (version as Record<string, unknown>).percentage as number };
  }).filter((version) => version.percentage > 0);
}

async function versionBindings(api: CloudflareApi, script: string, versionId: string): Promise<readonly Record<string, unknown>[]> {
  const result = await api.get(`/workers/scripts/${encodeURIComponent(script)}/versions/${encodeURIComponent(versionId)}`);
  const bindings = record(result) && record(result.resources) && Array.isArray(result.resources.bindings)
    ? result.resources.bindings : refuse(`ownership_freeze_version_invalid:${script}`);
  if ((bindings as unknown[]).some((binding) => !record(binding))) refuse(`ownership_freeze_version_invalid:${script}`);
  return bindings as readonly Record<string, unknown>[];
}

const bindsDatabase = (bindings: readonly Record<string, unknown>[], databaseId: string) =>
  bindings.some((binding) => binding.type === "d1" && (binding.id === databaseId || binding.database_id === databaseId));

/**
 * Prove the Workspace mutation freeze from Cloudflare: exact serving Versions
 * of the listed Workers, their bindings to this database and their freeze
 * variable, plus no unlisted Worker serving a Version bound to it.
 */
async function verifyWorkspaceMutationFreeze(
  api: CloudflareApi,
  databaseId: string,
  workers: readonly FreezeWorker[],
): Promise<void> {
  for (const worker of workers) {
    const serving = await servingVersions(api, worker.script);
    if (serving.length !== 1 || serving[0]!.versionId !== worker.versionId || serving[0]!.percentage !== 100) {
      refuse(`ownership_freeze_version_mismatch:${worker.script}`);
    }
    const bindings = await versionBindings(api, worker.script, worker.versionId);
    if (!bindsDatabase(bindings, databaseId)) refuse(`ownership_freeze_worker_not_bound:${worker.script}`);
    const freeze = bindings.filter((binding) => binding.name === WORKSPACE_MUTATIONS_FROZEN_ENV);
    if (freeze.length > 1) refuse(`ownership_freeze_variable_invalid:${worker.script}`);
    if (freeze.length === 1) {
      const [binding] = freeze;
      if (binding!.type !== "plain_text" || typeof binding!.text !== "string") refuse(`ownership_freeze_variable_invalid:${worker.script}`);
      let frozen: boolean;
      try {
        frozen = parseWorkspaceMutationsFrozen(binding!.text as string);
      } catch {
        return refuse(`ownership_freeze_variable_invalid:${worker.script}`);
      }
      if (!frozen) refuse(`ownership_freeze_not_frozen:${worker.script}`);
    }
    // An absent variable is the code default: frozen.
  }
  const listed = new Set(workers.map((worker) => worker.script));
  const scripts = await api.get("/workers/scripts");
  if (!Array.isArray(scripts)) refuse("ownership_freeze_scripts_invalid");
  for (const script of scripts as unknown[]) {
    const name = record(script) && typeof script.id === "string" ? script.id : refuse("ownership_freeze_scripts_invalid");
    if (listed.has(name as string)) continue;
    for (const version of await servingVersions(api, name as string)) {
      if (bindsDatabase(await versionBindings(api, name as string, version.versionId), databaseId)) {
        refuse(`ownership_freeze_unlisted_worker:${name as string}`);
      }
    }
  }
}

// --- configuration and context ---------------------------------------------

export interface CloudflareD1OwnershipTargetOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string) => string;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly log?: (line: string) => void;
  readonly freezeRecheckMilliseconds?: number;
}

function setting(
  options: CloudflareD1OwnershipTargetOptions,
  name: string,
  required: boolean,
): string | undefined {
  const direct = options.env[name]?.trim() || undefined;
  const path = options.env[`${name}_FILE`]?.trim() || undefined;
  if (direct && path) refuse(`ownership_target_config_ambiguous:${name}`);
  if (path) {
    if (!isAbsolute(path)) refuse(`ownership_target_config_path_not_absolute:${name}`);
    let value: string;
    try {
      value = (options.readFile ?? ((file) => readFileSync(file, "utf8")))(path).trim();
    } catch {
      return refuse(`ownership_target_config_unreadable:${name}`);
    }
    if (!value) refuse(`ownership_target_config_missing:${name}`);
    return value;
  }
  if (!direct && required) refuse(`ownership_target_config_missing:${name}`);
  return direct;
}

export async function openCloudflareD1OwnershipTarget(
  options: CloudflareD1OwnershipTargetOptions,
): Promise<OwnershipBackfillContext & { close(): Promise<void> }> {
  const mode = options.env.TAKOSUMI_OWNERSHIP_TARGET_MODE?.trim() || "read-only";
  if (mode !== "read-only" && mode !== "apply") refuse("ownership_target_mode_invalid");
  const accountId = setting(options, "TAKOSUMI_OWNERSHIP_D1_ACCOUNT_ID", true)!;
  const databaseId = setting(options, "TAKOSUMI_OWNERSHIP_D1_DATABASE_ID", true)!;
  const apiToken = setting(options, "TAKOSUMI_OWNERSHIP_D1_API_TOKEN", true)!;
  const databaseName = setting(options, "TAKOSUMI_OWNERSHIP_D1_DATABASE_NAME", false);
  const workers = mode === "apply"
    ? parseFreezeWorkers(setting(options, "TAKOSUMI_OWNERSHIP_FREEZE_WORKERS", true)!)
    : undefined;
  const baseFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const readFetch = retryingFetch(baseFetch, sleep);
  const api = new CloudflareApi(accountId, apiToken, readFetch);
  const stats: TargetStats = { statements: 0, writes: 0, refused: 0, freezeChecks: 0 };
  const errorFactory = (code: string) => new OwnershipTargetRefusal(code);

  if (databaseName !== undefined) {
    const database = await api.get(`/d1/database/${encodeURIComponent(databaseId)}`);
    if (!record(database) || database.name !== databaseName) refuse("ownership_target_database_name_mismatch");
  }

  let verifiedAt = Number.NEGATIVE_INFINITY;
  const verifyFreeze = async () => {
    stats.freezeChecks++;
    await verifyWorkspaceMutationFreeze(api, databaseId, workers!);
    verifiedAt = now();
  };
  if (workers) await verifyFreeze();

  const readTransport = new CloudflareD1RestTransport({ accountId, databaseId, apiToken, fetch: readFetch, errorFactory });
  const read = new GuardedD1(readTransport, "read-only", stats, async () => refuse("ownership_target_read_only_refused"));
  const control = new CloudflareD1OpenTofuControlStore(read, { schemaMode: "predeployed" });
  let ownershipDatabase: D1Database = read;
  if (workers) {
    const recheck = options.freezeRecheckMilliseconds ?? 30_000;
    // Writes never retry: an unacknowledged write is reconciled by a new dry-run.
    const writeTransport = new CloudflareD1RestTransport({ accountId, databaseId, apiToken, fetch: baseFetch, errorFactory });
    ownershipDatabase = new GuardedD1(writeTransport, "ownership-write", stats, async () => {
      if (now() - verifiedAt >= recheck) await verifyFreeze();
    });
  }
  const ownership = new D1AppOwnershipStore(ownershipDatabase, control);
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  return {
    control,
    ownership,
    ...(workers ? { workspaceMutationsFrozen: true as const } : {}),
    async close() {
      log(JSON.stringify({ kind: "takosumi.app-ownership-target@v1", target: "cloudflare-d1", mode, ...stats }));
    },
  };
}

/** Entry point read by the backfill and cutover verification scripts. */
export async function openOwnershipBackfill() {
  return await openCloudflareD1OwnershipTarget({ env: process.env });
}
