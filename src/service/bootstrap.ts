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
import { isTakosumiProcessRole, type TakosumiProcessRole } from "./process/mod.ts";
import type { WorkerDaemonHandle } from "./workers/daemon.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
import type { RevokeDebtStore } from "./domains/deploy-records/revoke_debt_store.ts";
import type { TakosumiDeploymentRecordStore } from "./domains/deploy-records/deployment_record_store.ts";
import { registerDefaultArtifactKinds } from "./bootstrap/registry_setup.ts";
import { currentRuntime } from "./shared/runtime/index.ts";
import {
  createRoleWorkerDaemon,
  createWorkerDaemonState,
  shouldStartWorkerDaemon,
} from "./bootstrap/worker_daemon.ts";
import { createRoleReadinessProbes } from "./bootstrap/readiness.ts";
import { InMemoryRevokeDebtStore } from "./domains/deploy-records/revoke_debt_store.ts";
import { SqlRevokeDebtStore } from "./domains/deploy-records/revoke_debt_store_sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
} from "./domains/deploy-records/deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy-records/deployment_record_store_sql.ts";
import {
  type EnqueueRun,
  OpenTofuDeploymentController,
  type OpenTofuRunner,
} from "./domains/deploy-control/mod.ts";
import type { InstallationCoordination } from "./domains/deploy-control/installation_lease.ts";
import {
  type EnqueueSourceSync,
  SourcesService,
} from "./domains/sources/mod.ts";
import { InstallationsService } from "./domains/installations/mod.ts";
import { SpacesService } from "./domains/spaces/mod.ts";
import { ConnectionsService } from "./domains/connections/mod.ts";
import { DependenciesService } from "./domains/dependencies/mod.ts";
import { RunGroupsService } from "./domains/run-groups/mod.ts";
import { seedOfficialInstallConfigs } from "./domains/installations/official_seed.ts";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSyncRun,
} from "takosumi-contract/sources";
import type {
  ApplyRunResponse,
  CreateApplyRunRequest,
  CreatePlanRunRequest,
  GetInstallationResponse,
  ListDeploymentOutputsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
  RunnerProfile,
} from "takosumi-contract/deploy-control-api";
import {
  InMemoryOpenTofuDeploymentStore,
  type OpenTofuDeploymentStore,
} from "./domains/deploy-control/store.ts";
import {
  SqlOpenTofuDeploymentStore,
} from "./domains/deploy-control/store_sql.ts";
import { log } from "./shared/log.ts";
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";
import type { Run } from "takosumi-contract/runs";

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

interface ResolvedOpenTofuStore {
  readonly store?: OpenTofuDeploymentStore;
  readonly durable: boolean;
}

function resolveOpenTofuStore(input: {
  readonly opentofuDeploymentStore?: OpenTofuDeploymentStore;
  readonly sqlClient?: SqlClient;
}): ResolvedOpenTofuStore {
  const store = input.opentofuDeploymentStore ??
    (input.sqlClient
      ? new SqlOpenTofuDeploymentStore({ client: input.sqlClient })
      : undefined);
  return {
    ...(store ? { store } : {}),
    durable: store !== undefined,
  };
}

/**
 * Durability gate for the public OpenTofu deployment ledger. The public API is
 * the canonical plan/apply/destroy entry point, so an in-memory ledger on a
 * production/staging deployment silently loses every run, Installation, and
 * Deployment on restart or isolate recycle.
 *
 * Mirrors the existing fail-closed conventions
 * (`assertNoStrictRuntimeAdapterFallbacks`, the synthetic-provider hard-fail):
 * when the OpenTofu routes are exposed (`deployControlToken` present) AND the
 * environment is production/staging AND no durable store is injected, this
 * throws so the process refuses to boot a data-losing deploy API. It is
 * gated on `deployControlToken` so hosts that never expose the Deploy Control API are
 * unaffected. `allowUnsafeProductionDefaults` provides a documented escape
 * hatch for operators who deliberately run an ephemeral ledger.
 */
