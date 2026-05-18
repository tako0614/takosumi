import type { Hono as HonoApp } from "hono";
import { createApiApp } from "./api/mod.ts";
import {
  createConsoleApiRequestLogger,
  parseApiLogLevel,
} from "./api/request_correlation.ts";
import {
  type AppContext,
  type AppContextOptions,
  type AppRuntimeConfig,
  createAppContext,
} from "./app_context.ts";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import {
  loadKernelPluginMarketplacePackagesFromEnv,
  loadKernelPluginsFromEnv,
} from "./plugins/mod.ts";
import { isPaaSProcessRole, type PaaSProcessRole } from "./process/mod.ts";
import type { WorkerDaemonHandle } from "./workers/daemon.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
import type { OperationJournalStore } from "./domains/deploy/operation_journal.ts";
import type { RevokeDebtStore } from "./domains/deploy/revoke_debt_store.ts";
import type { TakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store.ts";
import { registerBundledShapesAndProviders } from "./bootstrap/registry_setup.ts";
import { currentRuntime } from "./shared/runtime/index.ts";
import {
  createRoleWorkerDaemon,
  createWorkerDaemonState,
  shouldStartWorkerDaemon,
} from "./bootstrap/worker_daemon.ts";
import { createRoleReadinessProbes } from "./bootstrap/readiness.ts";
import {
  InMemoryOperationJournalStore,
} from "./domains/deploy/operation_journal.ts";
import { SqlOperationJournalStore } from "./domains/deploy/operation_journal_sql.ts";
import {
  InMemoryRevokeDebtStore,
} from "./domains/deploy/revoke_debt_store.ts";
import { SqlRevokeDebtStore } from "./domains/deploy/revoke_debt_store_sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
} from "./domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store_sql.ts";
import { InstallerPipeline } from "./domains/installer/mod.ts";

function resolveTakosumiDeploymentRecordStore(input: {
  readonly takosumiDeploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly sqlClient?: SqlClient;
  readonly deployLockLeaseMs?: number;
  readonly deployLockHeartbeatMs?: number;
}): TakosumiDeploymentRecordStore {
  if (input.takosumiDeploymentRecordStore) {
    return input.takosumiDeploymentRecordStore;
  }
  if (input.sqlClient) {
    return new SqlTakosumiDeploymentRecordStore({
      client: input.sqlClient,
      ...(input.deployLockLeaseMs !== undefined
        ? { lockLeaseMs: input.deployLockLeaseMs }
        : {}),
      ...(input.deployLockHeartbeatMs !== undefined
        ? { lockHeartbeatMs: input.deployLockHeartbeatMs }
        : {}),
    });
  }
  return new InMemoryTakosumiDeploymentRecordStore();
}

function resolveOperationJournalStore(input: {
  readonly takosumiOperationJournalStore?: OperationJournalStore;
  readonly sqlClient?: SqlClient;
}): OperationJournalStore {
  if (input.takosumiOperationJournalStore) {
    return input.takosumiOperationJournalStore;
  }
  if (input.sqlClient) {
    return new SqlOperationJournalStore({ client: input.sqlClient });
  }
  return new InMemoryOperationJournalStore();
}

function resolveRevokeDebtStore(input: {
  readonly takosumiRevokeDebtStore?: RevokeDebtStore;
  readonly sqlClient?: SqlClient;
}): RevokeDebtStore {
  if (input.takosumiRevokeDebtStore) {
    return input.takosumiRevokeDebtStore;
  }
  if (input.sqlClient) {
    return new SqlRevokeDebtStore({ client: input.sqlClient });
  }
  return new InMemoryRevokeDebtStore();
}

export { registerBundledShapesAndProviders };

export interface CreatePaaSAppOptions extends AppContextOptions {
  readonly role?: PaaSProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly context?: AppContext;
  readonly startWorkerDaemon?: boolean;
  /**
   * Optional SQL client used to back persistence-sensitive records. When
   * supplied, bootstrap instantiates SQL-backed stores so revoke-debt /
   * operation-journal records survive kernel restarts; in-memory fallback
   * is fine for tests / dev.
   */
  readonly sqlClient?: SqlClient;
  /**
   * Pre-built record store override. Wins over `sqlClient` so tests can
   * inject a hand-rolled fake without standing up a SqlClient.
   */
  readonly takosumiDeploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly takosumiOperationJournalStore?: OperationJournalStore;
  readonly takosumiRevokeDebtStore?: RevokeDebtStore;
}

export interface CreatedPaaSApp {
  readonly app: HonoApp;
  readonly context: AppContext;
  readonly role: PaaSProcessRole;
  readonly workerDaemon?: WorkerDaemonHandle;
}

