import { createTakosumiService } from "./bootstrap.ts";
import type { Hono as HonoApp } from "hono";
import type { TakosumiProcessRole } from "./process/mod.ts";
import {
  loadRuntimeConfigFromEnv,
  type RuntimeConfig,
  RuntimeConfigError,
  warnIfDevMode,
} from "./config/mod.ts";
import { log } from "./shared/log.ts";
import {
  currentRuntime,
  type RuntimeAdapter,
  type ServeHttpHandle,
} from "./shared/runtime/index.ts";
import { StorageMigrationRunner } from "./adapters/storage/migration-runner/mod.ts";
import {
  SecretEncryptionConfigurationError,
  selectSecretBoundaryCrypto,
} from "./adapters/secret-store/mod.ts";
import {
  assertDatabaseEncryptionAtRest,
  DatabaseEncryptionConfigurationError,
} from "./adapters/storage/encryption.ts";
import { SqlObservabilitySink } from "./services/observability/mod.ts";
import {
  type AuditExternalReplicationSink,
  AuditReplicationConfigurationError,
  resolveAuditRetention,
  selectAuditExternalReplicationSink,
  verifyAuditReplicationConsistency,
} from "./services/audit-replication/mod.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "./adapters/storage/sql.ts";
import { wrapPgResult } from "./adapters/storage/pg_result.ts";

/**
 * Materialised boot output exposed to callers that want to embed the service
 * into a custom host (e.g. tests or CLI `takosumi server`). The HTTP listener is *not* started here; callers wire
 * it up themselves via `runtime.serveHttp(app.fetch, ...)`.
 */
export interface StartedTakosumiService {
  readonly app: HonoApp;
  readonly role: TakosumiProcessRole;
  readonly runtime: RuntimeAdapter;
  readonly runtimeConfig: RuntimeConfig;
  readonly sharedSqlClient?: { client: SqlClient; close: () => Promise<void> };
}

/**
 * Boot the service synchronously inside an async function. This used to be a
 * sequence of top-level `await` statements which made the module unsafe to
 * import on Cloudflare Workers (Workers `export default { fetch: ... }`
 * touches the module, which would otherwise eagerly run config-load /
 * migration code on a bare V8 isolate without env bindings). Wrapping the
 * boot inside `startTakosumiService()` and gating the long-running entrypoint on
 * `import.meta.main` keeps the module import side-effect-free.
 */
export async function startTakosumiService(): Promise<StartedTakosumiService> {
  const runtime = currentRuntime();
  const runtimeEnv: Record<string, string> = runtime.env.toObject();
  warnIfDevMode(runtimeEnv);
  const runtimeConfig = await loadRuntimeConfigFromEnv({ env: runtimeEnv })
    .catch((error) => fatalStartupError(runtime, error));
  assertSecretEncryptionConfigured(runtime, runtimeEnv);
  assertDatabaseEncryptionConfigured(runtime, runtimeEnv);
  const auditReplicationSink = assertAuditReplicationConfigured(
    runtime,
    runtimeEnv,
  );
  await maybeApplyDatabaseMigrations(runtimeEnv);
  await maybeApplyAuditRetention(runtimeEnv);
  await maybeVerifyAuditReplicationChain(
    runtime,
    runtimeEnv,
    auditReplicationSink,
  );
  const sharedSqlClientHandle = await createSharedSqlClient(runtimeEnv);
  logDeploymentRecordStoreBackend(sharedSqlClientHandle !== undefined);
  const created = await createTakosumiService({
    runtimeEnv,
    runtimeConfig,
    ...(sharedSqlClientHandle
      ? { sqlClient: sharedSqlClientHandle.client }
      : {}),
  }).catch((error) => {
    fatalStartupError(runtime, error);
  });
  if (!created) {
    // fatalStartupError already exited; this is unreachable but keeps the
    // type checker honest.
    throw new Error("service.boot.create_service_app_did_not_return");
  }
  const app: HonoApp = created.app;
  const role: TakosumiProcessRole = created.role;
  startHeartbeatIfConfigured(runtime, role);
  return {
    app,
    role,
    runtime,
    runtimeConfig,
    ...(sharedSqlClientHandle
      ? { sharedSqlClient: sharedSqlClientHandle }
      : {}),
  };
}

