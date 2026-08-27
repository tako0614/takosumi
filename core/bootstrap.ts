import type { Hono as HonoApp } from "hono";
import { createApiApp } from "./api/mod.ts";
import type {
  ConnectionOAuthHelpers,
  DeployControlBearerAuthorizationInput,
  DeployControlPrincipal,
} from "./api/deploy_control_shared.ts";
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
  WorkspaceMember,
  WorkspaceMemberStatus,
  WorkspaceRole,
} from "takosumi-contract/workspaces";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import {
  isTakosumiProcessRole,
  type TakosumiProcessRole,
} from "./process/mod.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
import type { ArtifactReferenceAllocator } from "./adapters/storage/artifact-references.ts";
import { currentRuntime } from "./shared/runtime/index.ts";
import { createRoleReadinessProbes } from "./bootstrap/readiness.ts";
import {
  type DependencyValueSealer,
  type EnqueueRun,
  OpenTofuControllerError,
  OpenTofuController,
  type DeployControlActorContext,
  type OpenTofuRunner,
  type OpenTofuRunnerExecutorRegistry,
  type ReleaseActivator,
  type RecordMeteredUsageInput,
} from "./domains/deploy-control/mod.ts";
import type {
  BillingEnforcement,
  BillingExtensionFactory,
  QuotaPolicy,
  ShowbackRater,
} from "takosumi-contract/billing";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type {
  CapsuleCurrentResourceInventoryResponse,
} from "takosumi-contract/current-resource-inventory";
import {
  CapsuleLeaseBusyError,
  InMemoryCapsuleCoordination,
  withCapsuleLease,
  type CapsuleCoordination,
} from "./domains/deploy-control/capsule_lease.ts";
import {
  type EnqueueSourceSync,
  SourcesService,
} from "./domains/sources/mod.ts";
import {
  CAPSULE_LIFECYCLE_BUSY_REASON,
  CapsulesService,
} from "./domains/capsules/mod.ts";
import { WorkspacesService } from "./domains/workspaces/mod.ts";
import { ProjectsService } from "./domains/projects/mod.ts";
import { ConnectionsService } from "./domains/connections/mod.ts";
import { DependenciesService } from "./domains/dependencies/mod.ts";
import { OutputSharesService } from "./domains/output-shares/mod.ts";
import type { SensitiveOutputResolver } from "./domains/output-shares/mod.ts";
import type { ConnectionVault } from "./adapters/vault/mod.ts";
import { StaticSecretConnectionVault } from "./adapters/vault/mod.ts";
import {
  resolveTargetConnection,
} from "./adapters/vault/run_issued_operator_reconciliation.ts";
import type { FixedOperatorProviderConnectionDeclaration } from "takosumi-contract/credential-recipe-host";
import type { SecretBoundaryCrypto } from "./adapters/secret-store/memory.ts";
import { RunGroupsService } from "./domains/run-groups/mod.ts";
import { ActivityService } from "./domains/activity/mod.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  LegacyOutputInterfaceMigrationService,
  OutputBackedInterfaceInputResolver,
  type InterfaceBindingDeliveryHandlerRegistry,
  type InterfaceCredentialIssuer,
  type InterfaceOAuth2ResourceAuthorizer,
  type InterfaceStores,
} from "./domains/interfaces/mod.ts";
import { createSqlInterfaceStores } from "./domains/interfaces/sql_stores.ts";
import {
  type BackupArtifactStore,
  type BackupObjectReader,
  BackupsService,
  type ServiceDataBackupRunner,
} from "./domains/backups/mod.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleInstallConfig,
} from "./domains/capsules/default_install_config.ts";
import { withHostInstallConfigs } from "./domains/capsules/host_install_config_store.ts";
import {
  InMemoryGitInstallPlanStore,
  type GitInstallPlanStore,
} from "./domains/install-plans/store.ts";
import { SqlGitInstallPlanStore } from "./domains/install-plans/sql_store.ts";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncRequest,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSyncRun,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
  CapsuleAdoptedSourceRevision,
  CapsuleCompatibilityReportResponse,
  CreateSourceCompatibilityCheckRequest,
} from "takosumi-contract/capsules";
import type { CreateRestoreRequest } from "takosumi-contract/backups";
import type {
  ApplyRunResponse,
  ProviderConnection,
  ConnectionOAuthStartResponse,
  ConnectionResponse,
  CreateApplyRunRequest,
  CreateConnectionRequest,
  ConnectionSetupRequest,
  CreatePlanRunRequest,
  StateVersion,
  GetStateVersionResponse,
  GetCapsuleResponse,
  ListConnectionsResponse,
  ListStateVersionsResponse,
  ListRunnerProfilesResponse,
  PlanRunResponse,
  RunnerProfile,
  TestConnectionResponse,
} from "@takosumi/internal/deploy-control-api";
import type {
  RunCostInfo,
  RunEventsResponse,
  RunLogsResponse,
} from "takosumi-contract/runs";
import type { Output } from "takosumi-contract/outputs";
import type { PageParams } from "takosumi-contract/pagination";
import type {
  TakosumiAdapterCapabilities,
  TakosumiOperatorCapabilities,
  TakosumiResourceCapabilities,
} from "takosumi-contract/capabilities";
import {
  createCapsuleExecutionAuthorityResolver,
  InMemoryOpenTofuControlStore,
  type CapsuleExecutionAuthorityResolver,
  type OpenTofuControlStore,
} from "./domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "./domains/deploy-control/store_sql.ts";
import type { CapsuleModuleVariableMaterializer } from "./domains/deploy-control/module_variable_materializer.ts";
import {
  createRuntimeSecretFileMaterializer,
  type RuntimeSecretFileMaterializer,
} from "./domains/deploy-control/runtime_secret_file_materializer.ts";
import { log } from "./shared/log.ts";
import type { Run } from "takosumi-contract/runs";
import type { Dependency } from "takosumi-contract/dependencies";
import type {
  BillingSettings,
  CapsuleUsageSummary,
  UsageEvent,
} from "takosumi-contract/billing";
import type {
  CredentialRecipe,
  ListCredentialRecipesResponse,
} from "takosumi-contract/credential-recipes";
import type {
  ActorContext,
  InterfaceProjectionSink,
} from "takosumi-contract";
import type {
  CredentialRecipeDriverRegistry,
  CredentialRecipeRunCredentialIssuer,
  SourceCredentialDriverRegistry,
} from "./adapters/vault/driver_ports.ts";

interface ResolvedOpenTofuStore {
  readonly store?: OpenTofuControlStore;
  readonly durable: boolean;
}

function resolveOpenTofuStore(input: {
  readonly opentofuControlStore?: OpenTofuControlStore;
  readonly sqlClient?: SqlClient;
}): ResolvedOpenTofuStore {
  const store =
    input.opentofuControlStore ??
    (input.sqlClient
      ? new SqlOpenTofuControlStore({ client: input.sqlClient })
      : undefined);
  return {
    ...(store ? { store } : {}),
    durable: store?.persistence === "durable",
  };
}

/**
 * Durability gate for the public OpenTofu Run/StateVersion/Output ledger. The public API is
 * the canonical plan/apply/destroy entry point, so an in-memory ledger on a
 * production/staging deployment silently loses every run, Capsule, and
 * StateVersion and Output records on restart or isolate recycle.
 *
 * Mirrors the existing fail-closed conventions
 * (`assertNoStrictRuntimeAdapterFallbacks`, the synthetic-provider hard-fail):
 * when the OpenTofu routes are exposed (`deployControlToken` present) AND the
 * environment is production/staging AND no durable store is injected, this
 * throws so the process refuses to boot a data-losing deploy API. It is
 * gated on `deployControlToken` so hosts that never expose the Deploy Control API are
 * unaffected. Local dev mode never overrides this production/staging gate.
 */
