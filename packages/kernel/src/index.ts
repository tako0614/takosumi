import { createPaaSApp } from "./bootstrap.ts";
import type { Hono as HonoApp } from "hono";
import type { PaaSProcessRole } from "./process/mod.ts";
import {
  loadRuntimeConfigFromEnv,
  RuntimeConfigError,
  warnIfDevMode,
} from "./config/mod.ts";
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
import { ObservationRetentionService } from "./services/observation-retention/mod.ts";
import type {
  SqlClient,
  SqlParameters,
  SqlQueryResult,
  SqlTransaction,
} from "./adapters/storage/sql.ts";

const runtimeEnv: Record<string, string> = Deno.env.toObject();
warnIfDevMode(runtimeEnv);
const runtimeConfig = await loadRuntimeConfigFromEnv({ env: runtimeEnv })
  .catch((error) => fatalStartupError(error));
assertSecretEncryptionConfigured(runtimeEnv);
assertDatabaseEncryptionConfigured(runtimeEnv);
const auditReplicationSink = assertAuditReplicationConfigured(runtimeEnv);
await maybeApplyDatabaseMigrations(runtimeEnv);
await maybeApplyAuditRetention(runtimeEnv);
await maybeApplyObservationRetention(runtimeEnv);
await maybeVerifyAuditReplicationChain(runtimeEnv, auditReplicationSink);
const created = await createPaaSApp({ runtimeEnv, runtimeConfig }).catch(
  (error) => {
    fatalStartupError(error);
  },
);
const app: HonoApp = created.app;
const role: PaaSProcessRole = created.role;
startHeartbeatIfConfigured();

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? "8788");
  const server = Deno.serve({ port }, app.fetch);
  registerKernelShutdownHandlers(server);
}

export default app;

/**
 * Capture SIGINT / SIGTERM and drain in-flight requests via
 * `Deno.HttpServer.shutdown()` before exiting. Without this, a SIGINT to
 * the kernel terminates connections mid-request and the CLI / clients
 * see truncated responses.
 *
 * The CLI command (`packages/cli/src/commands/server.ts`) registers its
 * own SIGINT handler for the embedded runtime-agent. Both handlers fire
 * concurrently when the kernel is launched in-process; each one runs to
 * completion and `Deno.exit(0)` is called from this handler once the
 * server has finished draining.
 */
function registerKernelShutdownHandlers(server: Deno.HttpServer): void {
  let shuttingDown = false;
  const handler = (signal: Deno.Signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `[takosumi-kernel] received ${signal}, draining HTTP server...`,
    );
    server.shutdown()
      .catch((error) =>
        console.error(`[takosumi-kernel] shutdown error:`, error)
      )
      .finally(() => {
        console.log(`[takosumi-kernel] shutdown complete`);
        Deno.exit(0);
      });
  };
  try {
    Deno.addSignalListener("SIGINT", () => handler("SIGINT"));
    // SIGTERM is not supported on Windows; ignore the registration failure.
    if (Deno.build.os !== "windows") {
      Deno.addSignalListener("SIGTERM", () => handler("SIGTERM"));
    }
  } catch (error) {
    console.warn(
      `[takosumi-kernel] failed to register shutdown signal handlers: ${
        (error as Error).message
      }`,
    );
  }
}

