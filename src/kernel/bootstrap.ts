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
  type DeployServices,
} from "./app_context.ts";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import { isPaaSProcessRole, type PaaSProcessRole } from "./process/mod.ts";
import type { WorkerDaemonHandle } from "./workers/daemon.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
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
import { InMemoryRevokeDebtStore } from "./domains/deploy/revoke_debt_store.ts";
import { SqlRevokeDebtStore } from "./domains/deploy/revoke_debt_store_sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
} from "./domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store_sql.ts";
import {
  httpPlatformServiceResolver,
  type InstallationStatus,
  InstallerPipeline,
  type PlatformServiceResolver,
} from "./domains/installer/mod.ts";
import type {
  DeploymentApplyRequest,
  DeploymentApplyResponse,
  DeploymentDryRunRequest,
  DeploymentDryRunResponse,
  InstallationApplyRequest,
  InstallationApplyResponse,
  InstallationDryRunRequest,
  InstallationDryRunResponse,
  RollbackRequest,
  RollbackResponse,
} from "takosumi-contract/installer-api";
import {
  defaultGitRunner,
  defaultTarRunner,
} from "./shared/runtime/capability-runners.ts";
import type {
  GitRunner,
  TarRunner,
} from "takosumi-contract/reference/runtime-capability";
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
  /**
   * Injected runtime capabilities. Takosumi is consumed as a framework
   * library: git / tar subprocess capabilities are injected here rather than
   * reached through `Deno.*` / `node:*` in the library surface. Both fields are
   * optional and default to runners built over the `RuntimeAdapter`
   * `SubprocessAdapter` (`currentRuntime().subprocess`), so the default Deno
   * runtime behavior is unchanged. Operators that fetch git source or read
   * prepared tar archives through a custom transport inject their own runner.
   */
  readonly runtime?: {
    readonly gitRunner?: GitRunner;
    readonly tarRunner?: TarRunner;
  };
}

/**
 * Typed in-process operate facade exposed on {@link CreatedPaaSApp.kernel}.
 *
 * The facade delegates to the already-wired {@link InstallerPipeline} (the same
 * instance backing the public Installer API routes) and the deploy services
 * from {@link AppContext}. It does NOT duplicate pipeline logic — every method
 * forwards to the existing pipeline / service surface. `install` / `deploy` /
 * `rollback` / `status` map to the Installer API lifecycle; `pipeline` and
 * `deployServices` expose the wired instances for callers that need the full
 * surface (e.g. dry-run variants or deploy-service operations not projected as
 * a named method here).
 */
export interface TakosumiKernelFacade {
  /** The wired Installer API pipeline instance (Installation + Deployment lifecycle). */
  readonly pipeline: InstallerPipeline;
  /** The deploy domain services from the AppContext (`context.services.deploy`). */
  readonly deployServices: DeployServices;
  /** Dry-run a fresh Installation apply (`POST /v1/installations/dry-run`). */
  installDryRun(
    request: InstallationDryRunRequest,
  ): Promise<InstallationDryRunResponse>;
  /** Apply a fresh Installation (`POST /v1/installations`). */
  install(
    request: InstallationApplyRequest,
  ): Promise<InstallationApplyResponse>;
  /** Dry-run a new Deployment for an existing Installation. */
  deployDryRun(
    installationId: string,
    request: DeploymentDryRunRequest,
  ): Promise<DeploymentDryRunResponse>;
  /** Apply a new Deployment for an existing Installation. */
  deploy(
    installationId: string,
    request: DeploymentApplyRequest,
  ): Promise<DeploymentApplyResponse>;
  /** Pointer-only rollback to a previously succeeded Deployment. */
  rollback(
    installationId: string,
    request: RollbackRequest,
  ): Promise<RollbackResponse>;
  /** Read Installation + current Deployment + Deployment history (no mutation). */
  status(installationId: string): Promise<InstallationStatus>;
}

export interface CreatedPaaSApp {
  readonly app: HonoApp;
  readonly context: AppContext;
  readonly role: PaaSProcessRole;
  readonly workerDaemon?: WorkerDaemonHandle;
  /**
   * Typed in-process operate facade over the wired Installer pipeline and
   * deploy services. Lets a host call install / deploy / rollback / status
   * directly without going through the HTTP Installer API surface.
   */
  readonly kernel: TakosumiKernelFacade;
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
  // Operation journal (WAL): the impl exists (domains/deploy/operation_journal*,
  // apply_v2.ts `ApplyV2Options.operationJournalStore`) but is not wired into the
  // production apply facade. Bootstrap deliberately does NOT resolve/thread it —
  // doing so requires routing the facade through `applyV2`. Tracked in
  // docs/reference/known-gaps.md; re-add the resolver here when the WAL apply
  // path is wired.
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
  // Injected runtime capabilities. Default to runners built over the
  // RuntimeAdapter SubprocessAdapter (currentRuntime().subprocess), preserving
  // the historical Deno.Command git / tar behavior. Resolved here so the
  // capability seam is wired at bootstrap and can be threaded into the source
  // fetch / prepared-archive path; an operator override replaces either runner.
  const gitRunner: GitRunner = options.runtime?.gitRunner ?? defaultGitRunner;
  const tarRunner: TarRunner = options.runtime?.tarRunner ?? defaultTarRunner;
  // The single wired Installer pipeline instance. Reused for the public
  // Installer API routes AND the in-process operate facade so both share one
  // Installation / Deployment ledger and one plugin / alias / platform-service
  // wiring.
  const installerPipeline = new InstallerPipeline({
    ...(options.plugins ? { plugins: options.plugins } : {}),
    ...(options.kindAliases ? { kindAliases: options.kindAliases } : {}),
    ...(platformServices ? { platformServices } : {}),
    ...(installerStores.installations
      ? { installations: installerStores.installations }
      : {}),
    ...(installerStores.deployments
      ? { deployments: installerStores.deployments }
      : {}),
    gitRunner,
    tarRunner,
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
      pipeline: installerPipeline,
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
  // The resolved git / tar capabilities are now threaded into the
  // InstallerPipeline (above), which forwards them to the installer source
  // fetch / prepared-archive path. The installer no longer constructs
  // `Deno.Command` in its `git-fetch.ts` / `prepared-source.ts` surface, so the
  // capability seam is the single place runner behavior is chosen (default
  // `currentRuntime().subprocess` routing, or an operator override).
  //
  // Typed in-process operate facade. Delegates to the wired pipeline + deploy
  // services; does not duplicate any pipeline logic.
  const kernel: TakosumiKernelFacade = {
    pipeline: installerPipeline,
    deployServices: context.services.deploy,
    installDryRun: (request) => installerPipeline.installationDryRun(request),
    install: (request) => installerPipeline.installationApply(request),
    deployDryRun: (installationId, request) =>
      installerPipeline.deploymentDryRun(installationId, request),
    deploy: (installationId, request) =>
      installerPipeline.deploymentApply(installationId, request),
    rollback: (installationId, request) =>
      installerPipeline.rollback(installationId, request),
    status: (installationId) => installerPipeline.status(installationId),
  };
  return { app, context, role, workerDaemon, kernel };
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
