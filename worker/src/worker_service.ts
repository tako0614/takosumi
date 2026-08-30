import {
  type CreateTakosumiServiceOptions,
  type CreatedTakosumiService,
  createTakosumiService,
} from "../../core/bootstrap.ts";
import type { AppAdapters } from "../../core/app_context.ts";
import { selectSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { ObjectKeyArtifactReferenceAllocator } from "../../core/adapters/storage/artifact-references.ts";
import type {
  EnqueueRun,
  OpenTofuRunnerExecutorRegistry,
  ReleaseActivator,
} from "../../core/domains/deploy-control/mod.ts";
import type { OpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import type { EnqueueSourceSync } from "../../core/domains/sources/mod.ts";
import type { CapsuleCoordination } from "../../core/domains/deploy-control/capsule_lease.ts";
import { D1GitInstallPlanStore } from "../../core/domains/install-plans/d1_store.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type {
  CloudflareWorkerEnv,
  OpenTofuRunAction,
} from "./bindings.ts";
import {
  createCloudflareD1OpenTofuControlStore,
  initializeD1OpenTofuLedgerSchemaBinding,
} from "./d1_opentofu_store.ts";
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
import { createD1InterfaceStores } from "../../core/domains/interfaces/d1_stores.ts";
import {
  TAKOSUMI_OPERATOR_CAPABILITY_KEYS,
  type TakosumiOperatorCapabilities,
} from "takosumi-contract/capabilities";
import {
  D1AccountsStore,
  issueInterfaceOAuthAccessToken,
  resolveD1AccountsSchemaMode,
} from "@takosjp/takosumi-accounts-service";
import {
  connectionOAuthDescriptorsFromEnv,
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
} from "@takosumi/providers";
import {
  type CredentialRecipeRunCredentialIssuer,
} from "../../core/adapters/vault/driver_ports.ts";
import { isWorkspaceBindableOperatorConnection } from "takosumi-contract/connections";
import { resolveCredentialRecipeHostComposition } from "takosumi-contract/credential-recipe-host";
export { resolveCredentialRecipeHostComposition } from "takosumi-contract/credential-recipe-host";
import {
  createRunCredentialToken,
  runCredentialTokenSecret,
} from "../../core/shared/run_credential_tokens.ts";
import { createConnectionOAuthHelpers } from "../../core/api/connection_oauth_helpers.ts";
import {
  OPERATOR_CONTROL_MCP_INSTALL_CONFIG,
  operatorControlMcpEnabled,
  operatorControlMcpResourceAuthorized,
} from "../../deploy/operator-control-mcp.ts";
import {
  platformExtensionProviderCredentialComposition,
} from "../../deploy/platform/platform_extension_provider_credentials.ts";
import { applyCredentialRequiredProviderSources } from "../../deploy/platform/host_install_config_composition.ts";
import { createTakosumiAccountsOidcModuleVariableMaterializer } from "../../deploy/platform/accounts_oidc_module_variable_materializer.ts";

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
    /** Complete host-installed recipe catalog; defaults at this composition root. */
    readonly credentialRecipes?: CreateTakosumiServiceOptions["credentialRecipes"];
    /** Complete host-installed app config set; an empty array disables references. */
    readonly operatorInstallConfigs?: CreateTakosumiServiceOptions["operatorInstallConfigs"];
    /** Complete host-installed recipe driver registry. */
    readonly credentialRecipeDrivers?: CreateTakosumiServiceOptions["credentialRecipeDrivers"];
    /** Host-declared fixed-id operator Provider Connections. */
    readonly operatorProviderConnections?: CreateTakosumiServiceOptions["operatorProviderConnections"];
    /** Complete host-installed Source credential driver registry. */
    readonly sourceCredentialDrivers?: CreateTakosumiServiceOptions["sourceCredentialDrivers"];
    /** Host-installed guided connection setup dispatcher. */
    readonly buildConnectionSetupRequest?: CreateTakosumiServiceOptions["buildConnectionSetupRequest"];
    /** Complete host-installed OAuth helper registry. */
    readonly connectionOAuthHelpers?: CreateTakosumiServiceOptions["connectionOAuthHelpers"];
    /** Local/private control-plane ingress. */
    readonly mountInternalLedgerRoutes?: boolean;
    /** Additional host proof for custom/external Interface OAuth resources. */
    readonly interfaceOAuth2ResourceAuthorizer?: CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"];
  } = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const accountsD1SchemaMode = resolveD1AccountsSchemaMode(
    env.TAKOSUMI_ACCOUNTS_D1_SCHEMA_MODE,
  );
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
  await initializeD1OpenTofuLedgerSchemaBinding(
    env.TAKOSUMI_CONTROL_DB,
    controlD1SchemaMode ?? "bootstrap",
  );
  const opentofuControlStore = createCloudflareD1OpenTofuControlStore(
    env.TAKOSUMI_CONTROL_DB,
    {
      schemaMode: controlD1SchemaMode ?? "bootstrap",
    },
  );
  const adapters = createWorkerAdapters(env);
  const enqueueRun = options.enqueueRun ?? openTofuRunOwnerEnqueuer(env);
  const enqueueSourceSync =
    options.enqueueSourceSync ?? openTofuRunOwnerSourceSyncEnqueuer(env);
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
  const operatorCapabilities = operatorCapabilitiesFromEnv(env);
  const billingExtensionFactory = billingExtensionFactoryFromEnv(env);
  const accountsStore = env.TAKOSUMI_ACCOUNTS_DB
    ? new D1AccountsStore(env.TAKOSUMI_ACCOUNTS_DB, {
        schemaMode: accountsD1SchemaMode,
      })
    : undefined;
  const accountsIssuer = env.TAKOSUMI_ACCOUNTS_ISSUER;
  const pairwiseSubjectSecret =
    env.TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET;
  const moduleVariableMaterializer =
    accountsStore &&
      typeof accountsIssuer === "string" &&
      accountsIssuer.length > 0 &&
      typeof pairwiseSubjectSecret === "string" &&
      pairwiseSubjectSecret.length > 0
      ? createTakosumiAccountsOidcModuleVariableMaterializer({
          control: {
            getCapsule: (id) => opentofuControlStore.getCapsule(id),
            getInstallConfig: (id) =>
              opentofuControlStore.getInstallConfig(id),
          },
          accounts: accountsStore,
          issuer: accountsIssuer,
          pairwiseSubjectSecret,
        })
      : undefined;
  const interfaceCredentialIssuer = accountsStore
    ? interfaceCredentialIssuerFromAccountsStore(accountsStore)
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
  const envCredentialRecipeHost = mergeCredentialRecipeHostContributions(
    env.TAKOSUMI_CREDENTIAL_RECIPE_HOST_COMPOSITION,
    platformExtensionProviderCredentialComposition(env),
  );
  const credentialRecipeContribution =
    options.operatorProviderConnections === undefined
      ? envCredentialRecipeHost
      : {
          ...(envCredentialRecipeHost ?? {
            credentialRecipes: [],
            credentialRecipeDrivers: {},
          }),
          operatorProviderConnections: [
            ...(envCredentialRecipeHost?.operatorProviderConnections ?? []),
            ...options.operatorProviderConnections,
          ],
        };
  const credentialRecipeHost = resolveCredentialRecipeHostComposition(
    credentialRecipeContribution,
    {
      credentialRecipes:
        options.credentialRecipes ??
        REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes,
      credentialRecipeDrivers:
        options.credentialRecipeDrivers ??
        REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
      ...(options.credentialRecipes === undefined &&
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRequiredProviderSources
        ? {
            credentialRequiredProviderSources:
              REFERENCE_CREDENTIAL_RECIPE_COMPOSITION
                .credentialRequiredProviderSources,
          }
        : {}),
    },
  );
  const operatorInstallConfigs = applyCredentialRequiredProviderSources(
    options.operatorInstallConfigs ??
      env.TAKOSUMI_INSTALL_CONFIG_COMPOSITION ??
      (operatorControlMcpEnabled(env)
        ? [OPERATOR_CONTROL_MCP_INSTALL_CONFIG]
        : []),
    credentialRecipeHost.credentialRequiredProviderSources,
  );
  const runCredentialIssuer = runCredentialIssuerFromEnv(env);
  return await createTakosumiService({
    role,
    runtimeEnv,
    adapters,
    // The shipped Worker explicitly selects the reference provider package.
    // `createTakosumiService` itself has no implicit recipe/setup authority.
    credentialRecipes: credentialRecipeHost.credentialRecipes,
    operatorInstallConfigs,
    credentialRecipeDrivers: credentialRecipeHost.credentialRecipeDrivers,
    ...(credentialRecipeHost.operatorProviderConnections
      ? {
          operatorProviderConnections:
            credentialRecipeHost.operatorProviderConnections,
        }
      : {}),
    ...(runCredentialIssuer ? { runCredentialIssuer } : {}),
    sourceCredentialDrivers:
      options.sourceCredentialDrivers ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.sourceCredentialDrivers,
    buildConnectionSetupRequest:
      options.buildConnectionSetupRequest ??
      REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.buildConnectionSetupRequest,
    ...(connectionOAuthHelpers ? { connectionOAuthHelpers } : {}),
    opentofuControlStore,
    ...(moduleVariableMaterializer ? { moduleVariableMaterializer } : {}),
    gitInstallPlanStore: new D1GitInstallPlanStore(
      env.TAKOSUMI_CONTROL_DB,
    ),
    artifactReferenceAllocator: new ObjectKeyArtifactReferenceAllocator(),
    interfaceStores: createD1InterfaceStores(env.TAKOSUMI_CONTROL_DB),
    ...(env.TAKOSUMI_INTERFACE_PROJECTION_SINK
      ? { interfaceProjectionSink: env.TAKOSUMI_INTERFACE_PROJECTION_SINK }
      : {}),
    ...(interfaceCredentialIssuer ? { interfaceCredentialIssuer } : {}),
    interfaceOAuth2ResourceAuthorizer,
    operatorCapabilities,
    opentofuRunner,
    ...(options.runnerExecutors
      ? { opentofuRunnerExecutors: options.runnerExecutors }
      : {}),
    allowOperatorScopedProviderConnections,
    secretCrypto,
    ...(billingExtensionFactory ? { billingExtensionFactory } : {}),
    // GA async run lifecycle: every create path persists the Run `queued` and
    // schedules its per-run RUN_OWNER directly. The Worker never falls back to
    // inline execution or an unowned Queue handoff when RUN_OWNER is absent;
    // scheduling fails closed at the binding boundary instead.
    enqueueRun,
    enqueueSourceSync,
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
  });
}

