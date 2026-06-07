import {
  type CreatedTakosumiService,
  createTakosumiService,
} from "../../src/service/bootstrap.ts";
import type { AppAdapters } from "../../src/service/app_context.ts";
import {
  InMemoryRuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "../../src/service/agents/mod.ts";
import { LocalActorAdapter } from "../../src/service/adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../../src/service/adapters/coordination/mod.ts";
import { NoopTestKms } from "../../src/service/adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../../src/service/adapters/notification/mod.ts";
import { LocalOperatorConfig } from "../../src/service/adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../../src/service/adapters/provider/mod.ts";
import {
  type AckInput,
  type DeadLetterInput,
  type EnqueueInput,
  type LeaseInput,
  MemoryQueueAdapter,
  type NackInput,
  type QueueLease,
  type QueueMessage,
  type QueuePort,
} from "../../src/service/adapters/queue/mod.ts";
import { MemoryEncryptedSecretStore } from "../../src/service/adapters/secret-store/mod.ts";
import { ImmutableSourceAdapter } from "../../src/service/adapters/source/mod.ts";
import { InMemoryObservabilitySink } from "../../src/service/services/observability/mod.ts";
import type { EnqueueRun } from "../../src/service/domains/deploy-control/mod.ts";
import type { EnqueueSourceSync } from "../../src/service/domains/sources/mod.ts";
import type { InstallationCoordination } from "../../src/service/domains/deploy-control/installation_lease.ts";
import type { RunnerProfile } from "takosumi-contract/deploy-control-api";
import type { CloudflareWorkerEnv, Queue } from "./bindings.ts";
import { createCloudflareD1DeployStores } from "./d1_deploy_stores.ts";
import { createCloudflareD1OpenTofuDeploymentStore } from "./d1_opentofu_store.ts";
import { CloudflareD1SnapshotStorageDriver } from "./d1_storage.ts";
import { CloudflareR2ObjectStorage } from "./r2_object_storage.ts";
import { backupArtifactStoreFromEnv } from "./backup_artifact_store.ts";
import { sensitiveOutputResolverFromEnv } from "./sensitive_output_resolver.ts";
import { CloudflareContainerOpenTofuRunner } from "./container_runner.ts";

export async function createWorkerServiceApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
  options: { readonly runnerProfiles?: readonly RunnerProfile[] } = {},
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const storage = new CloudflareD1SnapshotStorageDriver(env.TAKOS_D1);
  const deployStores = createCloudflareD1DeployStores(env.TAKOS_D1);
  const adapters = createWorkerAdapters({
    env,
    runtimeEnv,
    storage,
  });
  const enqueueRun = openTofuRunEnqueuer(env);
  const enqueueSourceSync = openTofuSourceSyncEnqueuer(env);
  const installationCoordination = durableObjectInstallationCoordination(env);
  // Control backups (spec §33 / §26): seal the bundle with the at-rest crypto
  // and write to R2_BACKUPS. Absent binding -> backups stay disabled (501).
  const backupArtifactStore = backupArtifactStoreFromEnv(env.R2_BACKUPS, runtimeEnv);
  const sensitiveOutputResolver = sensitiveOutputResolverFromEnv(
    env.R2_ARTIFACTS,
    runtimeEnv,
  );
  return await createTakosumiService({
    role,
    runtimeEnv,
    adapters,
    startWorkerDaemon: false,
    takosumiDeploymentRecordStore: deployStores.deploymentRecordStore,
    takosumiRevokeDebtStore: deployStores.revokeDebtStore,
    opentofuDeploymentStore: createCloudflareD1OpenTofuDeploymentStore(
      env.TAKOS_D1,
    ),
    opentofuRunner: new CloudflareContainerOpenTofuRunner(env),
    // Async run lifecycle: when the run queue is bound, the create path persists
    // the run `queued` and returns immediately; the `queue()` consumer in this
    // same worker drives execution. Without the binding, the controller's
    // default inline dispatcher preserves synchronous create-executes-run.
    ...(enqueueRun ? { enqueueRun } : {}),
    ...(enqueueSourceSync ? { enqueueSourceSync } : {}),
    // Environment lease (spec §10.2): front the shared CoordinationObject so the
    // apply consumer serializes write runs per environment across isolates.
    ...(installationCoordination ? { installationCoordination } : {}),
    ...(options.runnerProfiles
      ? { runnerProfiles: options.runnerProfiles }
      : {}),
    ...(backupArtifactStore ? { backupArtifactStore } : {}),
    ...(sensitiveOutputResolver ? { sensitiveOutputResolver } : {}),
  });
}