function fatalStartupError(error: unknown): never {
  if (error instanceof RuntimeConfigError) {
    console.error(
      `[paas-init] fatal: ${error.message}\n` +
        error.diagnostics.map((diagnostic) =>
          `  - ${diagnostic.code}${
            diagnostic.key ? ` (${diagnostic.key})` : ""
          }: ${diagnostic.message}`
        ).join("\n"),
    );
    Deno.exit(1);
  }
  if (error instanceof SecretEncryptionConfigurationError) {
    console.error(
      `[paas-init] fatal: ${error.message}\n` +
        `Refusing to start takosumi with plaintext secret storage. ` +
        `See docs/hosting/cloudflare.md and docs/hosting/self-hosted.md ` +
        `for required encryption-key configuration.`,
    );
    Deno.exit(1);
  }
  if (error instanceof DatabaseEncryptionConfigurationError) {
    console.error(
      `[paas-init] fatal: ${error.message}\n` +
        `Refusing to start takosumi against an unencrypted database. ` +
        `See docs/hosting/cloudflare.md and docs/hosting/multi-cloud.md ` +
        `for at-rest encryption configuration per backend.`,
    );
    Deno.exit(1);
  }
  if (error instanceof AuditReplicationConfigurationError) {
    console.error(
      `[paas-init] fatal: ${error.message}\n` +
        `Refusing to start takosumi without an external audit-replication ` +
        `sink. See docs/hosting/cloudflare.md and docs/hosting/multi-cloud.md ` +
        `for the AuditExternalReplicationSink configuration.`,
    );
    Deno.exit(1);
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
 * health check). For deterministic apply, prefer `deno task db:migrate`.
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
    console.warn(
      `[paas-init] TAKOSUMI_DB_AUTO_MIGRATE requested but no DATABASE_URL is set; skipping migrations.`,
    );
    return;
  }

  const client = await tryCreatePostgresClient(databaseUrl);
  if (!client) return;
  try {
    const runner = new StorageMigrationRunner(client.client);
    const result = await runner.applyPending();
    if (result.appliedNow.length === 0) {
      console.log(
        `[paas-init] storage migrations up-to-date (${result.applied.length} applied).`,
      );
    } else {
      console.log(
        `[paas-init] applied ${result.appliedNow.length} storage migration(s):`,
      );
      for (const entry of result.appliedNow) {
        console.log(
          `  + ${entry.migration.id} v${entry.migration.version} (${entry.migration.domain})`,
        );
      }
    }
  } catch (error) {
    console.error(
      `[paas-init] storage migrations failed: ${(error as Error).message}`,
    );
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
    console.warn(
      `[paas-init] audit retention requested but no DATABASE_URL configured; skipping.`,
    );
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
    console.log(
      `[paas-init] audit retention applied (regime=${policy.regime} retention=${policy.retentionDays}d): ` +
        `${archived} archived, ${deleted} deleted.`,
    );
  } catch (error) {
    console.error(
      `[paas-init] audit retention failed: ${(error as Error).message}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

/**
 * Phase 18.3 / M3 init hook: apply observation retention GC at boot.
 *
 * `provider_observations` and `runtime_provider_observations` were Phase 17A
 * append-only and grew unbounded. The retention service flags rows older
 * than `recentRetentionDays` (default 30d) as archived, then deletes
 * archived rows older than `archiveCapDays` (default 90d). Observations
 * pointing at the current group head are exempt.
 *
 * Opt-out: `TAKOSUMI_OBSERVATION_RETENTION_DISABLE=true`. Tunables:
 * `TAKOSUMI_OBSERVATION_RETENTION_RECENT_DAYS`,
 * `TAKOSUMI_OBSERVATION_RETENTION_ARCHIVE_CAP_DAYS`.
 */
async function maybeApplyObservationRetention(
  env: Record<string, string | undefined>,
): Promise<void> {
  if (env.TAKOSUMI_OBSERVATION_RETENTION_DISABLE?.toLowerCase() === "true") {
    return;
  }
  const databaseUrl = env.TAKOSUMI_DATABASE_URL ?? env.DATABASE_URL ??
    env.TAKOSUMI_PRODUCTION_DATABASE_URL ?? env.TAKOSUMI_STAGING_DATABASE_URL;
  if (!databaseUrl) return; // silent: most local dev runs without DB

  const recentDays = parsePositiveIntEnv(
    env.TAKOSUMI_OBSERVATION_RETENTION_RECENT_DAYS,
  );
  const archiveCapDays = parsePositiveIntEnv(
    env.TAKOSUMI_OBSERVATION_RETENTION_ARCHIVE_CAP_DAYS,
  );
  const client = await tryCreatePostgresClient(databaseUrl);
  if (!client) return;
  try {
    const policy: { recentRetentionDays?: number; archiveCapDays?: number } =
      {};
    if (recentDays !== undefined) policy.recentRetentionDays = recentDays;
    if (archiveCapDays !== undefined) policy.archiveCapDays = archiveCapDays;
    const service = new ObservationRetentionService({
      client: client.client,
      ...(Object.keys(policy).length ? { policy } : {}),
    });
    const report = await service.run();
    console.log(
      `[paas-init] observation retention applied: ` +
        `archived deploy=${report.archivedDeploy} runtime=${report.archivedRuntime}, ` +
        `deleted deploy=${report.deletedDeploy} runtime=${report.deletedRuntime}.`,
    );
  } catch (error) {
    console.error(
      `[paas-init] observation retention failed: ${(error as Error).message}`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

function parsePositiveIntEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

async function tryCreatePostgresClient(
  databaseUrl: string,
): Promise<{ client: SqlClient; close: () => Promise<void> } | undefined> {
  try {
    const pgModule = await import("npm:pg@^8.11.0");
    const Pool = pgModule.default?.Pool;
    if (!Pool) throw new Error("npm:pg Pool export missing");
    const pool = new Pool({ connectionString: databaseUrl });

    const poolQuery = async <Row extends Record<string, unknown>>(
      sql: string,
      parameters?: SqlParameters,
    ): Promise<SqlQueryResult<Row>> => {
      const { sql: rendered, values } = renderNamedParams(sql, parameters);
      const result = await pool.query(rendered, values);
      return { rows: result.rows as Row[], rowCount: result.rows.length };
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
          const result = await conn.query(rendered, values);
          return { rows: result.rows as Row[], rowCount: result.rows.length };
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
    console.warn(
      `[paas-init] failed to load postgres driver: ${(error as Error).message}`,
    );
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

function startHeartbeatIfConfigured(): void {
  const heartbeatFile = Deno.env.get("TAKOSUMI_PAAS_WORKER_HEARTBEAT_FILE");
  if (!heartbeatFile) return;
  const intervalMs = Number(
    Deno.env.get("TAKOSUMI_PAAS_WORKER_POLL_INTERVAL_MS") ?? "250",
  );
  const write = async () => {
    const now = new Date().toISOString();
    await Deno.mkdir(dirname(heartbeatFile), { recursive: true });
    await Deno.writeTextFile(
      heartbeatFile,
      `${JSON.stringify({ ok: true, service: "takosumi", role, now })}\n`,
    );
  };
  write().catch((error) => console.error("heartbeat write failed", error));
  setInterval(
    () =>
      write().catch((error) => console.error("heartbeat write failed", error)),
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
 * Tests / harnesses that drive `createPaaSApp` directly can inject an
 * explicit test crypto adapter; this boot entrypoint always validates runtime
 * encryption configuration before serving.
 */
function assertSecretEncryptionConfigured(
  env: Record<string, string | undefined>,
): void {
  try {
    selectSecretBoundaryCrypto({ env });
  } catch (error) {
    if (error instanceof SecretEncryptionConfigurationError) {
      console.error(
        `[paas-init] fatal: ${error.message}\n` +
          `Refusing to start takosumi with plaintext secret storage. ` +
          `See docs/hosting/cloudflare.md and docs/hosting/self-hosted.md ` +
          `for required encryption-key configuration.`,
      );
      Deno.exit(1);
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
  env: Record<string, string | undefined>,
): void {
  try {
    const assertion = assertDatabaseEncryptionAtRest({ env });
    if (assertion.satisfied && assertion.evidence) {
      console.log(
        `[paas-init] db at-rest encryption: ${assertion.evidence}` +
          (assertion.overrideAccepted
            ? " (TAKOSUMI_DEV_MODE override accepted)"
            : ""),
      );
    }
  } catch (error) {
    if (error instanceof DatabaseEncryptionConfigurationError) {
      console.error(
        `[paas-init] fatal: ${error.message}\n` +
          `Refusing to start takosumi against an unencrypted database. ` +
          `See docs/hosting/cloudflare.md and docs/hosting/multi-cloud.md ` +
          `for at-rest encryption configuration per backend.`,
      );
      Deno.exit(1);
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
  env: Record<string, string | undefined>,
): AuditExternalReplicationSink | undefined {
  try {
    const sink = selectAuditExternalReplicationSink({ env });
    if (sink) {
      console.log(
        `[paas-init] audit-replication sink: ${sink.kind}`,
      );
    }
    return sink;
  } catch (error) {
    if (error instanceof AuditReplicationConfigurationError) {
      console.error(
        `[paas-init] fatal: ${error.message}\n` +
          `Refusing to start takosumi without an external audit-replication ` +
          `sink. See docs/hosting/cloudflare.md and docs/hosting/multi-cloud.md ` +
          `for the AuditExternalReplicationSink configuration.`,
      );
      Deno.exit(1);
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
 * to investigate before the kernel resumes serving.
 */
async function maybeVerifyAuditReplicationChain(
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
      console.log(
        `[paas-init] audit-replication chain verified ` +
          `(primary=${result.primaryCount} external=${result.externalCount}).`,
      );
      return;
    }
    const environment = (env.TAKOSUMI_ENVIRONMENT ?? env.NODE_ENV ?? "local")
      .toLowerCase();
    const productionLike = environment === "production" ||
      environment === "staging";
    const message = `audit-replication consistency failed: ` +
      `${result.reason} at sequence=${result.mismatchAtSequence ?? "?"} ` +
      `(primary=${result.primaryCount} external=${result.externalCount})`;
    if (productionLike) {
      console.error(
        `[paas-init] fatal: ${message}\n` +
          `Refusing to start: SQL audit chain disagrees with immutable ` +
          `replica. Investigate possible DB tampering before resuming traffic.`,
      );
      Deno.exit(1);
    }
    console.warn(`[paas-init] ${message}`);
  } catch (error) {
    console.warn(
      `[paas-init] audit-replication verification skipped: ${
        (error as Error).message
      }`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}