function assertDurableDeployControlStoreOrWarn(input: {
  readonly environment?: string;
  readonly deployControlAuthPresent: boolean;
  readonly durable: boolean;
}): void {
  if (input.durable) return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (!input.deployControlAuthPresent) {
    // Routes are not exposed; an in-memory ledger cannot lose anything the
    // operator is serving. Stay quiet.
    return;
  }
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the OpenTofu deploy API but no ` +
        `durable run ledger is configured; PlanRun/ApplyRun records and ` +
        `Capsule/StateVersion/Output records would be lost on restart or isolate ` +
        `recycle. Inject a durable opentofuControlStore (or a sqlClient).`,
    );
  }
  // Non-strict: warn loudly so a developer who is unknowingly running an
  // ephemeral ledger notices.
  log.warn("service.deployControl.in_memory_ledger", {
    environment: input.environment ?? "unknown",
    hint:
      "OpenTofu Run, Capsule, StateVersion, and Output records will NOT " +
      "persist across restart or isolate recycle. Inject " +
      "opentofuControlStore (or a sqlClient) for production/staging.",
  });
}

function assertInterfaceApiAuthOrWarn(input: {
  readonly environment?: string;
  readonly exposed: boolean;
  readonly bearerTokenPresent: boolean;
  readonly scopedAuthorizerPresent: boolean;
}): void {
  if (
    !input.exposed ||
    input.bearerTokenPresent ||
    input.scopedAuthorizerPresent
  )
    return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Interface API but no ` +
        `TAKOSUMI_DEPLOY_CONTROL_TOKEN or scoped Interface authorizer is ` +
        `configured; /api/v1/interfaces would be unauthenticated.`,
    );
  }
  log.warn("service.interface.unauthenticated_routes", {
    environment: input.environment ?? "unknown",
    hint:
      "Interface API routes are exposed without authentication. Set " +
      "TAKOSUMI_DEPLOY_CONTROL_TOKEN or inject authorizeInterfaceBearer " +
      "before exposing this host.",
  });
}

function assertDurableInterfaceStoresOrWarn(input: {
  readonly environment?: string;
  readonly exposed: boolean;
  readonly durable: boolean;
}): void {
  if (!input.exposed || input.durable) return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Interface API but no durable ` +
        `Interface/InterfaceBinding store is configured; runtime declarations ` +
        `would be lost on restart. Inject durable interfaceStores (or a sqlClient).`,
    );
  }
  log.warn("service.interface.in_memory_store", {
    environment: input.environment ?? "unknown",
    hint:
      "Interface and InterfaceBinding records will not persist across restart. " +
      "Inject interfaceStores (or a sqlClient) for production/staging.",
  });
}

function assertDurableGitInstallPlanStoreOrWarn(input: {
  readonly environment?: string;
  readonly durable: boolean;
}): void {
  if (input.durable) return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Git install-plan coordinator ` +
        `but no durable GitInstallPlan store is configured; idempotency and ` +
        `reconciliation evidence would be lost on restart. Inject a durable ` +
        `gitInstallPlanStore (or a sqlClient).`,
    );
  }
  log.warn("service.git_install_plan.in_memory_store", {
    environment: input.environment ?? "unknown",
    hint:
      "Git install-plan idempotency and reconciliation records will not " +
      "persist across restart. Inject a durable gitInstallPlanStore (or a " +
      "sqlClient) for production/staging.",
  });
}