function assertDurableDeployControlStoreOrWarn(input: {
  readonly environment?: string;
  readonly deployControlTokenPresent: boolean;
  readonly durable: boolean;
  readonly allowUnsafeProductionDefaults?: boolean;
}): void {
  if (input.durable) return;
  const strict = input.environment === "production" ||
    input.environment === "staging";
  if (!input.deployControlTokenPresent) {
    // Routes are not exposed; an in-memory ledger cannot lose anything the
    // operator is serving. Stay quiet.
    return;
  }
  if (strict && !input.allowUnsafeProductionDefaults) {
    throw new Error(
      `${input.environment} runtime exposes the OpenTofu deploy API but no ` +
        `durable run ledger is configured; PlanRun/ApplyRun records and ` +
        `Installation/Deployment records would be lost on restart or isolate ` +
        `recycle. Inject opentofuDeploymentStore (or a sqlClient) — or set ` +
        `allowUnsafeProductionDefaults to deliberately run ephemeral.`,
    );
  }
  // Non-strict, or strict-but-allowlisted: warn loudly so an operator who is
  // unknowingly running an ephemeral ledger notices.
  log.warn("service.deployControl.in_memory_ledger", {
    environment: input.environment ?? "unknown",
    hint: "OpenTofu run, Installation, and Deployment records will NOT " +
      "persist across restart or isolate recycle. Inject " +
      "opentofuDeploymentStore (or a sqlClient) for production/staging.",
  });
}

export { registerDefaultArtifactKinds };

/**
 * OperatorImplementation instances bundled with the service distribution.
 *
 * Cloud / host-specific factories live in operator distributions. Takosumi no
 * longer carries cloud SDK imports or a sibling implementation package, so this
 * function intentionally returns an empty array: operators explicitly pass the
 * implementation bindings they own to `createTakosumiService({ implementations: [...] })`.
 *
 * The function is retained as a no-op so existing callers don't break, but
 * its return value is `readonly []`. Future major versions may remove it.
 */
export function defaultBundledImplementations(): readonly OperatorImplementation[] {
  return [];
}

export interface CreateTakosumiServiceOptions extends AppContextOptions {
  readonly role?: TakosumiProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly context?: AppContext;
  readonly startWorkerDaemon?: boolean;
  /**
   * Optional SQL client used to back persistence-sensitive records. When
   * supplied, bootstrap instantiates SQL-backed stores so revoke-debt and
   * artifact-retention records survive service restarts; in-memory fallback
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
   * Pre-built durable store for the public OpenTofu run ledger. When omitted,
   * a configured `sqlClient` backs it with SQL; when neither is present the
   * controller falls back to an in-memory dev/test store (gated for
   * production/staging when the public deploy API is exposed).
   */
  readonly opentofuDeploymentStore?: OpenTofuDeploymentStore;
  /** OpenTofu executor. The reference Cloudflare distribution injects a
   * Cloudflare Container runner; when omitted, PlanRun/ApplyRun records remain
   * queued in the ledger for an external runner to pick up.
   */
  readonly opentofuRunner?: OpenTofuRunner;
  /**
   * Out-of-process run dispatch seam. The Workers adapter injects a producer
   * that enqueues onto `RUN_QUEUE`; when omitted the controller
   * defaults to an inline dispatcher that runs the consumer synchronously
   * (preserving create-executes-run for local / node substrates and tests).
   */
  readonly enqueueRun?: EnqueueRun;
  /**
   * Out-of-process source-sync dispatch seam (Core Specification §6). The
   * Workers adapter injects a producer that enqueues onto the run queue with
   * `action: "source_sync"`; when omitted the source-sync run stays queued for an
   * external consumer.
   */
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  /**
   * Installation lease seam (Core Specification §10.2). The Workers adapter
   * injects a DO-backed implementation fronting the `COORDINATION`
   * CoordinationObject so only ONE write run per (installation, environment)
   * runs at a time across isolates; when omitted the controller relies on its
   * in-process serialization (single-isolate safe).
   */
  readonly installationCoordination?: InstallationCoordination;
}

