import {
  type MembershipDomainDependencies,
  type MembershipDomainServices,
  createMembershipDomainServices,
} from "./domains/membership/mod.ts";
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
  PackageDescriptorStore,
  PackageResolutionStore,
  TrustRecordStore,
} from "./domains/registry/mod.ts";
import type { AuditStore } from "./domains/audit/mod.ts";
import type {
  ServiceEndpointStore,
  EndpointServiceGrantStore,
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
  ImmutableSourceAdapter,
  type SourcePort,
} from "./adapters/source/mod.ts";
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
import type { OperatorImplementation } from "takosumi-contract/reference/implementation";
import {
  InMemoryRuntimeAgentRegistry,
  type RuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "./agents/mod.ts";
import {
  InMemoryObservabilitySink,
  type ObservabilitySink,
  wrapObservabilitySinkWithOtlpMetrics,
} from "./domains/observability/mod.ts";
import {
  type EntitlementPolicyPort,
  EntitlementPolicyService,
} from "./domains/entitlements/mod.ts";
import {
  createOperatorImplementationRegistry,
  type OperatorImplementationRegistry,
} from "./implementation-bindings/mod.ts";

export interface AppContextOptions {
  readonly clock?: Clock;
  readonly dateClock?: () => Date;
  readonly idGenerator?: IdGenerator;
  readonly uuidFactory?: () => string;
  readonly stores?: Partial<AppStores>;
  readonly adapters?: Partial<AppAdapters>;
  readonly space?: Partial<MembershipDomainDependencies>;
  readonly runtimeConfig?: AppRuntimeConfig;
  readonly loadRuntimeConfig?: boolean;
  readonly runtimeEnv?: Record<string, string | undefined>;
  /**
   * Operator-injected platform service implementations. The Takosumi service
   * ships none by default — a plain import constructs zero platform
   * services. Operator distributions (takosumi) inject them here. Only
   * `entitlements` has a service consumer (the internal-mutation boundary gate);
   * usage / catalog-release / service-endpoint registries are owned and
   * consumed by the operator distribution, not the service, so they no longer
   * live on the service context at all.
   */
  readonly platformServices?: {
    readonly entitlements?: EntitlementPolicyPort;
  };
  readonly implementations?: readonly OperatorImplementation[];
  readonly implementationRegistry?: OperatorImplementationRegistry;
}

export interface AppRuntimeConfig {
  readonly environment?: string;
  readonly processRole?: string;
  readonly allowUnsafeProductionDefaults?: boolean;
}

export interface AppStores {
  readonly space: MembershipDomainDependencies;
  readonly runtime: RuntimeStores;
  readonly resources: ResourceStores;
  readonly registry: RegistryStores;
  readonly audit: AuditStores;
  readonly serviceEndpoints: ServiceEndpointStores;
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

export interface ServiceEndpointStores {
  readonly endpoints: ServiceEndpointStore;
  readonly trustRecords: ServiceTrustRecordStore;
  readonly grants: EndpointServiceGrantStore;
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
  observability: "in-memory observability",
  runtimeAgent: "in-memory runtime-agent registry",
};

export interface RuntimeServices {
  readonly materializer: RuntimeMaterializer;
}

export interface EntitlementServices {
  readonly policy: EntitlementPolicyPort;
}

export interface ServiceContainer {
  readonly space: MembershipDomainServices;
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

  const adapters = createDefaultAdapters({
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

export function createDefaultAdapters(
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
  const runtimeAgent =
    options.adapters?.runtimeAgent ??
    new InMemoryRuntimeAgentRegistry({
      clock: dateClock,
      idGenerator: uuidFactory,
      ledger: new StorageBackedWorkLedger(storage),
    });
  return {
    actor,
    auth: options.adapters?.auth ?? localActor,
    coordination:
      options.adapters?.coordination ??
      new MemoryCoordinationAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    notifications:
      options.adapters?.notifications ??
      new MemoryNotificationSink({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    operatorConfig:
      options.adapters?.operatorConfig ??
      new LocalOperatorConfig({ clock: dateClock }),
    provider:
      options.adapters?.provider ??
      new NoopProviderMaterializer({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    secrets:
      options.adapters?.secrets ??
      new MemoryEncryptedSecretStore({
        clock: dateClock,
        idGenerator: uuidFactory,
        // Pass runtimeEnv when supplied so the constructor selects the
        // configured encryption boundary and fails closed if no key is
        // configured for production-like environments.
        ...(options.runtimeEnv ? { env: options.runtimeEnv } : {}),
      }),
    source:
      options.adapters?.source ??
      new ImmutableSourceAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    storage,
    kms:
      options.adapters?.kms ??
      new NoopTestKms({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    observability,
    queue:
      options.adapters?.queue ??
      new MemoryQueueAdapter({
        clock: dateClock,
        idGenerator: uuidFactory,
      }),
    objectStorage:
      options.adapters?.objectStorage ??
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
      readonly loadRuntimeConfigFromEnv: (options?: {
        readonly env?: Record<string, string | undefined>;
      }) => Promise<AppRuntimeConfig>;
    }
  | undefined
> {
  try {
    return await import("./config/mod.ts");
  } catch (error) {
    if (
      error instanceof TypeError ||
      currentRuntime().fs.isNotFoundError(error)
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Build the canonical `OperatorImplementationRegistry` from the operator-supplied
 * `options.implementations` array. The registry is consulted by `DeployControlPipeline`
 * to resolve exact kind references to implementations that materialize them.
 */
export function buildOperatorImplementationRegistry(
  options: AppContextOptions = {},
): OperatorImplementationRegistry {
  return (
    options.implementationRegistry ??
    createOperatorImplementationRegistry(options.implementations ?? [])
  );
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
 * did not configure. That makes "git clone && bun core/index.ts" Just Work,
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
    hint:
      "pass `adapters` explicitly to persist state across restarts. " +
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
  return {
    space: createMembershipDomainServices(stores.space),
    runtime: {
      materializer: new DefaultRuntimeMaterializer({ clock: dateClock }),
    },
    entitlements: {
      policy:
        options.platformServices?.entitlements ??
        new EntitlementPolicyService({
          memberships: stores.space.memberships,
        }),
    },
  };
}
