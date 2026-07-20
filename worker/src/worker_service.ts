import {
  type CreateTakosumiServiceOptions,
  type CreatedTakosumiService,
  createTakosumiService,
} from "../../core/bootstrap.ts";
import type { AppAdapters } from "../../core/app_context.ts";
import { selectSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import type { ManagedProviderCredentialIssuer } from "../../core/adapters/vault/mod.ts";
import type {
  EnqueueRun,
  OpenTofuRunnerExecutorRegistry,
  ReleaseActivator,
} from "../../core/domains/deploy-control/mod.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import type { EnqueueSourceSync } from "../../core/domains/sources/mod.ts";
import type { CapsuleCoordination } from "../../core/domains/deploy-control/capsule_lease.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { CloudflareWorkerEnv, OpenTofuRunAction } from "./bindings.ts";
import { createCloudflareD1OpenTofuControlStore } from "./d1_opentofu_store.ts";
import {
  backupArtifactStoreFromEnv,
  backupObjectReaderFromR2,
} from "./backup_artifact_store.ts";
import { sensitiveOutputResolverFromEnv } from "./sensitive_output_resolver.ts";
import { dependencyValueSealerFromEnv } from "./dependency_value_sealer.ts";
import { CloudflareContainerOpenTofuRunner } from "./container_runner.ts";
import {
  createCompositeReleaseActivator,
  createRunnerReleaseActivator,
  releaseActivatorFromEnv,
} from "./release_activator.ts";
import { CloudflareD1ObservabilitySink } from "./d1_observability.ts";
import { createD1ResourceShapeStores } from "../../core/domains/resource-shape/d1_stores.ts";
import { createD1InterfaceStores } from "../../core/domains/interfaces/d1_stores.ts";
import { createD1FormRegistryStore } from "../../core/domains/service-forms/mod.ts";
import { createD1OfferingCatalogStore } from "../../core/domains/offerings/mod.ts";
import {
  ControllerOpentofuRunPort,
  OpentofuResourceShapeAdapter,
} from "../../core/domains/resource-shape/opentofu_adapter.ts";
import {
  composeResourceShapeSchemaRegistries,
  PluginResourceShapeAdapter,
  type ResourceAdapter,
  type ResourceShapePluginBinding,
  type ResourceShapePluginBindings,
} from "../../core/domains/resource-shape/mod.ts";
import {
  type ActorContext,
  RESOURCE_SHAPE_KINDS,
  type ResourceShapeKind,
} from "takosumi-contract";
import { isPublicManagedProviderConnection } from "takosumi-contract/connections";
import {
  decodeActorContext,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
} from "takosumi-contract/internal/rpc";
import {
  TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  type TakosumiAdapterCapabilities,
  type TakosumiOperatorCapabilities,
  type TakosumiResourceCapabilities,
} from "takosumi-contract/capabilities";
import {
  createManagedProviderRunToken,
  managedProviderRunTokenSecret,
} from "../../core/shared/managed_provider_tokens.ts";
import {
  D1AccountsStore,
  issueInterfaceOAuthAccessToken,
} from "@takosjp/takosumi-accounts-service";
import {
  connectionOAuthDescriptorsFromEnv,
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
} from "@takosumi/providers";
import { createConnectionOAuthHelpers } from "../../core/api/connection_oauth_helpers.ts";
import {
  configuredResourceShapeKinds,
  resourceShapeHostContributionsFromEnv,
} from "./resource_shape_composition.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../deploy/reference-app-install-configs.ts";
import {
  createR2TakoformPackageHostComposition,
  type TakoformPackageHostComposition,
} from "../../core/adapters/takoform/mod.ts";
import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  operatorControlMcpEnabled,
  operatorControlMcpResourceAuthorized,
} from "../../deploy/operator-control-mcp.ts";

const RESOURCE_SHAPE_RUN_WAIT_TIMEOUT_MS = 300_000;
const RESOURCE_SHAPE_DELETE_TIMEOUT_MS =
  RESOURCE_SHAPE_RUN_WAIT_TIMEOUT_MS * 2 + 60_000;
const RESOURCE_SHAPE_ADAPTER_PLUGIN_HANDLERS_ENV =
  "TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS";