// The service module used to run boot at the top level and `export default
// app`. Workers `export default { fetch: ... }` consumers therefore had to
// import this module, which forced `await loadRuntimeConfigFromEnv(...)`
// to fire inside the isolate. The service now exposes `startTakosumiService()` and
// only runs it when the module is executed as the program entrypoint (e.g.
// `bun run core/index.ts` on long-running servers).

if (import.meta.main) {
  const started = await startTakosumiService();
  const port = Number(started.runtime.env.get("PORT") ?? "8788");
  const server = started.runtime.serveHttp(started.app.fetch, { port });
  registerServiceShutdownHandlers(started.runtime, server);
}

/**
 * Capture SIGINT / SIGTERM and drain in-flight requests via the
 * RuntimeAdapter's `serveHttp` handle before exiting. Without this, a
 * SIGINT to the service terminates connections mid-request and the CLI
 * / clients see truncated responses.
 *
 * The CLI command (`packages/cli/src/commands/server.ts`) registers its
 * own SIGINT handler for the embedded runtime-agent. Both handlers fire
 * concurrently when the service is launched in-process; each one runs to
 * completion and the runtime exit hook is called from this handler once
 * the server has finished draining.
 */
function registerServiceShutdownHandlers(
  runtime: RuntimeAdapter,
  server: ServeHttpHandle,
): void {
  let shuttingDown = false;
  const handler = (signal: "SIGINT" | "SIGTERM") => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("service.shutdown.draining", { signal });
    server.shutdown()
      .catch((error) => log.error("service.shutdown.error", { error }))
      .finally(() => {
        log.info("service.shutdown.complete");
        runtime.exit(0);
      });
  };
  runtime.onSignal("SIGINT", () => handler("SIGINT"));
  runtime.onSignal("SIGTERM", () => handler("SIGTERM"));
}

function fatalStartupError(runtime: RuntimeAdapter, error: unknown): never {
  if (error instanceof RuntimeConfigError) {
    log.error("service.boot.runtime_config_invalid", {
      message: error.message,
      diagnostics: error.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        ...(diagnostic.key ? { key: diagnostic.key } : {}),
        message: diagnostic.message,
      })),
      docs: [
        "docs/reference/operator.md",
        "docs/reference/internal-execution-profiles.md",
      ],
    });
    runtime.exit(1);
  }
  if (error instanceof SecretEncryptionConfigurationError) {
    log.error("service.boot.secret_encryption_required", {
      message: error.message,
      hint: "Refusing to start takosumi with plaintext secret storage. " +
        "See docs/reference/operator.md and " +
        "docs/reference/internal-execution-profiles.md for required " +
        "encryption-key configuration.",
    });
    runtime.exit(1);
  }
  if (error instanceof DatabaseEncryptionConfigurationError) {
    log.error("service.boot.database_encryption_required", {
      message: error.message,
      hint: "Refusing to start takosumi against an unencrypted database. " +
        "See docs/reference/operator.md " +
        "for database at-rest encryption configuration.",
    });
    runtime.exit(1);
  }
  if (error instanceof AuditReplicationConfigurationError) {
    log.error("service.boot.audit_replication_required", {
      message: error.message,
      hint:
        "Refusing to start takosumi without an external audit-replication " +
        "sink. See docs/reference/operator.md for AuditExternalReplicationSink " +
        "configuration.",
    });
    runtime.exit(1);
  }
  throw error;
}