/**
 * Builds an {@link InstallationCoordination} that fronts the shared
 * {@link CoordinationObject} via its `acquire-lease` / `release-lease` POST
 * API. Returns undefined when the DO binding is absent, leaving the controller
 * on its in-process serialization. The same single DO instance
 * (`takos-control-plane`) backs the lease keyspace used by the rest of the
 * coordination surface, so environment leases share that storage.
 */
function durableObjectInstallationCoordination(
  env: CloudflareWorkerEnv,
): InstallationCoordination | undefined {
  const namespace = env.COORDINATION;
  if (!namespace) return undefined;
  const stub = () =>
    namespace.get(namespace.idFromName("takos-control-plane"));
  const post = async (path: string, body: unknown): Promise<unknown> => {
    const response = await stub().fetch(
      new Request(`https://takos-coordination.internal/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const payload = await response.json() as { result?: unknown; error?: string };
    if (!response.ok || payload.error) {
      throw new Error(
        `coordination ${path} failed: ${payload.error ?? response.status}`,
      );
    }
    return payload.result;
  };
  return {
    async acquireLease(input) {
      const result = await post("acquire-lease", {
        scope: input.scope,
        holderId: input.holderId,
        ttlMs: input.ttlMs,
      }) as {
        scope: string;
        holderId: string;
        token: string;
        acquired: boolean;
        expiresAt: string;
      };
      return result;
    },
    async releaseLease(input) {
      return await post("release-lease", {
        scope: input.scope,
        holderId: input.holderId,
        token: input.token,
      }) as boolean;
    },
  };
}

/**
 * Builds the producer half of the async run lifecycle: enqueues a
 * run-dispatch message onto `RUN_QUEUE`. Returns undefined when
 * the queue is not bound, so the controller falls back to its inline dispatcher.
 * The message carries only the run identity (never variables or credentials).
 */
function openTofuRunEnqueuer(
  env: CloudflareWorkerEnv,
): EnqueueRun | undefined {
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
    observability: new InMemoryObservabilitySink(),
    queue: input.env.TAKOS_QUEUE
      ? new CloudflareQueueAdapter(input.env.TAKOS_QUEUE)
      : new MemoryQueueAdapter({ clock, idGenerator }),
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
    TAKOS_RUNTIME_MODE: "cloudflare-worker",
  };
  for (const [key, value] of Object.entries(env)) {
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      runtimeEnv[key] = String(value);
    }
  }
  return runtimeEnv;
}

class CloudflareQueueAdapter implements QueuePort {
  constructor(private readonly queue: Queue<unknown>) {}

  async enqueue<TPayload = unknown>(
    input: EnqueueInput<TPayload>,
  ): Promise<QueueMessage<TPayload>> {
    await this.queue.send(input.payload);
    const now = new Date().toISOString();
    return {
      id: input.messageId ?? crypto.randomUUID(),
      queue: input.queue,
      payload: input.payload,
      status: "queued",
      priority: input.priority ?? 0,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? 3,
      enqueuedAt: now,
      availableAt: input.availableAt ?? now,
      metadata: { ...(input.metadata ?? {}) },
    };
  }

  lease<TPayload = unknown>(
    _input: LeaseInput,
  ): Promise<QueueLease<TPayload> | undefined> {
    return Promise.resolve(undefined);
  }

  ack(_input: AckInput): Promise<void> {
    return Promise.resolve();
  }

  nack<TPayload = unknown>(_input: NackInput): Promise<QueueMessage<TPayload>> {
    throw new Error("Cloudflare Queue consumer ack/nack is not exposed here");
  }

  deadLetter<TPayload = unknown>(
    _input: DeadLetterInput,
  ): Promise<QueueMessage<TPayload>> {
    throw new Error("Cloudflare Queue dead-letter is not exposed here");
  }
}
