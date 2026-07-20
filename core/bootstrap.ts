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
import type {
  OfferingHostComposition,
  ResourceDeploymentAdmission,
} from "takosumi-contract";
import type {
  InstallConfig,
  ManagedPublicHostnameClaimRequest,
  ManagedPublicHostnameClaimResult,
} from "takosumi-contract/install-configs";
import type { CapsuleCoordination } from "./domains/deploy-control/capsule_lease.ts";
import {
  type EnqueueSourceSync,
  SourcesService,
} from "./domains/sources/mod.ts";
import { CapsulesService } from "./domains/capsules/mod.ts";
import { WorkspacesService } from "./domains/workspaces/mod.ts";
import { ProjectsService } from "./domains/projects/mod.ts";
import { ConnectionsService } from "./domains/connections/mod.ts";
import { DependenciesService } from "./domains/dependencies/mod.ts";
import { OutputSharesService } from "./domains/output-shares/mod.ts";
import type { SensitiveOutputResolver } from "./domains/output-shares/mod.ts";
import type {
  ConnectionVault,
  ManagedProviderCredentialIssuer,
} from "./adapters/vault/mod.ts";
import { StaticSecretConnectionVault } from "./adapters/vault/mod.ts";
import type { SecretBoundaryCrypto } from "./adapters/secret-store/memory.ts";
import { RunGroupsService } from "./domains/run-groups/mod.ts";
import { ActivityService } from "./domains/activity/mod.ts";
import {
  createInMemoryResourceShapeStores,
  collectResourceFormPinBackupEntries,
  formatResourceShapeId,
  LegacyResourceStateAdoptionService,
  matchesApplyLock,
  ResourceFormPinOperations,
  ResourceShapeService,
  type ResourceAdapter,
  type ResourceObservationClaimInput,
  type ResourceShapeModuleRegistry,
  type ResourceShapeRecord,
  type ResourceShapeRecordId,
  type ResourceShapeSchemaRegistry,
  type ResourceShapeStores,
} from "./domains/resource-shape/mod.ts";
import { createSqlResourceShapeStores } from "./domains/resource-shape/sql_stores.ts";
import {
  createInMemoryInterfaceStores,
  createPortableDeclarationReader,
  ensureFormDescriptorInterfaces,
  InterfaceService,
  LegacyOutputInterfaceMigrationService,
  OutputBackedInterfaceInputResolver,
  RequiredFormInterfaceError,
  resourceInterfaceWorkspaceInput,
  resourceLifecycleInterfaceWorkspaceInput,
  type ResourceInterfaceWorkspaceResolver,
  type InterfaceBindingDeliveryHandlerRegistry,
  type InterfaceCredentialIssuer,
  type InterfaceOAuth2ResourceAuthorizer,
  type InterfaceStores,
} from "./domains/interfaces/mod.ts";
import { createSqlInterfaceStores } from "./domains/interfaces/sql_stores.ts";
import {
  FormRegistryService,
  createSqlFormRegistryStore,
  type FormPackageArtifactReader,
  type FormPackageVerifier,
  type FormRegistryStore,
} from "./domains/service-forms/mod.ts";
import {
  CompositeOfferingCatalogReader,
  createSqlOfferingCatalogStore,
  FormOfferingSubjectResolver,
  InMemoryOfferingCatalogReader,
  OfferingCatalogAdminService,
  OfferingService,
  type OfferingCatalogStore,
} from "./domains/offerings/mod.ts";
import {
  type BackupArtifactStore,
  type BackupObjectReader,
  BackupsService,
  type ServiceDataBackupRunner,
} from "./domains/backups/mod.ts";
import { bootstrapDefaultInstallConfig } from "./domains/capsules/default_install_config.ts";
import { bootstrapOperatorInstallConfigs } from "./domains/capsules/operator_install_configs.ts";
import type {
  CreateSourceRequest,
  CreateSourceResponse,
  CreateSourceSyncResponse,
  ListSourcesResponse,
  ListSourceSnapshotsResponse,
  PatchSourceRequest,
  SourceResponse,
  SourceSyncRun,
  SourceSnapshot,
} from "takosumi-contract/sources";
import type {
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
  InMemoryOpenTofuControlStore,
  type OpenTofuControlStore,
} from "./domains/deploy-control/store.ts";
import { SqlOpenTofuControlStore } from "./domains/deploy-control/store_sql.ts";
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
  InterfaceProjectionSnapshot,
  NativeResourceRef,
  ResourceObject,
  ResourceShapeKind,
} from "takosumi-contract";
import { type CredentialRecipeDriverRegistry } from "@takosumi/providers";

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