function mergeCredentialRecipeHostContributions(
  left: import("takosumi-contract/credential-recipe-host").CredentialRecipeHostComposition | undefined,
  right: import("takosumi-contract/credential-recipe-host").CredentialRecipeHostComposition | undefined,
): import("takosumi-contract/credential-recipe-host").CredentialRecipeHostComposition | undefined {
  if (!left) return right;
  if (!right) return left;
  const duplicateDriver = Object.keys(left.credentialRecipeDrivers).find((key) =>
    Object.prototype.hasOwnProperty.call(right.credentialRecipeDrivers, key)
  );
  if (duplicateDriver) {
    throw new TypeError(
      `Credential Recipe driver ${duplicateDriver} must have one host owner`,
    );
  }
  return {
    credentialRecipes: [
      ...left.credentialRecipes,
      ...right.credentialRecipes,
    ],
    credentialRecipeDrivers: {
      ...left.credentialRecipeDrivers,
      ...right.credentialRecipeDrivers,
    },
    ...(left.credentialRequiredProviderSources !== undefined ||
    right.credentialRequiredProviderSources !== undefined
      ? {
          credentialRequiredProviderSources: Array.from(
            new Set([
              ...(left.credentialRequiredProviderSources ?? []),
              ...(right.credentialRequiredProviderSources ?? []),
            ]),
          ).sort(),
        }
      : {}),
    operatorProviderConnections: [
      ...(left.operatorProviderConnections ?? []),
      ...(right.operatorProviderConnections ?? []),
    ],
  };
}

