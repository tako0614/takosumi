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
import type { CloudflareWorkerEnv } from "./bindings.ts";
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

export async function createWorkerServiceApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
  options: {
    readonly runnerProfiles?: readonly RunnerProfile[];
    readonly defaultRunnerProfileId?: string;
    readonly releaseActivator?: ReleaseActivator;
  } = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const storage = new CloudflareD1SnapshotStorageDriver(
    env.TAKOSUMI_CONTROL_DB,
  );
  const deployStores = createCloudflareD1DeployStores(env.TAKOSUMI_CONTROL_DB);
  const adapters = createWorkerAdapters({
    env,
    runtimeEnv,
    storage,
  });
  const enqueueRun = openTofuRunEnqueuer(env);
  const enqueueSourceSync = openTofuSourceSyncEnqueuer(env);
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
  return await createTakosumiService({
    role,
    runtimeEnv,
    adapters,
    startWorkerDaemon: false,
    takosumiDeploymentRecordStore: deployStores.deploymentRecordStore,
    takosumiRevokeDebtStore: deployStores.revokeDebtStore,
    opentofuDeploymentStore: createCloudflareD1OpenTofuDeploymentStore(
      env.TAKOSUMI_CONTROL_DB,
    ),
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
 * Builds the producer half of the async run lifecycle: enqueues a
 * run-dispatch message onto `RUN_QUEUE`. Returns undefined when
 * the queue is not bound, so the controller falls back to its inline dispatcher.
 * The message carries only the run identity (never variables or credentials).
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
