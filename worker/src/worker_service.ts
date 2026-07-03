import {
  type CreatedTakosumiService,
  createTakosumiService,
} from "../../core/bootstrap.ts";
import type { AppAdapters } from "../../core/app_context.ts";
import {
  InMemoryRuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "../../core/agents/mod.ts";
import { LocalActorAdapter } from "../../core/adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../../core/adapters/coordination/mod.ts";
import { NoopTestKms } from "../../core/adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../../core/adapters/notification/mod.ts";
import { LocalOperatorConfig } from "../../core/adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../../core/adapters/provider/mod.ts";
import { MemoryQueueAdapter } from "../../core/adapters/queue/mod.ts";
import { MemoryEncryptedSecretStore } from "../../core/adapters/secret-store/mod.ts";
import { selectSecretBoundaryCrypto } from "../../core/adapters/secret-store/memory.ts";
import { ImmutableSourceAdapter } from "../../core/adapters/source/mod.ts";
import { InMemoryObservabilitySink } from "../../core/domains/observability/mod.ts";
import type {
  EnqueueRun,
  ReleaseActivator,
} from "../../core/domains/deploy-control/mod.ts";
import type { EnqueueSourceSync } from "../../core/domains/sources/mod.ts";
import type { InstallationCoordination } from "../../core/domains/deploy-control/installation_lease.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { CloudflareWorkerEnv, OpenTofuRunAction } from "./bindings.ts";
import { createCloudflareD1DeployStores } from "./d1_deploy_stores.ts";
import { createCloudflareD1OpenTofuDeploymentStore } from "./d1_opentofu_store.ts";
import { CloudflareD1SnapshotStorageDriver } from "./d1_storage.ts";
import { CloudflareR2ObjectStorage } from "./r2_object_storage.ts";
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
import { CloudflareD1MetricObservabilitySink } from "./d1_observability.ts";
import { createD1ResourceShapeStores } from "../../core/domains/resource-shape/d1_stores.ts";
import { createResourceShapeBackingCapsuleResolver } from "../../core/domains/resource-shape/backing_capsule.ts";
import {
  ControllerOpentofuRunPort,
  OpentofuResourceShapeAdapter,
} from "../../core/domains/resource-shape/opentofu_adapter.ts";
import {
  RESOURCE_SHAPE_KINDS,
  type ActorContext,
  type ResourceShapeKind,
} from "takosumi-contract";
import {
  decodeActorContext,
  TAKOSUMI_INTERNAL_ACTOR_HEADER,
} from "takosumi-contract/internal/rpc";
import type {
  TakosumiAdapterCapabilities,
  TakosumiResourceCapabilities,
} from "takosumi-contract/capabilities";

export async function createWorkerServiceApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
  options: {
    readonly runnerProfiles?: readonly RunnerProfile[];
    readonly defaultRunnerProfileId?: string;
    readonly releaseActivator?: ReleaseActivator;
    readonly enqueueRun?: EnqueueRun;
    readonly enqueueSourceSync?: EnqueueSourceSync;
  } = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const storage = new CloudflareD1SnapshotStorageDriver(
    env.TAKOSUMI_CONTROL_DB,
  );
  const opentofuDeploymentStore = createCloudflareD1OpenTofuDeploymentStore(
    env.TAKOSUMI_CONTROL_DB,
  );
  const deployStores = createCloudflareD1DeployStores(env.TAKOSUMI_CONTROL_DB);
  const adapters = createWorkerAdapters({
    env,
    runtimeEnv,
    storage,
  });
  const enqueueRun =
    options.enqueueRun ??
    openTofuRunOwnerEnqueuer(env) ??
    openTofuRunEnqueuer(env);
  const enqueueSourceSync =
    options.enqueueSourceSync ??
    openTofuRunOwnerSourceSyncEnqueuer(env) ??
    openTofuSourceSyncEnqueuer(env);
  const installationCoordination = durableObjectInstallationCoordination(env);
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
  const officialCatalogSource = officialCatalogSourceFromEnv(env);
  const resourceShapeCapabilities = resourceShapeCapabilitiesFromEnv(env);
  return await createTakosumiService({
    role,
    runtimeEnv,
    adapters,
    startWorkerDaemon: false,
    takosumiDeploymentRecordStore: deployStores.deploymentRecordStore,
    takosumiRevokeDebtStore: deployStores.revokeDebtStore,
    opentofuDeploymentStore,
    resourceShapeStores: createD1ResourceShapeStores(env.TAKOSUMI_CONTROL_DB),
    resourceShapeAdapterFactory: ({ controller, capsules }) =>
      new OpentofuResourceShapeAdapter(
        new ControllerOpentofuRunPort({
          driver: controller,
          resolveCapsuleBinding: createResourceShapeBackingCapsuleResolver({
            installations: capsules,
          }),
          driveRunsSynchronously: enqueueRun ? false : true,
          waitTimeoutMs: 300_000,
        }),
      ),
    enabledResourceShapeKinds: resourceShapeCapabilities.enabledKinds,
    resourceCapabilities: resourceShapeCapabilities.resources,
    adapterCapabilities: resourceShapeCapabilities.adapters,
    resolveResourceShapeActor: resourceShapeActorFromRequest,
    ...(officialCatalogSource ? { officialCatalogSource } : {}),
    opentofuRunner,
    providerEnvRunner: opentofuRunner,
    secretCrypto,
    // Async run lifecycle: when the run queue is bound, the create path persists
    // the run `queued` and returns immediately; the `queue()` consumer in this
    // same worker drives execution. Without the binding, the controller's
    // default inline dispatcher preserves synchronous create-executes-run.
    ...(enqueueRun ? { enqueueRun } : {}),
    ...(enqueueSourceSync ? { enqueueSourceSync } : {}),
    // `takosumi deploy` upload archives are written to R2_SOURCE at the SAME raw
    // key the OpenTofu runner restores from (no logical-bucket prefix).
    ...(env.R2_SOURCE
      ? {
          writeSourceArchive: async (key: string, bytes: Uint8Array) => {
            await env.R2_SOURCE!.put(key, bytes);
          },
        }
      : {}),
    // Environment lease (spec §10.2): front the shared CoordinationObject so the
    // apply consumer serializes write runs per environment across isolates.
    ...(installationCoordination ? { installationCoordination } : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(options.defaultRunnerProfileId
      ? { defaultRunnerProfileId: options.defaultRunnerProfileId }
      : {}),
    ...(backupArtifactStore ? { backupArtifactStore } : {}),
    ...(backupStateObjectReader ? { backupStateObjectReader } : {}),
    ...(backupArtifactStore ? { serviceDataBackupRunner: opentofuRunner } : {}),
    ...(sensitiveOutputResolver ? { sensitiveOutputResolver } : {}),
    ...(dependencyValueSealer ? { dependencyValueSealer } : {}),
    ...(releaseActivator ? { releaseActivator } : {}),
  });
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

function officialCatalogSourceFromEnv(
  env: CloudflareWorkerEnv,
): { readonly git: string; readonly ref: string } | undefined {
  const git =
    typeof env.TAKOSUMI_OFFICIAL_CATALOG_GIT === "string"
      ? env.TAKOSUMI_OFFICIAL_CATALOG_GIT.trim()
      : "";
  const ref =
    typeof env.TAKOSUMI_OFFICIAL_CATALOG_REF === "string"
      ? env.TAKOSUMI_OFFICIAL_CATALOG_REF.trim()
      : "";
  return git && ref ? { git, ref } : undefined;
}

const RESOURCE_CAPABILITY_KEYS: readonly ResourceShapeKind[] =
  RESOURCE_SHAPE_KINDS;

const ADAPTER_CAPABILITY_KEYS: readonly (keyof TakosumiAdapterCapabilities)[] =
  ["opentofu", "aws", "cloudflare", "kubernetes", "vm", "takosumi_native"];

type MutablePartial<T> = { -readonly [K in keyof T]?: T[K] };

function resourceShapeCapabilitiesFromEnv(env: CloudflareWorkerEnv): {
  readonly enabledKinds: readonly ResourceShapeKind[];
  readonly resources: Partial<TakosumiResourceCapabilities>;
  readonly adapters: Partial<TakosumiAdapterCapabilities>;
} {
  const enabledKinds = parseCapabilityList(
    env.TAKOSUMI_RESOURCE_SHAPES,
    RESOURCE_CAPABILITY_KEYS,
  );
  const resources: MutablePartial<TakosumiResourceCapabilities> = {
    EdgeWorker: false,
    ObjectBucket: false,
    KVStore: false,
    Queue: false,
    SQLDatabase: false,
    ContainerService: false,
  };
  for (const kind of enabledKinds) resources[kind] = true;

  const adapters: MutablePartial<TakosumiAdapterCapabilities> = {
    opentofu: enabledKinds.length > 0,
    aws: false,
    cloudflare: false,
    kubernetes: false,
    vm: false,
    takosumi_native: false,
  };
  if (enabledKinds.length > 0) {
    for (const key of parseCapabilityList(
      env.TAKOSUMI_RESOURCE_ADAPTERS,
      ADAPTER_CAPABILITY_KEYS,
    )) {
      adapters[key] = true;
    }
  }
  return { enabledKinds, resources, adapters };
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

/**
 * Builds an {@link InstallationCoordination} that fronts the shared
 * {@link CoordinationObject} via its `acquire-lease` / `release-lease` POST
 * API. Returns undefined when the DO binding is absent, leaving the controller
 * on its in-process serialization. The same single DO instance
 * (`takosumi-control-plane`) backs the lease keyspace used by the rest of the
 * coordination surface, so environment leases share that storage.
 */
function durableObjectInstallationCoordination(
  env: CloudflareWorkerEnv,
): InstallationCoordination | undefined {
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
      spaceId: dispatch.spaceId,
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
      spaceId: dispatch.spaceId,
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
    readonly spaceId: string;
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
          spaceId: dispatch.spaceId,
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
      spaceId: dispatch.spaceId,
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
      spaceId: dispatch.spaceId,
      requestedAt: new Date().toISOString(),
    });
  };
}