export async function createWorkerServiceApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api",
  options: {
    readonly runnerProfiles?: readonly RunnerProfile[];
    readonly defaultRunnerProfileId?: string;
    readonly runnerExecutors?: OpenTofuRunnerExecutorRegistry;
    readonly releaseActivator?: ReleaseActivator;
    readonly enqueueRun?: EnqueueRun;
    readonly enqueueSourceSync?: EnqueueSourceSync;
    readonly managedVanityHostnameSlotsPerOwner?: number;
    /** Complete host-installed recipe catalog; defaults at this composition root. */
    readonly credentialRecipes?: CreateTakosumiServiceOptions["credentialRecipes"];
    /** Complete host-installed app config set; an empty array disables references. */
    readonly operatorInstallConfigs?: CreateTakosumiServiceOptions["operatorInstallConfigs"];
    /** Complete host-installed recipe driver registry. */
    readonly credentialRecipeDrivers?: CreateTakosumiServiceOptions["credentialRecipeDrivers"];
    /** Host-installed guided connection setup dispatcher. */
    readonly buildConnectionSetupRequest?: CreateTakosumiServiceOptions["buildConnectionSetupRequest"];
    /** Complete host-installed OAuth helper registry. */
    readonly connectionOAuthHelpers?: CreateTakosumiServiceOptions["connectionOAuthHelpers"];
    /** Complete host-installed Resource Shape compatibility schema authority. */
    readonly resourceShapeSchemaRegistry?: CreateTakosumiServiceOptions["resourceShapeSchemaRegistry"];
    /** Host-owned lookup for explicit Resource Shape moduleTemplate ids. */
    readonly resourceShapeModuleRegistry?: CreateTakosumiServiceOptions["resourceShapeModuleRegistry"];
    /** Local/private compatibility ingress; production platform edges omit it. */
    readonly mountInternalLedgerRoutes?: boolean;
    /** Opaque package reader selected by the host trust policy. */
    readonly formPackageArtifactReader?: CreateTakosumiServiceOptions["formPackageArtifactReader"];
    /** Trusted data-only package verifier selected by the host trust policy. */
    readonly formPackageVerifier?: CreateTakosumiServiceOptions["formPackageVerifier"];
    /** Complete generic noncommercial Offering contribution. */
    readonly offeringHostComposition?: CreateTakosumiServiceOptions["offeringHostComposition"];
    /** Additional host proof for custom/external Interface OAuth resources. */
    readonly interfaceOAuth2ResourceAuthorizer?: CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"];
    /**
     * Explicit host-code bridge from a Resource namespace to an existing
     * Workspace. Platform compositions inject their Workspace authority here;
     * this is never populated from a Wrangler text variable.
     */
    readonly resolveResourceInterfaceWorkspace?: CreateTakosumiServiceOptions["resolveResourceInterfaceWorkspace"];
  } = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const controlD1SchemaMode = env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE;
  if (
    controlD1SchemaMode !== undefined &&
    controlD1SchemaMode !== "bootstrap" &&
    controlD1SchemaMode !== "predeployed"
  ) {
    throw new TypeError(
      "TAKOSUMI_CONTROL_D1_SCHEMA_MODE must be bootstrap or predeployed",
    );
  }
  const opentofuControlStore = createCloudflareD1OpenTofuControlStore(
    env.TAKOSUMI_CONTROL_DB,
    {
      schemaMode: controlD1SchemaMode ?? "bootstrap",
    },
  );
  const adapters = createWorkerAdapters(env);
  const enqueueRun =
    options.enqueueRun ??
    openTofuRunOwnerEnqueuer(env) ??
    openTofuRunEnqueuer(env);
  const enqueueSourceSync =
    options.enqueueSourceSync ??
    openTofuRunOwnerSourceSyncEnqueuer(env) ??
    openTofuSourceSyncEnqueuer(env);
  const capsuleCoordination = durableObjectCapsuleCoordination(env);
  const opentofuRunner = new CloudflareContainerOpenTofuRunner(env, {
    observability: adapters.observability,
  });
  // Provider-credential Vault crypto (spec §8): the same env-backed, fail-closed
  // secret-boundary AES-GCM the secret store uses. Bootstrap builds the default
  // StaticSecretConnectionVault from this over the shared OpenTofu store, so a
  // Connection's secret values are sealed at register and minted per-phase at
  // plan/apply. Without it the controller fails closed on every provider-using
  // run — the previously-missing wiring that broke provider plan/apply in the
  // deployed worker.
  const secretCrypto = selectSecretBoundaryCrypto({ env: runtimeEnv });
  const providerBaseUrlAllowlist = parseProviderBaseUrlAllowlist(
    env.TAKOSUMI_RESOURCE_PROVIDER_BASE_URL_ALLOWLIST,
  );
  const allowOperatorScopedProviderConnections = envFlag(
    env.TAKOSUMI_ALLOW_OPERATOR_BACKED_PROVIDER_ENVS,
  );
  // Control backups (spec §33 / §26): seal the bundle with the at-rest crypto
  // and write to R2_BACKUPS. Absent binding -> backups stay disabled (501).
  const backupArtifactStore = backupArtifactStoreFromEnv(
    env.R2_BACKUPS,
    runtimeEnv,
  );
  const backupStateObjectReader = backupObjectReaderFromR2(env.R2_STATE);
  const sensitiveOutputResolver = sensitiveOutputResolverFromEnv(
    env.R2_ARTIFACTS,
    runtimeEnv,
  );
  // At-rest sealing for sensitive DependencySnapshot values (spec §11 / §18).
  // Reuses the same secret-boundary AES-GCM envelope as state/plan/raw-output
  // artifacts; wired whenever the sensitive output resolver is — a sensitive
  // published_output edge needs both to resolve AND to seal its pinned value.
  const dependencyValueSealer = sensitiveOutputResolver
    ? dependencyValueSealerFromEnv(runtimeEnv)
    : undefined;
  const envReleaseActivator = releaseActivatorFromEnv(env, runtimeEnv);
  const runnerReleaseActivator = createRunnerReleaseActivator(opentofuRunner);
  const releaseActivator =
    options.releaseActivator ??
    createCompositeReleaseActivator({
      operator: envReleaseActivator,
      runner: runnerReleaseActivator,
    });
  const envResourceShapeContributions =
    resourceShapeHostContributionsFromEnv(env);
  const resourceShapeSchemaRegistry = composeResourceShapeSchemaRegistries(
    options.resourceShapeSchemaRegistry,
    envResourceShapeContributions.schemaRegistry,
  );
  const resourceShapeModuleRegistry =
    options.resourceShapeModuleRegistry ??
    envResourceShapeContributions.moduleRegistry;
  const resourceShapeCapabilities = resourceShapeCapabilitiesFromEnv(
    env,
    resourceShapeSchemaRegistry,
  );
  const operatorCapabilities = operatorCapabilitiesFromEnv(env);
  const managedProviderCredentialIssuer =
    managedProviderCredentialIssuerFromEnv(env);
  const billingExtensionFactory = billingExtensionFactoryFromEnv(env);
  const resourceDeploymentAdmission = resourceDeploymentAdmissionFromEnv(env);
  const resourceArtifactWriter = resourceArtifactWriterFromEnv(env);
  const resolveResourceInterfaceWorkspace =
    options.resolveResourceInterfaceWorkspace ??
    resourceInterfaceWorkspaceResolverFromEnv(env);
  const interfaceCredentialIssuer = env.TAKOSUMI_ACCOUNTS_DB
    ? interfaceCredentialIssuerFromAccountsStore(
        new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB),
      )
    : undefined;
  const interfaceOAuth2ResourceAuthorizer =
    workerInterfaceOAuth2ResourceAuthorizer(
      env,
      opentofuControlStore,
      options.interfaceOAuth2ResourceAuthorizer,
    );
  const connectionOAuthHelpers =
    options.connectionOAuthHelpers ??
    createConnectionOAuthHelpers({
      stateSecret: runtimeEnv.TAKOSUMI_CONNECTION_OAUTH_STATE_SECRET,
      descriptors: connectionOAuthDescriptorsFromEnv(runtimeEnv),
    });
  const operatorInstallConfigs = options.operatorInstallConfigs ??
    env.TAKOSUMI_INSTALL_CONFIG_COMPOSITION ?? [
      ...REFERENCE_APP_INSTALL_CONFIGS,
      ...(operatorControlMcpEnabled(env)
        ? [OPERATOR_CONTROL_MCP_INSTALL_CONFIG]
        : []),
    ];
  const formPackageHost = resolveFormPackageHostComposition(env, options);
  const offeringHostComposition = resolveOfferingHostComposition(env, options);
  return await createTakosumiService({
    role,
    runtimeEnv,
    adapters,
    // The shipped Worker explicitly selects the reference provider package.
    // `createTakosumiService` itself has no implicit recipe/setup authority.
    credentialRecipes:
      options.credentialRecipes ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes,
    operatorInstallConfigs,
    credentialRecipeDrivers:
      options.credentialRecipeDrivers ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    buildConnectionSetupRequest:
      options.buildConnectionSetupRequest ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.buildConnectionSetupRequest,
    ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
    opentofuControlStore,
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    resourceShapeStores: createD1ResourceShapeStores(env.TAKOSUMI_CONTROL_DB),
    formRegistryStore: createD1FormRegistryStore(env.TAKOSUMI_CONTROL_DB),
    offeringCatalogStore: createD1OfferingCatalogStore(env.TAKOSUMI_CONTROL_DB),
    // Stock multi-tenant routes use the verified Workspace id as the Resource
    // authorization scope. Keep that host mapping explicit for backup.
    resolveResourceBackupScope: (workspaceId) => workspaceId,
    ...(formPackageHost
      ? { formPackageArtifactReader: formPackageHost.artifactReader }
      : {}),
    ...(formPackageHost
      ? { formPackageVerifier: formPackageHost.verifier }
      : {}),
    ...(offeringHostComposition ? { offeringHostComposition } : {}),
    resourceShapeSchemaRegistry,
    ...(resourceShapeModuleRegistry ? { resourceShapeModuleRegistry } : {}),
    interfaceStores: createD1InterfaceStores(env.TAKOSUMI_CONTROL_DB),
    ...(env.TAKOSUMI_INTERFACE_PROJECTION_SINK
      ? { interfaceProjectionSink: env.TAKOSUMI_INTERFACE_PROJECTION_SINK }
      : {}),
    ...(resolveResourceInterfaceWorkspace
      ? { resolveResourceInterfaceWorkspace }
      : {}),
    ...(interfaceCredentialIssuer ? { interfaceCredentialIssuer } : {}),
    interfaceOAuth2ResourceAuthorizer,
    resourceShapeAllowedProviderBaseUrls: providerBaseUrlAllowlist,
    resourceShapeAdapterFactory: ({ controller }) => {
      const adapter = new OpentofuResourceShapeAdapter(
        new ControllerOpentofuRunPort({
          driver: controller,
          driveRunsSynchronously: enqueueRun ? false : true,
          waitTimeoutMs: RESOURCE_SHAPE_RUN_WAIT_TIMEOUT_MS,
        }),
      );
      return resourceShapeAdapterFromEnv(env, adapter);
    },
    resourceShapeDeleteTimeoutMs: RESOURCE_SHAPE_DELETE_TIMEOUT_MS,
    enabledResourceShapeKinds: resourceShapeCapabilities.enabledKinds,
    resourceCapabilities: resourceShapeCapabilities.resources,
    adapterCapabilities: resourceShapeCapabilities.adapters,
    operatorCapabilities,
    resolveResourceShapeActor: resourceShapeActorFromRequest,
    opentofuRunner,
    ...(options.runnerExecutors
      ? { opentofuRunnerExecutors: options.runnerExecutors }
      : {}),
    allowOperatorScopedProviderConnections,
    secretCrypto,
    ...(managedProviderCredentialIssuer
      ? { managedProviderCredentialIssuer }
      : {}),
    ...(billingExtensionFactory ? { billingExtensionFactory } : {}),
    ...(resourceDeploymentAdmission ? { resourceDeploymentAdmission } : {}),
    ...(resourceArtifactWriter ? { resourceArtifactWriter } : {}),
    // Async run lifecycle: when the run queue is bound, the create path persists
    // the run `queued` and returns immediately; the `queue()` consumer in this
    // same worker drives execution. Without the binding, the controller's
    // default inline dispatcher preserves synchronous create-executes-run.
    ...(enqueueRun ? { enqueueRun } : {}),
    ...(enqueueSourceSync ? { enqueueSourceSync } : {}),
    // Environment lease (spec §10.2): front the shared CoordinationObject so the
    // apply consumer serializes write runs per environment across isolates.
    ...(capsuleCoordination ? { capsuleCoordination } : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(options.mountInternalLedgerRoutes === true
      ? { mountInternalLedgerRoutes: true }
      : {}),
    ...(backupArtifactStore ? { backupArtifactStore } : {}),
    ...(backupStateObjectReader ? { backupStateObjectReader } : {}),
    ...(backupArtifactStore ? { serviceDataBackupRunner: opentofuRunner } : {}),
    ...(sensitiveOutputResolver ? { sensitiveOutputResolver } : {}),
    ...(dependencyValueSealer ? { dependencyValueSealer } : {}),
    ...(releaseActivator ? { releaseActivator } : {}),
    ...(options.managedVanityHostnameSlotsPerOwner !== undefined
      ? {
          managedVanityHostnameSlotsPerOwner:
            options.managedVanityHostnameSlotsPerOwner,
        }
      : {}),
  });
}

