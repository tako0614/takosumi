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
import { isPaaSProcessRole, type PaaSProcessRole } from "./process/mod.ts";
import type { WorkerDaemonHandle } from "./workers/daemon.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
import type { OperationJournalStore } from "./domains/deploy/operation_journal.ts";
import type { RevokeDebtStore } from "./domains/deploy/revoke_debt_store.ts";
import type { TakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store.ts";
import { registerDefaultArtifactKinds } from "./bootstrap/registry_setup.ts";
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
import { InMemoryRevokeDebtStore } from "./domains/deploy/revoke_debt_store.ts";
import { SqlRevokeDebtStore } from "./domains/deploy/revoke_debt_store_sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
} from "./domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store_sql.ts";
import {
  httpPlatformServiceResolver,
  InstallerPipeline,
  type PlatformServiceResolver,
} from "./domains/installer/mod.ts";
import type {
  DeploymentStore as InstallerDeploymentStore,
  InstallationStore as InstallerInstallationStore,
} from "./domains/installer/store.ts";
import {
  SqlDeploymentStore as SqlInstallerDeploymentStore,
  SqlInstallationStore as SqlInstallerInstallationStore,
} from "./domains/installer/store_sql.ts";
import { log } from "./shared/log.ts";
import type { KernelPlugin } from "takosumi-contract/reference/plugin";

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

interface ResolvedInstallerStores {
  readonly installations?: InstallerInstallationStore;
  readonly deployments?: InstallerDeploymentStore;
  /**
   * True when both the Installation and Deployment ledger are durable
   * (operator-injected or SQL-backed). The durability gate reads this to
   * decide whether a production/staging Installer API surface is safe to
   * boot; when false the pipeline falls back to the in-memory stores in
   * `domains/installer/store.ts` (see `InstallerPipeline` constructor).
   */
  readonly durable: boolean;
}

/**
 * Resolve durable Installation + Deployment stores for the public Installer
 * API. An explicit override always wins; otherwise a configured `sqlClient`
 * backs both ledgers with the SQL stores. When neither is present the result
 * carries `undefined` stores and `durable: false`, leaving the pipeline to
 * construct its in-memory fallback (fine for dev / test, gated for
 * production/staging by {@link assertDurableInstallerStoreOrWarn}).
 */
function resolveInstallerStores(input: {
  readonly installerInstallationStore?: InstallerInstallationStore;
  readonly installerDeploymentStore?: InstallerDeploymentStore;
  readonly sqlClient?: SqlClient;
}): ResolvedInstallerStores {
  const installations = input.installerInstallationStore ??
    (input.sqlClient
      ? new SqlInstallerInstallationStore({ client: input.sqlClient })
      : undefined);
  const deployments = input.installerDeploymentStore ??
    (input.sqlClient
      ? new SqlInstallerDeploymentStore({ client: input.sqlClient })
      : undefined);
  return {
    ...(installations ? { installations } : {}),
    ...(deployments ? { deployments } : {}),
    durable: installations !== undefined && deployments !== undefined,
  };
}

/**
 * Durability gate for the public Installer API ledger. The Installer API is
 * the canonical install entry point and Installation / Deployment are the two
 * core durable public concepts (AGENTS.md), so an in-memory ledger on a
 * production/staging deployment silently loses every Installation /
 * Deployment on restart or isolate recycle.
 *
 * Mirrors the existing fail-closed conventions
 * (`assertNoStrictRuntimeAdapterFallbacks`, the synthetic-provider hard-fail):
 * when the installer routes are exposed (`installerToken` present) AND the
 * environment is production/staging AND no durable store is injected, this
 * throws so the process refuses to boot a data-losing Installer API. It is
 * gated on `installerToken` so hosts that never expose the Installer API are
 * unaffected. `allowUnsafeProductionDefaults` provides a documented escape
 * hatch for operators who deliberately run an ephemeral ledger.
 */