function createWorkerAdapters(input: {
  readonly env: CloudflareWorkerEnv;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly storage: CloudflareD1SnapshotStorageDriver;
}): AppAdapters {
  const clock = () => new Date();
  const idGenerator = () => crypto.randomUUID();
  const localActor = new LocalActorAdapter();
  const runtimeAgent = new InMemoryRuntimeAgentRegistry({
    clock,
    idGenerator,
    ledger: new StorageBackedWorkLedger(input.storage),
  });
  return {
    actor: localActor,
    auth: localActor,
    coordination: new MemoryCoordinationAdapter({ clock, idGenerator }),
    notifications: new MemoryNotificationSink({ clock, idGenerator }),
    operatorConfig: new LocalOperatorConfig({ clock }),
    provider: new NoopProviderMaterializer({ clock, idGenerator }),
    secrets: new MemoryEncryptedSecretStore({
      clock,
      idGenerator,
      env: input.runtimeEnv,
    }),
    source: new ImmutableSourceAdapter({ clock, idGenerator }),
    storage: input.storage,
    kms: new NoopTestKms({ clock, idGenerator }),
    observability: new CloudflareD1MetricObservabilitySink({
      db: input.env.TAKOSUMI_CONTROL_DB,
      fallback: new InMemoryObservabilitySink(),
    }),
    queue: new MemoryQueueAdapter({ clock, idGenerator }),
    objectStorage: new CloudflareR2ObjectStorage(input.env.R2_ARTIFACTS),
    runtimeAgent,
  };
}

function cloudflareRuntimeEnv(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
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