function resolveOfferingHostComposition(
  env: CloudflareWorkerEnv,
  options: {
    readonly offeringHostComposition?: CreateTakosumiServiceOptions["offeringHostComposition"];
  },
): CreateTakosumiServiceOptions["offeringHostComposition"] {
  const composition =
    options.offeringHostComposition ?? env.TAKOSUMI_OFFERING_HOST_COMPOSITION;
  if (composition === undefined) return undefined;
  if (
    typeof composition !== "object" ||
    composition === null ||
    typeof composition.catalogs?.getCatalog !== "function" ||
    (composition.resolvers !== undefined &&
      (!Array.isArray(composition.resolvers) ||
        composition.resolvers.some(
          (resolver) =>
            typeof resolver !== "object" ||
            resolver === null ||
            typeof resolver.subjectType !== "string" ||
            typeof resolver.resolve !== "function",
        )))
  ) {
    throw new TypeError(
      "TAKOSUMI_OFFERING_HOST_COMPOSITION must provide a catalog reader and optional subject resolvers",
    );
  }
  return composition;
}

function resolveFormPackageHostComposition(
  env: CloudflareWorkerEnv,
  options: {
    readonly formPackageArtifactReader?: CreateTakosumiServiceOptions["formPackageArtifactReader"];
    readonly formPackageVerifier?: CreateTakosumiServiceOptions["formPackageVerifier"];
  },
): TakoformPackageHostComposition | undefined {
  if (
    Boolean(options.formPackageArtifactReader) !==
    Boolean(options.formPackageVerifier)
  ) {
    throw new TypeError(
      "Form Package reader and verifier must be injected together",
    );
  }
  if (options.formPackageArtifactReader && options.formPackageVerifier) {
    return {
      artifactReader: options.formPackageArtifactReader,
      verifier: options.formPackageVerifier,
    };
  }
  const hostComposition = env.TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION;
  if (hostComposition !== undefined) {
    if (
      typeof hostComposition !== "object" ||
      hostComposition === null ||
      typeof hostComposition.artifactReader?.read !== "function" ||
      typeof hostComposition.verifier?.verify !== "function"
    ) {
      throw new TypeError(
        "TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION must be a host-code reader/verifier object",
      );
    }
    return hostComposition;
  }
  const bucket = env.R2_FORM_PACKAGES;
  const trustPolicy = env.TAKOSUMI_FORM_PACKAGE_TRUST_POLICY;
  if (Boolean(bucket) !== Boolean(trustPolicy)) {
    throw new TypeError(
      "R2_FORM_PACKAGES and TAKOSUMI_FORM_PACKAGE_TRUST_POLICY must be configured together",
    );
  }
  if (!bucket || !trustPolicy) return undefined;
  return createR2TakoformPackageHostComposition({ bucket, trustPolicy });
}