/**
 * Typed in-process operation facade exposed on {@link CreatedTakosumiService.operations}.
 *
 * The facade delegates to the already-wired OpenTofu controller, the same
 * instance backing the public route surface. It does not duplicate controller
 * logic.
 */
export interface TakosumiOperations {
  /** The wired OpenTofu deployment controller. */
  readonly controller: OpenTofuDeploymentController;
  /**
   * Spaces domain service (Core Specification §4): Space identity + handle
   * uniqueness over the same shared ledger.
   */
  readonly spaces: SpacesService;
  /**
   * Installations domain service (Core Specification §5 / §11): Installation /
   * InstallConfig / DeploymentProfile over the same shared ledger.
   */
  readonly installations: InstallationsService;
  readonly connections: ConnectionsService;
  /**
   * Dependencies domain service (Core Specification §14 / §15): the Space
   * Installation DAG edges over the same shared ledger.
   */
  readonly dependencies: DependenciesService;
  /**
   * RunGroups domain service (Core Specification §19 / §24): the space_update
   * RunGroup over the same shared ledger + controller.
   */
  readonly runGroups: RunGroupsService;
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
  createPlanRun(request: CreatePlanRunRequest): Promise<PlanRunResponse>;
  /**
   * Installation-driven plan (spec §23): resolves the Installation ->
   * InstallConfig -> Source, picks the latest SourceSnapshot, and dispatches
   * with installation state scope.
   */
  createInstallationPlan(installationId: string): Promise<PlanRunResponse>;
  /** Installation-driven destroy-plan: always lands waiting_approval (spec §23). */
  createInstallationDestroyPlan(
    installationId: string,
  ): Promise<PlanRunResponse>;
  getPlanRun(id: string): Promise<PlanRunResponse>;
  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse>;
  getApplyRun(id: string): Promise<ApplyRunResponse>;
  getInstallation(id: string): Promise<GetInstallationResponse>;
  listDeployments(installationId: string): Promise<ListDeploymentsResponse>;
  listDeploymentOutputs(
    installationId: string,
  ): Promise<ListDeploymentOutputsResponse>;
  /** Unified Run facade (§6.8): read / approve / cancel by run id. */
  getRun(id: string): Promise<Run>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  /**
   * Queue-consumer entry point. The Workers `queue()` consumer calls this for
   * each dispatched run message (plan/apply); it loads the run, applies the
   * idempotency guard, mints credentials, and drives the container dispatch.
   */
  dispatchQueuedRun(
    dispatch: {
      action: "plan" | "apply" | "source_sync";
      runId: string;
      spaceId: string;
    },
  ): Promise<void>;
  // --- Sources (Core Specification §6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(spaceId: string): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<CreateSourceSyncResponse>;
  listSourceSnapshots(sourceId: string): Promise<ListSourceSnapshotsResponse>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun>;
  /**
   * Verifies a per-source webhook bearer against the stored hook-secret hash.
   * Used by the platform worker's `/hooks/sources/:id` route.
   */
  verifySourceHookSecret(
    sourceId: string,
    presentedSecret: string,
  ): Promise<boolean>;
}

export interface CreatedTakosumiService {
  readonly app: HonoApp;
  readonly context: AppContext;
  readonly role: TakosumiProcessRole;
  readonly workerDaemon?: WorkerDaemonHandle;
  /**
   * Typed in-process operate facade over the wired Deploy Control pipeline.
   * Lets a host call plan/apply/destroy/status directly without going through
   * the HTTP Deploy Control API surface.
   */
  readonly operations: TakosumiOperations;
}