/**
 * Keeps signing material inside the OSS composition root. Vault supplies the
 * verified connection and canonical Run, adds the installed recipe's exact
 * audience/scopes, and lets the recipe driver request only a bounded TTL.
 */
function runCredentialIssuerFromEnv(
  env: CloudflareWorkerEnv,
): CredentialRecipeRunCredentialIssuer | undefined {
  const secret = runCredentialTokenSecret(env);
  if (!secret) return undefined;
  return async ({ connection, run, request }) => {
    if (!isWorkspaceBindableOperatorConnection(connection)) {
      throw new Error(
        `connection ${connection.id} is not authorized for Run credential issuance`,
      );
    }
    return await createRunCredentialToken({
      secret,
      audience: request.audience,
      subject: run.installingPrincipalId,
      workspaceId: run.workspaceId,
      capsuleId: run.capsuleId,
      runId: run.runId,
      installingPrincipalId: run.installingPrincipalId,
      connectionId: connection.id,
      provider: connection.provider,
      phase: run.phase,
      scopes: request.scopes,
      ...(request.ttlSeconds !== undefined
        ? { ttlSeconds: request.ttlSeconds }
        : {}),
    });
  };
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

export function workerInterfaceOAuth2ResourceAuthorizer(
  env: CloudflareWorkerEnv,
  store: Pick<OpenTofuControlStore, "getPublicHostReservation">,
  additional?: CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"],
): NonNullable<
  CreateTakosumiServiceOptions["interfaceOAuth2ResourceAuthorizer"]
> {
  return async (input) => {
    if (operatorControlMcpResourceAuthorized(env, input)) {
      // The host proves only its own enabled, versioned adapter route. The
      // Capsule still cannot grant a Binding; an operator/installer owns that
      // separate service-side authorization.
      return true;
    }
    if (input.ownerRef.kind === "Capsule") {
      const hostname = new URL(input.resource).hostname.toLowerCase();
      const reservation = await store.getPublicHostReservation(hostname);
      if (
        reservation?.status === "reserved" &&
        reservation.workspaceId === input.workspaceId &&
        reservation.capsuleId === input.ownerRef.id
      ) {
        return true;
      }
    }
    return additional ? await additional(input) : false;
  };
}

function operatorCapabilitiesFromEnv(
  env: CloudflareWorkerEnv,
): Partial<TakosumiOperatorCapabilities> {
  const capabilities = {} as Record<string, boolean>;
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

function envFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

class CoordinationTransportUnavailableError extends Error {
  readonly retryable = true;
  readonly reason = "coordination_transport_unavailable";
  readonly originalError?: unknown;

  constructor(path: string, originalError?: unknown) {
    super(`coordination ${path} transport unavailable`);
    this.name = "CoordinationTransportUnavailableError";
    this.originalError = originalError;
  }
}

class CoordinationRequestError extends Error {
  readonly retryable = false;

  constructor(path: string, status: number) {
    super(`coordination ${path} request failed with status ${status}`);
    this.name = "CoordinationRequestError";
  }
}

/**
 * Builds a {@link CapsuleCoordination} that fronts the shared
 * {@link CoordinationObject} via its `acquire-lease` / `renew-lease` /
 * `release-lease` POST API. Returns undefined when the DO binding is absent,
 * leaving the controller on its in-process serialization. The same single DO
 * instance (`takosumi-control-plane`) backs the lease keyspace used by the rest
 * of the coordination surface, so environment leases share that storage.
 */
export function durableObjectCapsuleCoordination(
  env: CloudflareWorkerEnv,
): CapsuleCoordination | undefined {
  const namespace = env.COORDINATION;
  if (!namespace) return undefined;
  const stub = () =>
    namespace.get(namespace.idFromName("takosumi-control-plane"));
  const post = async (path: string, body: unknown): Promise<unknown> => {
    let response: Response;
    try {
      response = await stub().fetch(
        new Request(`https://takos-coordination.internal/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    } catch (error) {
      throw new CoordinationTransportUnavailableError(path, error);
    }
    let payload: { result?: unknown; error?: string };
    try {
      payload = (await response.json()) as {
        result?: unknown;
        error?: string;
      };
    } catch (error) {
      throw new CoordinationTransportUnavailableError(path, error);
    }
    if (!response.ok || payload.error) {
      if (
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429
      ) {
        throw new CoordinationTransportUnavailableError(path);
      }
      throw new CoordinationRequestError(path, response.status);
    }
    return payload.result;
  };
  return {
    async acquireLease(input) {
      const result = (await post("acquire-lease", {
        scope: input.scope,
        holderId: input.holderId,
        ttlMs: input.ttlMs,
        ...(input.joinExistingHolder === true
          ? { joinExistingHolder: true }
          : {}),
      })) as {
        scope: string;
        holderId: string;
        token: string;
        referenceId?: string;
        acquired: boolean;
        expiresAt: string;
      };
      return result;
    },
    async renewLease(input) {
      return (await post("renew-lease", {
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
        ttlMs: input.ttlMs,
      })) as {
        scope: string;
        holderId: string;
        token: string;
        acquired: boolean;
        expiresAt: string;
      };
    },
    async releaseLease(input) {
      return (await post("release-lease", {
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
        ...(input.referenceId ? { referenceId: input.referenceId } : {}),
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
function openTofuRunOwnerEnqueuer(env: CloudflareWorkerEnv): EnqueueRun {
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
): EnqueueSourceSync {
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