/**
 * Reads the host-installed Resource namespace -> Workspace bridge. This is a
 * code-only composition seam: a serialized Worker var must never be accepted
 * as namespace authority, and omission deliberately preserves Core's
 * fail-closed behavior.
 */
export function resourceInterfaceWorkspaceResolverFromEnv(
  env: CloudflareWorkerEnv,
): CreateTakosumiServiceOptions["resolveResourceInterfaceWorkspace"] {
  const resolver = env.TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER;
  if (resolver === undefined) return undefined;
  if (typeof resolver !== "function") {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_INTERFACE_WORKSPACE_RESOLVER must be a host-code resolver function",
    );
  }
  return resolver;
}

function billingExtensionFactoryFromEnv(
  env: CloudflareWorkerEnv,
): import("takosumi-contract/billing").BillingExtensionFactory | undefined {
  const factory = env.TAKOSUMI_BILLING_EXTENSION_FACTORY;
  if (factory === undefined) return undefined;
  if (
    typeof factory !== "object" ||
    factory === null ||
    typeof (factory as { readonly create?: unknown }).create !== "function"
  ) {
    throw new TypeError(
      "TAKOSUMI_BILLING_EXTENSION_FACTORY must implement create()",
    );
  }
  return factory;
}

export function resourceDeploymentAdmissionFromEnv(
  env: CloudflareWorkerEnv,
):
  | import("takosumi-contract/resource-deployment").ResourceDeploymentAdmission
  | undefined {
  const admission = env.TAKOSUMI_RESOURCE_DEPLOYMENT_ADMISSION;
  if (admission === undefined) return undefined;
  if (
    typeof admission !== "object" ||
    admission === null ||
    typeof admission.quote !== "function" ||
    typeof admission.reserve !== "function" ||
    typeof admission.capture !== "function" ||
    typeof admission.markSettlementPending !== "function" ||
    typeof admission.release !== "function" ||
    typeof admission.admitImport !== "function" ||
    typeof admission.retire !== "function"
  ) {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_DEPLOYMENT_ADMISSION must implement quote(), reserve(), capture(), markSettlementPending(), release(), admitImport(), and retire()",
    );
  }
  return admission;
}

