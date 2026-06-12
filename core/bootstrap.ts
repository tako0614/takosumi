import type { Hono as HonoApp } from "hono";
import { createApiApp } from "./api/mod.ts";
import type { SourceArchiveWriter } from "./api/deploy_control_shared.ts";
import { createConnectionOAuthHelpersFromEnv } from "./api/connection_oauth_helpers.ts";
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
import type {
  MembershipStatus as SpaceMemberStatus,
  SpaceMembership as SpaceMember,
  SpaceRole as SpaceMemberRole,
} from "./domains/membership/mod.ts";
import { createMembershipControlFacade } from "./domains/membership/control_facade.ts";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import {
  isTakosumiProcessRole,
  type TakosumiProcessRole,
} from "./process/mod.ts";
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
import { InMemoryTakosumiDeploymentRecordStore } from "./domains/deploy-records/deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy-records/deployment_record_store_sql.ts";
import {
  type DependencyValueSealer,
  type EnqueueRun,
  OpenTofuDeploymentController,
  type ReconcileInvoiceUsageInput,
  type RecordManagedResourceUsageInput,
  type OpenTofuRunner,
  type RecordMeteredUsageInput,
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
import { OutputSharesService } from "./domains/output-shares/mod.ts";
import type { SensitiveOutputResolver } from "./domains/output-shares/mod.ts";
import type { ConnectionVault } from "./adapters/vault/mod.ts";
import { StaticSecretConnectionVault } from "./adapters/vault/mod.ts";
import type { SecretBoundaryCrypto } from "./adapters/secret-store/memory.ts";
import { RunGroupsService } from "./domains/run-groups/mod.ts";
import { ActivityService } from "./domains/activity/mod.ts";
import {
  type BackupArtifactStore,
  type BackupObjectReader,
  BackupsService,
  type ServiceDataBackupRunner,
} from "./domains/backups/mod.ts";
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
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type {
  ApplyRunResponse,
  Connection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  CreatePlanRunRequest,
  Deployment,
  GetInstallationResponse,
  ListConnectionsResponse,
  ListDeploymentOutputsResponse,
  ListDeploymentsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
  RunnerProfile,
} from "@takosumi/internal/deploy-control-api";
import type { RunCostInfo, RunLogsResponse } from "takosumi-contract/runs";
import {
  InMemoryOpenTofuDeploymentStore,
  type OpenTofuDeploymentStore,
} from "./domains/deploy-control/store.ts";
import { SqlOpenTofuDeploymentStore } from "./domains/deploy-control/store_sql.ts";
import { log } from "./shared/log.ts";
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";
import type { Run } from "takosumi-contract/runs";
import type { Dependency } from "takosumi-contract/dependencies";
import type {
  BillingSettings,
  CreditBalance,
  CreditReservation,
  InvoiceUsageReconciliation,
  UsageEvent,
} from "takosumi-contract/billing";
import type { ListProviderTemplatesResponse } from "takosumi-contract/providers";

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
  const store =
    input.opentofuDeploymentStore ??
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
  const strict =
    input.environment === "production" || input.environment === "staging";
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
    hint:
      "OpenTofu run, Installation, and Deployment records will NOT " +
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
   * Runner used only for non-managed provider env set executions.
   * Hosted/reference Workers inject the same Cloudflare Container runner object
   * but route it through this separate seam so user-supplied provider profiles
   * cannot accidentally run on the default managed-provider path.
   */
  readonly userEnvSetProviderRunner?: OpenTofuRunner;
  /**
   * Connection Vault used to mint run-scoped provider credentials for
   * plan/apply/destroy. Hosts that execute provider-using runs must inject this;
   * the controller fails closed without it.
   */
  readonly opentofuConnectionVault?: ConnectionVault;
  /**
   * At-rest secret crypto for the built-in {@link StaticSecretConnectionVault}.
   * When `opentofuConnectionVault` is not supplied but this IS, the bootstrap
   * constructs the default vault over the shared OpenTofu store with this crypto
   * — so a host only has to wire the env-backed crypto (via
   * `selectSecretBoundaryCrypto`) to get a working provider-credential vault,
   * instead of re-assembling the vault + store itself.
   */
  readonly secretCrypto?: SecretBoundaryCrypto;
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
  /**
   * Raw R2_SOURCE writer for `takosumi deploy` upload archives (Phase: deploy).
   * The Workers adapter injects `env.R2_SOURCE.put`; when omitted the upload +
   * deploy routes report not_implemented.
   */
  readonly writeSourceArchive?: SourceArchiveWriter;
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
  /**
   * Control-backup seal + object-storage seam (Core Specification §33 / §26
   * R2_BACKUPS). The host worker injects an implementation backed by R2_BACKUPS
   * + the at-rest secret-boundary crypto; when omitted the backup routes report
   * `not_implemented` (the dev/test fallback may inject an in-memory store).
   */
  readonly backupArtifactStore?: BackupArtifactStore;
  readonly backupStateObjectReader?: BackupObjectReader;
  /**
   * Optional service-data backup producer. Hosts wire this to an isolated
   * backup Run / Runner Container path for `provider_snapshot` /
   * `custom_command`; the control backup service records only the returned
   * artifact pointer.
   */
  readonly serviceDataBackupRunner?: ServiceDataBackupRunner;
  /**
   * Host-injected resolver for sensitive OutputShare values. Required for
   * sensitive cross-Space published_output injection; when omitted the service
   * fails closed for sensitive grants.
   */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
  /**
   * Host-injected at-rest sealer for the sensitive pinned values of a
   * DependencySnapshot entry (spec §11 / §18). Required whenever a sensitive
   * cross-Space published_output is injected: the controller seals the resolved
   * secret instead of persisting it as a cleartext ledger value, and unseals it
   * at apply. Omitted ⇒ a sensitive published_output edge fails closed.
   */
  readonly dependencyValueSealer?: DependencyValueSealer;
  /**
   * Internal compatibility seam for accounts-plane / CLI in-process callers.
   * Internet-facing platform hosts must leave this false so legacy `/v1/*`
   * PlanRun / ApplyRun / RunnerProfile routes cannot be exposed by env drift.
   */
  readonly mountInternalLedgerRoutes?: boolean;
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
  /**
   * Space membership facade backing the account-plane `/api/v1/spaces/:id/
   * members` surface. Delegates to the membership domain's
   * `MembershipRoleEntitlementService` (`listSpaceMemberships` /
   * `upsertSpaceMembership`); the control routes enforce the role/last-owner
   * gate before calling, and the soft-remove path is a `suspended` upsert.
   */
  readonly members: {
    listMembers(spaceId: string): Promise<readonly SpaceMember[]>;
    upsertMember(input: {
      readonly spaceId: string;
      readonly accountId: string;
      readonly roles?: readonly SpaceMemberRole[];
      readonly status?: SpaceMemberStatus;
      readonly actor: {
        readonly actorAccountId: string;
        readonly roles: readonly string[];
        readonly requestId: string;
      };
    }): Promise<SpaceMember>;
  };
  readonly connections: ConnectionsService;
  /**
   * Dependencies domain service (Core Specification §14 / §15): the Space
   * Installation DAG edges over the same shared ledger.
   */
  readonly dependencies: DependenciesService;
  /**
   * Lists every Dependency edge in a Space (spec §14). Backs the account-plane
   * `/api/v1/spaces/:id/graph` projection; delegates to
   * `dependencies.listBySpace`.
   */
  listDependenciesBySpace(spaceId: string): Promise<readonly Dependency[]>;
  /**
   * OutputShares domain service (Core Specification §18): the cross-Space output
   * sharing grants over the same shared ledger.
   */
  readonly outputShares: OutputSharesService;
  /**
   * RunGroups domain service (Core Specification §19 / §24): space_update and
   * space_drift_check RunGroups over the same shared ledger + controller.
   */
  readonly runGroups: RunGroupsService;
  /**
   * Activity domain service (Core Specification §27 / §34): the Space-scoped
   * audit trail over the same shared ledger.
   */
  readonly activity: ActivityService;
  /** Space billing + credit ledger facade (Core Specification §28). */
  getSpaceBilling(spaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
      readonly balance?: CreditBalance;
    };
  }>;
  listSpaceUsage(spaceId: string): Promise<{
    readonly usageEvents: readonly UsageEvent[];
  }>;
  recordMeteredUsage(
    spaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }>;
  recordManagedResourceUsage(
    spaceId: string,
    input: RecordManagedResourceUsageInput,
  ): Promise<{ readonly usageEvents: readonly UsageEvent[] }>;
  reconcileInvoiceUsage(
    spaceId: string,
    input: ReconcileInvoiceUsageInput,
  ): Promise<InvoiceUsageReconciliation>;
  listSpaceCreditReservations(spaceId: string): Promise<{
    readonly creditReservations: readonly CreditReservation[];
  }>;
  topUpSpaceCredits(
    spaceId: string,
    input: { readonly credits: number },
  ): Promise<{ readonly balance: CreditBalance }>;
  changeSpaceSubscription(
    spaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
  reconcileStripeSpaceSubscription(
    spaceId: string,
    input: {
      readonly stripeCustomerId: string;
      readonly stripeSubscriptionId: string;
      readonly stripePriceId?: string;
      readonly planCode: string;
      readonly status: string;
      readonly currentPeriodEndUnix?: number;
    },
  ): Promise<unknown>;
  /**
   * Control-backups domain service (Core Specification §33 / §26): exports a
   * Space's control ledger as a sealed R2_BACKUPS bundle.
   */
  readonly backups: BackupsService;
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
  /**
   * Installation-driven drift check (spec §19 `drift_check`; Phase 8): a
   * read-only plan that detects state drift. Never parks waiting_approval and can
   * never be applied; emits `installation.drift_detected` on a non-empty summary.
   */
  createInstallationDriftCheck(
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
  /** Reads one Deployment ledger record by id (§30 `GET /internal/v1/deployments/:id`). */
  getDeployment(id: string): Promise<Deployment>;
  /**
   * Creates a rollback PLAN run for a Deployment (§30 `POST
   * /internal/v1/deployments/:id/rollback-plan`): re-plans the Deployment's Installation
   * pinned to that Deployment's source snapshot. Flows through the normal
   * approve/apply path.
   */
  createDeploymentRollbackPlan(deploymentId: string): Promise<PlanRunResponse>;
  /** Unified Run facade (§6.8): read / approve / cancel by run id. */
  getRun(id: string): Promise<Run>;
  /** Reads a Run's structured diagnostics + redacted audit trail (spec §30). */
  getRunLogs(id: string): Promise<RunLogsResponse>;
  /**
   * Reads a plan / destroy_plan Run's public, non-secret cost projection (the
   * billing reservation values the controller already computed at plan time, so
   * a dashboard can explain a credit shortfall before apply). Never computes
   * cost and never returns secret material.
   */
  getRunCost(id: string): Promise<RunCostInfo>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  /** Lists a Space's Connections (never includes secret values; spec §30). */
  listConnections(spaceId: string): Promise<ListConnectionsResponse>;
  /** Lists operator-scoped (instance-wide) Connections (spec §30). */
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  /** Reads a Connection projection by id (no secret values). */
  getConnection(connectionId: string): Promise<Connection>;
  /**
   * Registers a provider-credential Connection (§9). The dashboard control
   * surface only ever builds Space-scoped `provider_env_set` /
   * `cloudflare_api_token` requests here; `values` are write-only and the
   * response is the public projection (no secret values).
   */
  createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse>;
  /**
   * OPTIONAL Cloudflare credential OAuth helper, present only when the operator
   * wired the upstream OAuth client via env. Used by the dashboard
   * credential-helper flow; absent otherwise so the dashboard falls back to the
   * guided-token deep-link path.
   */
  readonly connectionOAuth?: {
    readonly cloudflare?: {
      start(input: {
        readonly subject: string;
        readonly spaceId: string;
        readonly displayName?: string;
        readonly successRedirectUri?: string;
      }): Promise<ConnectionOAuthStartResponse>;
      complete(input: {
        readonly code: string;
        readonly state: string;
        readonly query: Readonly<Record<string, string>>;
      }): Promise<{
        readonly request: CreateConnectionRequest;
        readonly subject?: string;
      }>;
    };
  };
  /**
   * Queue-consumer entry point. The Workers `queue()` consumer calls this for
   * each dispatched run message (plan/apply); it loads the run, applies the
   * idempotency guard, mints credentials, and drives the container dispatch.
   */
  dispatchQueuedRun(dispatch: {
    action: "plan" | "apply" | "source_sync";
    runId: string;
    spaceId: string;
  }): Promise<void>;
  // --- Sources (Core Specification §6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(spaceId: string): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: { readonly dedupe?: boolean },
  ): Promise<CreateSourceSyncResponse>;
  createSourceCompatibilityCheck(
    sourceId: string,
    request?: CreateSourceCompatibilityCheckRequest,
  ): Promise<CapsuleCompatibilityReportResponse>;
  listProviderTemplates(): Promise<ListProviderTemplatesResponse>;
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
  const runtimeConfig =
    options.runtimeConfig ??
    (await loadRuntimeConfigFromEnv({ env: runtimeEnv }));
  const role = options.role ?? processRoleFromRuntimeConfig(runtimeConfig);
  registerDefaultArtifactKinds();
  const context =
    options.context ??
    (await createAppContext({
      ...options,
      runtimeEnv,
      runtimeConfig,
      implementations: options.implementations ?? [],
    }));
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
  const sharedOpenTofuStore =
    opentofuStore.store ?? new InMemoryOpenTofuDeploymentStore();
  // Provider-credential Vault: an explicitly injected vault wins; otherwise, when
  // the host supplied at-rest secret crypto, build the default
  // StaticSecretConnectionVault over the SAME shared store the controller uses
  // (so a Connection registered through the vault is visible to binding
  // resolution + credential mint). Without either, the controller fails closed on
  // every provider-using run (this is what the shipped worker was previously
  // missing — provider plan/apply + private-git source_sync had no vault to mint).
  const opentofuConnectionVault =
    options.opentofuConnectionVault ??
    (options.secretCrypto
      ? new StaticSecretConnectionVault({
          store: sharedOpenTofuStore,
          crypto: options.secretCrypto,
        })
      : undefined);
  // Activity domain (Core Specification §27 / §34): the Space-scoped audit
  // trail. Constructed first so the controller + Installation / Dependency /
  // RunGroup services can emit through it (fire-and-forget; a failed audit write
  // never fails the action it records).
  const activityService = new ActivityService({ store: sharedOpenTofuStore });
  // Source domain service (Core Specification §6). The source REST API, webhook,
  // and scheduler all reach it through the controller. The source_sync producer
  // (when bound) enqueues onto the run queue with `action: "source_sync"`.
  const sourcesService = new SourcesService({
    store: sharedOpenTofuStore,
    ...(options.enqueueSourceSync
      ? { enqueueSourceSync: options.enqueueSourceSync }
      : {}),
    ...(options.opentofuRunner?.readCapsuleSourceFiles
      ? {
          readCapsuleSourceFiles: (snapshot) =>
            options.opentofuRunner!.readCapsuleSourceFiles!({
              runId: `compatibility_${snapshot.id}`,
              sourceSnapshot: snapshot,
            }),
        }
      : {}),
    normalizedArtifactStorage: context.adapters.objectStorage,
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
    activity: activityService,
  });
  const dependenciesService = new DependenciesService({
    store: sharedOpenTofuStore,
    activity: activityService,
  });
  // OutputShares domain (Core Specification §18): the cross-Space output sharing
  // grant. Validates against the producer's latest OutputSnapshot over the SAME
  // shared ledger; emits Space activity through the same recorder.
  const outputSharesService = new OutputSharesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
  });
  // Seed built-in shared InstallConfigs from the first-party module registry
  // (trustLevel "official"). Idempotent upsert keyed by the derived config id,
  // so a restart re-seeds the same rows. Fire-and-forget: a seed failure must
  // not block boot, and install read paths tolerate an empty seed set.
  void seedOfficialInstallConfigsOrWarn(sharedOpenTofuStore);
  const opentofuController = new OpenTofuDeploymentController({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.opentofuRunner ? { runner: options.opentofuRunner } : {}),
    ...(options.userEnvSetProviderRunner
      ? { userEnvSetProviderRunner: options.userEnvSetProviderRunner }
      : {}),
    ...(opentofuConnectionVault ? { vault: opentofuConnectionVault } : {}),
    ...(options.enqueueRun ? { enqueueRun: options.enqueueRun } : {}),
    sourcesService,
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.installationCoordination
      ? { installationCoordination: options.installationCoordination }
      : {}),
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
    ...(options.dependencyValueSealer
      ? { dependencyValueSealer: options.dependencyValueSealer }
      : {}),
    // Operator-economic guard (P2): a per-Space cumulative apply ceiling for runs
    // on the managed (operator-key) default while billing is not `enforce`. Set
    // by the hosted platform worker via env; absent on self-host (uncapped, since
    // a self-hoster applies on their own infrastructure/Connection).
    ...managedDefaultApplyCapFromEnv(runtimeEnv),
  });
  // RunGroups domain (Core Specification §19 / §24): space_update re-plans
  // stale Installations and space_drift_check groups read-only drift checks.
  // Status is computed from member runs at read time. Constructed after the
  // controller it drives.
  const runGroupsService = new RunGroupsService({
    store: sharedOpenTofuStore,
    controller: opentofuController,
    activity: activityService,
  });
  // Control-backups domain (Core Specification §33 / §26 R2_BACKUPS): exports a
  // Space's control ledger as a sealed bundle. The seal + object-storage seam is
  // host-injected (`backupArtifactStore`); when absent the service is disabled
  // and the routes report not_implemented.
  const backupsService = new BackupsService({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.backupArtifactStore
      ? { artifactStore: options.backupArtifactStore }
      : {}),
    ...(options.backupStateObjectReader
      ? { stateObjectReader: options.backupStateObjectReader }
      : {}),
    ...(options.serviceDataBackupRunner
      ? { serviceDataRunner: options.serviceDataBackupRunner }
      : {}),
  });
  const connectionOAuthHelpers =
    createConnectionOAuthHelpersFromEnv(runtimeEnv);
  const app = await createApiApp({
    role,
    context,
    registerRuntimeAgentRoutes: role === "takosumi-runtime-agent",
    registerReadinessRoutes: true,
    registerOpenApiRoute: role === "takosumi-api",
    registerArtifactRoutes:
      role === "takosumi-api" &&
      Boolean(deployToken) &&
      Boolean(context.adapters?.objectStorage),
    registerMetricsRoutes:
      role === "takosumi-api" && Boolean(metricsScrapeToken),
    metricsRouteOptions: metricsScrapeToken
      ? {
          observability: context.adapters.observability,
          getScrapeToken: () => metricsScrapeToken,
        }
      : undefined,
    artifactRouteOptions:
      deployToken && context.adapters?.objectStorage
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
      ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
      ...(options.mountInternalLedgerRoutes === true
        ? { mountInternalLedgerRoutes: true }
        : {}),
      spacesService,
      installationsService,
      connectionsService,
      dependenciesService,
      outputSharesService,
      runGroupsService,
      activityService,
      backupsService,
      ...(options.writeSourceArchive
        ? { writeSourceArchive: options.writeSourceArchive }
        : {}),
      ...(deployControlToken
        ? { getDeployControlToken: () => deployControlToken }
        : {}),
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
        ? createConsoleApiRequestLogger(
            parseApiLogLevel(runtimeEnv.TAKOSUMI_LOG_LEVEL),
          )
        : undefined,
      minLevel: parseApiLogLevel(runtimeEnv.TAKOSUMI_LOG_LEVEL),
      traceSink: context.adapters.observability,
    },
  });
  // Typed in-process operate facade. Delegates to the wired OpenTofu
  // controller; does not duplicate controller logic.
  //
  // The membership domain keeps its OWN `MembershipSpace` store and membership
  // ledger, distinct from the Core-Spec `Space` (owner namespace) owned by
  // `spacesService`. A Core-Spec Space is created with NO bridge into the
  // membership domain, so `upsertSpaceMembership`'s two preconditions
  // (`requireMembershipSpace` + `canManageSpace`) can never be satisfied for a
  // fresh Space. `createMembershipControlFacade` self-bootstraps the membership
  // domain (idempotently, for the NAMESPACE owner resolved server-side) before
  // each mutation so the real domain path matches what the route layer assumes.
  const members = createMembershipControlFacade({
    membership: context.services.space,
    membershipSpaceStore: context.stores.space.spaces,
    membershipLedgerStore: context.stores.space.memberships,
    resolveSpace: async (spaceId) => {
      const space = await spacesService.getSpace(spaceId);
      return {
        ownerUserId: space.ownerUserId,
        displayName: space.displayName,
        handle: space.handle,
      };
    },
  });
  const operations: TakosumiOperations = {
    controller: opentofuController,
    spaces: spacesService,
    installations: installationsService,
    members,
    connections: connectionsService,
    dependencies: dependenciesService,
    listDependenciesBySpace: (spaceId) =>
      dependenciesService.listBySpace(spaceId),
    outputShares: outputSharesService,
    runGroups: runGroupsService,
    activity: activityService,
    getSpaceBilling: (spaceId) => opentofuController.getSpaceBilling(spaceId),
    listSpaceUsage: (spaceId) => opentofuController.listSpaceUsage(spaceId),
    recordMeteredUsage: (spaceId, input) =>
      opentofuController.recordMeteredUsage(spaceId, input),
    recordManagedResourceUsage: (spaceId, input) =>
      opentofuController.recordManagedResourceUsage(spaceId, input),
    reconcileInvoiceUsage: (spaceId, input) =>
      opentofuController.reconcileInvoiceUsage(spaceId, input),
    listSpaceCreditReservations: (spaceId) =>
      opentofuController.listSpaceCreditReservations(spaceId),
    topUpSpaceCredits: (spaceId, input) =>
      opentofuController.topUpSpaceCredits(spaceId, input),
    changeSpaceSubscription: (spaceId, input) =>
      opentofuController.changeSpaceSubscription(spaceId, input),
    reconcileStripeSpaceSubscription: (spaceId, input) =>
      opentofuController.reconcileStripeSpaceSubscription(spaceId, input),
    backups: backupsService,
    listRunnerProfiles: () => opentofuController.listRunnerProfiles(),
    createPlanRun: (request) => opentofuController.createPlanRun(request),
    createInstallationPlan: (installationId) =>
      opentofuController.createInstallationPlan(installationId),
    createInstallationDestroyPlan: (installationId) =>
      opentofuController.createInstallationDestroyPlan(installationId),
    createInstallationDriftCheck: (installationId) =>
      opentofuController.createInstallationDriftCheck(installationId),
    getPlanRun: (id) => opentofuController.getPlanRun(id),
    createApplyRun: (request) => opentofuController.createApplyRun(request),
    getApplyRun: (id) => opentofuController.getApplyRun(id),
    getInstallation: (id) => opentofuController.getInstallation(id),
    listDeployments: (installationId) =>
      opentofuController.listDeployments(installationId),
    listDeploymentOutputs: (installationId) =>
      opentofuController.listDeploymentOutputs(installationId),
    getDeployment: (id) => opentofuController.getDeployment(id),
    createDeploymentRollbackPlan: (deploymentId) =>
      opentofuController.createDeploymentRollbackPlan(deploymentId),
    getRun: (id) => opentofuController.getRun(id),
    getRunLogs: (id) => opentofuController.getRunLogs(id),
    getRunCost: (id) => opentofuController.getRunCost(id),
    approveRun: (id, input) => opentofuController.approveRun(id, input ?? {}),
    cancelRun: (id) => opentofuController.cancelRun(id),
    listConnections: (spaceId) => opentofuController.listConnections(spaceId),
    listOperatorConnections: () => opentofuController.listOperatorConnections(),
    getConnection: (connectionId) =>
      opentofuController.getConnection(connectionId),
    createConnection: (request) =>
      opentofuController.createConnection(request),
    // Only present when the operator wired the upstream Cloudflare OAuth client.
    // The control-routes layer enforces session auth + Space ownership BEFORE
    // calling these, so the principal passed to the helper is a thin in-process
    // actor (the helper itself does not re-authorize; it only signs/verifies
    // the OAuth state and exchanges the code).
    ...(connectionOAuthHelpers?.cloudflare
      ? {
          connectionOAuth: {
            cloudflare: {
              start: (input) =>
                connectionOAuthHelpers.cloudflare!.start({
                  provider: "cloudflare",
                  request: new Request("https://connection-oauth.internal/start"),
                  principal: { actor: "dashboard-session" },
                  body: {
                    spaceId: input.spaceId,
                    // Sign the authenticated subject INTO the OAuth state so the
                    // cross-site callback can authorize without a session cookie.
                    subject: input.subject,
                    ...(input.displayName
                      ? { displayName: input.displayName }
                      : {}),
                    ...(input.successRedirectUri
                      ? { successRedirectUri: input.successRedirectUri }
                      : {}),
                  },
                }),
              complete: (input) =>
                connectionOAuthHelpers.cloudflare!.complete({
                  provider: "cloudflare",
                  request: new Request(
                    "https://connection-oauth.internal/callback",
                  ),
                  principal: { actor: "dashboard-session" },
                  code: input.code,
                  state: input.state,
                  query: input.query,
                }),
            },
          },
        }
      : {}),
    dispatchQueuedRun: (dispatch) =>
      opentofuController.dispatchQueuedRun(dispatch),
    createSource: (request) => opentofuController.createSource(request),
    listSources: (spaceId) => opentofuController.listSources(spaceId),
    getSource: (id) => opentofuController.getSource(id),
    patchSource: (id, patch) => opentofuController.patchSource(id, patch),
    createSourceSync: (sourceId, opts) =>
      opentofuController.createSourceSync(sourceId, opts ?? {}),
    createSourceCompatibilityCheck: (sourceId, request) =>
      opentofuController.createSourceCompatibilityCheck(sourceId, request),
    listProviderTemplates: () => opentofuController.listProviderTemplates(),
    listSourceSnapshots: (sourceId) =>
      opentofuController.listSourceSnapshots(sourceId),
    getSourceSyncRun: (id) => opentofuController.getSourceSyncRun(id),
    verifySourceHookSecret: (sourceId, presentedSecret) =>
      opentofuController.verifySourceHookSecret(sourceId, presentedSecret),
  };
  return { app, context, role, workerDaemon, operations };
}

/**
 * Seeds built-in shared InstallConfigs into the shared ledger. The config id is
 * derived from the template id so the upsert is idempotent across restarts.
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

function managedDefaultApplyCapFromEnv(
  env: Record<string, string | undefined>,
): { managedDefaultApplyCap: number } | Record<string, never> {
  const raw = env.TAKOSUMI_MANAGED_APPLY_CAP?.trim();
  if (!raw) return {};
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return {};
  return { managedDefaultApplyCap: Math.floor(parsed) };
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