function assertDurableInstallerStoreOrWarn(input: {
  readonly environment?: string;
  readonly installerTokenPresent: boolean;
  readonly durable: boolean;
  readonly allowUnsafeProductionDefaults?: boolean;
}): void {
  if (input.durable) return;
  const strict = input.environment === "production" ||
    input.environment === "staging";
  if (!input.installerTokenPresent) {
    // Routes are not exposed; an in-memory ledger cannot lose anything the
    // operator is serving. Stay quiet.
    return;
  }
  if (strict && !input.allowUnsafeProductionDefaults) {
    throw new Error(
      `${input.environment} runtime exposes the Installer API but no durable ` +
        `Installation/Deployment store is configured; the canonical install ` +
        `ledger would be lost on restart or isolate recycle. Inject ` +
        `installerInstallationStore + installerDeploymentStore (or a sqlClient) ` +
        `— or set allowUnsafeProductionDefaults to deliberately run ephemeral.`,
    );
  }
  // Non-strict, or strict-but-allowlisted: warn loudly so an operator who is
  // unknowingly running an ephemeral ledger notices.
  log.warn("kernel.installer.in_memory_ledger", {
    environment: input.environment ?? "unknown",
    hint: "Installation/Deployment records will NOT persist across restart " +
      "or isolate recycle. Inject installerInstallationStore + " +
      "installerDeploymentStore (or a sqlClient) for production/staging.",
  });
}

export { registerDefaultArtifactKinds };

/**
 * KernelPlugin instances bundled with the kernel distribution.
 *
 * Cloud / host-specific factories live in the separate takosumi-plugins
 * repository as dedicated `kind-*` packages such as
 * `@takos/takosumi-kind-cloudflare-worker` or
 * `@takos/takosumi-kind-docker-compose-web-service`. Takosumi core no longer
 * carries cloud SDK imports, so this function intentionally returns an empty
 * array: operators explicitly import the kind packages they want and pass their
 * factories to `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * The function is retained as a no-op so existing callers don't break, but
 * its return value is `readonly []`. Future major versions may remove it.
 */