export function resourceArtifactWriterFromEnv(
  env: CloudflareWorkerEnv,
): import("takosumi-contract").ResourceArtifactWriter | undefined {
  const writer = env.TAKOSUMI_RESOURCE_ARTIFACT_WRITER;
  if (writer === undefined) return undefined;
  if (
    typeof writer !== "object" ||
    writer === null ||
    typeof writer.prepare !== "function" ||
    typeof writer.write !== "function"
  ) {
    throw new TypeError(
      "TAKOSUMI_RESOURCE_ARTIFACT_WRITER must implement prepare() and write()",
    );
  }
  return writer;
}

function interfaceCredentialIssuerFromAccountsStore(
  store: import("@takosjp/takosumi-accounts-service").AccountsStore,
): NonNullable<
  NonNullable<
    Parameters<typeof createTakosumiService>[0]
  >["interfaceCredentialIssuer"]
> {
  return {
    issuePrincipalOAuth2Token: async (input) => {
      const issued = await issueInterfaceOAuthAccessToken({
        store,
        subject: input.subjectId,
        workspaceId: input.workspaceId,
        ...(input.interfaceOwnerRef.kind === "Capsule"
          ? { capsuleId: input.interfaceOwnerRef.id }
          : {}),
        audience: input.resource,
        permission: input.permission,
        interfaceId: input.interfaceId,
        bindingId: input.bindingId,
        interfaceRevision: input.interfaceResolvedRevision,
        now: Date.parse(input.issuedAt),
      });
      return {
        accessToken: issued.accessToken,
        expiresAt: new Date(issued.expiresAt).toISOString(),
      };
    },
  };
}