export async function createTakosumiService(
  options: CreateTakosumiServiceOptions = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = options.runtimeEnv ?? currentRuntime().env.toObject();
  const runtimeConfig = options.runtimeConfig ??
    await loadRuntimeConfigFromEnv({ env: runtimeEnv });
  const role = options.role ?? processRoleFromRuntimeConfig(runtimeConfig);
  registerDefaultArtifactKinds();
  const context = options.context ?? await createAppContext({
    ...options,
    runtimeEnv,
    runtimeConfig,
    implementations: options.implementations ?? [],
  });
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const deployControlToken = runtimeEnv.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
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
  // Build the auxiliary deployment record store. SqlClient wins so production
  // restarts preserve artifact retention and revoke-cleanup evidence; the
  // in-memory fallback is fine for tests / dev.
  const recordStore = resolveTakosumiDeploymentRecordStore({
    takosumiDeploymentRecordStore: options.takosumiDeploymentRecordStore,
    sqlClient: options.sqlClient,
    ...(deployLockLeaseMs !== undefined ? { deployLockLeaseMs } : {}),
    ...(deployLockHeartbeatMs !== undefined ? { deployLockHeartbeatMs } : {}),
  });
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
  // Durable OpenTofu run ledger. SQL-backed when a SqlClient is configured
  // (and not explicitly overridden); the in-memory fallback is only safe for
  // dev/test and is gated below for production/staging hosts that expose the
  // public deploy API.
  const opentofuStore = resolveOpenTofuStore({
    ...(options.opentofuDeploymentStore
      ? { opentofuDeploymentStore: options.opentofuDeploymentStore }
      : {}),
    ...(options.sqlClient ? { sqlClient: options.sqlClient } : {}),
  });
  assertDurableDeployControlStoreOrWarn({
    environment: runtimeConfig.environment,
    deployControlTokenPresent: Boolean(deployControlToken),
    durable: opentofuStore.durable,
    allowUnsafeProductionDefaults:
      runtimeConfig.allowUnsafeProductionDefaults ?? false,
  });
  // Resolve a single concrete store so the controller and the Source domain
  // service share the SAME ledger (when no durable store is injected the
  // controller would otherwise build its own private in-memory store, leaving
  // the SourcesService backed by a different instance).
  const sharedOpenTofuStore = opentofuStore.store ??
    new InMemoryOpenTofuDeploymentStore();
  // Source domain service (Core Specification §6). The source REST API, webhook,
  // and scheduler all reach it through the controller. The source_sync producer
  // (when bound) enqueues onto the run queue with `action: "source_sync"`.
  const sourcesService = new SourcesService({
    store: sharedOpenTofuStore,
    ...(options.enqueueSourceSync
      ? { enqueueSourceSync: options.enqueueSourceSync }
      : {}),
  });
  // Spaces + Installations domains (Core Specification §4 / §5 / §11): Space /
  // Installation / InstallConfig / DeploymentProfile over the SAME shared
  // ledger as the controller and Source service.
  const spacesService = new SpacesService({ store: sharedOpenTofuStore });
  const connectionsService = new ConnectionsService({
    store: sharedOpenTofuStore,
  });
  const installationsService = new InstallationsService({
    store: sharedOpenTofuStore,
  });
  const dependenciesService = new DependenciesService({
    store: sharedOpenTofuStore,
  });
  // Seed the official InstallConfig catalog from the built-in template registry
  // (trustLevel "official"). Idempotent upsert keyed by the derived config id,
  // so a restart re-seeds the same rows. Fire-and-forget: a seed failure must
  // not block boot, and install read paths tolerate an empty catalog.
  void seedOfficialInstallConfigsOrWarn(sharedOpenTofuStore);
  const opentofuController = new OpenTofuDeploymentController({
    store: sharedOpenTofuStore,
    ...(options.opentofuRunner ? { runner: options.opentofuRunner } : {}),
    ...(options.enqueueRun ? { enqueueRun: options.enqueueRun } : {}),
    sourcesService,
    ...(options.runnerProfiles ? { runnerProfiles: options.runnerProfiles } : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.installationCoordination
      ? { installationCoordination: options.installationCoordination }
      : {}),
  });
  // RunGroups domain (Core Specification §19 / §24): the space_update RunGroup
  // re-plans stale Installations through the controller and computes group
  // status from member runs at read time. Constructed after the controller it
  // drives.
  const runGroupsService = new RunGroupsService({
    store: sharedOpenTofuStore,
    controller: opentofuController,
  });
  const app = await createApiApp({
    role,
    context,
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
    deployControlPublicRouteOptions: {
      controller: opentofuController,
      spacesService,
      installationsService,
      connectionsService,
      dependenciesService,
      runGroupsService,
      ...(deployControlToken ? { getDeployControlToken: () => deployControlToken } : {}),
    },
    readinessRouteProbes: createRoleReadinessProbes({
      role,
      context,
      runtimeConfig,
      runtimeEnv,
      implementationBindingCount: options.implementations?.length ?? 0,
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
  // Typed in-process operate facade. Delegates to the wired OpenTofu
  // controller; does not duplicate controller logic.
  const operations: TakosumiOperations = {
    controller: opentofuController,
    spaces: spacesService,
    installations: installationsService,
    connections: connectionsService,
    dependencies: dependenciesService,
    runGroups: runGroupsService,
    listRunnerProfiles: () => opentofuController.listRunnerProfiles(),
    createPlanRun: (request) => opentofuController.createPlanRun(request),
    createInstallationPlan: (installationId) =>
      opentofuController.createInstallationPlan(installationId),
    createInstallationDestroyPlan: (installationId) =>
      opentofuController.createInstallationDestroyPlan(installationId),
    getPlanRun: (id) => opentofuController.getPlanRun(id),
    createApplyRun: (request) => opentofuController.createApplyRun(request),
    getApplyRun: (id) => opentofuController.getApplyRun(id),
    getInstallation: (id) => opentofuController.getInstallation(id),
    listDeployments: (installationId) =>
      opentofuController.listDeployments(installationId),
    listDeploymentOutputs: (installationId) =>
      opentofuController.listDeploymentOutputs(installationId),
    getRun: (id) => opentofuController.getRun(id),
    approveRun: (id, input) => opentofuController.approveRun(id, input ?? {}),
    cancelRun: (id) => opentofuController.cancelRun(id),
    dispatchQueuedRun: (dispatch) =>
      opentofuController.dispatchQueuedRun(dispatch),
    createSource: (request) => opentofuController.createSource(request),
    listSources: (spaceId) => opentofuController.listSources(spaceId),
    getSource: (id) => opentofuController.getSource(id),
    patchSource: (id, patch) => opentofuController.patchSource(id, patch),
    createSourceSync: (sourceId, opts) =>
      opentofuController.createSourceSync(sourceId, opts ?? {}),
    listSourceSnapshots: (sourceId) =>
      opentofuController.listSourceSnapshots(sourceId),
    getSourceSyncRun: (id) => opentofuController.getSourceSyncRun(id),
    verifySourceHookSecret: (sourceId, presentedSecret) =>
      opentofuController.verifySourceHookSecret(sourceId, presentedSecret),
  };
  return { app, context, role, workerDaemon, operations };
}

/**
 * Seeds the official InstallConfig catalog into the shared ledger. The config id
 * is derived from the template id so the upsert is idempotent across restarts.
 * Logs and swallows a seed failure so it never blocks service boot.
 */
async function seedOfficialInstallConfigsOrWarn(
  store: OpenTofuDeploymentStore,
): Promise<void> {
  try {
    await seedOfficialInstallConfigs(store);
  } catch (error) {
    log.warn("service.installations.install_config_seed_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
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
): TakosumiProcessRole {
  const role = runtimeConfig.processRole;
  return role && isTakosumiProcessRole(role) ? role : "takosumi-api";
}

/**
 * Parse a positive-integer env var, returning `undefined` when unset or
 * unparseable so callers can fall back to a downstream default. Used for
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` where the service-level default lives in
 * the artifact-routes module.
 */
function parsePositiveIntegerEnv(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

