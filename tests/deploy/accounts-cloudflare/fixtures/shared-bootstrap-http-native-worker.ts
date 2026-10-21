import entrypoint from "../../../../deploy/accounts-cloudflare/src/entry-worker.ts";
import { D1AccountsStore, type D1Database } from "../../../../accounts/service/src/d1-store.ts";
import { loadD1AccountsMigrationCatalog, applyD1AccountsMigrationBatch } from "../../../../accounts/service/src/d1-migrations.ts";
import { rotateAccountSession, HOSTED_ACCOUNT_SESSION_COOKIE_NAME } from "../../../../accounts/service/src/account-session.ts";
import { ensureD1OpenTofuLedgerSchema } from "../../../../worker/src/d1_opentofu_store.ts";
import { acquireControlD1MaintenanceFence, releaseControlD1MaintenanceFence } from "../../../../worker/src/d1_schema_maintenance.ts";

interface FixtureEnv extends Record<string, unknown> {
  TAKOSUMI_ACCOUNTS_DB: D1Database;
  TAKOSUMI_CONTROL_DB: D1Database;
  TAKOSUMI_ACCOUNT_SESSION_HASH_SALT: string;
  FIXTURE_GATE_URL?: string;
}
type Lane = "accounts" | "control";
type SqlCounts = { prepared: number; batchCalls: number; batchStatements: number; classes: Record<string, number> };
type RequestCounts = { expectedIssuerOrigin: boolean; expectedHostHeader: boolean; startedAt: number; completedAt: number | null; durationMs: number | null; status: number | null; accounts: SqlCounts; control: SqlCounts };
const wrappedEnvironments = new WeakMap<object, FixtureEnv>();
let active: RequestCounts | undefined;
let lastRequest: RequestCounts | undefined;
let gateEntered = false;
let gateFinished = false;