function workerInterfaceOAuth2ResourceAuthorizer(
  env: CloudflareWorkerEnv,
  store: Pick<OpenTofuControlStore, "getPublicHostReservation">,
  additional?: CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"],
): NonNullable<
  CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"]
> {
  return async (input) => {
    if (additional && (await additional(input))) return true;
    if (operatorControlMcpResourceAuthorized(env, input)) {
      // The host proves only its own enabled, versioned adapter route. The
      // Capsule still cannot grant a Binding; an operator/installer owns that
      // separate service-side authorization.
      return true;
    }
    if (input.ownerRef.kind !== "Capsule") return false;
    const hostname = new URL(input.resource).hostname.toLowerCase();
    const reservation = await store.getPublicHostReservation(hostname);
    return (
      reservation?.status === "reserved" &&
      reservation.workspaceId === input.workspaceId &&
      reservation.capsuleId === input.ownerRef.id
    );
  };
}

function managedProviderCredentialIssuerFromEnv(
  env: CloudflareWorkerEnv,
): ManagedProviderCredentialIssuer | undefined {
  const secret = managedProviderRunTokenSecret(env);
  if (!secret) return undefined;
  return async (request) => {
    const { workspaceId, connection, phase } = request;
    if (!isPublicManagedProviderConnection(connection)) return undefined;
    if (!phase || connection.envNames.length === 0) return undefined;
    const issued = await createManagedProviderRunToken({
      secret,
      audience: request.managedProviderProfile,
      workspaceId,
      ...(request.capsuleId ? { capsuleId: request.capsuleId } : {}),
      connectionId: connection.id,
      provider: connection.provider,
      phase,
      scopes: ["write"],
    });
    return {
      values: Object.fromEntries(
        connection.envNames.map((envName) => [envName, issued.token]),
      ),
      issuer: "takosumi_managed_provider_token",
      temporary: true,
      expiresAt: issued.expiresAt,
      ttlSeconds: issued.ttlSeconds,
      secretValueStored: false,
    };
  };
}

function resourceShapeActorFromRequest(request: Request): ActorContext {
  const actorHeader = request.headers.get(TAKOSUMI_INTERNAL_ACTOR_HEADER);
  if (actorHeader) return decodeActorContext(actorHeader);
  return {
    actorAccountId: "platform-resource-shape",
    roles: ["owner"],
    requestId: crypto.randomUUID(),
  };
}

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] };

function resourceShapeAdapterFromEnv(
  env: CloudflareWorkerEnv,
  fallback: ResourceAdapter,
): ResourceAdapter {
  const plugins = resourceShapePluginBindingsFromEnv(env);
  return Object.keys(plugins).length > 0
    ? new PluginResourceShapeAdapter(fallback, plugins)
    : fallback;
}

function resourceShapePluginBindingsFromEnv(
  env: CloudflareWorkerEnv,
): ResourceShapePluginBindings {
  const raw = env.TAKOSUMI_RESOURCE_ADAPTER_PLUGIN_HANDLERS;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TypeError(
      `${RESOURCE_SHAPE_ADAPTER_PLUGIN_HANDLERS_ENV} must be valid JSON`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `${RESOURCE_SHAPE_ADAPTER_PLUGIN_HANDLERS_ENV} must be a JSON array`,
    );
  }
  const out: Record<string, ResourceShapePluginBinding> = {};
  for (const [index, entry] of parsed.entries()) {
    const label = `${RESOURCE_SHAPE_ADAPTER_PLUGIN_HANDLERS_ENV}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`${label} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const plugin = record.plugin;
    const handlerKey = record.handlerKey;
    if (typeof plugin !== "string" || plugin.trim() === "") {
      throw new TypeError(`${label}.plugin must be a non-empty string`);
    }
    if (typeof handlerKey !== "string" || handlerKey.trim() === "") {
      throw new TypeError(`${label}.handlerKey must be a non-empty string`);
    }
    const binding = env[handlerKey.trim()];
    if (!isFetchBinding(binding)) {
      throw new TypeError(
        `${label}.handlerKey "${handlerKey}" did not resolve to a fetch binding`,
      );
    }
    out[plugin.trim()] = binding;
  }
  return out;
}

function isFetchBinding(value: unknown): value is ResourceShapePluginBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { readonly fetch?: unknown }).fetch === "function"
  );
}