function withCanonicalResourceProjectionEvidence(
  sink: InterfaceProjectionSink,
  stores: ResourceShapeStores,
): InterfaceProjectionSink {
  return {
    async project(snapshot: InterfaceProjectionSnapshot): Promise<void> {
      const owner = snapshot.interface.metadata.ownerRef;
      if (owner.kind !== "Resource") {
        await sink.project(snapshot);
        return;
      }

      // The Resource record and ResolutionLock remain the authority. Re-read
      // the record around the lock read so an Interface projector cannot pair
      // a known-stale Resource generation with current native identity.
      const before = await stores.resources.get(owner.id);
      const lock = await stores.locks.get(owner.id);
      const after = await stores.resources.get(owner.id);
      if (
        !before ||
        !after ||
        !lock ||
        lock.resourceId !== owner.id ||
        before.phase !== "Ready" ||
        before.observedGeneration !== before.generation ||
        after.phase !== before.phase ||
        after.generation !== before.generation ||
        after.observedGeneration !== before.observedGeneration ||
        after.updatedAt !== before.updatedAt
      ) {
        await sink.project(snapshot);
        return;
      }

      await sink.project({
        ...snapshot,
        ownerResource: {
          id: owner.id,
          generation: before.generation,
          nativeResources: structuredClone(lock.nativeResources ?? []),
        },
      });
    },
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

function assertResourceShapeApiAuthOrWarn(input: {
  readonly environment?: string;
  readonly exposed: boolean;
  readonly bearerTokenPresent: boolean;
  readonly scopedAuthorizerPresent: boolean;
}): void {
  if (
    !input.exposed ||
    input.bearerTokenPresent ||
    input.scopedAuthorizerPresent
  ) {
    return;
  }
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Resource Shape API but no ` +
        `TAKOSUMI_DEPLOY_CONTROL_TOKEN or scoped Resource Shape actor resolver ` +
        `is configured; /v1/resources would be unauthenticated.`,
    );
  }
  log.warn("service.resourceShape.unauthenticated_routes", {
    environment: input.environment ?? "unknown",
    hint:
      "Resource Shape API routes are exposed without a bearer token. Set " +
      "TAKOSUMI_DEPLOY_CONTROL_TOKEN or inject resolveResourceShapeActor " +
      "before exposing this host.",
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
        `configured; /v1/interfaces would be unauthenticated.`,
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

function assertDurableResourceShapeStoresOrWarn(input: {
  readonly environment?: string;
  readonly exposed: boolean;
  readonly durable: boolean;
}): void {
  if (!input.exposed || input.durable) return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Resource Shape API but no ` +
        `durable Resource/ResolutionLock/TargetPool/SpacePolicy stores are ` +
        `configured; desired resources and resolution evidence would be lost ` +
        `on restart. Inject durable resourceShapeStores (or a sqlClient).`,
    );
  }
  log.warn("service.resourceShape.in_memory_store", {
    environment: input.environment ?? "unknown",
    hint:
      "Resource, ResolutionLock, TargetPool, and SpacePolicy records will not " +
      "persist across restart. Inject durable resourceShapeStores (or a " +
      "sqlClient) for production/staging.",
  });
}

function assertDurableOfferingCatalogStoreOrWarn(input: {
  readonly environment?: string;
  readonly exposed: boolean;
  readonly durable: boolean;
}): void {
  if (!input.exposed || input.durable) return;
  const strict =
    input.environment === "production" || input.environment === "staging";
  if (strict) {
    throw new Error(
      `${input.environment} runtime exposes the Offering catalog API but no ` +
        `durable Offering catalog store is configured; published exact ` +
        `catalog authority would be lost on restart. Inject a durable ` +
        `offeringCatalogStore (or a sqlClient).`,
    );
  }
  log.warn("service.offeringCatalog.in_memory_store", {
    environment: input.environment ?? "unknown",
    hint:
      "Published Offering catalogs will not persist across restart. Inject " +
      "a durable offeringCatalogStore (or a sqlClient) for production/staging.",
  });
}