export async function createPaaSApp(
  options: CreatePaaSAppOptions = {},
): Promise<CreatedPaaSApp> {
  const runtimeEnv = options.runtimeEnv ?? currentRuntime().env.toObject();
  const runtimeConfig = options.runtimeConfig ??
    await loadRuntimeConfigFromEnv({ env: runtimeEnv });
  const role = options.role ?? processRoleFromRuntimeConfig(runtimeConfig);
  registerBundledShapesAndProviders(runtimeEnv);
  const marketplaceInstall = await loadKernelPluginMarketplacePackagesFromEnv(
    runtimeEnv,
  );
  const context = options.context ?? await createAppContext({
    ...options,
    runtimeEnv,
    runtimeConfig,
    plugins: options.plugins ??
      [
        ...marketplaceInstall.plugins,
        ...await loadKernelPluginsFromEnv(runtimeEnv),
      ],
  });
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const installerToken = runtimeEnv.TAKOSUMI_INSTALLER_TOKEN;
  const fetchToken = runtimeEnv.TAKOSUMI_ARTIFACT_FETCH_TOKEN;
  const metricsScrapeToken = runtimeEnv.TAKOSUMI_METRICS_SCRAPE_TOKEN;
  const artifactMaxBytes = parsePositiveIntegerEnv(
    runtimeEnv.TAKOSUMI_ARTIFACT_MAX_BYTES,
  );
  const deployLockLeaseMs = parsePositiveIntegerEnv(
    runtimeEnv.TAKOSUMI_LOCK_LEASE_MS,
  );
  const deployLockHeartbeatMs = parsePositiveIntegerEnv(
    runtimeEnv.TAKOSUMI_LOCK_HEARTBEAT_MS,
  );
  // Build the takosumi deploy record store. SqlClient wins so production
  // restarts share the same apply / destroy lease across kernel pods;
  // the in-memory fallback is fine for tests / dev.
  const recordStore = resolveTakosumiDeploymentRecordStore({
    takosumiDeploymentRecordStore: options.takosumiDeploymentRecordStore,
    sqlClient: options.sqlClient,
    ...(deployLockLeaseMs !== undefined ? { deployLockLeaseMs } : {}),
    ...(deployLockHeartbeatMs !== undefined ? { deployLockHeartbeatMs } : {}),
  });
  const _operationJournalStore = resolveOperationJournalStore(options);
  const revokeDebtStore = resolveRevokeDebtStore(options);
  const workerDaemonState = createWorkerDaemonState();
  const workerDaemon = shouldStartWorkerDaemon(role, options)
    ? createRoleWorkerDaemon({
      role,
      context,
      runtimeEnv,
      deploymentRecordStore: recordStore,
      revokeDebtStore,
      onTick: workerDaemonState.onTick,
    }).start()
    : undefined;
  // marketplaceInstall.hookPackages is reserved for installer-pipeline
  // catalog hooks (Wave 5 follow-up). Currently unused on the v1 surface.
  void marketplaceInstall;
  const app = await createApiApp({
    role,
    context,
    registerInternalRoutes: role === "takosumi-api",
    registerPublicRoutes: role === "takosumi-api" &&
      runtimeConfig.routes?.publicRoutesEnabled === true,
    registerRuntimeAgentRoutes: role === "takosumi-runtime-agent",
    registerReadinessRoutes: true,
    registerOpenApiRoute: role === "takosumi-api",
    registerArtifactRoutes: role === "takosumi-api" &&
      Boolean(deployToken) &&
      Boolean(context.adapters?.objectStorage),
    registerMetricsRoutes: role === "takosumi-api" &&
      Boolean(metricsScrapeToken),
    metricsRouteOptions: metricsScrapeToken
      ? {
        observability: context.adapters.observability,
        getScrapeToken: () => metricsScrapeToken,
      }
      : undefined,
    artifactRouteOptions: deployToken && context.adapters?.objectStorage
      ? {
        getDeployToken: () => deployToken,
        objectStorage: context.adapters.objectStorage,
        recordStore,
        ...(fetchToken ? { getArtifactFetchToken: () => fetchToken } : {}),
        ...(artifactMaxBytes !== undefined
          ? { maxBytes: artifactMaxBytes }
          : {}),
      }
      : undefined,
    installerPublicRouteOptions: {
      pipeline: new InstallerPipeline(),
      ...(installerToken
        ? { getInstallerToken: () => installerToken }
        : {}),
    },
    readinessRouteProbes: createRoleReadinessProbes({
      role,
      context,
      runtimeConfig,
      runtimeEnv,
      workerDaemonState,
      workerDaemon,
    }),
    requestCorrelation: {
      logger: shouldEmitHttpRequestLogs(runtimeConfig.environment, runtimeEnv)
        ? createConsoleApiRequestLogger(parseApiLogLevel(
          runtimeEnv.TAKOSUMI_LOG_LEVEL,
        ))
        : undefined,
      minLevel: parseApiLogLevel(runtimeEnv.TAKOSUMI_LOG_LEVEL),
      traceSink: context.adapters.observability,
    },
  });
  return { app, context, role, workerDaemon };
}

function shouldEmitHttpRequestLogs(
  environment: AppRuntimeConfig["environment"],
  env: Record<string, string | undefined>,
): boolean {
  const configured = env.TAKOSUMI_HTTP_REQUEST_LOGS?.toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return environment === "production" || environment === "staging";
}

function processRoleFromRuntimeConfig(
  runtimeConfig: AppRuntimeConfig,
): PaaSProcessRole {
  const role = runtimeConfig.processRole;
  return role && isPaaSProcessRole(role) ? role : "takosumi-api";
}

/**
 * Parse a positive-integer env var, returning `undefined` when unset or
 * unparseable so callers can fall back to a downstream default. Used for
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` where the kernel-level default lives in
 * the artifact-routes module.
 */
function parsePositiveIntegerEnv(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
