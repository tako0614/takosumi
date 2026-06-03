import {
  type CreatedTakosumiService,
  createTakosumiService,
} from "../../../src/service/bootstrap.ts";
import type { AppAdapters } from "../../../src/service/app_context.ts";
import {
  InMemoryRuntimeAgentRegistry,
  StorageBackedWorkLedger,
} from "../../../src/service/agents/mod.ts";
import { LocalActorAdapter } from "../../../src/service/adapters/auth/mod.ts";
import { MemoryCoordinationAdapter } from "../../../src/service/adapters/coordination/mod.ts";
import { NoopTestKms } from "../../../src/service/adapters/kms/mod.ts";
import { MemoryNotificationSink } from "../../../src/service/adapters/notification/mod.ts";
import { LocalOperatorConfig } from "../../../src/service/adapters/operator-config/mod.ts";
import { NoopProviderMaterializer } from "../../../src/service/adapters/provider/mod.ts";
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
} from "../../../src/service/adapters/queue/mod.ts";
import { InMemoryRouterConfigAdapter } from "../../../src/service/adapters/router/mod.ts";
import { MemoryEncryptedSecretStore } from "../../../src/service/adapters/secret-store/mod.ts";
import { ImmutableSourceAdapter } from "../../../src/service/adapters/source/mod.ts";
import { InMemoryObservabilitySink } from "../../../src/service/services/observability/mod.ts";
import type {
  OpenTofuApplyJob,
  OpenTofuApplyResult,
  OpenTofuDestroyJob,
  OpenTofuDestroyResult,
  OpenTofuPlanJob,
  OpenTofuPlanResult,
  OpenTofuRunner,
} from "../../../src/service/domains/deploy-control/mod.ts";
import type {
  CloudflareWorkerEnv,
  OpenTofuRunQueueMessage,
  Queue,
  QueueBatch,
} from "./bindings.ts";
import { createCloudflareD1DeployStores } from "./d1_deploy_stores.ts";
import { createCloudflareD1OpenTofuDeploymentStore } from "./d1_opentofu_store.ts";
import { CloudflareD1SnapshotStorageDriver } from "./d1_storage.ts";
import { CloudflareR2ObjectStorage } from "./r2_object_storage.ts";
import {
  createServiceWorkerRequest,
  isServiceControlPlanePath,
} from "./routes.ts";

export type { CloudflareWorkerEnv } from "./bindings.ts";

export interface CloudflareWorkerHandler {
  fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response>;
  queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void>;
}

export interface CreatedCloudflareWorkerApp {
  readonly app: {
    fetch(request: Request): Promise<Response> | Response;
  };
}

export interface CreateCloudflareWorkerOptions {
  readonly createServiceApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedCloudflareWorkerApp>;
  readonly createRuntimeAgentApp?: (
    env: CloudflareWorkerEnv,
  ) => Promise<CreatedCloudflareWorkerApp>;
}

export function createCloudflareWorker(
  options: CreateCloudflareWorkerOptions = {},
): CloudflareWorkerHandler {
  let serviceApp: Promise<CreatedCloudflareWorkerApp> | undefined;
  let runtimeAgentApp: Promise<CreatedCloudflareWorkerApp> | undefined;

  return {
    async fetch(request: Request, env: CloudflareWorkerEnv): Promise<Response> {
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
          : createWorkerServiceApp(env, "takosumi-runtime-agent");
        const created = await runtimeAgentApp;
        return created.app.fetch(createServiceWorkerRequest(request));
      }
      if (isServiceControlPlanePath(url.pathname)) {
        serviceApp ??= options.createServiceApp
          ? options.createServiceApp(env)
          : createWorkerServiceApp(env, "takosumi-api");
        const created = await serviceApp;
        return created.app.fetch(createServiceWorkerRequest(request));
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
    async queue(batch: QueueBatch, env: CloudflareWorkerEnv): Promise<void> {
      for (const message of batch.messages) {
        const run = parseOpenTofuRunQueueMessage(message.body);
        if (!run) continue;
        await dispatchOpenTofuRunToContainer(run, env);
        message.ack?.();
      }
    },
  };
}

async function createWorkerServiceApp(
  env: CloudflareWorkerEnv,
  role: "takosumi-api" | "takosumi-runtime-agent",
): Promise<CreatedTakosumiService> {
  const runtimeEnv = cloudflareRuntimeEnv(env, role);
  const storage = new CloudflareD1SnapshotStorageDriver(env.TAKOS_D1);
  const deployStores = createCloudflareD1DeployStores(env.TAKOS_D1);
  const adapters = createWorkerAdapters({
    env,
    runtimeEnv,
    storage,
  });
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
  });
}