function resourceShapeCapabilitiesFromEnv(
  env: CloudflareWorkerEnv,
  schemaRegistry?: CreateTakosumiServiceOptions["resourceShapeSchemaRegistry"],
): {
  readonly enabledKinds: readonly ResourceShapeKind[];
  readonly resources: Partial<TakosumiResourceCapabilities>;
  readonly adapters: Partial<TakosumiAdapterCapabilities>;
} {
  const enabledKinds = configuredResourceShapeKinds(
    env.TAKOSUMI_RESOURCE_SHAPES,
    schemaRegistry,
  );
  const resources = Object.fromEntries(
    RESOURCE_SHAPE_KINDS.map((kind) => [kind, false]),
  ) as MutablePartial<TakosumiResourceCapabilities>;
  for (const kind of enabledKinds) resources[kind] = true;

  const adapters: MutablePartial<TakosumiAdapterCapabilities> = {
    opentofu: enabledKinds.length > 0,
  };
  if (enabledKinds.length > 0) {
    for (const key of parseExtensionCapabilityTokens(
      env.TAKOSUMI_RESOURCE_ADAPTERS,
    )) {
      adapters[key] = true;
    }
  }
  return { enabledKinds, resources, adapters };
}

function operatorCapabilitiesFromEnv(
  env: CloudflareWorkerEnv,
): Partial<TakosumiOperatorCapabilities> {
  const capabilities: MutablePartial<TakosumiOperatorCapabilities> = {};
  for (const key of parseCapabilityList(
    env.TAKOSUMI_OPERATOR_CAPABILITIES,
    TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  )) {
    capabilities[key] = true;
  }
  return capabilities;
}