function freshCounts(): SqlCounts { return { prepared: 0, batchCalls: 0, batchStatements: 0, classes: {} }; }
function classify(lane: Lane, sql: string): string {
  const text = sql.toLowerCase();
  if (/schema_migrations|sqlite_master|pragma\s/i.test(text)) return `${lane}_schema`;
  if (lane === "accounts") return "accounts_store";
  if (/\bworkspaces\b|workspace_members/u.test(text)) return "control_workspace";
  return "control_other";
}
function countedDatabase(database: D1Database, lane: Lane, env: FixtureEnv): D1Database {
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        if (active) {
          const key = classify(lane, sql);
          active[lane].prepared++;
          active[lane].classes[key] = (active[lane].classes[key] ?? 0) + 1;
        }
        const statement = Reflect.apply(target.prepare, target, [sql]);
        // Test-only real network barrier after the outer predeployed schema
        // check, inside the cold Control initializer. No SQL/guard is replaced.
        if (lane !== "control" || !env.FIXTURE_GATE_URL || !active || active.control.prepared !== 8 || gateEntered) return statement;
        gateEntered = true;
        const waitForGate = async () => { const response = await fetch(env.FIXTURE_GATE_URL!); await response.arrayBuffer(); gateFinished = true; };
        let originalFlight: Promise<void> | undefined;
        return new Proxy(statement, { get(source, key) {
          const value = Reflect.get(source, key, source);
          if (["first", "all", "run", "raw"].includes(String(key)) && typeof value === "function") return async (...args: unknown[]) => {
            originalFlight ??= waitForGate();
            await originalFlight;
            return await Reflect.apply(value, source, args);
          };
          return typeof value === "function" ? value.bind(source) : value;
        } });
      };
      if (property === "batch") return (statements: readonly unknown[]) => {
        if (active) { active[lane].batchCalls++; active[lane].batchStatements += statements.length; }
        return Reflect.apply(target.batch, target, [statements]);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
function envFor(env: FixtureEnv): FixtureEnv {
  const existing = wrappedEnvironments.get(env);
  if (existing) return existing;
  const wrapped = {
    ...env,
    TAKOSUMI_ACCOUNTS_DB: countedDatabase(env.TAKOSUMI_ACCOUNTS_DB, "accounts", env),
    TAKOSUMI_CONTROL_DB: countedDatabase(env.TAKOSUMI_CONTROL_DB, "control", env),
  } as FixtureEnv;
  wrappedEnvironments.set(env, wrapped);
  return wrapped;
}
function safeCounts(value: RequestCounts | undefined) {
  if (!value) return null;
  return {
    expectedIssuerOrigin: value.expectedIssuerOrigin,
    expectedHostHeader: value.expectedHostHeader,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    durationMs: value.durationMs,
    status: value.status,
    accounts: { ...value.accounts, classes: { ...value.accounts.classes } },
    control: { ...value.control, classes: { ...value.control.classes } },
  };
}

export default {
  async fetch(request: Request, env: FixtureEnv, context?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/__fixture/prepare" && request.method === "POST") {
      try {
        const accounts = env.TAKOSUMI_ACCOUNTS_DB;
        const catalog = await loadD1AccountsMigrationCatalog();
        for (const migration of catalog.migrations) {
          if (migration.version > 5) break;
          await applyD1AccountsMigrationBatch(accounts, migration, 1_700_000_000_000 + migration.version);
        }
        await ensureD1OpenTofuLedgerSchema(env.TAKOSUMI_CONTROL_DB);
        const fence = await acquireControlD1MaintenanceFence(env.TAKOSUMI_CONTROL_DB, { sourceCommit: "c".repeat(40), manifestDigest: `sha256:${"d".repeat(64)}`, environment: "test", databaseRole: "in_place", releasePolicy: "in_place" }, "2026-10-21T00:00:00.000Z");
        await releaseControlD1MaintenanceFence(env.TAKOSUMI_CONTROL_DB, fence, "2026-10-21T00:00:01.000Z");
        const store = new D1AccountsStore(accounts, { schemaMode: "predeployed", sessionHashSalt: env.TAKOSUMI_ACCOUNT_SESSION_HASH_SALT });
        const now = Date.now();
        const subject = "tsub_bootstrap_native_fixture";
        await store.saveAccount({ subject, createdAt: now, updatedAt: now });
        const session = await rotateAccountSession({ store, subject, now, ttlMs: 60_000, hostedPolicy: true, freshlyAuthenticatedAt: Math.floor(now / 1000) });
        return Response.json({ ok: true, cookie: `${HOSTED_ACCOUNT_SESSION_COOKIE_NAME}=${session.sessionId}` }, { headers: { "cache-control": "no-store" } });
      } catch {
        return Response.json({ ok: false, stage: "fixture_prepare_failed" }, { status: 500, headers: { "cache-control": "no-store" } });
      }
    }
    if (path === "/__fixture/reset" && request.method === "POST") {
      active = undefined;
      lastRequest = undefined;
      return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    if (path === "/__fixture/diagnostics" && request.method === "GET") {
      return Response.json({ lastRequest: safeCounts(lastRequest), currentRequest: safeCounts(active), inFlight: active !== undefined, gateEntered, gateFinished }, { headers: { "cache-control": "no-store" } });
    }
    const started = performance.now();
    const tracking = path === "/api/v1/account/shared-workspaces/bootstrap" && request.method === "POST";
    if (tracking) {
      active = { expectedIssuerOrigin: new URL(request.url).origin === "https://auth-staging.takos.jp", expectedHostHeader: !request.headers.has("host") || request.headers.get("host") === new URL(request.url).host, startedAt: Date.now(), completedAt: null, durationMs: null, status: null, accounts: freshCounts(), control: freshCounts() };
    }
    try {
      const response = await entrypoint.fetch(request, envFor(env), context);
      if (tracking && active) active.status = response.status;
      return response;
    } catch {
      if (tracking && active) active.status = null;
      throw new Error("fixture_worker_request_failed");
    } finally {
      if (tracking && active) {
        active.durationMs = performance.now() - started;
        active.completedAt = Date.now();
        lastRequest = active;
        active = undefined;
      }
    }
  },
};
