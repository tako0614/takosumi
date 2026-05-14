import {
  type CreatedPaaSApp,
  createPaaSApp,
} from "../../../packages/kernel/src/bootstrap.ts";
import type { AppAdapters } from "../../../packages/kernel/src/app_context.ts";
import {
  InMemoryRuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "../../../packages/kernel/src/agents/mod.ts";
import { LocalActorAdapter } from "../../../packages/kernel/src/adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../../../packages/kernel/src/adapters/coordination/mod.ts";
import { NoopTestKms } from "../../../packages/kernel/src/adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../../../packages/kernel/src/adapters/notification/mod.ts";
import { LocalOperatorConfig } from "../../../packages/kernel/src/adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../../../packages/kernel/src/adapters/provider/mod.ts";
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
} from "../../../packages/kernel/src/adapters/queue/mod.ts";
import { InMemoryRouterConfigAdapter } from "../../../packages/kernel/src/adapters/router/mod.ts";
import { MemoryEncryptedSecretStore } from "../../../packages/kernel/src/adapters/secret-store/mod.ts";
import { ImmutableManifestSourceAdapter } from "../../../packages/kernel/src/adapters/source/mod.ts";
import { InMemoryObservabilitySink } from "../../../packages/kernel/src/services/observability/mod.ts";
import type { Queue } from "./bindings.ts";
import type { CloudflareWorkerEnv } from "./bindings.ts";
import { createCloudflareD1DeployStores } from "./d1_deploy_stores.ts";
import { CloudflareD1SnapshotStorageDriver } from "./d1_storage.ts";
import { CloudflareR2ObjectStorage } from "./r2_object_storage.ts";
import {
  createKernelWorkerRequest,
  isKernelControlPlanePath,
} from "./routes.ts";

export type { CloudflareWorkerEnv } from "./bindings.ts";

export interface CloudflareWorkerHandler {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response>;
}

export interface CreateCloudflareWorkerOptions {
  readonly createKernelApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedPaaSApp>;
  readonly createRuntimeAgentApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedPaaSApp>;
}

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions = {},
): CloudflareWorkerHandler {
  let kernelApp: Promise<CreatedPaaSApp> | undefined;
  let runtimeAgentApp: Promise<CreatedPaaSApp> | undefined;

  return {
    async fetch(
      request: Request,
      env: CloudflareWorkerEnv,
    ): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, provider: "cloudflare-worker" });
      }
      if (url.pathname.startsWith("/coordination/")) {
        const id = env.TAKOS_COORDINATION.idFromName("takos-control-plane");
        const targetPath = `/${url.pathname.slice("/coordination/".length)}`;
        return env.TAKOS_COORDINATION.get(id).fetch(
          new Request(new URL(targetPath, request.url), request),
        );
      }
      if (url.pathname === "/queue/test" && request.method === "POST") {
        await env.TAKOS_QUEUE?.send(await request.json());
        return Response.json({ queued: true });
      }
      if (url.pathname === "/storage/healthz") {
        await env.TAKOS_D1.prepare("select 1").first();
        await env.TAKOS_ARTIFACTS.head("healthz");
        return Response.json({ ok: true, storage: "cloudflare-d1-r2" });
      }
      if (isRuntimeAgentPath(url.pathname)) {
        runtimeAgentApp ??= options.createRuntimeAgentApp
          ? options.createRuntimeAgentApp(env)
          : createWorkerPaaSApp(env, "takosumi-runtime-agent");
        const created = await runtimeAgentApp;
        return created.app.fetch(createKernelWorkerRequest(request));
      }
      if (isKernelControlPlanePath(url.pathname)) {
        kernelApp ??= options.createKernelApp
          ? options.createKernelApp(env)
          : createWorkerPaaSApp(env, "takosumi-api");
        const created = await kernelApp;
        return created.app.fetch(createKernelWorkerRequest(request));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
}

async function createWorkerPaaSApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
): Promise<CreatedPaaSApp> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const storage = new CloudflareD1SnapshotStorageDriver(env.TAKOS_D1);
  const deployStores = createCloudflareD1DeployStores(env.TAKOS_D1);
  const adapters = createWorkerAdapters({
    env,
    runtimeEnv,
    storage,
  });
  return await createPaaSApp({
    role,
    runtimeEnv,
    adapters,
    startWorkerDaemon: false,
    takosumiDeploymentRecordStore: deployStores.deploymentRecordStore,
    takosumiDeployIdempotencyStore: deployStores.idempotencyStore,
    takosumiOperationJournalStore: deployStores.operationJournalStore,
    takosumiRevokeDebtStore: deployStores.revokeDebtStore,
  });
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
    source: new ImmutableManifestSourceAdapter({ clock, idGenerator }),
    storage: input.storage,
    kms: new NoopTestKms({ clock, idGenerator }),
    observability: new InMemoryObservabilitySink(),
    routerConfig: new InMemoryRouterConfigAdapter({ clock }),
    queue: input.env.TAKOS_QUEUE
      ? new CloudflareQueueAdapter(input.env.TAKOS_QUEUE)
      : new MemoryQueueAdapter({ clock, idGenerator }),
    objectStorage: new CloudflareR2ObjectStorage(input.env.TAKOS_ARTIFACTS),
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

function isRuntimeAgentPath(pathname: string): boolean {
  return pathname === "/api/internal/v1/runtime/agents" ||
    pathname.startsWith("/api/internal/v1/runtime/agents/");
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