function parseCapabilityList<T extends string>(
  value: unknown,
  allowed: readonly T[],
): readonly T[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const raw = value.trim();
  const allowedSet = new Set<T>(allowed);
  const tokens = raw === "all" ? [...allowed] : parseCapabilityTokens(raw);
  const out: T[] = [];
  const seen = new Set<T>();
  for (const token of tokens) {
    if (!allowedSet.has(token as T)) continue;
    const key = token as T;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function parseCapabilityTokens(raw: string): readonly string[] {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string",
        );
      }
    } catch {
      return [];
    }
  }
  return raw
    .split(/[,\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseExtensionCapabilityTokens(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of parseCapabilityTokens(value.trim())) {
    if (
      token.trim() === "" ||
      token === "all" ||
      /\s/u.test(token) ||
      seen.has(token)
    ) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

function parseProviderBaseUrlAllowlist(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const token of parseCapabilityTokens(value.trim())) {
    try {
      const url = new URL(token);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      url.hash = "";
      url.search = "";
      const normalized = url.href.replace(/\/+$/u, "");
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    } catch {
      continue;
    }
  }
  return out;
}

function envFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Builds a {@link CapsuleCoordination} that fronts the shared
 * {@link CoordinationObject} via its `acquire-lease` / `release-lease` POST
 * API. Returns undefined when the DO binding is absent, leaving the controller
 * on its in-process serialization. The same single DO instance
 * (`takosumi-control-plane`) backs the lease keyspace used by the rest of the
 * coordination surface, so environment leases share that storage.
 */
function durableObjectCapsuleCoordination(
  env: CloudflareWorkerEnv,
): CapsuleCoordination | undefined {
  const namespace = env.COORDINATION;
  if (!namespace) return undefined;
  const stub = () =>
    namespace.get(namespace.idFromName("takosumi-control-plane"));
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await stub().fetch(
      new Request(`https://takos-coordination.internal/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const payload = (await response.json()) as {
      result?: unknown;
      error?: string;
    };
    if (!response.ok || payload.error) {
      throw new Error(
        `coordination ${path} failed: ${payload.error ?? response.status}`,
      );
    }
    return payload.result;
  };
  return {
    async acquireLease(input) {
      const result = (await post("acquire-lease", {
        scope: input.scope,
        holderId: input.holderId,
        ttlMs: input.ttlMs,
      })) as {
        scope: string;
        holderId: string;
        token: string;
        acquired: boolean;
        expiresAt: string;
      };
      return result;
    },
    async renewLease(input) {
      // The DO's `renew-lease` throws (400) when the lease is not held by this
      // holder+token. Translate that into a fail-closed `acquired=false` lease
      // so the renewal harness stops renewing instead of surfacing the error and
      // killing the apply it is babysitting.
      try {
        const result = (await post("renew-lease", {
          scope: input.scope,
          holderId: input.holderId,
          token: input.token,
          ttlMs: input.ttlMs,
        })) as {
          scope: string;
          holderId: string;
          token: string;
          acquired: boolean;
          expiresAt: string;
        };
        return result;
      } catch {
        return {
          scope: input.scope,
          holderId: input.holderId,
          token: input.token,
          acquired: false,
          expiresAt: new Date().toISOString(),
        };
      }
    },
    async releaseLease(input) {
      return (await post("release-lease", {
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
      })) as boolean;
    },
  };
}

/**
 * Fast async run lifecycle: schedule the per-run owner DO directly when the
 * binding exists. The owner already persists only run identity, owns retries,
 * and performs long dispatch from its alarm, so routing through Queue first only
 * adds delivery latency on the first deploy path.
 */
function openTofuRunOwnerEnqueuer(
  env: CloudflareWorkerEnv,
): EnqueueRun | undefined {
  if (!env.RUN_OWNER) return undefined;
  return async (dispatch) => {
    await scheduleOpenTofuRunOwner(env, {
      action: dispatch.action,
      runId: dispatch.runId,
      workspaceId: dispatch.workspaceId,
      messageId: directRunOwnerMessageId(dispatch.runId),
      queueAttempt: 1,
      cause: dispatch.cause,
    });
  };
}

function openTofuRunOwnerSourceSyncEnqueuer(
  env: CloudflareWorkerEnv,
): EnqueueSourceSync | undefined {
  if (!env.RUN_OWNER) return undefined;
  return async (dispatch) => {
    await scheduleOpenTofuRunOwner(env, {
      action: "source_sync",
      runId: dispatch.runId,
      workspaceId: dispatch.workspaceId,
      messageId: directRunOwnerMessageId(dispatch.runId),
      queueAttempt: 1,
    });
  };
}

async function scheduleOpenTofuRunOwner(
  env: CloudflareWorkerEnv,
  dispatch: {
    readonly action: OpenTofuRunAction;
    readonly runId: string;
    readonly workspaceId: string;
    readonly queueAttempt: number;
    readonly messageId: string;
    readonly cause?: "controller_retry";
  },
): Promise<void> {
  const namespace = env.RUN_OWNER;
  if (!namespace) {
    throw new Error("RUN_OWNER binding is not configured");
  }
  const response = await namespace
    .get(namespace.idFromName(dispatch.runId))
    .fetch(
      new Request("https://opentofu-run-owner/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "takosumi.opentofu-run-owner.start@v1",
          action: dispatch.action,
          runId: dispatch.runId,
          workspaceId: dispatch.workspaceId,
          queueAttempt: dispatch.queueAttempt,
          messageId: dispatch.messageId,
          ...(dispatch.cause ? { cause: dispatch.cause } : {}),
        }),
      }),
    );
  if (!response.ok) {
    throw new Error("opentofu run owner scheduling failed");
  }
}

function directRunOwnerMessageId(runId: string): string {
  return `direct:${runId}:${Date.now().toString(36)}`;
}

/**
 * Queue fallback for async run lifecycle. Used only when RUN_OWNER is absent
 * but RUN_QUEUE is still bound. The message carries only the run identity
 * (never variables or credentials).
 */
function openTofuRunEnqueuer(env: CloudflareWorkerEnv): EnqueueRun | undefined {
  const queue = env.RUN_QUEUE;
  if (!queue) return undefined;
  return async (dispatch) => {
    await queue.send({
      kind: "takosumi.opentofu-run@v1",
      action: dispatch.action,
      runId: dispatch.runId,
      workspaceId: dispatch.workspaceId,
      ...(dispatch.cause ? { cause: dispatch.cause } : {}),
      requestedAt: new Date().toISOString(),
    });
  };
}

/**
 * Source-sync producer (Core Specification §6). Enqueues a `source_sync`
 * dispatch onto the same run queue; the consumer loads the SourceSyncRun, mints
 * source-phase (git-only) credentials, and drives the runner DO. Returns
 * undefined when the queue is not bound so the run stays queued.
 */
function openTofuSourceSyncEnqueuer(
  env: CloudflareWorkerEnv,
): EnqueueSourceSync | undefined {
  const queue = env.RUN_QUEUE;
  if (!queue) return undefined;
  return async (dispatch) => {
    await queue.send({
      kind: "takosumi.opentofu-run@v1",
      action: "source_sync",
      runId: dispatch.runId,
      workspaceId: dispatch.workspaceId,
      requestedAt: new Date().toISOString(),
    });
  };
}

function createWorkerAdapters(env: CloudflareWorkerEnv): AppAdapters {
  return {
    observability: new CloudflareD1ObservabilitySink({
      db: env.TAKOSUMI_CONTROL_DB,
    }),
  };
}

function cloudflareRuntimeEnv(
  env: CloudflareWorkerEnv,
  role: "takosumi-api",
): Record<string, string | undefined> {
  const runtimeEnv: Record<string, string | undefined> = {
    TAKOSUMI_PROCESS_ROLE: role,
    TAKOSUMI_RUNTIME_MODE: "cloudflare-worker",
  };
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      runtimeEnv[key] = String(value);
    }
  }
  return runtimeEnv;
}