async function dispatchOpenTofuRunToContainer(
  run: OpenTofuRunQueueMessage,
  env: CloudflareWorkerEnv,
): Promise<void> {
  if (!env.TAKOS_OPENTOFU_RUNNER) {
    throw new Error("TAKOS_OPENTOFU_RUNNER binding is not configured");
  }
  const id = env.TAKOS_OPENTOFU_RUNNER.idFromName(run.runId);
  const response = await env.TAKOS_OPENTOFU_RUNNER.get(id).fetch(
    new Request(
      `https://opentofu-runner.internal/runs/${encodeURIComponent(run.runId)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(run),
      },
    ),
  );
  if (!response.ok) {
    throw new Error(
      `OpenTofu runner rejected ${run.action} run ${run.runId}: ${response.status}`,
    );
  }
}

function isRuntimeAgentPath(pathname: string): boolean {
  return (
    pathname === "/api/internal/v1/runtime/agents" ||
    pathname.startsWith("/api/internal/v1/runtime/agents/")
  );
}

function parseOpenTofuRunQueueMessage(
  value: unknown,
): OpenTofuRunQueueMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "takosumi.opentofu-run@v1") return undefined;
  const action = record.action;
  if (action !== "plan" && action !== "apply" && action !== "destroy") {
    throw new Error("OpenTofu run queue message action is invalid");
  }
  const runId = nonEmptyString(record.runId);
  if (!runId) {
    throw new Error("OpenTofu run queue message runId is required");
  }
  const requestedAt = nonEmptyString(record.requestedAt);
  if (!requestedAt) {
    throw new Error("OpenTofu run queue message requestedAt is required");
  }
  const request = record.request;
  if (
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    throw new Error("OpenTofu run queue message request must be an object");
  }
  return {
    kind: "takosumi.opentofu-run@v1",
    action,
    runId,
    requestedAt,
    request: request as Record<string, unknown>,
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

class CloudflareContainerOpenTofuRunner implements OpenTofuRunner {
  constructor(private readonly env: CloudflareWorkerEnv) {}

  async plan(job: OpenTofuPlanJob): Promise<OpenTofuPlanResult> {
    const result = await this.#runContainer("plan", job.planRun.id, job);
    const planDigest = stringFromRecord(result, "planDigest") ??
      await digestJson({
        action: "plan",
        runId: job.planRun.id,
        stdout: stringFromRecord(result, "stdout") ?? "",
        stderr: stringFromRecord(result, "stderr") ?? "",
      });
    const planArtifact = planArtifactFromContainerResult(
      result,
      job.planRun.id,
      planDigest,
    );
    return {
      planDigest,
      planArtifact,
      ...(stringArrayFromRecord(result, "requiredProviders")
        ? { requiredProviders: stringArrayFromRecord(result, "requiredProviders") }
        : {}),
      ...(stringFromRecord(result, "sourceCommit")
        ? { sourceCommit: stringFromRecord(result, "sourceCommit") }
        : {}),
      ...(stringFromRecord(result, "providerLockDigest")
        ? {
          providerLockDigest: stringFromRecord(result, "providerLockDigest"),
        }
        : {}),
      ...(recordFromRecord(result, "summary")
        ? { summary: recordFromRecord(result, "summary") as OpenTofuPlanResult["summary"] }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async apply(job: OpenTofuApplyJob): Promise<OpenTofuApplyResult> {
    const result = await this.#runContainer(
      "apply",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
    );
    return {
      ...(recordFromRecord(result, "outputs")
        ? { outputs: recordFromRecord(result, "outputs") as OpenTofuApplyResult["outputs"] }
        : {}),
      diagnostics: diagnosticsFromContainerResult(result),
    };
  }

  async destroy(job: OpenTofuDestroyJob): Promise<OpenTofuDestroyResult> {
    const result = await this.#runContainer(
      "destroy",
      runnerRunIdFromPlanArtifact(job.planArtifact) ?? job.planRun.id,
      job,
    );
    return { diagnostics: diagnosticsFromContainerResult(result) };
  }

  async #runContainer(
    action: OpenTofuRunQueueMessage["action"],
    runId: string,
    request: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.env.TAKOS_OPENTOFU_RUNNER) {
      throw new Error("TAKOS_OPENTOFU_RUNNER binding is not configured");
    }
    const id = this.env.TAKOS_OPENTOFU_RUNNER.idFromName(runId);
    const response = await this.env.TAKOS_OPENTOFU_RUNNER.get(id).fetch(
      new Request(
        `https://opentofu-runner.internal/runs/${encodeURIComponent(runId)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "takosumi.opentofu-run@v1",
            action,
            runId,
            requestedAt: new Date().toISOString(),
            request,
          }),
        },
      ),
    );
    const payload = await readResponseJsonObject(response);
    if (!response.ok) {
      throw new Error(
        `OpenTofu runner rejected ${action} run ${runId}: ${response.status}`,
      );
    }
    return payload;
  }
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

