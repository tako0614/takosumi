import {
  type CoreDomainDependencies,
  type CoreDomainServices,
  createCoreDomainServices,
  createInMemoryCoreDomainDependencies,
} from "./domains/core/mod.ts";
import {
  type DeployBlocker,
  type DeploymentFilter,
  DeploymentService,
  type DeploymentServiceOptions,
  type DeploymentStore,
  InMemoryDeploymentStore,
  type PublicDeployManifest,
} from "./domains/deploy/mod.ts";
import {
  DefaultRuntimeMaterializer,
  InMemoryProviderObservationStore,
  InMemoryRuntimeDesiredStateStore,
  InMemoryRuntimeObservedStateStore,
  type ProviderObservationStore,
  type RuntimeDesiredStateStore,
  type RuntimeMaterializer,
  type RuntimeObservedStateStore,
} from "./domains/runtime/mod.ts";
import {
  type BindingSetRevisionStore,
  InMemoryBindingSetRevisionStore,
  InMemoryMigrationLedgerStore,
  InMemoryResourceBindingStore,
  InMemoryResourceInstanceStore,
  type MigrationLedgerStore,
  type ResourceBindingStore,
  type ResourceInstanceStore,
} from "./domains/resources/mod.ts";
import {
  type BundledRegistry,
  InMemoryBundledRegistry,
  InMemoryPackageDescriptorStore,
  InMemoryPackageResolutionStore,
  InMemoryTrustRecordStore,
  type PackageDescriptorStore,
  type PackageResolutionStore,
  type TrustRecordStore,
} from "./domains/registry/mod.ts";
import { type AuditStore, InMemoryAuditStore } from "./domains/audit/mod.ts";
import {
  InMemoryServiceEndpointStore,
  InMemoryServiceGrantStore,
  InMemoryServiceTrustRecordStore,
  ServiceEndpointRegistry,
  type ServiceEndpointStore,
  type ServiceGrantStore,
  type ServiceTrustRecordStore,
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
import {
  ImmutableManifestSourceAdapter,
  type SourcePort,
} from "./adapters/source/mod.ts";
import {
  MemoryStorageDriver,
  type StorageDriver,
  type StorageTransaction,
} from "./adapters/storage/mod.ts";
import type { Clock } from "./shared/time.ts";
import type { IdGenerator } from "./shared/ids.ts";
import {
  type ActorContext,
  type Deployment,
  type DeploymentApproval,
  type DeploymentInput,
  type GroupHead,
  type IsoTimestamp,
  type JsonObject,
  type KernelPluginClientRegistry,
  type KernelPluginPortKind,
  TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
} from "takosumi-contract";
import {
  InMemoryRuntimeAgentRegistry,
  type RuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "./agents/mod.ts";
import {
  InMemoryObservabilitySink,
  type ObservabilitySink,
} from "./services/observability/mod.ts";
import { EntitlementPolicyService } from "./services/entitlements/mod.ts";
import {
  HttpBillingPort,
  InMemoryUsageAggregateStore,
  type UsageAggregateStore,
  UsageProjectionService,
} from "./services/usage/mod.ts";
import {
  createKernelPluginRegistry,
  createPluginAdapterOverrides,
  createReferenceKernelPlugin,
  type KernelPluginRegistry,
  type TakosPaaSKernelPlugin,
} from "./plugins/mod.ts";

export interface AppContextOptions {
  readonly clock?: Clock;
  readonly dateClock?: () => Date;
  readonly idGenerator?: IdGenerator;
  readonly uuidFactory?: () => string;
  readonly stores?: Partial<AppStores>;
  readonly adapters?: Partial<AppAdapters>;
  readonly core?: Partial<CoreDomainDependencies>;
  readonly deploy?: Omit<Partial<DeploymentServiceOptions>, "store">;
  readonly runtimeConfig?: AppRuntimeConfig;
  readonly loadRuntimeConfig?: boolean;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly billing?: {
    readonly baseUrl?: string;
    readonly secret?: string;
  };
  readonly plugins?: readonly TakosPaaSKernelPlugin[];
  readonly pluginRegistry?: KernelPluginRegistry;
  readonly pluginClientRegistry?: KernelPluginClientRegistry;
}

export interface AppRuntimeConfig {
  readonly plugins?: Partial<Record<KernelPluginPortKind, string>>;
  readonly pluginConfig?: JsonObject;
  readonly environment?: string;
  readonly processRole?: string;
  readonly allowUnsafeProductionDefaults?: boolean;
  readonly routes?: {
    readonly publicRoutesEnabled?: boolean;
  };
}

export interface AppStores {
  readonly core: CoreDomainDependencies;
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

const STRICT_RUNTIME_KERNEL_PORTS = [
  "auth",
  "coordination",
  "notification",
  "operator-config",
  "storage",
  "source",
  "provider",
  "queue",
  "object-storage",
  "kms",
  "secret-store",
  "router-config",
  "observability",
  "runtime-agent",
] as const satisfies readonly KernelPluginPortKind[];

const STRICT_RUNTIME_PORT_ADAPTERS: Record<
  (typeof STRICT_RUNTIME_KERNEL_PORTS)[number],
  keyof AppAdapters
> = {
  auth: "auth",
  coordination: "coordination",
  notification: "notifications",
  "operator-config": "operatorConfig",
  storage: "storage",
  source: "source",
  provider: "provider",
  queue: "queue",
  "object-storage": "objectStorage",
  kms: "kms",
  "secret-store": "secrets",
  "router-config": "routerConfig",
  observability: "observability",
  "runtime-agent": "runtimeAgent",
};

const STRICT_RUNTIME_FALLBACK_LABELS: Record<
  (typeof STRICT_RUNTIME_KERNEL_PORTS)[number],
  string
> = {
  auth: "local auth",
  coordination: "in-memory coordination",
  notification: "in-memory notification",
  "operator-config": "local operator config",
  storage: "in-memory canonical storage",
  source: "inline manifest source",
  provider: "noop provider",
  queue: "in-memory queue",
  "object-storage": "in-memory object storage",
  kms: "noop KMS",
  "secret-store": "in-memory secret store",
  "router-config": "in-memory router config",
  observability: "in-memory observability",
  "runtime-agent": "in-memory runtime-agent registry",
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
  readonly manifest: PublicDeployManifest;
  readonly env?: string;
  readonly envName?: string;
  readonly input?: DeploymentInput;
  readonly id?: string;
  readonly createdAt?: IsoTimestamp;
  readonly blockers?: readonly DeployBlocker[];
}

export interface DeploymentApplyFacade {
  applyManifest(
    input: ApplyDeploymentManifestInput,
  ): Promise<ApplyDeploymentResult>;
  applyDeployment(
    input: ApplyDeploymentByIdInput,
  ): Promise<ApplyDeploymentResult>;
  rollbackToDeployment(
    input: RollbackDeploymentFacadeInput,
  ): Promise<ApplyDeploymentResult>;
  rollbackToActivation(
    input: RollbackDeploymentFacadeInput,
  ): Promise<ApplyDeploymentResult>;
  getDeployment(id: string): Promise<Deployment | undefined>;
  listDeployments(filter?: DeploymentFilter): Promise<readonly Deployment[]>;
}

export interface ApplyDeploymentManifestInput {
  readonly spaceId: string;
  readonly manifest: PublicDeployManifest;
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

export interface UsageServices {
  readonly projection: UsageProjectionService;
}

export interface ServiceEndpointServices {
  readonly registry: ServiceEndpointRegistry;
}

export interface EntitlementServices {
  readonly policy: EntitlementPolicyService;
}

export interface ServiceContainer {
  readonly core: CoreDomainServices;
  readonly deploy: DeployServices;
  readonly runtime: RuntimeServices;
  readonly usage: UsageServices;
  readonly serviceEndpoints: ServiceEndpointServices;
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

function createAppStores(
  options: AppContextOptions = {},
  storageDriver?: StorageDriver,
): AppStores {
  if (storageDriver) {
    return createStorageBackedAppStores(options, storageDriver);
  }
  const registryStores = createRegistryStores(options.stores?.registry);
  return {
    core: createInMemoryCoreDomainDependencies({
      ...options.core,
      clock: options.core?.clock ?? options.clock,
      idGenerator: options.core?.idGenerator ?? options.idGenerator,
      ...options.stores?.core,
    }),
    deploy: {
      deploys: options.stores?.deploy?.deploys ??
        new InMemoryDeploymentStore(),
    },
    runtime: {
      desiredStates: options.stores?.runtime?.desiredStates ??
        new InMemoryRuntimeDesiredStateStore(),
      observedStates: options.stores?.runtime?.observedStates ??
        new InMemoryRuntimeObservedStateStore(),
      providerObservations: options.stores?.runtime?.providerObservations ??
        new InMemoryProviderObservationStore(),
    },
    resources: {
      instances: options.stores?.resources?.instances ??
        new InMemoryResourceInstanceStore(),
      bindings: options.stores?.resources?.bindings ??
        new InMemoryResourceBindingStore(),
      bindingSetRevisions: options.stores?.resources?.bindingSetRevisions ??
        new InMemoryBindingSetRevisionStore(),
      migrationLedger: options.stores?.resources?.migrationLedger ??
        new InMemoryMigrationLedgerStore(),
    },
    registry: registryStores,
    audit: {
      events: options.stores?.audit?.events ?? new InMemoryAuditStore(),
    },
    usage: {
      aggregates: options.stores?.usage?.aggregates ??
        new InMemoryUsageAggregateStore(),
    },
    serviceEndpoints: {
      endpoints: options.stores?.serviceEndpoints?.endpoints ??
        new InMemoryServiceEndpointStore(),
      trustRecords: options.stores?.serviceEndpoints?.trustRecords ??
        new InMemoryServiceTrustRecordStore(),
      grants: options.stores?.serviceEndpoints?.grants ??
        new InMemoryServiceGrantStore(),
    },
  };
}

function shouldUseStorageBackedStores(options: AppContextOptions): boolean {
  return Boolean(
    options.adapters?.storage || options.runtimeConfig?.plugins?.storage,
  );
}

function createStorageBackedAppStores(
  options: AppContextOptions,
  driver: StorageDriver,
): AppStores {
  const registryStores = {
    descriptors: options.stores?.registry?.descriptors ??
      storageBackedStore(driver, (tx) => tx.registry.descriptors),
    resolutions: options.stores?.registry?.resolutions ??
      storageBackedStore(driver, (tx) => tx.registry.resolutions),
    trustRecords: options.stores?.registry?.trustRecords ??
      storageBackedStore(driver, (tx) => tx.registry.trustRecords),
    bundledRegistry: options.stores?.registry?.bundledRegistry ??
      storageBackedStore(driver, (tx) => tx.registry.bundledRegistry),
  };
  return {
    core: createInMemoryCoreDomainDependencies({
      ...options.core,
      clock: options.core?.clock ?? options.clock,
      idGenerator: options.core?.idGenerator ?? options.idGenerator,
      spaces: options.stores?.core?.spaces ??
        storageBackedStore(driver, (tx) => tx.core.spaces),
      groups: options.stores?.core?.groups ??
        storageBackedStore(driver, (tx) => tx.core.groups),
      memberships: options.stores?.core?.memberships ??
        storageBackedStore(driver, (tx) => tx.core.spaceMemberships),
    }),
    deploy: {
      deploys: options.stores?.deploy?.deploys ??
        storageBackedStore(driver, (tx) => tx.deploy.deploys, {
          missingOptionalMethods: [
            "getDefaultRollbackValidators",
            "getGroupHeadHistory",
            "listObservations",
          ],
        }),
    },
    runtime: {
      desiredStates: options.stores?.runtime?.desiredStates ??
        storageBackedStore(driver, (tx) => tx.runtime.desiredStates),
      observedStates: options.stores?.runtime?.observedStates ??
        storageBackedStore(driver, (tx) => tx.runtime.observedStates),
      providerObservations: options.stores?.runtime?.providerObservations ??
        storageBackedStore(driver, (tx) => tx.runtime.providerObservations),
    },
    resources: {
      instances: options.stores?.resources?.instances ??
        storageBackedStore(driver, (tx) => tx.resources.instances),
      bindings: options.stores?.resources?.bindings ??
        storageBackedStore(driver, (tx) => tx.resources.bindings),
      bindingSetRevisions: options.stores?.resources?.bindingSetRevisions ??
        storageBackedStore(driver, (tx) => tx.resources.bindingSetRevisions),
      migrationLedger: options.stores?.resources?.migrationLedger ??
        storageBackedStore(driver, (tx) => tx.resources.migrationLedger),
    },
    registry: registryStores,
    audit: {
      events: options.stores?.audit?.events ??
        storageBackedStore(driver, (tx) => tx.audit.events),
    },
    usage: {
      aggregates: options.stores?.usage?.aggregates ??
        storageBackedStore(driver, (tx) => tx.usage.aggregates),
    },
    serviceEndpoints: {
      endpoints: options.stores?.serviceEndpoints?.endpoints ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.endpoints),
      trustRecords: options.stores?.serviceEndpoints?.trustRecords ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.trustRecords),
      grants: options.stores?.serviceEndpoints?.grants ??
        storageBackedStore(driver, (tx) => tx.serviceEndpoints.grants),
    },
  };
}

function storageBackedStore<TStore extends object>(
  driver: StorageDriver,
  select: (transaction: StorageTransaction) => TStore,
  options: {
    readonly missingOptionalMethods?: readonly string[];
  } = {},
): TStore {
  const missingOptionalMethods = new Set(options.missingOptionalMethods ?? []);
  return new Proxy({}, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      if (missingOptionalMethods.has(property)) return undefined;
      return (...args: readonly unknown[]) =>
        driver.transaction((transaction) => {
          const store = select(transaction) as Record<string, unknown>;
          const method = store[property];
          if (typeof method !== "function") {
            throw new Error(`storage store method not found: ${property}`);
          }
          return method.apply(store, args);
        });
    },
  }) as TStore;
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
    applyManifest: async (input) => {
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
    rollbackToActivation: rollbackToDeployment,
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
  const pluginAdapters = createConfiguredPluginAdapters({
    ...options,
    dateClock,
    uuidFactory,
  });
  assertNoStrictRuntimeAdapterFallbacks(options);
  const localActor = new LocalActorAdapter();
  const actor = options.adapters?.actor ?? pluginAdapters.actor ?? localActor;
  const storage = options.adapters?.storage ??
    pluginAdapters.storage ??
    new MemoryStorageDriver();
  const runtimeAgent = options.adapters?.runtimeAgent ??
    pluginAdapters.runtimeAgent ??
    new InMemoryRuntimeAgentRegistry({
      clock: dateClock,
      idGenerator: uuidFactory,
      ledger: new StorageBackedWorkLedger(storage),
    });
  return {
    actor,
    auth: options.adapters?.auth ?? pluginAdapters.auth ?? localActor,
    coordination: options.adapters?.coordination ??
      pluginAdapters.coordination ??
      new MemoryCoordinationAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    notifications: options.adapters?.notifications ??
      pluginAdapters.notifications ??
      new MemoryNotificationSink({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    operatorConfig: options.adapters?.operatorConfig ??
      pluginAdapters.operatorConfig ??
      new LocalOperatorConfig({ clock: dateClock }),
    provider: options.adapters?.provider ??
      pluginAdapters.provider ??
      new NoopProviderMaterializer({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    secrets: options.adapters?.secrets ??
      pluginAdapters.secrets ??
      new MemoryEncryptedSecretStore({
        clock: dateClock,
        idGenerator: uuidFactory,
        // Pass runtimeEnv when supplied so the constructor selects the
        // configured encryption boundary and fails closed if no key is
        // configured for production-like environments.
        ...(options.runtimeEnv ? { env: options.runtimeEnv } : {}),
      }),
    source: options.adapters?.source ??
      pluginAdapters.source ??
      new ImmutableManifestSourceAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    storage,
    kms: options.adapters?.kms ??
      pluginAdapters.kms ??
      new NoopTestKms({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    observability: options.adapters?.observability ??
      pluginAdapters.observability ??
      new InMemoryObservabilitySink(),
    routerConfig: options.adapters?.routerConfig ??
      pluginAdapters.routerConfig ??
      new InMemoryRouterConfigAdapter({ clock: dateClock }),
    queue: options.adapters?.queue ??
      pluginAdapters.queue ??
      new MemoryQueueAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    objectStorage: options.adapters?.objectStorage ??
      pluginAdapters.objectStorage ??
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
    if (error instanceof TypeError || error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
}

function createConfiguredPluginAdapters(
  options: AppContextOptions & {
    readonly dateClock: () => Date;
    readonly uuidFactory: () => string;
  },
): Partial<AppAdapters> {
  const selectedPluginIds = selectedKernelPluginIds(options.runtimeConfig);
  if (Object.keys(selectedPluginIds).length === 0) return {};
  const registry = options.pluginRegistry ??
    createKernelPluginRegistry(withReferencePlugin(options.plugins ?? []));
  return createPluginAdapterOverrides({
    registry,
    selectedPluginIds,
    context: {
      kernelApiVersion: TAKOSUMI_KERNEL_PLUGIN_API_VERSION,
      environment: options.runtimeConfig?.environment ?? "local",
      processRole: options.runtimeConfig?.processRole ?? "takosumi-api",
      selectedPluginIds,
      operatorConfig: options.runtimeConfig?.pluginConfig,
      clientRegistry: options.pluginClientRegistry,
      clock: options.dateClock,
      idGenerator: options.uuidFactory,
    },
  });
}

function withReferencePlugin(
  plugins: readonly TakosPaaSKernelPlugin[],
): readonly TakosPaaSKernelPlugin[] {
  const externalPlugins = dedupePluginsById(plugins);
  return externalPlugins.some((plugin) =>
      plugin.manifest.id === "takos.kernel.reference"
    )
    ? externalPlugins
    : [createReferenceKernelPlugin(), ...externalPlugins];
}

function dedupePluginsById(
  plugins: readonly TakosPaaSKernelPlugin[],
): readonly TakosPaaSKernelPlugin[] {
  const seen = new Set<string>();
  const out: TakosPaaSKernelPlugin[] = [];
  for (const plugin of plugins) {
    if (seen.has(plugin.manifest.id)) continue;
    seen.add(plugin.manifest.id);
    out.push(plugin);
  }
  return out;
}

function selectedKernelPluginIds(
  config: AppRuntimeConfig | undefined,
): Partial<Record<KernelPluginPortKind, string>> {
  return { ...(config?.plugins ?? {}) };
}

function assertNoStrictRuntimeAdapterFallbacks(
  options: AppContextOptions,
): void {
  const environment = options.runtimeConfig?.environment;
  if (environment !== "production" && environment !== "staging") return;
  const selectedPluginIds = selectedKernelPluginIds(options.runtimeConfig);
  for (const port of STRICT_RUNTIME_KERNEL_PORTS) {
    const adapterKey = STRICT_RUNTIME_PORT_ADAPTERS[port];
    if (options.adapters?.[adapterKey] || selectedPluginIds[port]) continue;
    if (
      port === "runtime-agent" &&
      (options.adapters?.storage || selectedPluginIds.storage)
    ) continue;
    throw new Error(
      `${environment} runtime requires an explicit ${port} adapter or ${port} kernel plugin; refusing ${
        STRICT_RUNTIME_FALLBACK_LABELS[port]
      } fallback`,
    );
  }
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
  });
  return {
    core: createCoreDomainServices(stores.core),
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
    usage: {
      projection: new UsageProjectionService({
        aggregates: stores.usage.aggregates,
        billing: createBillingPort(options),
        clock: dateClock,
      }),
    },
    serviceEndpoints: {
      registry: new ServiceEndpointRegistry(stores.serviceEndpoints),
    },
    entitlements: {
      policy: new EntitlementPolicyService({
        memberships: stores.core.memberships,
      }),
    },
  };
}

function createBillingPort(options: AppContextOptions) {
  const baseUrl = options.billing?.baseUrl ??
    options.runtimeEnv?.TAKOS_APP_BILLING_BASE_URL;
  const secret = options.billing?.secret ??
    options.runtimeEnv?.TAKOS_APP_BILLING_SECRET;
  if (!baseUrl || !secret) return undefined;
  return new HttpBillingPort({ baseUrl, secret });
}

function createRegistryStores(
  overrides?: Partial<RegistryStores>,
): RegistryStores {
  const descriptors = overrides?.descriptors ??
    new InMemoryPackageDescriptorStore();
  const resolutions = overrides?.resolutions ??
    new InMemoryPackageResolutionStore();
  const trustRecords = overrides?.trustRecords ??
    new InMemoryTrustRecordStore();
  return {
    descriptors,
    resolutions,
    trustRecords,
    bundledRegistry: overrides?.bundledRegistry ??
      new InMemoryBundledRegistry(descriptors, resolutions, trustRecords),
  };
}