/**
 * Phase 11A init hook: optionally apply DB migrations at boot.
 *
 * Default behavior:
 *   - production / staging: auto-apply (TAKOSUMI_DB_AUTO_MIGRATE defaults to true)
 *   - local / development:  skip (TAKOSUMI_DB_AUTO_MIGRATE defaults to false)
 *
 * Opt-out: TAKOSUMI_DB_AUTO_MIGRATE=false (any env)
 * Opt-in:  TAKOSUMI_DB_AUTO_MIGRATE=true  (local)
 *
 * Failures are logged but do not crash boot, so a misconfigured DATABASE_URL
 * does not stop the API from starting up in degraded mode (deploys gated by
 * health check). For deterministic apply, prefer `bun run db:migrate`.
 */
async function maybeApplyDatabaseMigrations(
  env: Record<string, string | undefined>,
): Promise<void> {
  const environment = (env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? "local")
    .toLowerCase();
  const isManaged = environment === "production" || environment === "staging";
  const explicit = env.TAKOSUMI_DB_AUTO_MIGRATE?.toLowerCase();
  const shouldRun = explicit === "true"
    ? true
    : explicit === "false"
    ? false
    : isManaged;
  if (!shouldRun) return;

  const databaseUrl = env.TAKOSUMI_DATABASE_URL ?? env.DATABASE_URL ??
    (environment === "production"
      ? env.TAKOSUMI_PRODUCTION_DATABASE_URL
      : undefined) ??
    (environment === "staging" ? env.TAKOSUMI_STAGING_DATABASE_URL : undefined);
  if (!databaseUrl) {
    log.warn("service.boot.db_migrations_skipped_no_url");
    return;
  }

  const client = await tryCreatePostgresClient(databaseUrl);
  if (!client) return;
  try {
    const runner = new StorageMigrationRunner(client.client);
    const result = await runner.applyPending();
    if (result.appliedNow.length === 0) {
      log.info("service.boot.db_migrations_up_to_date", {
        applied: result.applied.length,
      });
    } else {
      log.info("service.boot.db_migrations_applied", {
        appliedNow: result.appliedNow.length,
        migrations: result.appliedNow.map((entry) => ({
          id: entry.migration.id,
          version: entry.migration.version,
          domain: entry.migration.domain,
        })),
      });
    }
  } catch (error) {
    log.error("service.boot.db_migrations_failed", {
      message: (error as Error).message,
      stack: (error as Error).stack,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Phase 18 / C9 init hook: apply audit retention policy at boot when
 * `TAKOSUMI_AUDIT_RETENTION_DAYS` is set and a SQL audit backend is reachable.
 *
 * The audit_events table is append-only for tamper evidence: we never delete
 * rows. Instead, events older than the retention cutoff are flagged as
 * `archived = true`, allowing operators to plan tier-2 / cold storage export
 * pipelines without breaking the SHA-256 hash chain.
 */
async function maybeApplyAuditRetention(
  env: Record<string, string | undefined>,
): Promise<void> {
  const retentionRaw = env.TAKOSUMI_AUDIT_RETENTION_DAYS;
  const regimeRaw = env.TAKOSUMI_AUDIT_RETENTION_REGIME;
  if (!retentionRaw && !regimeRaw) return;
  const policy = resolveAuditRetention({ env });

  const databaseUrl = env.TAKOSUMI_DATABASE_URL ?? env.DATABASE_URL ??
    env.TAKOSUMI_PRODUCTION_DATABASE_URL ?? env.TAKOSUMI_STAGING_DATABASE_URL;
  if (!databaseUrl) {
    log.warn("service.boot.audit_retention_skipped_no_url");
    return;
  }

  const client = await tryCreatePostgresClient(databaseUrl);
  if (!client) return;
  try {
    const sink = new SqlObservabilitySink({
      client: client.client,
      retentionPolicy: policy,
    });
    const { archived, deleted } = await sink.applyRetentionPolicy();
    log.info("service.boot.audit_retention_applied", {
      regime: policy.regime,
      retentionDays: policy.retentionDays,
      archived,
      deleted,
    });
  } catch (error) {
    log.error("service.boot.audit_retention_failed", {
      message: (error as Error).message,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Surface the deployment-record-store backend selection at boot so
 * operators can spot the in-memory fallback in their logs. Without this
 * line, a missing `TAKOSUMI_DATABASE_URL` silently degrades durability
 * (the `(tenantId, name) → applied[]` mapping is wiped on every restart)
 * and the only way to detect it is a deploy round-trip.
 */
function logDeploymentRecordStoreBackend(sqlClientResolved: boolean): void {
  if (sqlClientResolved) {
    log.info("service.boot.deployment_record_store_selected", {
      backend: "sql",
      source: "TAKOSUMI_DATABASE_URL",
    });
    return;
  }
  log.info("service.boot.deployment_record_store_selected", {
    backend: "in_memory",
    note: "TAKOSUMI_DATABASE_URL unset; restarts will lose state",
  });
}

/**
 * Build a long-lived SqlClient that the service passes into
 * `createTakosumiService` so SQL-backed deployment and deployControl lifecycle records
 * survive process restart.
 *
 * Returns `undefined` when no `DATABASE_URL` is configured or the pg
 * driver is unavailable; the service then boots with the in-memory
 * record store, which is acceptable for tests and dev but loses
 * deploy state on restart.
 *
 * The returned handle is intentionally NOT closed by the service: the
 * underlying pg pool is reused for the lifetime of the process. The
 * shared instance is fine because `SqlTakosumiDeploymentRecordStore`
 * uses `takosumi_deployment_record_locks` lease rows instead of session-scoped
 * advisory locks, so successive acquire / release queries do not need
 * connection pinning.
 */
async function createSharedSqlClient(
  env: Record<string, string | undefined>,
): Promise<{ client: SqlClient; close: () => Promise<void> } | undefined> {
  const databaseUrl = env.TAKOSUMI_DATABASE_URL ?? env.DATABASE_URL ??
    env.TAKOSUMI_PRODUCTION_DATABASE_URL ?? env.TAKOSUMI_STAGING_DATABASE_URL;
  if (!databaseUrl) return undefined;
  return await tryCreatePostgresClient(databaseUrl);
}

async function tryCreatePostgresClient(
  databaseUrl: string,
): Promise<{ client: SqlClient; close: () => Promise<void> } | undefined> {
  // `npm:pg` ships a binary protocol client that requires `node:net` and
  // `node:tls`; loading it on a Cloudflare Worker / V8 isolate produces a
  // hard error at module-resolve time. Gate the dynamic import behind the
  // runtime check so the service module stays importable on Workers and
  // operators receive a clean warning when the driver is unavailable.
  const runtime = currentRuntime();
  if (runtime.kind !== "node") {
    log.warn("service.boot.postgres_driver_unavailable", {
      message:
        `npm:pg cannot run on the ${runtime.kind} runtime; use an HTTP-mode ` +
        "Postgres adapter (Hyperdrive, Neon, etc.) instead.",
    });
    return undefined;
  }
  try {
    // Dynamic specifier prevents bundlers (and Workers' build pipeline) from
    // statically discovering `npm:pg` when the module is imported but never
    // called. The exact pin stays the same.
    const pgSpecifier = "npm:pg@^8.11.0";
    const pgModule = await import(pgSpecifier);
    const Pool = pgModule.default?.Pool;
    if (!Pool) throw new Error("npm:pg Pool export missing");
    const pool = new Pool({ connectionString: databaseUrl });

    const poolQuery = async <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: SqlParameters,
    ): Promise<SqlQueryResult<Row>> => {
      const { sql: rendered, values } = renderNamedParams(sql, parameters);
      return wrapPgResult<Row>(await pool.query(rendered, values));
    };

    const client: SqlClient = {
      query: poolQuery,
      async transaction<T>(
        fn: (transaction: SqlTransaction) => T | Promise<T>,
      ): Promise<T> {
        const conn = await pool.connect();
        const connQuery = async <Row extends Record<string, unknown>>(
          sql: string,
          parameters?: SqlParameters,
        ): Promise<SqlQueryResult<Row>> => {
          const { sql: rendered, values } = renderNamedParams(sql, parameters);
          return wrapPgResult<Row>(await conn.query(rendered, values));
        };
        try {
          await conn.query("begin");
          const value = await fn({ query: connQuery });
          await conn.query("commit");
          return value;
        } catch (error) {
          await conn.query("rollback").catch(() => {});
          throw error;
        } finally {
          conn.release();
        }
      },
    };
    return { client, close: () => pool.end() };
  } catch (error) {
    log.warn("service.boot.postgres_driver_unavailable", {
      message: (error as Error).message,
    });
    return undefined;
  }
}

function renderNamedParams(
  sql: string,
  parameters?: SqlParameters,
): { sql: string; values: unknown[] } {
  if (!parameters) return { sql, values: [] };
  if (Array.isArray(parameters)) {
    return { sql, values: parameters as unknown[] };
  }
  const record = parameters as Readonly<Record<string, unknown>>;
  const order: string[] = [];
  const rendered = sql.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    order.push(name as string);
    return `$${order.length}`;
  });
  return { sql: rendered, values: order.map((name) => record[name]) };
}

function startHeartbeatIfConfigured(
  runtime: RuntimeAdapter,
  role: TakosumiProcessRole,
): void {
  const heartbeatFile = runtime.env.get("TAKOSUMI_SERVICE_WORKER_HEARTBEAT_FILE");
  if (!heartbeatFile) return;
  if (!runtime.fs.available) {
    log.warn("service.heartbeat.unsupported_runtime", { runtime: runtime.kind });
    return;
  }
  const intervalMs = Number(
    runtime.env.get("TAKOSUMI_SERVICE_WORKER_POLL_INTERVAL_MS") ?? "250",
  );
  const write = async () => {
    const now = new Date().toISOString();
    await runtime.fs.mkdir(dirname(heartbeatFile), { recursive: true });
    await runtime.fs.writeTextFile(
      heartbeatFile,
      `${JSON.stringify({ ok: true, service: "takosumi", role, now })}\n`,
    );
  };
  write().catch((error) =>
    log.error("service.heartbeat.write_failed", { error })
  );
  setInterval(
    () =>
      write().catch((error) =>
        log.error("service.heartbeat.write_failed", { error })
      ),
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 1_000,
  );
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "." : path.slice(0, index);
}

/**
 * Phase 18 boot guard: refuse to start with plaintext (base64-only) secret
 * storage. Production / staging always require an encryption key. Local /
 * development environments require either a key or an explicit opt-in via
 * `TAKOSUMI_DEV_MODE=1` to acknowledge the insecure default.
 *
 * Tests / harnesses that drive `createTakosumiService` directly can inject an
 * explicit test crypto adapter; this boot entrypoint always validates runtime
 * encryption configuration before serving.
 */
function assertSecretEncryptionConfigured(
  runtime: RuntimeAdapter,
  env: Record<string, string | undefined>,
): void {
  try {
    selectSecretBoundaryCrypto({ env });
  } catch (error) {
    if (error instanceof SecretEncryptionConfigurationError) {
      log.error("service.boot.secret_encryption_required", {
        message: error.message,
        hint: "Refusing to start takosumi with plaintext secret storage. " +
          "See docs/reference/operator.md and " +
          "docs/reference/internal-execution-profiles.md for required " +
          "encryption-key configuration.",
      });
      runtime.exit(1);
    }
    throw error;
  }
}

/**
 * Phase 18.3 M7 boot guard: refuse to start when the configured database
 * lacks at-rest encryption in production / staging. Local / dev opt-in via
 * `TAKOSUMI_DEV_MODE=1`.
 */
function assertDatabaseEncryptionConfigured(
  runtime: RuntimeAdapter,
  env: Record<string, string | undefined>,
): void {
  try {
    const assertion = assertDatabaseEncryptionAtRest({ env });
    if (assertion.satisfied && assertion.evidence) {
      log.info("service.boot.db_at_rest_encryption_satisfied", {
        evidence: assertion.evidence,
        ...(assertion.overrideAccepted
          ? { overrideAccepted: true, override: "TAKOSUMI_DEV_MODE" }
          : {}),
      });
    }
  } catch (error) {
    if (error instanceof DatabaseEncryptionConfigurationError) {
      log.error("service.boot.database_encryption_required", {
        message: error.message,
        hint: "Refusing to start takosumi against an unencrypted database. " +
          "See docs/reference/operator.md " +
          "for database at-rest encryption configuration.",
      });
      runtime.exit(1);
    }
    throw error;
  }
}

/**
 * Phase 18.3 M5 boot guard: refuse to start without an external audit
 * replication sink in production / staging. Local / dev returns
 * `undefined` when no sink is configured.
 */
function assertAuditReplicationConfigured(
  runtime: RuntimeAdapter,
  env: Record<string, string | undefined>,
): AuditExternalReplicationSink | undefined {
  try {
    const sink = selectAuditExternalReplicationSink({ env });
    if (sink) {
      log.info("service.boot.audit_replication_sink_selected", {
        kind: sink.kind,
      });
    }
    return sink;
  } catch (error) {
    if (error instanceof AuditReplicationConfigurationError) {
      log.error("service.boot.audit_replication_required", {
        message: error.message,
        hint:
          "Refusing to start takosumi without an external audit-replication " +
          "sink. See docs/reference/operator.md for AuditExternalReplicationSink " +
          "configuration.",
      });
      runtime.exit(1);
    }
    throw error;
  }
}

/**
 * Phase 18.3 M5 boot hook: when an external replication sink is configured
 * AND a SQL backend is reachable, verify the SQL audit chain matches the
 * external immutable replica before serving traffic. A mismatch surfaces
 * tampering at the DB layer that the in-process hash chain cannot detect
 * on its own.
 *
 * Failures are logged but do not crash boot in local environments. In
 * production / staging the verification mismatch is surfaced as an
 * `AuditReplicationConfigurationError`-like fatal so operators are forced
 * to investigate before the service resumes serving.
 */
async function maybeVerifyAuditReplicationChain(
  runtime: RuntimeAdapter,
  env: Record<string, string | undefined>,
  sink: AuditExternalReplicationSink | undefined,
): Promise<void> {
  if (!sink) return;
  const databaseUrl = env.TAKOSUMI_DATABASE_URL ?? env.DATABASE_URL ??
    env.TAKOSUMI_PRODUCTION_DATABASE_URL ?? env.TAKOSUMI_STAGING_DATABASE_URL;
  if (!databaseUrl) return;

  const client = await tryCreatePostgresClient(databaseUrl);
  if (!client) return;
  try {
    const observability = new SqlObservabilitySink({ client: client.client });
    const primary = await observability.listAudit();
    const external = await sink.readChain();
    const result = await verifyAuditReplicationConsistency(primary, external);
    if (result.ok) {
      log.info("service.boot.audit_replication_chain_verified", {
        primaryCount: result.primaryCount,
        externalCount: result.externalCount,
      });
      return;
    }
    const environment = (env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? "local")
      .toLowerCase();
    const productionLike = environment === "production" ||
      environment === "staging";
    const inconsistency = {
      reason: result.reason,
      mismatchAtSequence: result.mismatchAtSequence ?? null,
      primaryCount: result.primaryCount,
      externalCount: result.externalCount,
    };
    if (productionLike) {
      log.error("service.boot.audit_replication_chain_mismatch", {
        ...inconsistency,
        hint: "Refusing to start: SQL audit chain disagrees with immutable " +
          "replica. Investigate possible DB tampering before resuming traffic.",
      });
      runtime.exit(1);
    }
    log.warn("service.boot.audit_replication_chain_mismatch", inconsistency);
  } catch (error) {
    log.warn("service.boot.audit_replication_verification_skipped", {
      message: (error as Error).message,
    });
  } finally {
    await client.close().catch(() => {});
  }
}
