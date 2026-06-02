import {
  type SpaceDomainDependencies,
  type SpaceDomainServices,
  createSpaceDomainServices,
} from "./domains/space/mod.ts";
import {
  type DeployBlocker,
  type DeploymentFilter,
  DeploymentService,
  type DeploymentServiceOptions,
  type DeploymentStore,
  type ReferenceDeploySourcePayload,
} from "./domains/deploy/mod.ts";
import {
  DefaultRuntimeMaterializer,
  type ProviderObservationStore,
  type RuntimeDesiredStateStore,
  type RuntimeMaterializer,
  type RuntimeObservedStateStore,
} from "./domains/runtime/mod.ts";
import type {
  BindingSetRevisionStore,
  MigrationLedgerStore,
  ResourceBindingStore,
  ResourceInstanceStore,
} from "./domains/resources/mod.ts";
import type {
  BundledRegistry,
  CatalogReleaseAdoptionStore,
  CatalogReleaseDescriptorStore,
  CatalogReleasePublisherKeyStore,
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "./domains/registry/mod.ts";
import type { AuditStore } from "./domains/audit/mod.ts";
import type {
  ServiceEndpointStore,
  ServiceGrantStore,
  ServiceTrustRecordStore,
} from "./domains/service-endpoints/mod.ts";
import {
  type ActorAdapter,
  type AuthPort,
  LocalActorAdapter,
} from "./adapters/auth/mod.ts";
import {
  type CoordinationPort,
  MemoryCoordinationAdapter,
} from "./adapters/coordination/mod.ts";
import {
  MemoryNotificationSink,
  type NotificationPort,
} from "./adapters/notification/mod.ts";
import { type KmsPort, NoopTestKms } from "./adapters/kms/mod.ts";
import {
  InMemoryRouterConfigAdapter,
  type RouterConfigPort,
} from "./adapters/router/mod.ts";
import { MemoryQueueAdapter, type QueuePort } from "./adapters/queue/mod.ts";
import {
  MemoryObjectStorage,
  type ObjectStoragePort,
} from "./adapters/object-storage/mod.ts";
import {
  LocalOperatorConfig,
  type OperatorConfigPort,
} from "./adapters/operator-config/mod.ts";
import {
  NoopProviderMaterializer,
  type ProviderMaterializer,
} from "./adapters/provider/mod.ts";
import {
  MemoryEncryptedSecretStore,
  type SecretStorePort,
} from "./adapters/secret-store/mod.ts";
import { ImmutableSourceAdapter, type SourcePort } from "./adapters/source/mod.ts";
import {
  MemoryStorageDriver,
  type StorageDriver,
} from "./adapters/storage/mod.ts";
import {
  createAppStores,
  shouldUseStorageBackedStores,
} from "./app_context_stores.ts";
import type { Clock } from "./shared/time.ts";
import type { IdGenerator } from "./shared/ids.ts";
import { log } from "./shared/log.ts";
import { currentRuntime } from "./shared/runtime/index.ts";
import type {
  ActorContext,
  Deployment,
  DeploymentApproval,
  DeploymentInput,
  GroupHead,
  IsoTimestamp,
  TakosumiPlugin,
} from "takosumi-contract/reference/compat";
import {
  InMemoryRuntimeAgentRegistry,
  type RuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "./agents/mod.ts";
import {
  InMemoryObservabilitySink,
  type ObservabilitySink,
  wrapObservabilitySinkWithOtlpMetrics,
} from "./services/observability/mod.ts";
import {
  type EntitlementPolicyPort,
  EntitlementPolicyService,
} from "./services/entitlements/mod.ts";
import type { UsageAggregateStore } from "./services/usage/mod.ts";
import {
  createTakosumiPluginRegistry,
  type TakosumiPluginRegistry,
} from "./plugins/mod.ts";

export interface AppContextOptions {
  readonly clock?: Clock;
  readonly dateClock?: () => Date;
  readonly idGenerator?: IdGenerator;
  readonly uuidFactory?: () => string;
  readonly stores?: Partial<AppStores>;
  readonly adapters?: Partial<AppAdapters>;
  readonly space?: Partial<SpaceDomainDependencies>;
  readonly deploy?: Omit<Partial<DeploymentServiceOptions>, "store">;
  readonly runtimeConfig?: AppRuntimeConfig;
  readonly loadRuntimeConfig?: boolean;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly billing?: {
    readonly baseUrl?: string;
    readonly secret?: string;
  };
  /**
   * Operator-injected managed-hosting service implementations. The Takosumi service
   * ships none by default — a plain import constructs zero managed-hosting
   * services. Operator distributions (takosumi) inject them here. Only
   * `entitlements` has a service consumer (the internal-mutation boundary gate);
   * usage / catalog-release / service-endpoint registries are owned and
   * consumed by the operator distribution, not the service, so they no longer
   * live on the service context at all.
   */
  readonly managedHosting?: {
    readonly entitlements?: EntitlementPolicyPort;
  };
  readonly plugins?: readonly TakosumiPlugin[];
  readonly pluginRegistry?: TakosumiPluginRegistry;
}

export interface AppRuntimeConfig {
  readonly environment?: string;
  readonly processRole?: string;
  readonly allowUnsafeProductionDefaults?: boolean;
}

export interface AppStores {
  readonly space: SpaceDomainDependencies;
  readonly deploy: DeployStores;
  readonly runtime: RuntimeStores;
  readonly resources: ResourceStores;
  readonly registry: RegistryStores;
  readonly audit: AuditStores;
  readonly usage: UsageStores;
  readonly serviceEndpoints: ServiceEndpointStores;
}

export interface DeployStores {
  readonly deploys: DeploymentStore;
}

export interface RuntimeStores {
  readonly desiredStates: RuntimeDesiredStateStore;
  readonly observedStates: RuntimeObservedStateStore;
  readonly providerObservations: ProviderObservationStore;
}

export interface ResourceStores {
  readonly instances: ResourceInstanceStore;
  readonly bindings: ResourceBindingStore;
  readonly bindingSetRevisions: BindingSetRevisionStore;
  readonly migrationLedger: MigrationLedgerStore;
}

export interface RegistryStores {
  readonly descriptors: PackageDescriptorStore;
  readonly resolutions: PackageResolutionStore;
  readonly trustRecords: TrustRecordStore;
  readonly bundledRegistry: BundledRegistry;
  readonly catalogReleases: CatalogReleaseDescriptorStore;
  readonly catalogPublisherKeys: CatalogReleasePublisherKeyStore;
  readonly catalogReleaseAdoptions: CatalogReleaseAdoptionStore;
}

export interface AuditStores {
  readonly events: AuditStore;
}

export interface UsageStores {
  readonly aggregates: UsageAggregateStore;
}

export interface ServiceEndpointStores {
  readonly endpoints: ServiceEndpointStore;
  readonly trustRecords: ServiceTrustRecordStore;
  readonly grants: ServiceGrantStore;
}

export interface AppAdapters {
  readonly actor: ActorAdapter;
  readonly auth: AuthPort;
  readonly coordination: CoordinationPort;
  readonly notifications: NotificationPort;
  readonly operatorConfig: OperatorConfigPort;
  readonly provider: ProviderMaterializer;
  readonly secrets: SecretStorePort;
  readonly source: SourcePort;
  readonly storage: StorageDriver;
  readonly kms: KmsPort;
  readonly observability: ObservabilitySink;
  readonly routerConfig: RouterConfigPort;
  readonly queue: QueuePort;
  readonly objectStorage: ObjectStoragePort;
  readonly runtimeAgent: RuntimeAgentRegistry;
}

const STRICT_RUNTIME_ADAPTERS: readonly (keyof AppAdapters)[] = [
  "auth",
  "coordination",
  "notifications",
  "operatorConfig",
  "storage",
  "source",
  "provider",
  "queue",
  "objectStorage",
  "kms",
  "secrets",
  "routerConfig",
  "observability",
  "runtimeAgent",
];

const STRICT_RUNTIME_FALLBACK_LABELS: Record<keyof AppAdapters, string> = {
  actor: "local actor",
  auth: "local auth",
  coordination: "in-memory coordination",
  notifications: "in-memory notification",
  operatorConfig: "local operator config",
  storage: "in-memory canonical storage",
  source: "inline source",
  provider: "noop provider",
  queue: "in-memory queue",
  objectStorage: "in-memory object storage",
  kms: "noop KMS",
  secrets: "in-memory secret store",
  routerConfig: "in-memory router config",
  observability: "in-memory observability",
  runtimeAgent: "in-memory runtime-agent registry",
};

export interface DeployServices {
  readonly deployments: DeploymentService;
  readonly plans: DeploymentPlanFacade;
  readonly apply: DeploymentApplyFacade;
}

export interface DeploymentPlanFacade {
  createPlan(input: CreateDeploymentPlanInput): Promise<Deployment>;
  getDeployment(id: string): Promise<Deployment | undefined>;
  listDeployments(filter?: DeploymentFilter): Promise<readonly Deployment[]>;
}

export interface CreateDeploymentPlanInput {
  readonly spaceId: string;
  readonly manifest: ReferenceDeploySourcePayload;
  readonly env?: string;
  readonly envName?: string;
  readonly input?: DeploymentInput;
  readonly id?: string;
  readonly createdAt?: IsoTimestamp;
  readonly blockers?: readonly DeployBlocker[];
}

export interface DeploymentApplyFacade {
  applySourcePayload(
    input: ApplyDeploymentSourcePayloadInput,
  ): Promise<ApplyDeploymentResult>;
  applyDeployment(
    input: ApplyDeploymentByIdInput,
  ): Promise<ApplyDeploymentResult>;
  rollbackToDeployment(
    input: RollbackDeploymentFacadeInput,
  ): Promise<ApplyDeploymentResult>;
  getDeployment(id: string): Promise<Deployment | undefined>;
  listDeployments(filter?: DeploymentFilter): Promise<readonly Deployment[]>;
}

export interface ApplyDeploymentSourcePayloadInput {
  readonly spaceId: string;
  readonly manifest: ReferenceDeploySourcePayload;
  readonly env?: string;
  readonly envName?: string;
  readonly input?: DeploymentInput;
  readonly createdAt?: IsoTimestamp;
  readonly createdBy?: string;
  readonly actor?: ActorContext;
  readonly approval?: DeploymentApproval;
  readonly blockers?: readonly DeployBlocker[];
}

export interface ApplyDeploymentByIdInput {
  readonly deploymentId: string;
  readonly appliedAt?: IsoTimestamp;
  readonly approval?: DeploymentApproval;
}

export interface RollbackDeploymentFacadeInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly targetDeploymentId: string;
  readonly advancedAt?: IsoTimestamp;
  readonly reason?: string;
}

export interface ApplyDeploymentResult {
  readonly deployment: Deployment;
  readonly head?: GroupHead;
}

export interface RuntimeServices {
  readonly materializer: RuntimeMaterializer;
}

export interface EntitlementServices {
  readonly policy: EntitlementPolicyPort;
}

export interface ServiceContainer {
  readonly space: SpaceDomainServices;
  readonly deploy: DeployServices;
  readonly runtime: RuntimeServices;
  readonly entitlements: EntitlementServices;
}

export interface AppContext {
  readonly stores: AppStores;
  readonly adapters: AppAdapters;
  readonly services: ServiceContainer;
}

export function createInMemoryAppContext(
  options: AppContextOptions = {},
): AppContext {
  const dateClock = options.dateClock ?? (() => new Date());
  const uuidFactory = options.uuidFactory ?? (() => crypto.randomUUID());

  const adapters = createDefaultAppAdapters({
    ...options,
    dateClock,
    uuidFactory,
  });
  const stores = createAppStores(
    options,
    shouldUseStorageBackedStores(options) ? adapters.storage : undefined,
  );
  const services = createServiceContainer({
    ...options,
    dateClock,
    uuidFactory,
    stores,
  });

  return { stores, adapters, services };
}

export async function createAppContext(
  options: AppContextOptions = {},
): Promise<AppContext> {
  return createInMemoryAppContext(await withOptionalRuntimeConfig(options));
}

export async function createConfiguredAppContext(
  options: AppContextOptions = {},
): Promise<AppContext> {
  return await createAppContext({ ...options, loadRuntimeConfig: true });
}

export function createInMemoryAppStores(
  options: AppContextOptions = {},
): AppStores {
  return createAppStores(options);
}

function createDeploymentPlanFacade(
  deploymentService: DeploymentService,
): DeploymentPlanFacade {
  return {
    createPlan: (input) =>
      deploymentService.resolveDeployment({
        spaceId: input.spaceId,
        manifest: input.manifest,
        env: input.env,
        envName: input.envName,
        input: input.input,
        id: input.id,
        createdAt: input.createdAt,
        blockers: input.blockers,
      }),
    getDeployment: (id) => deploymentService.getDeployment(id),
    listDeployments: (filter = {}) => deploymentService.listDeployments(filter),
  };
}

function createDeploymentApplyFacade(
  deploymentService: DeploymentService,
  store: DeploymentStore,
): DeploymentApplyFacade {
  const applyDeployment = async (
    input: ApplyDeploymentByIdInput,
  ): Promise<ApplyDeploymentResult> => {
    const deployment = await deploymentService.applyDeployment({
      deploymentId: input.deploymentId,
      appliedAt: input.appliedAt,
      approval: input.approval,
    });
    const head = await store.getGroupHead({
      spaceId: deployment.space_id,
      groupId: deployment.group_id,
    });
    return { deployment, head };
  };

  const rollbackToDeployment = async (
    input: RollbackDeploymentFacadeInput,
  ): Promise<ApplyDeploymentResult> => {
    const head = await deploymentService.rollbackGroup({
      spaceId: input.spaceId,
      groupId: input.groupId,
      targetDeploymentId: input.targetDeploymentId,
      advancedAt: input.advancedAt,
      reason: input.reason,
    });
    const deployment = await store.getDeployment(input.targetDeploymentId);
    if (!deployment) {
      throw new Error(
        `rollback target disappeared: ${input.targetDeploymentId}`,
      );
    }
    return { deployment, head };
  };

  return {
    applySourcePayload: async (input) => {
      const resolved = await deploymentService.resolveDeployment({
        spaceId: input.spaceId,
        manifest: input.manifest,
        env: input.env,
        envName: input.envName,
        input: input.input,
        createdAt: input.createdAt,
        blockers: input.blockers,
      });
      return await applyDeployment({
        deploymentId: resolved.id,
        appliedAt: input.createdAt,
        approval: input.approval,
      });
    },
    applyDeployment,
    rollbackToDeployment,
    getDeployment: (id) => deploymentService.getDeployment(id),
    listDeployments: (filter = {}) => deploymentService.listDeployments(filter),
  };
}

export function createDefaultAppAdapters(
  options: AppContextOptions & {
    readonly dateClock?: () => Date;
    readonly uuidFactory?: () => string;
  } = {},
): AppAdapters {
  const dateClock = options.dateClock ?? (() => new Date());
  const uuidFactory = options.uuidFactory ?? (() => crypto.randomUUID());
  assertNoStrictRuntimeAdapterFallbacks(options);
  warnAboutDevAdapterFallbacks(options);
  const localActor = new LocalActorAdapter();
  const actor = options.adapters?.actor ?? localActor;
  const storage = options.adapters?.storage ?? new MemoryStorageDriver();
  const observability = wrapObservabilitySinkWithOtlpMetrics(
    options.adapters?.observability ?? new InMemoryObservabilitySink(),
    options.runtimeEnv,
  );
  const runtimeAgent = options.adapters?.runtimeAgent ??
    new InMemoryRuntimeAgentRegistry({
      clock: dateClock,
      idGenerator: uuidFactory,
      ledger: new StorageBackedWorkLedger(storage),
    });
  return {
    actor,
    auth: options.adapters?.auth ?? localActor,
    coordination: options.adapters?.coordination ??
      new MemoryCoordinationAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    notifications: options.adapters?.notifications ??
      new MemoryNotificationSink({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    operatorConfig: options.adapters?.operatorConfig ??
      new LocalOperatorConfig({ clock: dateClock }),
    provider: options.adapters?.provider ??
      new NoopProviderMaterializer({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    secrets: options.adapters?.secrets ??
      new MemoryEncryptedSecretStore({
        clock: dateClock,
        idGenerator: uuidFactory,
        // Pass runtimeEnv when supplied so the constructor selects the
        // configured encryption boundary and fails closed if no key is
        // configured for production-like environments.
        ...(options.runtimeEnv ? { env: options.runtimeEnv } : {}),
      }),
    source: options.adapters?.source ??
      new ImmutableSourceAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    storage,
    kms: options.adapters?.kms ??
      new NoopTestKms({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    observability,
    routerConfig: options.adapters?.routerConfig ??
      new InMemoryRouterConfigAdapter({ clock: dateClock }),
    queue: options.adapters?.queue ??
      new MemoryQueueAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    objectStorage: options.adapters?.objectStorage ??
      new MemoryObjectStorage({ clock: dateClock }),
    runtimeAgent,
  };
}

async function withOptionalRuntimeConfig(
  options: AppContextOptions,
): Promise<AppContextOptions> {
  if (options.runtimeConfig || !options.loadRuntimeConfig) return options;
  const configModule = await importRuntimeConfigModule();
  if (!configModule) return options;
  const runtimeConfig = await configModule.loadRuntimeConfigFromEnv({
    env: options.runtimeEnv,
  });
  return { ...options, runtimeConfig };
}

async function importRuntimeConfigModule(): Promise<
  | {
    readonly loadRuntimeConfigFromEnv: (
      options?: { readonly env?: Record<string, string | undefined> },
    ) => Promise<AppRuntimeConfig>;
  }
  | undefined
> {
  try {
    return await import("./config/mod.ts");
  } catch (error) {
    if (
      error instanceof TypeError || currentRuntime().fs.isNotFoundError(error)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Build the canonical `TakosumiPluginRegistry` from the operator-supplied
 * `options.plugins` array. The registry is consulted by `InstallerPipeline`
 * to resolve exact kind references to plugins that materialize them.
 */
export function buildTakosumiPluginRegistry(
  options: AppContextOptions = {},
): TakosumiPluginRegistry {
  return options.pluginRegistry ??
    createTakosumiPluginRegistry(options.plugins ?? []);
}

function assertNoStrictRuntimeAdapterFallbacks(
  options: AppContextOptions,
): void {
  const environment = options.runtimeConfig?.environment;
  if (environment !== "production" && environment !== "staging") return;
  for (const adapterKey of STRICT_RUNTIME_ADAPTERS) {
    if (options.adapters?.[adapterKey]) continue;
    if (adapterKey === "runtimeAgent" && options.adapters?.storage) continue;
    throw new Error(
      `${environment} runtime requires an explicit ${adapterKey} adapter; refusing ${
        STRICT_RUNTIME_FALLBACK_LABELS[adapterKey]
      } fallback`,
    );
  }
}

/**
 * Dev / local fallback warning. In non-strict environments the service will
 * silently activate in-memory implementations for any adapter the operator
 * did not configure. That makes "git clone && takosumi server" Just Work,
 * but it also means an operator who forgot to wire Postgres won't notice
 * their state is volatile until first restart wipes the canonical store.
 *
 * Logs a single boot-time warning listing the strict-runtime adapters that
 * fell back to in-memory; set `TAKOSUMI_LOG_LEVEL=warn` (or `error`) to
 * suppress if the operator deliberately wants the in-memory mode.
 */
function warnAboutDevAdapterFallbacks(options: AppContextOptions): void {
  const environment = options.runtimeConfig?.environment;
  if (environment === "production" || environment === "staging") return;
  const logLevel = options.runtimeEnv?.TAKOSUMI_LOG_LEVEL ?? "info";
  if (logLevel === "error" || logLevel === "warn") return;
  // Skip when the caller did not pass any adapters at all. This is the
  // signature of a unit test or exploratory boot, not a misconfigured
  // operator — emitting here would just spam test output. Operators who
  // explicitly inject some adapters (production-like setup) still see
  // warnings for the ones they missed.
  if (!options.adapters) return;
  const fallbacks: string[] = [];
  for (const adapterKey of STRICT_RUNTIME_ADAPTERS) {
    if (options.adapters?.[adapterKey]) continue;
    if (adapterKey === "runtimeAgent" && options.adapters?.storage) continue;
    fallbacks.push(adapterKey);
  }
  if (fallbacks.length === 0) return;
  log.warn("service.boot.in_memory_fallbacks", {
    adapters: fallbacks,
    hint: "pass `adapters` explicitly to persist state across restarts. " +
      "Set TAKOSUMI_LOG_LEVEL=warn to suppress this notice.",
  });
}

export function createServiceContainer(
  options: AppContextOptions & {
    readonly stores?: AppStores;
    readonly dateClock?: () => Date;
    readonly uuidFactory?: () => string;
  } = {},
): ServiceContainer {
  const stores = options.stores ?? createInMemoryAppStores(options);
  const dateClock = options.dateClock ?? (() => new Date());
  const uuidFactory = options.uuidFactory ?? (() => crypto.randomUUID());
  const deploymentService = new DeploymentService({
    ...options.deploy,
    store: stores.deploy.deploys,
    clock: options.deploy?.clock ?? dateClock,
    idFactory: options.deploy?.idFactory ?? uuidFactory,
    // Propagate the runtime environment so the deploy service fails CLOSED on
    // production / staging when no real providerAdapter is wired, instead of
    // silently advancing GroupHead via SYNTHETIC_PROVIDER_ADAPTER.
    environment: options.deploy?.environment ??
      options.runtimeConfig?.environment,
  });
  return {
    space: createSpaceDomainServices(stores.space),
    deploy: {
      deployments: deploymentService,
      plans: createDeploymentPlanFacade(deploymentService),
      apply: createDeploymentApplyFacade(
        deploymentService,
        stores.deploy.deploys,
      ),
    },
    runtime: {
      materializer: new DefaultRuntimeMaterializer({ clock: dateClock }),
    },
    entitlements: {
      policy: options.managedHosting?.entitlements ??
        new EntitlementPolicyService({
          memberships: stores.space.memberships,
        }),
    },
  };
}