export interface CreateTakosumiServiceOptions extends AppContextOptions {
  readonly role?: TakosumiProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly context?: AppContext;
  /**
   * Host/provider extension dispatcher for opaque ProviderConnection setup ids.
   * Omitted means no guided setup helpers are installed.
   */
  readonly buildConnectionSetupRequest?: (
    setupId: string,
    input: ConnectionSetupRequest,
  ) => CreateConnectionRequest;
  /**
   * Complete host-contributed OAuth helper registry keyed by opaque helper id.
   * Omitted means no OAuth helpers are installed.
   */
  readonly connectionOAuthHelpers?: ConnectionOAuthHelpers;
  /**
   * Complete service-installed Credential Recipe catalog. Omitted means no
   * recipes are installed. Reference recipes are an explicit host-composition
   * choice and arbitrary provider recipes require no Core contract change.
   */
  readonly credentialRecipes?: readonly CredentialRecipe[];
  /**
   * Complete host-contributed Workspace-neutral InstallConfig set. Core owns
   * only the generic Capsule default and never embeds app identities, Git
   * addresses, artifact values, or secrets.
   */
  readonly operatorInstallConfigs?: readonly InstallConfig[];
  /**
   * Complete host-installed runtime driver registry keyed by
   * `recipeId/authMode`. Omitted means no provider recipe drivers are installed.
   */
  readonly credentialRecipeDrivers?: CredentialRecipeDriverRegistry;
  /** Host-declared fixed-id, credentialless operator Provider Connections. */
  readonly operatorProviderConnections?: readonly FixedOperatorProviderConnectionDeclaration[];
  /**
   * Host-owned generic Run-credential signer. Core/Vault binds canonical
   * identity claims and recipe-owned audience/scopes; recipe drivers may
   * request only a bounded TTL and never receive this signer or its secret.
   */
  readonly runCredentialIssuer?: CredentialRecipeRunCredentialIssuer;
  /**
   * Complete host-installed Source credential driver registry. Core has no
   * implicit transport-specific credential implementation.
   */
  readonly sourceCredentialDrivers?: SourceCredentialDriverRegistry;
  /** Optional SQL client used by the durable OpenTofu and Resource APIs. */
  readonly sqlClient?: SqlClient;
  /**
   * Host-selected durable Git install-plan ledger. Postgres compositions derive
   * one from sqlClient; D1 hosts inject their raw-SQL realization explicitly.
   */
  readonly gitInstallPlanStore?: GitInstallPlanStore;
  /**
   * Pre-built durable store for the public OpenTofu run ledger. When omitted,
   * a configured `sqlClient` backs it with SQL; when neither is present the
   * controller falls back to an in-memory dev/test store (gated for
   * production/staging when the public deploy API is exposed).
   */
  readonly opentofuControlStore?: OpenTofuControlStore;
  /** Private host implementation for deterministic non-secret module values. */
  readonly moduleVariableMaterializer?: CapsuleModuleVariableMaterializer;
  /**
   * Optional private override for Capsule-stable runtime secret files. Hosts
   * that supply secretCrypto receive the generic sealed implementation.
   */
  readonly runtimeSecretFileMaterializer?: RuntimeSecretFileMaterializer;
  /**
   * Host-owned allocator for opaque source/state/output/backup artifact refs.
   * Required by execution and backup paths; Core never derives storage layouts.
   */
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  /** Durable Takosumi-managed runtime Interface declarations and bindings. */
  readonly interfaceStores?: InterfaceStores;
  /** Recoverable host materialization of canonical Interface/Binding state. */
  readonly interfaceProjectionSink?: InterfaceProjectionSink;
  /**
   * Host-owned issuer for invocation-time Principal OAuth credentials. Core
   * authorizes the exact InterfaceBinding and never persists the returned raw
   * token. When omitted, oauth2 delivery remains NotReady.
   */
  readonly interfaceCredentialIssuer?: InterfaceCredentialIssuer;
  /** Host-installed open InterfaceBinding delivery handlers by delivery type. */
  readonly interfaceBindingDeliveryHandlers?: InterfaceBindingDeliveryHandlerRegistry;
  /** Host verifier for operator/customer bearers on the Deploy Control API. */
  readonly authorizeDeployControlBearer?: (
    input: DeployControlBearerAuthorizationInput,
  ) =>
    | DeployControlPrincipal
    | undefined
    | Promise<DeployControlPrincipal | undefined>;
  /**
   * Optional host proof for custom/external OAuth resources. The default Core
   * proof accepts only an active public-host reservation owned by the same
   * Capsule and Workspace.
   */
  readonly interfaceOAuth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  /** Host verifier for external user/runtime bearers on the Interface API. */
  readonly authorizeInterfaceBearer?: (input: {
    readonly token: string;
    readonly request: Request;
  }) => ActorContext | undefined | Promise<ActorContext | undefined>;
  /**
   * Host-specific current Workspace membership check for account sessions or
   * PATs that are not intrinsically Workspace-bound.
   */
  readonly authorizeInterfaceWorkspace?: (input: {
    readonly actor: ActorContext;
    readonly workspaceId: string;
    readonly request: Request;
  }) => boolean | Promise<boolean>;
  readonly adapterCapabilities?: Partial<TakosumiAdapterCapabilities>;
  readonly operatorCapabilities?: Partial<TakosumiOperatorCapabilities>;
  /**
   * OpenTofu executor explicitly bound to the reference
   * `opentofu.default` executor id. The reference Cloudflare distribution
   * injects a Container runner; when omitted, no implicit executor is chosen.
   */
  readonly opentofuRunner?: OpenTofuRunner;
  /**
   * Additional operator-defined executor-id bindings. RunnerProfile.executorId
   * selects only through this registry; provider names and labels are never
   * execution authority.
   */
  readonly opentofuRunnerExecutors?: OpenTofuRunnerExecutorRegistry;
  /**
   * ProviderConnection Vault used to mint run-scoped provider credentials for
   * plan/apply/destroy. Hosts that execute provider-using runs must inject this;
   * the controller fails closed without it.
   */
  readonly opentofuConnectionVault?: ConnectionVault;
  /**
   * Internal extension seam for deployments that deliberately allow
   * Workspace Provider Bindings to reference operator-scoped Provider Connections.
   * OSS/self-host defaults to false and the stock worker does not expose an env
   * switch for this.
   */
  readonly allowOperatorScopedProviderConnections?: boolean;
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
   * Asynchronous run dispatch seam. The GA Workers adapter schedules the
   * per-run Durable Object directly; when omitted the controller defaults to an
   * inline dispatcher (preserving create-executes-run for local / node
   * substrates and tests).
   */
  readonly enqueueRun?: EnqueueRun;
  /**
   * Out-of-process source-sync dispatch seam (Core Specification §6). The
   * GA Workers adapter schedules the per-run Durable Object with
   * `action: "source_sync"`; when omitted Core claims and terminally fails the
   * Run with `runner_capability_missing` instead of leaving unowned queued work.
   */
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  /**
   * Capsule lease seam (Core Specification §10.2). The Workers adapter
   * injects a DO-backed implementation fronting the `COORDINATION`
   * CoordinationObject so only ONE write run per (Capsule, environment)
   * runs at a time across isolates. When omitted, bootstrap creates one
   * in-memory coordinator shared by every lifecycle path in this service
   * instance; multi-replica hosts must inject a durable shared implementation.
   */
  readonly capsuleCoordination?: CapsuleCoordination;
  /**
   * Control-backup seal + artifact-storage seam. The host injects an
   * implementation backed by its storage and at-rest crypto; when omitted the backup routes report
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
   * sensitive cross-Workspace published_output injection; when omitted the service
   * fails closed for sensitive grants.
   */
  readonly sensitiveOutputResolver?: SensitiveOutputResolver;
  /**
   * Host-injected at-rest sealer for the sensitive pinned values of a
   * DependencySnapshot entry (spec §11 / §18). Required whenever a sensitive
   * cross-Workspace published_output is injected: the controller seals the resolved
   * secret instead of persisting it as a cleartext ledger value, and unseals it
   * at apply. Omitted ⇒ a sensitive published_output edge fails closed.
   */
  readonly dependencyValueSealer?: DependencyValueSealer;
  /**
   * Optional host/operator executor for Plan-pinned service-side lifecycle
   * actions. Declared post-apply/pre-destroy phases fail closed unless this seam
   * returns terminal `succeeded`; a missing executor is never deferred work.
   */
  readonly releaseActivator?: ReleaseActivator;
  /** Explicit host showback price policy; omitted leaves measurements unrated. */
  readonly showbackRater?: ShowbackRater;
  /**
   * Seam B composition port (OSS/Cloud boundary). When omitted, OSS uses the
   * showback no-op ({@link NOOP_BILLING_ENFORCEMENT}): cost is estimated and
   * recorded but apply is NEVER blocked and no payment provider is contacted.
   * A commercial host may inject a closed implementation to gate apply on
   * payment / USD balance.
   */
  readonly billingEnforcement?: BillingEnforcement;
  /**
   * Seam B composition port for plan quota / per-run limits. When omitted, OSS
   * uses {@link NOOP_QUOTA_POLICY} (no plan limits). Cloud injects subscription
   * plan-limit + resource-quota enforcement.
   */
  readonly quotaPolicy?: QuotaPolicy;
  /**
   * Host composition factory for commercial billing. The host closes over its
   * own commercial ledger and returns only the narrow decision ports. Direct
   * ports above remain available for focused tests and custom embeddings.
   */
  readonly billingExtensionFactory?: BillingExtensionFactory;
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
 * instance backing the internal route seam. It does not duplicate controller
 * logic.
 */
export interface TakosumiOperations {
  /** The wired OpenTofu deployment controller. */
  readonly controller: OpenTofuController;
  /** Durable actor/idempotency-scoped Git install coordinator records. */
  readonly gitInstallPlans: GitInstallPlanStore;
  /** Workspace identity + handle uniqueness over the shared ledger. */
  readonly workspaces: WorkspacesService;
  /** Canonical Workspace-owned Project ledger. */
  readonly projects: ProjectsService;
  /** Capsule and service-side InstallConfig ledger over the shared store. */
  readonly capsules: CapsulesService;
  /**
   * Private provider-neutral authority for hosted Capsule execution. Hosts map
   * their tenant/space vocabulary to the exact Workspace/Capsule pair.
   */
  readonly capsuleExecutionAuthority: CapsuleExecutionAuthorityResolver;
  /**
   * Canonical WorkspaceMember ledger backing the account-plane member surface.
   * It is persisted by the same store as Workspace/Project/Capsule; there is no
   * membership-domain projection or isolate-local shadow roster.
   */
  readonly members: {
    getMember(
      workspaceId: string,
      accountId: string,
    ): Promise<WorkspaceMember | undefined>;
    listMembers(workspaceId: string): Promise<readonly WorkspaceMember[]>;
    upsertMember(input: {
      readonly workspaceId: string;
      readonly accountId: string;
      readonly roles?: readonly WorkspaceRole[];
      readonly status?: WorkspaceMemberStatus;
      readonly actor: {
        readonly actorAccountId: string;
        readonly roles: readonly string[];
        readonly requestId: string;
      };
    }): Promise<WorkspaceMember>;
  };
  readonly connections: ConnectionsService;
  /**
   * Dependencies domain service (Core Specification §14 / §15): the Workspace
   * Capsule DAG edges over the same shared ledger.
   */
  readonly dependencies: DependenciesService;
  /**
   * Lists every Dependency edge in a Workspace (spec §14). Backs the account-plane
   * `/api/v1/workspaces/:id/graph` projection; delegates to
   * `dependencies.listBySpace`.
   */
  listDependenciesByWorkspace(
    workspaceId: string,
  ): Promise<readonly Dependency[]>;
  /**
   * OutputShares domain service (Core Specification §18): the cross-Workspace output
   * sharing grants over the same shared ledger.
   */
  readonly outputShares: OutputSharesService;
  /**
   * RunGroups domain service (Core Specification §19 / §24): workspace_update and
   * workspace_drift_check RunGroups over the same shared ledger + controller.
   */
  readonly runGroups: RunGroupsService;
  /** Runtime declarations shared by Capsule and OpenTofu authoring flows. */
  readonly interfaces: InterfaceService;
  /**
   * Activity domain service (Core Specification §27 / §34): the Workspace-scoped
   * audit trail over the same shared ledger.
   */
  readonly activity: ActivityService;
  /** Provider-neutral disabled/showback settings. */
  getWorkspaceBilling(workspaceId: string): Promise<{
    readonly billing: {
      readonly settings: BillingSettings;
    };
  }>;
  listWorkspaceUsage(
    workspaceId: string,
    params?: PageParams,
  ): Promise<{
    readonly usageEvents: readonly UsageEvent[];
    readonly nextCursor?: string;
  }>;
  getCapsuleUsageSummary(capsuleId: string): Promise<CapsuleUsageSummary>;
  recordMeteredUsage(
    workspaceId: string,
    input: RecordMeteredUsageInput,
  ): Promise<{ readonly usageEvent: UsageEvent }>;
  updateWorkspaceBillingSettings(
    workspaceId: string,
    input: { readonly billingSettings: BillingSettings },
  ): Promise<{ readonly billing: { readonly settings: BillingSettings } }>;
  /**
   * Control-backups domain service: exports a Workspace's control ledger as a
   * sealed bundle referenced through the host artifact store.
   */
  readonly backups: BackupsService;
  getSourceSnapshot(id: string): Promise<SourceSnapshot>;
  readSourceSnapshotFiles(
    id: string,
    options?: { readonly modulePath?: string },
  ): Promise<readonly { readonly path: string; readonly text: string }[]>;
  resolveStableSourceTag(url: string): Promise<{
    readonly tag: string;
    readonly commit: string;
  }>;
  listRunnerProfiles(): Promise<ListRunnerProfilesResponse>;
  createPlanRun(request: CreatePlanRunRequest): Promise<PlanRunResponse>;
  /**
   * Canonical Capsule-driven plan: resolves the Capsule's
   * service-side config to Source, picks the latest SourceSnapshot, and
   * dispatches with Capsule state scope.
   */
  createCapsulePlan(
    capsuleId: string,
    options?: {
      readonly compatibilityReportId?: string;
      readonly runnerProfileId?: string;
      readonly sourceSnapshotId?: string;
      readonly planRunId?: string;
      readonly actor?: string;
    },
  ): Promise<PlanRunResponse>;
  /** Capsule-driven destroy-plan: always lands waiting_approval (spec §23). */
  createCapsuleDestroyPlan(
    capsuleId: string,
    options?: {
      readonly runnerProfileId?: string;
      readonly actor?: string;
    },
  ): Promise<PlanRunResponse>;
  /**
   * Capsule-driven drift check (spec §19 `drift_check`; Phase 8): a
   * read-only plan that detects state drift. Never parks waiting_approval and can
   * never be applied; emits `capsule.drift_detected` on a non-empty summary.
   */
  createCapsuleDriftCheck(capsuleId: string): Promise<PlanRunResponse>;
  getPlanRun(id: string): Promise<PlanRunResponse>;
  createApplyRun(request: CreateApplyRunRequest): Promise<ApplyRunResponse>;
  getApplyRun(id: string): Promise<ApplyRunResponse>;
  getCapsule(id: string): Promise<GetCapsuleResponse>;
  getCapsuleAdoptedSourceRevision(
    capsuleId: string,
  ): Promise<CapsuleAdoptedSourceRevision | undefined>;
  listStateVersions(
    capsuleId: string,
    params?: PageParams,
  ): Promise<ListStateVersionsResponse>;
  listStateVersionsByIds(
    ids: readonly string[],
  ): Promise<readonly StateVersion[]>;
  listStateVersionsByWorkspace(
    workspaceId: string,
  ): Promise<readonly StateVersion[]>;
  getStateVersion(id: string): Promise<GetStateVersionResponse>;
  /** OSS-owned value-free inventory for the current Capsule apply lineage. */
  getCurrentResourceInventory(
    capsuleId: string,
  ): Promise<CapsuleCurrentResourceInventoryResponse>;
  /** Internal Output lookup used only after a caller authorizes its Capsule. */
  getOutput(id: string): Promise<Output | undefined>;
  /** Creates a rollback PLAN run from a StateVersion's Run provenance. */
  createStateVersionRollbackPlan(
    stateVersionId: string,
  ): Promise<PlanRunResponse>;
  /** Unified Run facade (§6.8): read / approve / cancel by run id. */
  getRun(id: string): Promise<Run>;
  /** Lists a Workspace's unified Runs newest first (spec §19 / §30). */
  listRuns(
    workspaceId: string,
    options?: { readonly limit?: number },
  ): Promise<readonly Run[]>;
  /** Reads a Run's structured diagnostics + redacted audit trail (spec §30). */
  getRunLogs(id: string): Promise<RunLogsResponse>;
  /** Reads a Run's run-level audit event trail (spec §30). */
  getRunEvents(id: string): Promise<RunEventsResponse>;
  /**
   * Reads a plan / destroy_plan Run's public, non-secret cost projection (the
   * billing reservation values the controller already computed at plan time, so
   * a dashboard can explain a USD balance shortfall before apply). Never computes
   * cost and never returns secret material.
   */
  getRunCost(id: string): Promise<RunCostInfo>;
  approveRun(
    id: string,
    input?: { readonly approvedBy?: string; readonly reason?: string },
  ): Promise<Run>;
  cancelRun(id: string): Promise<Run>;
  /** Lists a Workspace's Connections (never includes secret values; spec §30). */
  listConnections(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListConnectionsResponse>;
  /** Lists operator-scoped (instance-wide) Connections (spec §30). */
  listOperatorConnections(): Promise<ListConnectionsResponse>;
  /** Reads a ProviderConnection projection by id (no secret values). */
  getConnection(connectionId: string): Promise<ProviderConnection>;
  /**
   * Registers a Provider ProviderConnection backing record (§9). The dashboard sends
   * an explicit provider source and Credential Recipe; `values` are write-only
   * and the response is the public projection (no secret values).
   */
  createConnection(
    request: CreateConnectionRequest,
  ): Promise<ConnectionResponse>;
  /** Re-verifies a ProviderConnection's stored credential with the provider (§30). */
  testConnection(connectionId: string): Promise<TestConnectionResponse>;
  /**
   * Revokes a ProviderConnection and deletes its sealed secret blob (§30), recording the
   * §27 / §34 `connection.revoked` Workspace activity.
   */
  revokeConnection(connectionId: string): Promise<void>;
  /** Provider-owned OAuth helpers keyed by opaque composition-time helper id. */
  readonly connectionOAuth?: Readonly<
    Record<
      string,
      {
        start(input: {
          readonly subject: string;
          readonly workspaceId: string;
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
      }
    >
  >;
  /**
   * Queue-consumer entry point. The Workers `queue()` consumer calls this for
   * each dispatched run message (plan/apply); it loads the run, applies the
   * idempotency guard, mints credentials, and drives the container dispatch.
   */
  dispatchQueuedRun(dispatch: {
    action: "plan" | "apply" | "source_sync" | "restore";
    runId: string;
    workspaceId: string;
  }): Promise<void>;
  // --- Sources (Core Specification §6) ---
  createSource(request: CreateSourceRequest): Promise<CreateSourceResponse>;
  listSources(
    workspaceId: string,
    params?: PageParams,
  ): Promise<ListSourcesResponse>;
  getSource(id: string): Promise<SourceResponse>;
  patchSource(id: string, patch: PatchSourceRequest): Promise<SourceResponse>;
  createSourceSync(
    sourceId: string,
    options?: CreateSourceSyncRequest & { readonly dedupe?: boolean },
  ): Promise<CreateSourceSyncResponse>;
  createSourceReconciliationSyncs(
    sourceId: string,
  ): Promise<readonly CreateSourceSyncResponse[]>;
  createSourceCompatibilityCheck(
    sourceId: string,
    request?: CreateSourceCompatibilityCheckRequest,
  ): Promise<CapsuleCompatibilityReportResponse>;
  getCompatibilityReport(
    reportId: string,
  ): Promise<CapsuleCompatibilityReportResponse>;
  listCredentialRecipes(): Promise<ListCredentialRecipesResponse>;
  listSourceSnapshots(sourceId: string): Promise<ListSourceSnapshotsResponse>;
  getSourceSyncRun(id: string): Promise<SourceSyncRun>;
  createRestoreRun(
    workspaceId: string,
    backupId: string,
    request: CreateRestoreRequest,
    context?: DeployControlActorContext,
  ): Promise<Run>;
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
  const capsuleCoordination =
    options.capsuleCoordination ?? new InMemoryCapsuleCoordination();
  const context =
    options.context ??
    (await createAppContext({
      ...options,
      runtimeEnv,
      runtimeConfig,
    }));
  const deployControlToken = runtimeEnv.TAKOSUMI_DEPLOY_CONTROL_TOKEN;
  const metricsScrapeToken = runtimeEnv.TAKOSUMI_METRICS_SCRAPE_TOKEN;
  const metricTags = serviceMetricTags(runtimeConfig, runtimeEnv);
  // Durable OpenTofu run ledger. SQL-backed when a SqlClient is configured
  // (and not explicitly overridden); the in-memory fallback is only safe for
  // dev/test and is gated below for production/staging hosts that expose the
  // public deploy API.
  const opentofuStore = resolveOpenTofuStore({
    ...(options.opentofuControlStore
      ? { opentofuControlStore: options.opentofuControlStore }
      : {}),
    ...(options.sqlClient ? { sqlClient: options.sqlClient } : {}),
  });
  assertDurableDeployControlStoreOrWarn({
    environment: runtimeConfig.environment,
    deployControlAuthPresent: Boolean(
      deployControlToken || options.authorizeDeployControlBearer,
    ),
    durable: opentofuStore.durable,
  });
  // Resolve a single concrete store so the controller and the Source domain
  // service share the SAME ledger (when no durable store is injected the
  // controller would otherwise build its own private in-memory store, leaving
  // the SourcesService backed by a different instance).
  const durableOpenTofuStore =
    opentofuStore.store ?? new InMemoryOpenTofuControlStore();
  const operatorInstallConfigs = options.operatorInstallConfigs ?? [];
  const defaultInstallConfigOverrides = operatorInstallConfigs.filter(
    (config) => config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  );
  if (defaultInstallConfigOverrides.length > 1) {
    throw new TypeError(
      `duplicate host InstallConfig id: ${DEFAULT_CAPSULE_INSTALL_CONFIG_ID}`,
    );
  }
  const sharedOpenTofuStore = withHostInstallConfigs(durableOpenTofuStore, [
    defaultInstallConfigOverrides[0] ?? defaultCapsuleInstallConfig(),
    ...operatorInstallConfigs.filter(
      (config) => config.id !== DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    ),
  ]);
  const gitInstallPlanStore =
    options.gitInstallPlanStore ??
    (options.sqlClient
      ? new SqlGitInstallPlanStore(options.sqlClient)
      : new InMemoryGitInstallPlanStore());
  assertDurableGitInstallPlanStoreOrWarn({
    environment: runtimeConfig.environment,
    durable: gitInstallPlanStore.durable,
  });
  const billingExtension = options.billingExtensionFactory
    ? await options.billingExtensionFactory.create()
    : undefined;
  const billingEnforcement =
    options.billingEnforcement ?? billingExtension?.billingEnforcement;
  const quotaPolicy = options.quotaPolicy ?? billingExtension?.quotaPolicy;
  const showbackRater =
    options.showbackRater ?? billingExtension?.showbackRater;
  const credentialRecipes = options.credentialRecipes ?? [];
  const credentialRecipeById = new Map(
    credentialRecipes.map((recipe) => [recipe.id, recipe] as const),
  );
  if (credentialRecipeById.size !== credentialRecipes.length) {
    throw new Error("Credential Recipe ids must be unique");
  }
  const credentialRecipeDrivers: CredentialRecipeDriverRegistry =
    options.credentialRecipeDrivers ?? {};
  const operatorProviderConnections = options.operatorProviderConnections ?? [];
  if (!Array.isArray(operatorProviderConnections)) {
    throw new TypeError("operatorProviderConnections must be an array");
  }
  const prevalidatedOperatorConnections = new Set<string>();
  const operatorProviderConnectionProjection: ProviderConnection[] = [];
  // Code-owned fixed Connections are a release projection, not runtime DB
  // records. A stable synthetic lifecycle timestamp keeps response bytes
  // deterministic; release tooling owns any durable reconciliation separately.
  const validationTimestamp = "1970-01-01T00:00:00.000Z";
  for (const declaration of operatorProviderConnections) {
    if (prevalidatedOperatorConnections.has(declaration.id)) {
      throw new TypeError(
        `operator Provider Connection declaration id ${declaration.id} must be unique`,
      );
    }
    prevalidatedOperatorConnections.add(declaration.id);
    operatorProviderConnectionProjection.push(
      resolveTargetConnection(
        declaration,
        (id) => credentialRecipeById.get(id),
        credentialRecipeDrivers,
        validationTimestamp,
      ),
    );
  }
  // Provider-credential Vault: an explicitly injected vault wins; otherwise, when
  // the host supplied at-rest secret crypto, build the default
  // StaticSecretConnectionVault over the SAME shared store the controller uses
  // (so a ProviderConnection registered through the vault is visible to binding
  // resolution + credential mint). Without either, the controller fails closed on
  // every provider-using run (this is what the shipped worker was previously
  // missing — provider plan/apply + private-git source_sync had no vault to mint).
  const opentofuConnectionVault =
    options.opentofuConnectionVault ??
    (options.secretCrypto
      ? new StaticSecretConnectionVault({
          store: sharedOpenTofuStore,
          crypto: options.secretCrypto,
          operatorProviderConnections: operatorProviderConnectionProjection,
          credentialRecipeResolver: (id) => credentialRecipeById.get(id),
          credentialDrivers: credentialRecipeDrivers,
          ...(options.runCredentialIssuer
            ? { runCredentialIssuer: options.runCredentialIssuer }
            : {}),
          sourceCredentialDrivers: options.sourceCredentialDrivers ?? {},
        })
      : undefined);
  const runtimeSecretFileMaterializer =
    options.runtimeSecretFileMaterializer ??
    (options.secretCrypto
      ? createRuntimeSecretFileMaterializer({
          store: sharedOpenTofuStore,
          crypto: options.secretCrypto,
        })
      : undefined);
  // Activity domain (Core Specification §27 / §34): the Workspace-scoped audit
  // trail. Constructed first so the controller + Capsule / Dependency /
  // RunGroup services can emit through it (fire-and-forget; a failed audit write
  // never fails the action it records).
  const activityService = new ActivityService({ store: sharedOpenTofuStore });
  let opentofuController: OpenTofuController;
  const enqueueSourceSync: EnqueueSourceSync =
    options.enqueueSourceSync ??
    (async (dispatch) => {
      await opentofuController.dispatchQueuedRun(dispatch);
    });
  // Source domain service (Core Specification §6). The source REST API, webhook,
  // and scheduler all reach it through the controller. The source_sync producer
  // schedules the host dispatcher with `action: "source_sync"`; node/local
  // compositions fall back to the controller's inline dispatcher once the
  // controller is constructed.
  const sourcesService = new SourcesService({
    store: sharedOpenTofuStore,
    enqueueSourceSync,
    ...(options.artifactReferenceAllocator
      ? { artifactReferenceAllocator: options.artifactReferenceAllocator }
      : {}),
    ...(options.opentofuRunner?.readCapsuleSourceFiles
      ? {
          readCapsuleSourceFiles: (snapshot, fileOptions) =>
            options.opentofuRunner!.readCapsuleSourceFiles!({
              // Separate compatibility requests may inspect the same immutable
              // snapshot concurrently from different service isolates. The
              // ledger Run id keeps their runner workspaces independent.
              runId:
                fileOptions?.runId ??
                `source_files_${crypto.randomUUID().replaceAll("-", "")}`,
              sourceSnapshot: snapshot,
              ...(fileOptions?.modulePath
                ? { modulePath: fileOptions.modulePath }
                : {}),
            }),
        }
      : {}),
  });
  // Workspace + Capsule domains (Core Specification §4 / §5 / §11): Workspace /
  // Capsule / InstallConfig / ProviderBindingSet over the SAME shared
  // ledger as the controller and Source service.
  const projectsService = new ProjectsService({ store: sharedOpenTofuStore });
  const workspacesService = new WorkspacesService({
    store: sharedOpenTofuStore,
    ensureDefaultProject: (workspaceId) =>
      projectsService.ensureDefaultProject(workspaceId),
  });
  const connectionsService = new ConnectionsService({
    store: sharedOpenTofuStore,
    operatorProviderConnections: operatorProviderConnectionProjection,
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
  });
  const capsulesService = new CapsulesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    projects: projectsService,
    capsuleAbandonAdmission: async ({ capsule, holderId }, work) => {
      try {
        return await withCapsuleLease(
          capsuleCoordination,
          {
            capsuleId: capsule.id,
            environment: capsule.environment,
            holderId,
          },
          async () => {
            const current = await sharedOpenTofuStore.getCapsule(capsule.id);
            if (
              !current ||
              current.workspaceId !== capsule.workspaceId ||
              current.installingPrincipalId !==
                capsule.installingPrincipalId ||
              current.environment !== capsule.environment ||
              current.status === "destroyed"
            ) {
              throw new OpenTofuControllerError(
                "failed_precondition",
                `capsule ${capsule.id} lifecycle changed before abandonment`,
                { reason: CAPSULE_LIFECYCLE_BUSY_REASON },
              );
            }
            return await work(current);
          },
        );
      } catch (error) {
        if (error instanceof CapsuleLeaseBusyError) {
          throw new OpenTofuControllerError(
            "failed_precondition",
            `capsule ${capsule.id} is busy with another lifecycle operation`,
            { reason: CAPSULE_LIFECYCLE_BUSY_REASON },
          );
        }
        throw error;
      }
    },
  });
  const dependenciesService = new DependenciesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    // The same service-scoped coordinator protects every lifecycle admission;
    // Workers replace the in-memory default with their DO-backed implementation.
    coordination: capsuleCoordination,
  });
  // OutputShares domain (Core Specification §18): the cross-Workspace output sharing
  // grant. Validates against the producer's latest Output over the SAME
  // shared ledger; emits Workspace activity through the same recorder.
  const outputSharesService = new OutputSharesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
  });
  opentofuController = new OpenTofuController({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.opentofuRunner ? { runner: options.opentofuRunner } : {}),
    ...(options.opentofuRunnerExecutors
      ? { runnerExecutors: options.opentofuRunnerExecutors }
      : {}),
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
    operatorProviderConnections: operatorProviderConnectionProjection,
    ...(opentofuConnectionVault ? { vault: opentofuConnectionVault } : {}),
    credentialRecipes,
    ...(options.enqueueRun ? { enqueueRun: options.enqueueRun } : {}),
    sourcesService,
    ...(options.artifactReferenceAllocator
      ? { artifactReferenceAllocator: options.artifactReferenceAllocator }
      : {}),
    ...(options.moduleVariableMaterializer
      ? { moduleVariableMaterializer: options.moduleVariableMaterializer }
      : {}),
    ...(runtimeSecretFileMaterializer
      ? { runtimeSecretFileMaterializer }
      : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    capsuleCoordination,
    ...(options.sensitiveOutputResolver
      ? { sensitiveOutputResolver: options.sensitiveOutputResolver }
      : {}),
    ...(options.dependencyValueSealer
      ? { dependencyValueSealer: options.dependencyValueSealer }
      : {}),
    ...(options.releaseActivator
      ? { releaseActivator: options.releaseActivator }
      : {}),
    ...(showbackRater ? { showbackRater } : {}),
    ...(billingEnforcement ? { billingEnforcement } : {}),
    ...(quotaPolicy ? { quotaPolicy } : {}),
    observability: context.adapters.observability,
    metricTags,
  });
  // RunGroups domain (Core Specification §19 / §24): workspace_update re-plans
  // stale Capsules and workspace_drift_check groups read-only drift checks.
  // Status is computed from member runs at read time. Constructed after the
  // controller it drives.
  const runGroupsService = new RunGroupsService({
    store: sharedOpenTofuStore,
    controller: opentofuController,
    activity: activityService,
  });
  // Control-backups domain: exports a Workspace's Git/OpenTofu control ledger
  // as a sealed bundle. Form/Resource pin sidecars are retired.
  const backupsService = new BackupsService({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.backupArtifactStore
      ? { artifactStore: options.backupArtifactStore }
      : {}),
    ...(options.artifactReferenceAllocator
      ? { artifactReferenceAllocator: options.artifactReferenceAllocator }
      : {}),
    ...(options.backupStateObjectReader
      ? { stateObjectReader: options.backupStateObjectReader }
      : {}),
    ...(options.serviceDataBackupRunner
      ? { serviceDataRunner: options.serviceDataBackupRunner }
      : {}),
  });
  const interfaceStores =
    options.interfaceStores ??
    (options.sqlClient
      ? createSqlInterfaceStores(options.sqlClient)
      : createInMemoryInterfaceStores());
  const interfaceProjectionSink = options.interfaceProjectionSink;
  let interfaceService: InterfaceService;
  interfaceService = new InterfaceService({
    stores: interfaceStores,
    resolver: new OutputBackedInterfaceInputResolver({
      opentofu: sharedOpenTofuStore,
    }),
    activity: activityService,
    ...(interfaceProjectionSink
      ? { projectionSink: interfaceProjectionSink }
      : {}),
    ...(options.interfaceCredentialIssuer
      ? { credentialIssuer: options.interfaceCredentialIssuer }
      : {}),
    ...(options.interfaceBindingDeliveryHandlers
      ? { bindingDeliveryHandlers: options.interfaceBindingDeliveryHandlers }
      : {}),
    oauth2ResourceAuthorizer:
      options.interfaceOAuth2ResourceAuthorizer ??
      (async ({ workspaceId, ownerRef, resource }) => {
        if (ownerRef.kind !== "Capsule") return false;
        const hostname = new URL(resource).hostname.toLowerCase();
        const reservation =
          await sharedOpenTofuStore.getPublicHostReservation(hostname);
        return (
          reservation?.status === "reserved" &&
          reservation.workspaceId === workspaceId &&
          reservation.capsuleId === ownerRef.id
        );
      }),
    ownerExists: async ({ workspaceId, ownerRef }) => {
      try {
        if (ownerRef.kind === "Workspace") {
          const workspace = await workspacesService.getWorkspace(ownerRef.id);
          return workspace.id === workspaceId;
        }
        if (ownerRef.kind === "Capsule") {
          const capsule = await capsulesService.getCapsule(ownerRef.id);
          return (
            capsule.workspaceId === workspaceId &&
            capsule.status !== "destroyed"
          );
        }
        return false;
      } catch {
        return false;
      }
    },
    ownerReady: async ({ workspaceId, ownerRef }) => {
      try {
        if (ownerRef.kind === "Workspace") return ownerRef.id === workspaceId;
        if (ownerRef.kind === "Capsule") {
          const capsule = await capsulesService.getCapsule(ownerRef.id);
          return (
            capsule.workspaceId === workspaceId &&
            (capsule.status === "active" || capsule.status === "stale")
          );
        }
        return false;
      } catch {
        return false;
      }
    },
    lifecycleGuard: async ({ workspaceId, ownerRef, inputs }) => {
      const capsuleIds = new Set<string>();
      if (ownerRef.kind === "Capsule") capsuleIds.add(ownerRef.id);
      for (const input of Object.values(inputs)) {
        if (input.source === "capsule_output") capsuleIds.add(input.capsuleId);
      }
      for (const capsuleId of capsuleIds) {
        const capsule = await sharedOpenTofuStore.getCapsule(capsuleId);
        if (!capsule || capsule.workspaceId !== workspaceId) {
          return {
            ok: false as const,
            phase: "NotReady" as const,
            reason: "CapsuleUnavailable",
            message: "referenced Capsule is unavailable in the Workspace",
          };
        }
        const safety =
          await sharedOpenTofuStore.getCapsuleRuntimeSafety(capsuleId);
        if (safety?.phase === "terminating") {
          return {
            ok: false as const,
            phase: "Terminating" as const,
            reason: "OwnerDestroyQueued",
            message: `Capsule destroy ${safety.runId} is in progress`,
          };
        }
        if (safety?.phase === "unknown") {
          return {
            ok: false as const,
            phase: "Unknown" as const,
            reason: "RunLedgerUnsafe",
            message: `Capsule mutation ${safety.runId} requires recovery`,
          };
        }
        if (safety?.phase === "retired" || capsule.status === "destroyed") {
          return {
            ok: false as const,
            phase: "NotReady" as const,
            reason: "CapsuleRetired",
            message: "referenced Capsule has been destroyed",
          };
        }
        if (
          capsule.status !== "active" &&
          capsule.status !== "stale" &&
          safety?.phase !== "safe"
        ) {
          return {
            ok: false as const,
            phase:
              capsule.status === "error"
                ? ("Unknown" as const)
                : ("NotReady" as const),
            reason: "CapsuleNotReady",
            message: `referenced Capsule is ${capsule.status}`,
          };
        }
      }
      return undefined;
    },
  });
  const legacyOutputInterfaceMigrationService =
    new LegacyOutputInterfaceMigrationService({
      opentofu: sharedOpenTofuStore,
      interfaces: interfaceService,
      now: () => new Date().toISOString(),
    });
  opentofuController.setInterfaceOutputSourcesResolver(
    async ({ workspaceId, capsuleId }) => {
      const names = new Set(
        await interfaceService.capsuleOutputNames(workspaceId, capsuleId),
      );
      try {
        const capsule = await capsulesService.getCapsule(capsuleId);
        if (capsule.workspaceId !== workspaceId) return [];
        const config = await capsulesService.getInstallConfig(
          capsule.installConfigId,
        );
        for (const blueprint of config.interfaceBlueprints ?? []) {
          for (const input of Object.values(blueprint.spec.inputs ?? {})) {
            if (input.source === "capsule_output") names.add(input.outputName);
          }
        }
      } catch (error) {
        if (
          !(error instanceof OpenTofuControllerError) ||
          error.code !== "not_found"
        ) {
          throw error;
        }
      }
      return [...names].sort((left, right) => left.localeCompare(right));
    },
  );
  opentofuController.setPlanRunQueuedObserver(async (run) => {
    if (!run.capsuleId) return;
    await interfaceService.markCapsulePlanPending(
      run.workspaceId,
      run.capsuleId,
      run.id,
    );
  });
  const reconcileCapsuleInterfacesAfterApply = async (
    workspaceId: string,
    capsuleId: string,
  ): Promise<void> => {
    let interfaces = await interfaceService.reconcileCapsule(
      workspaceId,
      capsuleId,
    );
    for (const delayMs of [250, 750, 2_000] as const) {
      const bindings = await Promise.all(
        interfaces.map(async (iface) => ({
          iface,
          bindings: await interfaceService.listBindings(iface.metadata.id),
        })),
      );
      const authorityMayFollowApply = bindings.some(({ iface, bindings }) => {
        const resourceInputName = iface.spec.access.resourceUriInput;
        const resourceInput = resourceInputName
          ? iface.spec.inputs?.[resourceInputName]
          : undefined;
        if (
          resourceInput?.source !== "capsule_output" ||
          resourceInput.capsuleId !== capsuleId
        ) {
          return false;
        }
        return bindings.some(
          (binding) =>
            binding.status.phase === "NotReady" &&
            binding.status.conditions?.some(
              (condition) =>
                condition.type === "Ready" &&
                condition.reason === "OAuthResourceUnauthorized",
            ),
        );
      });
      if (!authorityMayFollowApply) return;
      await new Promise<void>((resolvePromise) =>
        setTimeout(resolvePromise, delayMs),
      );
      interfaces = await interfaceService.reconcileCapsule(
        workspaceId,
        capsuleId,
      );
    }
  };
  opentofuController.setTerminalRunObserver(async (run) => {
    if (!run.capsuleId) return;
    if (!("planRunId" in run)) {
      // Plan completion never publishes a runtime revision. It clears only the
      // matching pending-observation condition. A successful read-only drift
      // plan records/clears Drifted while retaining the pinned revision.
      const driftChangeCount =
        (run.summary?.add ?? 0) +
        (run.summary?.change ?? 0) +
        (run.summary?.destroy ?? 0);
      await interfaceService.completeCapsulePlanObservation(
        run.workspaceId,
        run.capsuleId,
        run.id,
        run.driftCheck === true && run.status === "succeeded"
          ? { drift: driftChangeCount > 0 ? "detected" : "clear" }
          : {},
      );
      return;
    }
    if (run.status === "succeeded") {
      if (run.operation === "destroy") {
        await interfaceService.retireCapsule(run.workspaceId, run.capsuleId);
      } else {
        const capsule = await sharedOpenTofuStore.getCapsule(run.capsuleId);
        let config;
        if (capsule) {
          try {
            config = await capsulesService.getInstallConfig(
              capsule.installConfigId,
            );
          } catch (error) {
            if (
              !(error instanceof OpenTofuControllerError) ||
              error.code !== "not_found"
            ) {
              throw error;
            }
          }
        }
        if (config?.interfaceBlueprints?.length) {
          await interfaceService.ensureCapsuleBlueprints({
            workspaceId: run.workspaceId,
            capsuleId: run.capsuleId,
            blueprints: config.interfaceBlueprints,
          });
        }
        await reconcileCapsuleInterfacesAfterApply(
          run.workspaceId,
          run.capsuleId,
        );
      }
      return;
    }
    if (run.status === "cancelled" && run.startedAt === undefined) {
      // Queued destroy cancellation must undo the early Terminating fence;
      // no provider dispatch occurred, so the pinned output is still valid.
      if (run.operation === "destroy") {
        await interfaceService.reconcileCapsule(run.workspaceId, run.capsuleId);
      }
      return;
    }
    const runtimeMutationDispatched = run.auditEvents.some(
      (event) =>
        event.data?.providerDispatched === true ||
        event.data?.lifecycleActionDispatched === true,
    );
    if (
      (run.status === "failed" && runtimeMutationDispatched) ||
      (run.status === "expired" && run.startedAt !== undefined)
    ) {
      await interfaceService.markCapsuleUnknown(
        run.workspaceId,
        run.capsuleId,
        `OpenTofu ${run.operation} ${run.status}`,
      );
      return;
    }
    if (
      run.operation === "destroy" &&
      run.status === "failed" &&
      !runtimeMutationDispatched
    ) {
      // The queued destroy fence made Interfaces Terminating, but a missing
      // activator/credential/precondition failed before any lifecycle or
      // provider mutation. Reconcile from the still-safe pinned apply.
      await interfaceService.reconcileCapsule(run.workspaceId, run.capsuleId);
    }
  });
  opentofuController.setApplyRunQueuedObserver(async (run) => {
    if (run.operation === "destroy" && run.capsuleId) {
      await interfaceService.markCapsuleTerminating(
        run.workspaceId,
        run.capsuleId,
      );
    }
  });
  opentofuController.setRestoreRunObserver(async ({ phase, run }) => {
    const capsuleId = run.capsuleId;
    if (!capsuleId) return;
    if (phase === "succeeded") {
      await interfaceService.reconcileCapsule(run.workspaceId, capsuleId);
      return;
    }
    // Restore replaces the pinned state/output generation. Fence runtime
    // delivery before dispatch and keep it fail-closed when restore fails.
    await interfaceService.markCapsuleUnknown(
      run.workspaceId,
      capsuleId,
      phase === "started"
        ? "OpenTofu restore started"
        : "OpenTofu restore failed",
    );
  });
  assertInterfaceApiAuthOrWarn({
    environment: runtimeConfig.environment,
    exposed: role === "takosumi-api",
    bearerTokenPresent: Boolean(deployControlToken),
    scopedAuthorizerPresent: Boolean(options.authorizeInterfaceBearer),
  });
  assertDurableInterfaceStoresOrWarn({
    environment: runtimeConfig.environment,
    exposed: role === "takosumi-api",
    durable: interfaceStores.persistence === "durable",
  });
  const connectionOAuthHelpers = options.connectionOAuthHelpers;
  const app = await createApiApp({
    role,
    registerReadinessRoutes: true,
    registerOpenApiRoute: role === "takosumi-api",
    ...(deployControlToken
      ? { getOpenApiBearerToken: () => deployControlToken }
      : {}),
    registerMetricsRoutes:
      role === "takosumi-api" && Boolean(metricsScrapeToken),
    registerInterfaceRoutes: role === "takosumi-api",
    ...(options.adapterCapabilities
      ? { adapterCapabilities: options.adapterCapabilities }
      : {}),
    ...(options.operatorCapabilities
      ? { operatorCapabilities: options.operatorCapabilities }
      : {}),
    interfaceRouteOptions: {
      service: interfaceService,
      ...(deployControlToken
        ? { getInterfaceBearerToken: () => deployControlToken }
        : {}),
      ...(options.authorizeInterfaceBearer
        ? { authorizeInterfaceBearer: options.authorizeInterfaceBearer }
        : {}),
      ...(options.authorizeInterfaceWorkspace
        ? { authorizeInterfaceWorkspace: options.authorizeInterfaceWorkspace }
        : {}),
    },
    metricsRouteOptions: metricsScrapeToken
      ? {
          observability: context.adapters.observability,
          getScrapeToken: () => metricsScrapeToken,
          metricTags,
        }
      : undefined,
    deployControlInternalRouteOptions: {
      controller: opentofuController,
      ...(options.buildConnectionSetupRequest
        ? { buildConnectionSetupRequest: options.buildConnectionSetupRequest }
        : {}),
      ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
      ...(options.mountInternalLedgerRoutes === true
        ? { mountInternalLedgerRoutes: true }
        : {}),
      workspacesService,
      projectsService,
      capsulesService,
      connectionsService,
      dependenciesService,
      outputSharesService,
      runGroupsService,
      activityService,
      backupsService,
      legacyOutputInterfaceMigrationService,
      ...(deployControlToken
        ? { getDeployControlToken: () => deployControlToken }
        : {}),
      ...(options.authorizeDeployControlBearer
        ? {
            authorizeDeployControlBearer: options.authorizeDeployControlBearer,
          }
        : {}),
    },
    readinessRouteProbes: createRoleReadinessProbes({
      role,
      context,
      runtimeConfig,
      runtimeEnv,
    }),
    requestCorrelation: {
      logger: shouldEmitHttpRequestLogs(runtimeConfig.environment, runtimeEnv)
        ? createConsoleApiRequestLogger(
            parseApiLogLevel(runtimeEnv.TAKOSUMI_LOG_LEVEL),
          )
        : undefined,
      minLevel: parseApiLogLevel(runtimeEnv.TAKOSUMI_LOG_LEVEL),
      traceSink: context.adapters.observability,
      metricSink: context.adapters.observability,
      metricTags,
    },
  });
  // Typed in-process operate facade. Delegates to the wired OpenTofu
  // controller; does not duplicate controller logic.
  //
  const members: TakosumiOperations["members"] = {
    getMember: (workspaceId, accountId) =>
      workspacesService.getWorkspaceMember(workspaceId, accountId),
    listMembers: (workspaceId) =>
      workspacesService.listWorkspaceMembers(workspaceId),
    upsertMember: (input) =>
      workspacesService.upsertWorkspaceMember({
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        ...(input.roles ? { roles: input.roles } : {}),
        ...(input.status ? { status: input.status } : {}),
        actorAccountId: input.actor.actorAccountId,
      }),
  };
  const operations: TakosumiOperations = {
    controller: opentofuController,
    gitInstallPlans: gitInstallPlanStore,
    workspaces: workspacesService,
    projects: projectsService,
    capsules: capsulesService,
    capsuleExecutionAuthority:
      createCapsuleExecutionAuthorityResolver(sharedOpenTofuStore),
    members,
    connections: connectionsService,
    dependencies: dependenciesService,
    listDependenciesByWorkspace: (workspaceId) =>
      dependenciesService.listByWorkspace(workspaceId),
    outputShares: outputSharesService,
    runGroups: runGroupsService,
    interfaces: interfaceService,
    activity: activityService,
    getWorkspaceBilling: (workspaceId) =>
      opentofuController.getWorkspaceBilling(workspaceId),
    listWorkspaceUsage: (workspaceId, params) =>
      opentofuController.listWorkspaceUsage(workspaceId, params),
    getCapsuleUsageSummary: (capsuleId) =>
      opentofuController.getCapsuleUsageSummary(capsuleId),
    recordMeteredUsage: (workspaceId, input) =>
      opentofuController.recordMeteredUsage(workspaceId, input),
    updateWorkspaceBillingSettings: (workspaceId, input) =>
      opentofuController.updateWorkspaceBillingSettings(workspaceId, input),
    backups: backupsService,
    getSourceSnapshot: (id) => opentofuController.getSourceSnapshot(id),
    readSourceSnapshotFiles: (id, fileOptions) =>
      opentofuController.readSourceSnapshotFiles(id, fileOptions),
    resolveStableSourceTag: (url) =>
      opentofuController.resolveStableSourceTag(url),
    listRunnerProfiles: () => opentofuController.listRunnerProfiles(),
    createPlanRun: (request) => opentofuController.createPlanRun(request),
    createCapsulePlan: (capsuleId, options) =>
      opentofuController.createCapsulePlan(
        capsuleId,
        options?.actor ? { actor: options.actor } : {},
        options?.compatibilityReportId ||
        options?.runnerProfileId ||
        options?.sourceSnapshotId ||
        options?.planRunId
          ? {
              ...(options?.compatibilityReportId
                ? { compatibilityReportId: options.compatibilityReportId }
                : {}),
              ...(options?.runnerProfileId
                ? { runnerProfileId: options.runnerProfileId }
                : {}),
              ...(options?.sourceSnapshotId
                ? { sourceSnapshotId: options.sourceSnapshotId }
                : {}),
              ...(options?.planRunId
                ? { planRunId: options.planRunId }
                : {}),
            }
          : {},
      ),
    createCapsuleDestroyPlan: (capsuleId, options) =>
      opentofuController.createCapsuleDestroyPlan(
        capsuleId,
        options?.actor ? { actor: options.actor } : {},
        options?.runnerProfileId
          ? { runnerProfileId: options.runnerProfileId }
          : {},
      ),
    createCapsuleDriftCheck: (capsuleId) =>
      opentofuController.createCapsuleDriftCheck(capsuleId),
    getPlanRun: (id) => opentofuController.getPlanRun(id),
    createApplyRun: (request) => opentofuController.createApplyRun(request),
    getApplyRun: (id) => opentofuController.getApplyRun(id),
    getCapsule: (id) => opentofuController.getCapsule(id),
    getCapsuleAdoptedSourceRevision: (capsuleId) =>
      opentofuController.getCapsuleAdoptedSourceRevision(capsuleId),
    listStateVersions: (capsuleId, params) =>
      opentofuController.listStateVersions(capsuleId, params),
    listStateVersionsByIds: (ids) =>
      opentofuController.listStateVersionsByIds(ids),
    listStateVersionsByWorkspace: (workspaceId) =>
      opentofuController.listStateVersionsByWorkspace(workspaceId),
    getStateVersion: (id) => opentofuController.getStateVersion(id),
    getCurrentResourceInventory: (capsuleId) =>
      opentofuController.getCurrentResourceInventory(capsuleId),
    getOutput: (id) => opentofuController.getOutput(id),
    createStateVersionRollbackPlan: (stateVersionId) =>
      opentofuController.createStateVersionRollbackPlan(stateVersionId),
    getRun: (id) => opentofuController.getRun(id),
    listRuns: (workspaceId, options) =>
      opentofuController.listRuns(workspaceId, options),
    getRunLogs: (id) => opentofuController.getRunLogs(id),
    getRunEvents: (id) => opentofuController.getRunEvents(id),
    getRunCost: (id) => opentofuController.getRunCost(id),
    approveRun: (id, input) => opentofuController.approveRun(id, input ?? {}),
    cancelRun: (id) => opentofuController.cancelRun(id),
    listConnections: (workspaceId, params) =>
      opentofuController.listConnections(workspaceId, params),
    listOperatorConnections: () => opentofuController.listOperatorConnections(),
    getConnection: (connectionId) =>
      opentofuController.getConnection(connectionId),
    createConnection: (request) => opentofuController.createConnection(request),
    testConnection: (connectionId) =>
      opentofuController.testConnection(connectionId),
    // Revoke + delete the sealed blob, mirroring the §30
    // `POST /internal/v1/connections/:id/revoke` route: read the non-secret
    // ProviderConnection projection first (for the activity context captured before the
    // blob is gone), delete, then record the space-scoped `connection.revoked`
    // activity. The control-routes layer has already space-permission gated.
    revokeConnection: async (connectionId) => {
      const connection = await opentofuController.getConnection(connectionId);
      await opentofuController.deleteConnection(connectionId);
      if (connection.workspaceId) {
        await activityService.record({
          workspaceId: connection.workspaceId,
          actorId: "dashboard-session",
          action: "connection.revoked",
          targetType: "connection",
          targetId: connection.id,
          metadata: {
            provider: connection.provider,
            ...(connection.credentialRecipe
              ? {
                  recipeId: connection.credentialRecipe.id,
                  recipeAuthMode: connection.credentialRecipe.authMode,
                }
              : {}),
            ...(connection.kind ? { kind: connection.kind } : {}),
            scope: connection.scope,
          },
        });
      }
    },
    // Provider helpers are installed at composition time and exposed by opaque
    // helper id. Accounts/Core do not grow a route or type branch per vendor.
    ...(connectionOAuthHelpers && Object.keys(connectionOAuthHelpers).length > 0
      ? {
          connectionOAuth: Object.fromEntries(
            Object.entries(connectionOAuthHelpers).map(([helperId, helper]) => [
              helperId,
              {
                start: (input) =>
                  helper.start({
                    helperId,
                    request: new Request(
                      "https://connection-oauth.internal/start",
                    ),
                    principal: { actor: "dashboard-session" },
                    body: {
                      workspaceId: input.workspaceId,
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
                  helper.complete({
                    helperId,
                    request: new Request(
                      "https://connection-oauth.internal/callback",
                    ),
                    principal: { actor: "dashboard-session" },
                    code: input.code,
                    state: input.state,
                    query: input.query,
                  }),
              },
            ]),
          ),
        }
      : {}),
    dispatchQueuedRun: (dispatch) =>
      opentofuController.dispatchQueuedRun(dispatch),
    createSource: (request) => opentofuController.createSource(request),
    listSources: (workspaceId, params) =>
      opentofuController.listSources(workspaceId, params),
    getSource: (id) => opentofuController.getSource(id),
    patchSource: (id, patch) => opentofuController.patchSource(id, patch),
    createSourceSync: (sourceId, opts) =>
      opentofuController.createSourceSync(sourceId, opts ?? {}),
    createSourceReconciliationSyncs: (sourceId) =>
      opentofuController.createSourceReconciliationSyncs(sourceId),
    createSourceCompatibilityCheck: (sourceId, request) =>
      opentofuController.createSourceCompatibilityCheck(sourceId, request),
    getCompatibilityReport: (reportId) =>
      opentofuController.getCompatibilityReport(reportId),
    listCredentialRecipes: () => opentofuController.listCredentialRecipes(),
    listSourceSnapshots: (sourceId) =>
      opentofuController.listSourceSnapshots(sourceId),
    getSourceSyncRun: (id) => opentofuController.getSourceSyncRun(id),
    createRestoreRun: (workspaceId, backupId, request, context) =>
      opentofuController.createRestoreRun(
        workspaceId,
        backupId,
        request,
        context,
      ),
    verifySourceHookSecret: (sourceId, presentedSecret) =>
      opentofuController.verifySourceHookSecret(sourceId, presentedSecret),
  };
  return { app, context, role, operations };
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

function serviceMetricTags(
  runtimeConfig: AppRuntimeConfig,
  env: Record<string, string | undefined>,
): Record<string, string> {
  return {
    environment: runtimeConfig.environment ?? "local",
    runner_profile_id:
      normalizedMetricTag(env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID) ??
      "opentofu-default",
  };
}

function normalizedMetricTag(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function processRoleFromRuntimeConfig(
  runtimeConfig: AppRuntimeConfig,
): TakosumiProcessRole {
  const role = runtimeConfig.processRole;
  return role && isTakosumiProcessRole(role) ? role : "takosumi-api";
}


function record(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}