export interface ResourceShapeAdapterFactoryDeps {
  readonly controller: OpenTofuController;
  readonly capsules: CapsulesService;
  readonly workspaces: WorkspacesService;
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
  /** Optional SQL client used by the durable OpenTofu and Resource APIs. */
  readonly sqlClient?: SqlClient;
  /**
   * Host-local exact FormRef/package/activation registry. When omitted,
   * `sqlClient` supplies the durable Postgres implementation; a zero-form host
   * with neither dependency simply leaves the registry operation seam absent.
   */
  readonly formRegistryStore?: FormRegistryStore;
  /** Opaque package bytes reader installed by the host trust policy. */
  readonly formPackageArtifactReader?: FormPackageArtifactReader;
  /** Trusted data-only package verifier installed by the host trust policy. */
  readonly formPackageVerifier?: FormPackageVerifier;
  /**
   * Complete generic noncommercial Offering contribution. Omitted installs an
   * empty catalog with no subject resolvers; plain OpenTofu and zero-form hosts
   * therefore remain fully functional without an Offering dependency.
   */
  readonly offeringHostComposition?: OfferingHostComposition;
  /**
   * Durable immutable generic Offering catalog administration store. When
   * omitted, `sqlClient` supplies Postgres; otherwise dev/test uses memory.
   * Cloud commercial bindings are never persisted through this port.
   */
  readonly offeringCatalogStore?: OfferingCatalogStore;
  /**
   * Pre-built durable store for the public OpenTofu run ledger. When omitted,
   * a configured `sqlClient` backs it with SQL; when neither is present the
   * controller falls back to an in-memory dev/test store (gated for
   * production/staging when the public deploy API is exposed).
   */
  readonly opentofuControlStore?: OpenTofuControlStore;
  /**
   * Host-owned allocator for opaque source/state/output/backup artifact refs.
   * Required by execution and backup paths; Core never derives storage layouts.
   */
  readonly artifactReferenceAllocator?: ArtifactReferenceAllocator;
  /** Resource Shape durable stores. When omitted, `sqlClient` is used. */
  readonly resourceShapeStores?: ResourceShapeStores;
  /** Operator-owned module registry for explicit Resource Shape moduleTemplate ids. */
  readonly resourceShapeModuleRegistry?: ResourceShapeModuleRegistry;
  /** Host-installed schemas for operator-defined Resource Shape tokens. */
  readonly resourceShapeSchemaRegistry?: ResourceShapeSchemaRegistry;
  /** Durable Takosumi-managed runtime Interface declarations and bindings. */
  readonly interfaceStores?: InterfaceStores;
  /** Recoverable host materialization of canonical Interface/Binding state. */
  readonly interfaceProjectionSink?: InterfaceProjectionSink;
  /**
   * Explicit bridge from Resource Shape namespace ownership to the Stack Workspace
   * that may own Interfaces for that Resource. Without this mapping,
   * Resource-owned/output Interfaces fail closed; matching id strings are not
   * treated as authority.
   */
  readonly resolveResourceInterfaceWorkspace?: ResourceInterfaceWorkspaceResolver;
  /**
   * Explicit host-owned Workspace -> Resource authorization-scope mapping used
   * for the redacted exact-Form backup sidecar and exact FormRef migration.
   */
  readonly resolveResourceBackupScope?: (
    workspaceId: string,
  ) => string | undefined | Promise<string | undefined>;
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
  /**
   * Adapter that materializes resolved Resource Shapes. The API is mounted only
   * when the host explicitly injects an adapter or adapter factory; Core never
   * selects a stub or target implementation implicitly.
   */
  readonly resourceShapeAdapter?: ResourceAdapter;
  /**
   * Builds a Resource Shape adapter after the shared OpenTofu controller exists.
   * Host workers use this to wire the real opentofu-adapter, whose run port
   * records a first-class Resource subject in the normal Run ledger.
   */
  readonly resourceShapeAdapterFactory?: (
    deps: ResourceShapeAdapterFactoryDeps,
  ) => ResourceAdapter | Promise<ResourceAdapter>;
  /** Host price/quote and reserve/capture/release policy for Deploy API. */
  readonly resourceDeploymentAdmission?: ResourceDeploymentAdmission;
  /**
   * Upper bound for a synchronous Resource Shape delete request. OpenTofu-backed
   * deletes may perform a destroy plan and a destroy apply, so hosts that wire a
   * real runner should set this longer than one runner wait window.
   */
  readonly resourceShapeDeleteTimeoutMs?: number;
  /**
   * Operator-managed compat/provider base URLs accepted in TargetPool
   * implementation options. Empty rejects provider base URL overrides.
   */
  readonly resourceShapeAllowedProviderBaseUrls?: readonly string[];
  /**
   * Public Resource Shape kinds this service instance exposes for new desired
   * state. Omitted means none. Every kind must also be installed through the
   * explicit schema registry contribution.
   */
  readonly enabledResourceShapeKinds?: readonly ResourceShapeKind[];
  readonly resourceCapabilities?: Partial<TakosumiResourceCapabilities>;
  readonly adapterCapabilities?: Partial<TakosumiAdapterCapabilities>;
  readonly operatorCapabilities?: Partial<TakosumiOperatorCapabilities>;
  readonly resolveResourceShapeActor?: (
    request: Request,
  ) => ActorContext | Promise<ActorContext>;
  readonly authorizeResourceShapeForceDelete?: (input: {
    readonly actor: ActorContext;
    readonly request: Request;
    readonly space: string;
    readonly kind: ResourceShapeKind;
    readonly name: string;
  }) => boolean | Promise<boolean>;
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
   * Host-injected credential issuer for operator managed-provider compatibility
   * Connections. OSS/self-host leaves this undefined and the Vault falls back to
   * the stored static secret. A managed compatibility extension may use it to
   * mint run-scoped, Workspace-bound provider tokens for protocols that cannot
   * carry custom attribution headers.
   */
  readonly managedProviderCredentialIssuer?: ManagedProviderCredentialIssuer;
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
   * `action: "source_sync"`; when omitted Core claims and terminally fails the
   * Run with `runner_capability_missing` instead of leaving an unowned queue row.
   */
  readonly enqueueSourceSync?: EnqueueSourceSync;
  readonly runnerProfiles?: readonly RunnerProfile[];
  readonly defaultRunnerProfileId?: string;
  /**
   * Capsule lease seam (Core Specification §10.2). The Workers adapter
   * injects a DO-backed implementation fronting the `COORDINATION`
   * CoordinationObject so only ONE write run per (Capsule, environment)
   * runs at a time across isolates; when omitted the controller relies on its
   * in-process serialization (single-isolate safe).
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
  /** Operator policy for short managed hostnames; scoped names remain free. */
  readonly managedVanityHostnameSlotsPerOwner?: number;
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
  /** Optional zero-form-capable portable Service Form host registry. */
  readonly forms?: FormRegistryService;
  /**
   * Generic noncommercial availability and exact-selection engine. Commercial
   * hosts bind manager/price/capacity evidence only after this returns an exact
   * OfferingSelection.
   */
  readonly offerings: Pick<OfferingService, "listAvailability" | "resolve">;
  /** Operator administration of immutable generic noncommercial catalogs. */
  readonly offeringCatalogs: Pick<
    OfferingCatalogAdminService,
    "publish" | "get" | "list"
  >;
  /** Internal-only bounded exact-Form backfill and backup replay operation. */
  readonly resourceFormPins?: ResourceFormPinOperations;
  claimManagedPublicHostname(
    input: ManagedPublicHostnameClaimRequest,
  ): Promise<ManagedPublicHostnameClaimResult>;
  /** Workspace identity + handle uniqueness over the shared ledger. */
  readonly workspaces: WorkspacesService;
  /** Canonical Workspace-owned Project ledger. */
  readonly projects: ProjectsService;
  /** Capsule and service-side InstallConfig ledger over the shared store. */
  readonly capsules: CapsulesService;
  /**
   * Canonical WorkspaceMember ledger backing the account-plane member surface.
   * It is persisted by the same store as Workspace/Project/Capsule; there is no
   * membership-domain projection or isolate-local shadow roster.
   */
  readonly members: {
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
  /** Runtime declarations shared by Capsule and Resource authoring flows. */
  readonly interfaces: InterfaceService;
  /**
   * Narrow in-process seam for the bounded scheduled Resource observer. The
   * lease is durable scheduler metadata only; lifecycle and condition updates
   * still go through the canonical ResourceShapeService.
   */
  readonly resourceObservation?: {
    claimCandidate(
      input: ResourceObservationClaimInput,
    ): Promise<ResourceShapeRecord | undefined>;
    observe(
      resource: ResourceShapeRecord,
      actor: ActorContext,
    ): Promise<boolean>;
    finishClaim(
      resourceId: ResourceShapeRecordId,
      leaseId: string,
      attemptedAt: string,
    ): Promise<boolean>;
  };
  /** Bounded restart recovery for direct Resource adapter Run/audit sagas. */
  readonly resourceOperationRepair?: {
    repair(options?: {
      readonly workspaceId?: string;
      readonly limit?: number;
    }): Promise<{
      readonly scanned: number;
      readonly completed: number;
      readonly auditsRepaired: number;
      readonly pending: number;
    }>;
  };
  /**
   * Read-only compatibility-profile projection. It returns evidence only for a
   * fully observed Ready Resource with a durable ResolutionLock; lifecycle
   * mutation remains exclusively on the Resource Deploy API.
   */
  readonly resourceCompatibility?: {
    resolveReadyResource(input: {
      readonly space: string;
      readonly kind: ResourceShapeKind;
      readonly name: string;
    }): Promise<
      | {
          readonly resource: ResourceObject;
          readonly resourceGeneration: number;
          readonly nativeResources: readonly NativeResourceRef[];
        }
      | undefined
    >;
    /**
     * Internal host inventory for bounded reconciliation jobs. This is not
     * mounted as an HTTP route and exposes only coherent Ready evidence.
     */
    listReadyResourcesPage(input: {
      readonly kind: ResourceShapeKind;
      readonly cursor?: string;
      readonly limit?: number;
    }): Promise<{
      readonly items: readonly {
        readonly resourceId: string;
        readonly resource: ResourceObject;
        readonly resourceGeneration: number;
        readonly nativeResources: readonly NativeResourceRef[];
      }[];
      readonly nextCursor?: string;
    }>;
  };
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
  readSourceSnapshotPresentationFile(
    id: string,
    path: string,
  ): Promise<{
    readonly path: string;
    readonly text: string;
    readonly digest: string;
    readonly sizeBytes: number;
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
    },
  ): Promise<PlanRunResponse>;
  /** Capsule-driven destroy-plan: always lands waiting_approval (spec §23). */
  createCapsuleDestroyPlan(
    capsuleId: string,
    options?: {
      readonly runnerProfileId?: string;
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
    options?: { readonly dedupe?: boolean },
  ): Promise<CreateSourceSyncResponse>;
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
  const sharedOpenTofuStore =
    opentofuStore.store ?? new InMemoryOpenTofuControlStore();
  const formRegistryStore =
    options.formRegistryStore ??
    (options.sqlClient
      ? createSqlFormRegistryStore(options.sqlClient)
      : undefined);
  const formRegistryService = formRegistryStore
    ? new FormRegistryService({
        store: formRegistryStore,
        ...(options.formPackageArtifactReader
          ? { artifactReader: options.formPackageArtifactReader }
          : {}),
        ...(options.formPackageVerifier
          ? { verifier: options.formPackageVerifier }
          : {}),
      })
    : undefined;
  const offeringCatalogStore =
    options.offeringCatalogStore ??
    (options.sqlClient
      ? createSqlOfferingCatalogStore(options.sqlClient)
      : new InMemoryOfferingCatalogReader());
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
          credentialRecipeResolver: (id) => credentialRecipeById.get(id),
          credentialDrivers: credentialRecipeDrivers,
          ...(options.managedProviderCredentialIssuer
            ? {
                managedProviderCredentialIssuer:
                  options.managedProviderCredentialIssuer,
              }
            : {}),
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
  // enqueues onto the run queue with `action: "source_sync"`; node/local
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
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
  });
  const capsulesService = new CapsulesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    projects: projectsService,
  });
  const dependenciesService = new DependenciesService({
    store: sharedOpenTofuStore,
    activity: activityService,
    // Serialize the Workspace's dependency-graph cycle check-then-write across
    // isolates when a coordination seam is wired (the Workers adapter injects a
    // DO-backed implementation). Without it, creation stays single-isolate safe.
    ...(options.capsuleCoordination
      ? { coordination: options.capsuleCoordination }
      : {}),
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
  // Seed the required shared InstallConfigs before the service is exposed. The
  // generic Capsule default powers the standard Git URL install flow, so a seed
  // failure is a boot/readiness failure rather than a deferred dashboard error.
  await bootstrapDefaultInstallConfig(sharedOpenTofuStore);
  await bootstrapOperatorInstallConfigs(
    capsulesService,
    options.operatorInstallConfigs,
  );
  opentofuController = new OpenTofuController({
    store: sharedOpenTofuStore,
    activity: activityService,
    ...(options.opentofuRunner ? { runner: options.opentofuRunner } : {}),
    ...(options.opentofuRunnerExecutors
      ? { runnerExecutors: options.opentofuRunnerExecutors }
      : {}),
    allowOperatorScopedProviderConnections:
      options.allowOperatorScopedProviderConnections === true,
    ...(opentofuConnectionVault ? { vault: opentofuConnectionVault } : {}),
    credentialRecipes,
    ...(options.enqueueRun ? { enqueueRun: options.enqueueRun } : {}),
    sourcesService,
    ...(options.artifactReferenceAllocator
      ? { artifactReferenceAllocator: options.artifactReferenceAllocator }
      : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.capsuleCoordination
      ? { capsuleCoordination: options.capsuleCoordination }
      : {}),
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
    ...(options.managedVanityHostnameSlotsPerOwner !== undefined
      ? {
          managedVanityHostnameSlotsPerOwner:
            options.managedVanityHostnameSlotsPerOwner,
        }
      : {}),
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
  const injectedResourceShapeAdapter =
    options.resourceShapeAdapter ??
    (options.resourceShapeAdapterFactory
      ? await options.resourceShapeAdapterFactory({
          controller: opentofuController,
          capsules: capsulesService,
          workspaces: workspacesService,
        })
      : undefined);
  const resourceShapeAdapter = injectedResourceShapeAdapter;
  const resourceShapeStores =
    options.resourceShapeStores ??
    (options.sqlClient
      ? createSqlResourceShapeStores(options.sqlClient)
      : createInMemoryResourceShapeStores());
  // Control-backups domain: exports a Workspace's control ledger as a sealed
  // bundle. Resource exact pins require an explicit host-owned scope mapping;
  // Core never infers matching ids.
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
    ...(options.resolveResourceBackupScope
      ? {
          collectResourceFormPins: async (workspaceId: string) => {
            const resourceScopeId =
              await options.resolveResourceBackupScope!(workspaceId);
            return resourceScopeId
              ? await collectResourceFormPinBackupEntries(
                  resourceShapeStores,
                  resourceScopeId,
                )
              : { status: "ready" as const, entries: [] };
          },
        }
      : {}),
  });
  const resourceFormPinOperations = formRegistryService
    ? new ResourceFormPinOperations({
        stores: resourceShapeStores,
        forms: formRegistryService,
        activity: activityService,
      })
    : undefined;
  const legacyResourceStateAdoptionService =
    new LegacyResourceStateAdoptionService(
      resourceShapeStores,
      sharedOpenTofuStore,
      () => new Date().toISOString(),
    );
  const resolveResourceInterfaceWorkspace =
    options.resolveResourceInterfaceWorkspace;
  const resourceShapeService = resourceShapeAdapter
    ? new ResourceShapeService({
        stores: resourceShapeStores,
        adapter: resourceShapeAdapter,
        activity: activityService,
        operationRuns: sharedOpenTofuStore,
        ...(options.resourceDeploymentAdmission
          ? { deploymentAdmission: options.resourceDeploymentAdmission }
          : {}),
        ...(options.resourceShapeModuleRegistry
          ? { moduleRegistry: options.resourceShapeModuleRegistry }
          : {}),
        ...(options.resourceShapeSchemaRegistry
          ? { schemaRegistry: options.resourceShapeSchemaRegistry }
          : {}),
        ...(formRegistryService ? { formRegistry: formRegistryService } : {}),
        ...(formRegistryService
          ? {
              requiredFormInterfaceAdmission: async ({
                request,
                definition,
              }) => {
                if (
                  !definition.interfaceDescriptors?.some(
                    (descriptor) => descriptor.required === true,
                  )
                ) {
                  return undefined;
                }
                if (!resolveResourceInterfaceWorkspace) {
                  return "required Interface materialization needs an explicit Resource-to-Workspace bridge";
                }
                const workspaceId = await resolveResourceInterfaceWorkspace({
                  resourceSpaceId: request.space,
                  resourceId: formatResourceShapeId(
                    request.space,
                    request.kind,
                    request.name,
                  ),
                });
                return workspaceId
                  ? undefined
                  : "required Interface materialization has no authorized Workspace mapping for this Resource";
              },
            }
          : {}),
        now: () => new Date().toISOString(),
        ...(options.resourceShapeDeleteTimeoutMs !== undefined
          ? { deleteTimeoutMs: options.resourceShapeDeleteTimeoutMs }
          : {}),
        ...(options.resourceShapeAllowedProviderBaseUrls
          ? {
              allowedProviderBaseUrls:
                options.resourceShapeAllowedProviderBaseUrls,
            }
          : {}),
      })
    : undefined;
  const offeringService = new OfferingService({
    catalogs: options.offeringHostComposition?.catalogs
      ? new CompositeOfferingCatalogReader([
          offeringCatalogStore,
          options.offeringHostComposition.catalogs,
        ])
      : offeringCatalogStore,
    resolvers: [
      ...(formRegistryService && resourceShapeService
        ? [
            new FormOfferingSubjectResolver({
              forms: formRegistryService,
              availability: resourceShapeService,
            }),
          ]
        : []),
      ...(options.offeringHostComposition?.resolvers ?? []),
    ],
  });
  const offeringCatalogAdminService = new OfferingCatalogAdminService({
    store: offeringCatalogStore,
  });
  const interfaceStores =
    options.interfaceStores ??
    (options.sqlClient
      ? createSqlInterfaceStores(options.sqlClient)
      : createInMemoryInterfaceStores());
  const interfaceProjectionSink = options.interfaceProjectionSink
    ? withCanonicalResourceProjectionEvidence(
        options.interfaceProjectionSink,
        resourceShapeStores,
      )
    : undefined;
  let interfaceService: InterfaceService;
  interfaceService = new InterfaceService({
    stores: interfaceStores,
    resolver: new OutputBackedInterfaceInputResolver({
      opentofu: sharedOpenTofuStore,
      resources: resourceShapeStores.resources,
      ...(resolveResourceInterfaceWorkspace
        ? { resolveResourceWorkspace: resolveResourceInterfaceWorkspace }
        : {}),
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
        const resource = await resourceShapeStores.resources.get(ownerRef.id);
        if (!resource || !resolveResourceInterfaceWorkspace) return false;
        return (
          (await resolveResourceInterfaceWorkspace(
            resourceInterfaceWorkspaceInput(resource),
          )) === workspaceId
        );
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
        const resource = await resourceShapeStores.resources.get(ownerRef.id);
        if (!resource || !resolveResourceInterfaceWorkspace) return false;
        const resourceWorkspaceId = await resolveResourceInterfaceWorkspace(
          resourceInterfaceWorkspaceInput(resource),
        );
        return (
          resourceWorkspaceId === workspaceId &&
          resource.phase === "Ready" &&
          resource.observedGeneration === resource.generation
        );
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
    hydrateWorkspace: async (workspaceId) => {
      // Crash-safe, Workspace-bounded repair for a succeeded apply whose
      // best-effort terminal observer did not materialize service-side
      // blueprints. Never scan every tenant during service startup.
      let cursor: string | undefined;
      do {
        const page = await capsulesService.listCapsulesPage(workspaceId, {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const capsule of page.items) {
          if (
            (capsule.status !== "active" && capsule.status !== "stale") ||
            !capsule.currentOutputId
          ) {
            continue;
          }
          let config;
          try {
            config = await capsulesService.getInstallConfig(
              capsule.installConfigId,
            );
          } catch (error) {
            if (
              error instanceof OpenTofuControllerError &&
              error.code === "not_found"
            ) {
              continue;
            }
            throw error;
          }
          if (config.interfaceBlueprints?.length) {
            await interfaceService.ensureCapsuleBlueprints({
              workspaceId,
              capsuleId: capsule.id,
              blueprints: config.interfaceBlueprints,
            });
          }
        }
        cursor = page.nextCursor;
      } while (cursor);

      if (resolveResourceInterfaceWorkspace) {
        // Resource lifecycle delivery is also best effort. Rebuild the state
        // needed by this Workspace from the durable Resource ledger so a lost
        // observer cannot leave an old binding usable indefinitely.
        const interfaces = await interfaceService.list({
          workspaceId,
          includeRetired: false,
        });
        const resourceIds = new Set<string>();
        for (const iface of interfaces) {
          if (iface.metadata.ownerRef.kind === "Resource") {
            resourceIds.add(iface.metadata.ownerRef.id);
          }
          for (const input of Object.values(iface.spec.inputs ?? {})) {
            if (input.source === "resource_output") {
              resourceIds.add(input.resourceId);
            }
          }
        }
        const snapshots = await Promise.all(
          [...resourceIds].map(async (resourceId) => {
            const resource =
              await resourceShapeStores.resources.get(resourceId);
            if (!resource) {
              return { resourceId, phase: "retired" as const };
            }
            const mappedWorkspaceId = await resolveResourceInterfaceWorkspace(
              resourceInterfaceWorkspaceInput(resource),
            );
            if (mappedWorkspaceId !== workspaceId) {
              return { resourceId, phase: "not_ready" as const };
            }
            if (
              resource.phase === "Ready" &&
              resource.observedGeneration === resource.generation
            ) {
              return { resourceId, phase: "ready" as const };
            }
            if (resource.phase === "Failed" || resource.phase === "Degraded") {
              return {
                resourceId,
                phase: "unknown" as const,
                message: `Resource is ${resource.phase} in the durable ledger`,
              };
            }
            if (resource.phase === "Deleting") {
              return { resourceId, phase: "terminating" as const };
            }
            if (resource.phase === "Deleted") {
              return { resourceId, phase: "retired" as const };
            }
            return { resourceId, phase: "not_ready" as const };
          }),
        );
        await interfaceService.repairResourceLifecycles(workspaceId, snapshots);
      }
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
  const materializeFormDescriptorInterfaces = async (
    resourceId: string,
  ): Promise<void> => {
    if (!formRegistryService || !resolveResourceInterfaceWorkspace) return;
    const resource = await resourceShapeStores.resources.get(resourceId);
    if (
      !resource?.form ||
      resource.phase !== "Ready" ||
      resource.observedGeneration !== resource.generation
    ) {
      return;
    }
    const workspaceId = await resolveResourceInterfaceWorkspace(
      resourceInterfaceWorkspaceInput(resource),
    );
    if (!workspaceId) return;
    const definition = await formRegistryService.getDefinition(
      resource.form.formRef,
    );
    if (!definition) return;
    await ensureFormDescriptorInterfaces({
      interfaces: interfaceService,
      workspaceId,
      resourceId,
      form: resource.form,
      descriptors: definition.interfaceDescriptors ?? [],
    });
  };
  const degradeRequiredFormInterface = async (
    resourceId: string,
    error: unknown,
  ): Promise<boolean> => {
    if (!formRegistryService) return false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await resourceShapeStores.resources.get(resourceId);
      if (!current?.form) return false;
      const definition = await formRegistryService.getDefinition(
        current.form.formRef,
      );
      const required = definition?.interfaceDescriptors?.some(
        (descriptor) => descriptor.required === true,
      );
      if (!required) return false;
      if (
        current.phase !== "Ready" ||
        current.observedGeneration !== current.generation
      ) {
        return current.phase === "Degraded";
      }
      const at = new Date().toISOString();
      const reason =
        error instanceof RequiredFormInterfaceError
          ? `${error.descriptorName}@${error.descriptorVersion}: ${error.reason}`
          : "required Interface materialization is unavailable";
      const degraded: ResourceShapeRecord = {
        ...current,
        phase: "Degraded",
        conditions: [
          ...(current.conditions ?? []).filter(
            (condition) => condition.type.toLowerCase() !== "ready",
          ),
          {
            type: "Ready",
            status: "false",
            reason: "RequiredInterfaceNotReady",
            message: reason,
            observedGeneration: current.generation,
            lastTransitionAt: at,
          },
        ],
        updatedAt: at,
      };
      const changed = await resourceShapeStores.resources.compareAndSet(
        degraded,
        {
          generation: current.generation,
          phase: current.phase,
          updatedAt: current.updatedAt,
        },
      );
      if (changed.status === "updated") return true;
      if (changed.status === "not_found") return false;
    }
    return false;
  };
  resourceShapeService?.setLifecycleObserver({
    async observe(event) {
      if (!resolveResourceInterfaceWorkspace) {
        if (event.type === "ready") {
          await degradeRequiredFormInterface(
            event.resourceId,
            new Error(
              "required Interface materialization has no Resource-to-Workspace bridge",
            ),
          );
        }
        return;
      }
      const workspaceId = await resolveResourceInterfaceWorkspace(
        resourceLifecycleInterfaceWorkspaceInput(event),
      );
      if (!workspaceId) {
        if (event.type === "ready") {
          await degradeRequiredFormInterface(
            event.resourceId,
            new Error(
              "required Interface materialization has no authorized Workspace mapping",
            ),
          );
        }
        return;
      }
      switch (event.type) {
        case "ready":
          try {
            await materializeFormDescriptorInterfaces(event.resourceId);
          } catch (error) {
            if (await degradeRequiredFormInterface(event.resourceId, error)) {
              await interfaceService.markResourceUnknown(
                workspaceId,
                event.resourceId,
                "required portable Interface did not become Ready",
              );
              return;
            }
            throw error;
          }
          await interfaceService.reconcileResource(
            workspaceId,
            event.resourceId,
          );
          return;
        case "unknown":
          await interfaceService.markResourceUnknown(
            workspaceId,
            event.resourceId,
            `Resource ${event.operation} failed after backend dispatch`,
          );
          return;
        case "terminating":
          await interfaceService.markResourceTerminating(
            workspaceId,
            event.resourceId,
          );
          return;
        case "retired":
          await interfaceService.retireResource(workspaceId, event.resourceId);
      }
    },
  });
  opentofuController.setPlanRunQueuedObserver(async (run) => {
    if (!run.capsuleId) return;
    await interfaceService.markCapsulePlanPending(
      run.workspaceId,
      run.capsuleId,
      run.id,
    );
  });
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
        await interfaceService.reconcileCapsule(run.workspaceId, run.capsuleId);
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
  assertResourceShapeApiAuthOrWarn({
    environment: runtimeConfig.environment,
    exposed: resourceShapeService !== undefined,
    bearerTokenPresent: Boolean(deployControlToken),
    scopedAuthorizerPresent: Boolean(options.resolveResourceShapeActor),
  });
  assertDurableResourceShapeStoresOrWarn({
    environment: runtimeConfig.environment,
    exposed: resourceShapeService !== undefined,
    durable: resourceShapeStores.persistence === "durable",
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
  assertDurableOfferingCatalogStoreOrWarn({
    environment: runtimeConfig.environment,
    exposed: role === "takosumi-api" && Boolean(deployControlToken),
    durable: Boolean(options.offeringCatalogStore ?? options.sqlClient),
  });
  const connectionOAuthHelpers = options.connectionOAuthHelpers;
  const installedResourceShapeKinds =
    options.resourceShapeSchemaRegistry?.kinds() ?? [];
  const enabledResourceShapeKinds = options.enabledResourceShapeKinds ?? [];
  for (const kind of enabledResourceShapeKinds) {
    if (!installedResourceShapeKinds.includes(kind)) {
      throw new TypeError(
        `enabled Resource Shape kind has no installed schema authority: ${kind}`,
      );
    }
  }
  const resourceCapabilities: Partial<TakosumiResourceCapabilities> = {
    ...Object.fromEntries(
      enabledResourceShapeKinds.map((kind) => [
        kind,
        resourceShapeService !== undefined,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(options.resourceCapabilities ?? {}).map(
        ([token, enabled]) => [
          token,
          token === "Stack"
            ? enabled
            : resourceShapeService !== undefined && enabled === true,
        ],
      ),
    ),
  };
  const app = await createApiApp({
    role,
    registerReadinessRoutes: true,
    registerOpenApiRoute: role === "takosumi-api",
    ...(deployControlToken
      ? { getOpenApiBearerToken: () => deployControlToken }
      : {}),
    registerMetricsRoutes:
      role === "takosumi-api" && Boolean(metricsScrapeToken),
    registerResourceShapeRoutes:
      role === "takosumi-api" && resourceShapeService !== undefined,
    registerFormActivationRoutes:
      role === "takosumi-api" &&
      formRegistryService !== undefined &&
      Boolean(deployControlToken),
    registerOfferingCatalogRoutes:
      role === "takosumi-api" && Boolean(deployControlToken),
    registerInterfaceRoutes: role === "takosumi-api",
    resourceCapabilities,
    ...(options.adapterCapabilities
      ? { adapterCapabilities: options.adapterCapabilities }
      : {}),
    ...(options.operatorCapabilities
      ? { operatorCapabilities: options.operatorCapabilities }
      : {}),
    resourceShapeRouteOptions: resourceShapeService
      ? {
          service: resourceShapeService,
          enabledResourceShapeKinds,
          installedResourceShapeKinds,
          ...(options.resolveResourceInterfaceWorkspace
            ? {
                interfaceDeclarations: createPortableDeclarationReader({
                  interfaces: interfaceService,
                  listResources: (space, page) =>
                    resourceShapeService.listPage(space, page),
                  getResource: async (space, kind, name) => {
                    const result = await resourceShapeService.get(
                      space,
                      kind,
                      name,
                    );
                    return result.ok ? result.value : undefined;
                  },
                  resolveWorkspace: options.resolveResourceInterfaceWorkspace,
                  ensureResourceDeclarations: (resource) =>
                    materializeFormDescriptorInterfaces(
                      formatResourceShapeId(
                        resource.metadata.space,
                        resource.kind,
                        resource.metadata.name,
                      ),
                    ),
                }),
              }
            : {}),
          ...(deployControlToken
            ? { getResourceShapeBearerToken: () => deployControlToken }
            : {}),
          ...(options.resolveResourceShapeActor
            ? {
                resolveActor: (c) =>
                  options.resolveResourceShapeActor!(c.req.raw),
              }
            : {}),
          ...(options.authorizeResourceShapeForceDelete
            ? {
                authorizeResourceShapeForceDelete:
                  options.authorizeResourceShapeForceDelete,
              }
            : {}),
        }
      : undefined,
    formActivationRouteOptions:
      formRegistryService && deployControlToken
        ? {
            service: formRegistryService,
            getBearerToken: () => deployControlToken,
          }
        : undefined,
    offeringCatalogRouteOptions: deployControlToken
      ? {
          catalogs: offeringCatalogAdminService,
          offerings: offeringService,
          getBearerToken: () => deployControlToken,
        }
      : undefined,
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
      legacyResourceStateAdoptionService,
      ...(resourceFormPinOperations && options.resolveResourceBackupScope
        ? {
            resourceFormPinOperations,
            resolveResourceFormPinScope: options.resolveResourceBackupScope,
          }
        : {}),
      ...(formRegistryService ? { formRegistryService } : {}),
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
    ...(formRegistryService ? { forms: formRegistryService } : {}),
    offerings: offeringService,
    offeringCatalogs: offeringCatalogAdminService,
    ...(resourceFormPinOperations
      ? { resourceFormPins: resourceFormPinOperations }
      : {}),
    claimManagedPublicHostname: (input) =>
      opentofuController.claimManagedPublicHostname(input),
    workspaces: workspacesService,
    projects: projectsService,
    capsules: capsulesService,
    members,
    connections: connectionsService,
    dependencies: dependenciesService,
    listDependenciesByWorkspace: (workspaceId) =>
      dependenciesService.listByWorkspace(workspaceId),
    outputShares: outputSharesService,
    runGroups: runGroupsService,
    interfaces: interfaceService,
    ...(resourceShapeService
      ? {
          resourceCompatibility: {
            resolveReadyResource: async (input: {
              readonly space: string;
              readonly kind: ResourceShapeKind;
              readonly name: string;
            }) => {
              const resourceId = formatResourceShapeId(
                input.space,
                input.kind,
                input.name,
              );
              const result = await resourceShapeService.get(
                input.space,
                input.kind,
                input.name,
              );
              if (!result.ok || result.value.status?.phase !== "Ready") {
                return undefined;
              }
              // Re-read the durable record and lock after projection. A
              // concurrent update must not pair an older Ready projection with
              // a newer ResolutionLock (or vice versa).
              const [record, lock] = await Promise.all([
                resourceShapeStores.resources.get(resourceId),
                resourceShapeStores.locks.get(resourceId),
              ]);
              if (
                !record ||
                !lock ||
                record.phase !== "Ready" ||
                record.observedGeneration !== record.generation ||
                result.value.status.observedGeneration !==
                  record.observedGeneration
              ) {
                return undefined;
              }
              return structuredClone({
                resource: result.value,
                resourceGeneration: record.generation,
                nativeResources: lock.nativeResources ?? [],
              });
            },
            // --- Resource Shape host inventory
            listReadyResourcesPage: async (input: {
              readonly kind: ResourceShapeKind;
              readonly cursor?: string;
              readonly limit?: number;
            }) => {
              const page =
                await resourceShapeStores.resources.listReadyByKindPage(
                  input.kind,
                  {
                    ...(input.cursor ? { cursor: input.cursor } : {}),
                    ...(input.limit !== undefined
                      ? { limit: input.limit }
                      : {}),
                  },
                );
              const items = await Promise.all(
                page.items.map(async (candidate) => {
                  const currentBefore = await resourceShapeStores.resources.get(
                    candidate.id,
                  );
                  const lockBefore = await resourceShapeStores.locks.get(
                    candidate.id,
                  );
                  const projected = await resourceShapeService.get(
                    candidate.spaceId,
                    candidate.kind,
                    candidate.name,
                  );
                  const lockAfter = await resourceShapeStores.locks.get(
                    candidate.id,
                  );
                  const currentAfter = await resourceShapeStores.resources.get(
                    candidate.id,
                  );
                  const unchanged =
                    currentBefore &&
                    currentAfter &&
                    currentBefore.id === candidate.id &&
                    currentAfter.id === candidate.id &&
                    currentBefore.kind === input.kind &&
                    currentAfter.kind === input.kind &&
                    currentBefore.phase === "Ready" &&
                    currentAfter.phase === "Ready" &&
                    currentBefore.generation === candidate.generation &&
                    currentAfter.generation === candidate.generation &&
                    currentBefore.observedGeneration === candidate.generation &&
                    currentAfter.observedGeneration === candidate.generation &&
                    currentBefore.updatedAt === candidate.updatedAt &&
                    currentAfter.updatedAt === candidate.updatedAt;
                  if (
                    !unchanged ||
                    !projected.ok ||
                    projected.value.status?.phase !== "Ready" ||
                    projected.value.status.observedGeneration !==
                      candidate.generation ||
                    !lockBefore ||
                    !lockAfter ||
                    !matchesApplyLock(lockBefore, lockAfter) ||
                    lockBefore.resourceId !== candidate.id ||
                    lockBefore.locked !== true ||
                    projected.value.status.resolution?.locked !== true ||
                    projected.value.status.resolution.selectedImplementation !==
                      lockBefore.selectedImplementation ||
                    projected.value.status.resolution.target !==
                      lockBefore.target
                  ) {
                    throw new Error(
                      `canonical Ready Resource inventory conflict for ${candidate.id}`,
                    );
                  }
                  return structuredClone({
                    resourceId: candidate.id,
                    resource: projected.value,
                    resourceGeneration: candidate.generation,
                    nativeResources: lockBefore.nativeResources ?? [],
                  });
                }),
              );
              return {
                items,
                ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
              };
            },
            // --- End Resource Shape host inventory
          },
        }
      : {}),
    ...(resourceShapeService
      ? {
          resourceOperationRepair: {
            repair: (options?: {
              readonly workspaceId?: string;
              readonly limit?: number;
            }) => resourceShapeService.repairResourceOperationRuns(options),
          },
          resourceObservation: {
            claimCandidate: (input: ResourceObservationClaimInput) =>
              resourceShapeStores.resources.claimObservationCandidate(input),
            observe: async (
              resource: ResourceShapeRecord,
              actor: ActorContext,
            ) =>
              (
                await resourceShapeService.observeClaimedResource(
                  resource,
                  actor,
                )
              ).ok,
            finishClaim: (
              resourceId: ResourceShapeRecordId,
              leaseId: string,
              attemptedAt: string,
            ) =>
              resourceShapeStores.resources.finishObservationClaim(
                resourceId,
                leaseId,
                attemptedAt,
              ),
          },
        }
      : {}),
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
    readSourceSnapshotPresentationFile: (id, path) =>
      opentofuController.readSourceSnapshotPresentationFile(id, path),
    listRunnerProfiles: () => opentofuController.listRunnerProfiles(),
    createPlanRun: (request) => opentofuController.createPlanRun(request),
    createCapsulePlan: (capsuleId, options) =>
      opentofuController.createCapsulePlan(
        capsuleId,
        {},
        options?.compatibilityReportId || options?.runnerProfileId
          ? {
              ...(options?.compatibilityReportId
                ? { compatibilityReportId: options.compatibilityReportId }
                : {}),
              ...(options?.runnerProfileId
                ? { runnerProfileId: options.runnerProfileId }
                : {}),
            }
          : {},
      ),
    createCapsuleDestroyPlan: (capsuleId, options) =>
      opentofuController.createCapsuleDestroyPlan(
        capsuleId,
        {},
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
    listStateVersions: (capsuleId, params) =>
      opentofuController.listStateVersions(capsuleId, params),
    listStateVersionsByIds: (ids) =>
      opentofuController.listStateVersionsByIds(ids),
    listStateVersionsByWorkspace: (workspaceId) =>
      opentofuController.listStateVersionsByWorkspace(workspaceId),
    getStateVersion: (id) => opentofuController.getStateVersion(id),
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