async function readResponseJsonObject(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) return {};
  const value = JSON.parse(text) as unknown;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("OpenTofu runner response must be a JSON object");
}

function diagnosticsFromContainerResult(
  result: Record<string, unknown>,
): OpenTofuPlanResult["diagnostics"] {
  const stderr = stringFromRecord(result, "stderr");
  return stderr && stderr.trim().length > 0
    ? [{ severity: "warning", message: stderr }]
    : [];
}

function planArtifactFromContainerResult(
  result: Record<string, unknown>,
  runId: string,
  planDigest: string,
): OpenTofuPlanResult["planArtifact"] {
  const artifact = recordFromRecord(result, "planArtifact");
  if (!artifact) {
    throw new Error(`OpenTofu runner plan ${runId} did not return a planArtifact`);
  }
  const kind = stringFromRecord(artifact, "kind");
  const ref = stringFromRecord(artifact, "ref");
  const digest = stringFromRecord(artifact, "digest");
  if (!kind || !ref || !digest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned an incomplete planArtifact`,
    );
  }
  if (digest !== planDigest) {
    throw new Error(
      `OpenTofu runner plan ${runId} returned a planArtifact digest that does not match planDigest`,
    );
  }
  return {
    kind,
    ref,
    digest,
    ...(stringFromRecord(artifact, "contentType")
      ? { contentType: stringFromRecord(artifact, "contentType") }
      : {}),
    ...(typeof artifact?.sizeBytes === "number"
      ? { sizeBytes: artifact.sizeBytes }
      : {}),
    ...(typeof artifact?.createdAt === "number"
      ? { createdAt: artifact.createdAt }
      : {}),
  };
}

function runnerRunIdFromPlanArtifact(
  artifact: OpenTofuPlanResult["planArtifact"],
): string | undefined {
  const runnerLocal = /^runner-local:\/\/([^/]+)\/tfplan$/.exec(artifact.ref);
  if (runnerLocal?.[1]) return runnerLocal[1];
  const r2Plan = /^r2:\/\/[^/]+\/opentofu-plan-runs\/([^/]+)\/tfplan$/.exec(
    artifact.ref,
  );
  return r2Plan?.[1];
}

function stringArrayFromRecord(
  record: Record<string, unknown>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0
  );
  return strings.length > 0 ? strings : undefined;
}

function stringFromRecord(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordFromRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function digestJson(value: unknown): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}