export function defaultBundledPlugins(): readonly KernelPlugin[] {
  return [];
}

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
  /**
   * Pre-built durable stores for the public Installer API ledger. When
   * omitted, a configured `sqlClient` backs both with SQL stores; when
   * neither is present the installer pipeline falls back to its in-memory
   * stores (gated for production/staging when the Installer API is exposed).
   */
  readonly installerInstallationStore?: InstallerInstallationStore;
  readonly installerDeploymentStore?: InstallerDeploymentStore;
  /**
   * Operator-owned resolver for Space-visible platform service paths. The
   * kernel treats these paths as ordinary `listen.path` sources and does not
   * attach identity, billing, or account semantics to the path string.
   */
  readonly platformServices?: PlatformServiceResolver;
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
  registerDefaultArtifactKinds();
  // Billing is an operator-distribution / account-plane concern, not a kernel
  // core one. The operator-config layer (here) resolves any env-driven billing
  // wiring from product-neutral `TAKOSUMI_BILLING_*` keys and injects it via
  // `options.billing`; kernel core (`createBillingPort` in app_context.ts) only
  // reads `options.billing` and no longer hard-reads a product-namespaced key.
  const billing = resolveBillingOptions({
    configured: options.billing,
    env: runtimeEnv,
  });
  const context = options.context ?? await createAppContext({
    ...options,
    runtimeEnv,
    runtimeConfig,
    plugins: options.plugins ?? [],
    ...(billing ? { billing } : {}),
  });
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const installerToken = runtimeEnv.TAKOSUMI_INSTALLER_TOKEN;
  const fetchToken = runtimeEnv.TAKOSUMI_ARTIFACT_FETCH_TOKEN;
  const metricsScrapeToken = runtimeEnv.TAKOSUMI_METRICS_SCRAPE_TOKEN;
  const platformServiceResolverUrl =
    runtimeEnv.TAKOSUMI_PLATFORM_SERVICE_RESOLVER_URL;
  const platformServiceResolverToken =
    runtimeEnv.TAKOSUMI_PLATFORM_SERVICE_RESOLVER_TOKEN;
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
  // Durable operation journal (WAL). The store is resolved here (SQL when a
  // SqlClient is configured, in-memory otherwise). When consumed, the
  // shape-model apply path uses it: `ApplyService` forwards it to `applyV2`,
  // which writes `prepare`/`commit` stage records around the provider apply
  // loop whenever an `operationPlanPreview` is present.
  //
  // HONEST STATUS — currently UNUSED in production. The default production
  // apply facade (`createDeploymentApplyFacade` in app_context.ts) resolves +
  // applies a Deployment via the graph-projection path and never dispatches
  // through `applyV2`, and bootstrap does not construct an `ApplyService` with
  // this store, so the resolved store is NOT wired into any production apply
  // path. We still resolve it (a) to fail fast if the SQL store cannot be
  // constructed for a SqlClient-backed deployment and (b) so the wiring point
  // is obvious once the facade builds a non-dry-run `operationPlanPreview`.
  // It is deliberately not threaded further: doing so requires routing the
  // facade through `applyV2` (a larger apply-pipeline change). Tracked as a
  // known gap in docs/reference/known-gaps.md ("Operation journal (WAL) not
  // wired into the production apply facade"). See apply_v2.ts
  // (`ApplyV2Options.operationJournalStore`) for the stage semantics and the
  // commit-before-prepare guard.
  const operationJournalStore = resolveOperationJournalStore(options);
  // Intentionally not consumed yet (see HONEST STATUS above). The `void`
  // suppresses the unused-binding lint without implying the store is wired.
  void operationJournalStore;
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
  const platformServices = resolvePlatformServices({
    configured: options.platformServices,
    url: platformServiceResolverUrl,
    token: platformServiceResolverToken,
  });
  // Durable Installation + Deployment ledger for the public Installer API.
  // SQL-backed when a SqlClient is configured (and not explicitly overridden);
  // the in-memory fallback is only safe for dev / test and is gated below for
  // production/staging hosts that actually expose the Installer API.
  const installerStores = resolveInstallerStores({
    ...(options.installerInstallationStore
      ? { installerInstallationStore: options.installerInstallationStore }
      : {}),
    ...(options.installerDeploymentStore
      ? { installerDeploymentStore: options.installerDeploymentStore }
      : {}),
    ...(options.sqlClient ? { sqlClient: options.sqlClient } : {}),
  });
  assertDurableInstallerStoreOrWarn({
    environment: runtimeConfig.environment,
    installerTokenPresent: Boolean(installerToken),
    durable: installerStores.durable,
    allowUnsafeProductionDefaults:
      runtimeConfig.allowUnsafeProductionDefaults ?? false,
  });
  const app = await createApiApp({
    role,
    context,
    registerInternalRoutes: role === "takosumi-api",
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
      pipeline: new InstallerPipeline({
        ...(options.plugins ? { plugins: options.plugins } : {}),
        ...(options.kindAliases ? { kindAliases: options.kindAliases } : {}),
        ...(platformServices ? { platformServices } : {}),
        ...(installerStores.installations
          ? { installations: installerStores.installations }
          : {}),
        ...(installerStores.deployments
          ? { deployments: installerStores.deployments }
          : {}),
      }),
      ...(installerToken ? { getInstallerToken: () => installerToken } : {}),
    },
    readinessRouteProbes: createRoleReadinessProbes({
      role,
      context,
      runtimeConfig,
      runtimeEnv,
      implementationBindingCount: options.plugins?.length ?? 0,
      strictImplementationBindings:
        runtimeConfig.environment === "production" ||
        runtimeConfig.environment === "staging",
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

function resolvePlatformServices(input: {
  readonly configured?: PlatformServiceResolver;
  readonly url?: string;
  readonly token?: string;
}): PlatformServiceResolver | undefined {
  if (input.configured) return input.configured;
  if (!input.url) return undefined;
  return httpPlatformServiceResolver({
    url: input.url,
    ...(input.token ? { token: input.token } : {}),
  });
}

/**
 * Resolve billing port config for the operator-config layer. An explicit
 * `options.billing` always wins; otherwise read the product-neutral
 * `TAKOSUMI_BILLING_BASE_URL` / `TAKOSUMI_BILLING_SECRET` env pair. Billing is
 * an operator-distribution concern, so the kernel deliberately does NOT read a
 * product-namespaced key (the old `TAKOS_APP_BILLING_*` fallback that lived in
 * kernel core has been removed — see `createBillingPort` in app_context.ts).
 */
function resolveBillingOptions(input: {
  readonly configured?: { readonly baseUrl?: string; readonly secret?: string };
  readonly env: Record<string, string | undefined>;
}): { readonly baseUrl?: string; readonly secret?: string } | undefined {
  const baseUrl = input.configured?.baseUrl ??
    input.env.TAKOSUMI_BILLING_BASE_URL;
  const secret = input.configured?.secret ?? input.env.TAKOSUMI_BILLING_SECRET;
  if (baseUrl === undefined && secret === undefined) return undefined;
  return {
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(secret !== undefined ? { secret } : {}),
  };
}
