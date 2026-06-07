import {
  type CreatedTakosumiService,
  createTakosumiService,
  type TakosumiOperations,
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
import { constantTimeEqualsString } from "../../src/service/shared/constant_time.ts";
import {
  createDefaultRunnerProfiles,
  type EnqueueRun,
  type OpenTofuApplyJob,
  type OpenTofuApplyResult,
  type OpenTofuDestroyJob,
  type OpenTofuDestroyResult,
  type OpenTofuPlanJob,
  type OpenTofuPlanResult,
  type OpenTofuRunner,
  type OpenTofuSourceSyncJob,
  type OpenTofuSourceSyncResult,
  resolveEnabledRunnerProfiles,
} from "../../src/service/domains/deploy-control/mod.ts";
import type { EnqueueSourceSync } from "../../src/service/domains/sources/mod.ts";
import type { InstallationCoordination } from "../../src/service/domains/deploy-control/installation_lease.ts";
import type { RunnerProfile } from "takosumi-contract/deploy-control-api";
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
import { backupArtifactStoreFromEnv } from "./backup_artifact_store.ts";
import {
  createServiceWorkerRequest,
  isServiceControlPlanePath,
} from "./routes.ts";

export type { CloudflareWorkerEnv, QueueBatch } from "./bindings.ts";

// Durable Object classes that back the embedded deploy-control plane. Re-exported
// from the single handler module so a host worker (e.g. the unified Takos worker)
// can pull every deploy-control export — the in-process service factory and the
// DO classes the wrangler bindings reference — from one entry point.
export { CoordinationObject } from "./durable/CoordinationObject.ts";
export { OpenTofuRunnerObject } from "./durable/OpenTofuRunnerObject.ts";

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
        const denied = denyUnauthorizedCoordination(request, env);
        if (denied) return denied;
        const id = env.COORDINATION.idFromName("takos-control-plane");
        const targetPath = `/${url.pathname.slice("/coordination/".length)}`;
        return env.COORDINATION.get(id).fetch(
          new Request(new URL(targetPath, request.url), request),
        );
      }
      if (url.pathname === "/queue/test" && request.method === "POST") {
        await env.TAKOS_QUEUE?.send(await request.json());
        return Response.json({ queued: true });
      }
      if (url.pathname === "/storage/healthz") {
        await env.TAKOS_D1.prepare("select 1").first();
        await env.R2_ARTIFACTS.head("healthz");
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
      await consumeOpenTofuRunBatch(batch, env);
    },
  };
}

/**
 * The deploy-control queue consumer, factored out so a composing host worker
 * (the operator's Takosumi platform worker) can mount it as its `queue()`
 * handler. The platform worker owns the public fetch surface via the accounts
 * handler but must run the OpenTofu run-queue consumer in-process; this is the
 * single entry point it wires up.
 */
export function createDeployControlQueueConsumer(): (
  batch: QueueBatch,
  env: CloudflareWorkerEnv,
) => Promise<void> {
  return (batch, env) => consumeOpenTofuRunBatch(batch, env);
}

// Queue consumer config (mirrors deploy/*/wrangler.toml `max_retries`): one
// initial delivery + this many retries. On the final attempt the consumer
// records the run failed instead of rethrowing, so the message is not endlessly
// redelivered; earlier attempts rethrow so Cloudflare Queues retries.
const OPENTOFU_RUN_MAX_RETRIES = 2;
const OPENTOFU_RUN_DLQ_SUFFIX = "-dlq";

/**
 * Drives a batch of OpenTofu run-dispatch messages.
 *
 * Main queue: load the run via the in-process deploy-control controller, run the
 * idempotency-guarded consumer (which mints credentials and dispatches to the
 * container DO), then `ack`. A thrown error is rethrown on non-final attempts so
 * Queues retries; on the final attempt the run is marked failed (the controller
 * already records redacted diagnostics) and the message is acked so it is not
 * redelivered forever.
 *
 * DLQ: a run that exhausted retries is marked failed ("retries-exhausted") if it
 * is not already terminal, then acked.
 */
async function consumeOpenTofuRunBatch(
  batch: QueueBatch,
  env: CloudflareWorkerEnv,
): Promise<void> {
  const isDeadLetter = typeof batch.queue === "string" &&
    batch.queue.endsWith(OPENTOFU_RUN_DLQ_SUFFIX);
  for (const message of batch.messages) {
    const run = parseOpenTofuRunQueueMessage(message.body);
    if (!run) {
      // Unparseable message: ack so it does not loop. (Never logged with body.)
      message.ack?.();
      continue;
    }
    if (isDeadLetter) {
      await markOpenTofuRunRetriesExhausted(run, env);
      message.ack?.();
      continue;
    }
    const attempt = typeof message.attempts === "number" ? message.attempts : 1;
    const finalAttempt = attempt > OPENTOFU_RUN_MAX_RETRIES;
    try {
      await dispatchOpenTofuRun(run, env);
      message.ack?.();
    } catch (error) {
      if (finalAttempt) {
        // Out of retries: leave the run in its recorded terminal/failed state and
        // stop redelivery. The DLQ consumer is the backstop for runs the consumer
        // crashed on before it could record failed.
        message.ack?.();
        return;
      }
      // Rethrow so Cloudflare Queues counts the failure and retries the message.
      throw redactedDispatchError(error);
    }
  }
}

/**
 * Loads the deploy-control controller for this env and runs the queued plan/apply
 * consumer. The controller mints credentials just before the container dispatch
 * and records the terminal run status; this function never serializes or logs
 * the run body or any credential value.
 */
async function dispatchOpenTofuRun(
  run: OpenTofuRunQueueMessage,
  env: CloudflareWorkerEnv,
): Promise<void> {
  if (run.action === "destroy") {
    // Destroy is an apply-run variant; the controller routes by the PlanRun
    // operation. Treat it as an apply dispatch for the consumer.
    await dispatchToController(env, "apply", run.runId, run.spaceId);
    return;
  }
  await dispatchToController(env, run.action, run.runId, run.spaceId);
}

async function dispatchToController(
  env: CloudflareWorkerEnv,
  action: "plan" | "apply" | "source_sync",
  runId: string,
  spaceId: string,
): Promise<void> {
  const service = await cachedDeployControlService(env);
  await service.operations.dispatchQueuedRun({ action, runId, spaceId });
}

async function markOpenTofuRunRetriesExhausted(
  run: OpenTofuRunQueueMessage,
  env: CloudflareWorkerEnv,
): Promise<void> {
  try {
    const service = await cachedDeployControlService(env);
    await markRunFailedIfNotTerminal(
      service.operations.controller,
      run,
      "retries-exhausted",
    );
  } catch {
    // Best-effort: the DLQ backstop must never throw (it would re-queue the
    // dead letter). Swallow; the run simply stays in its last recorded state.
  }
}

/**
 * The `/coordination/*` route forwards straight to a single shared
 * {@link CoordinationObject} Durable Object (lease/alarm storage for the
 * control plane). It is an internal control-plane surface, so it must not be
 * edge-reachable without authentication. We gate it on the same operator secret
 * as the Deploy Control API (`TAKOSUMI_DEPLOY_CONTROL_TOKEN`):
 *
 * - token unset  -> the control-plane surface is not exposed -> 404 (mirrors the
 *   Deploy Control "routes disabled" behavior, so an unconfigured host never
 *   accepts unauthenticated writes into the coordination DO).
 * - token set    -> require `Authorization: Bearer <token>`, constant-time
 *   compared; 401 on missing/invalid bearer.
 *
 * Returns a Response when the request must be rejected, or undefined when it is
 * authorized and may proceed to the Durable Object.
 */
function denyUnauthorizedCoordination(
  request: Request,
  env: CloudflareWorkerEnv,
): Response | undefined {
  const configuredToken = typeof env.TAKOSUMI_DEPLOY_CONTROL_TOKEN === "string"
    ? env.TAKOSUMI_DEPLOY_CONTROL_TOKEN
    : undefined;
  if (!configuredToken) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  const header = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const bearer = header.startsWith(prefix)
    ? header.slice(prefix.length)
    : undefined;
  if (!bearer || !constantTimeEqualsString(bearer, configuredToken)) {
    return Response.json(
      { error: "invalid coordination bearer" },
      { status: 401 },
    );
  }
  return undefined;
}

/**
 * Builds the deploy-control Takosumi service (the `takosumi-api` role) directly,
 * bypassing the worker fetch dispatcher. The unified Takos worker injects the
 * returned service's `app.fetch` as the in-process deploy-control transport for
 * the accounts handler's deploy-control proxy seam — so the deploy-control plane
 * runs in-process and owns no public route.
 */
export function createDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  return createWorkerServiceApp(env, "takosumi-api", {
    runnerProfiles: resolveEnabledRunnerProfilesFromEnv(env),
  });
}

/**
 * The operator-curated provider surface. `createDefaultRunnerProfiles` seeds
 * every reference profile (most as disabled templates); the operator opts in via
 * `TAKOSUMI_ENABLED_RUNNER_PROFILES` (CSV). Only listed profiles are seeded into
 * the controller, each enabled, so `/v1/runner-profiles` and policy evaluation
 * never expose an unlisted provider. Unset/empty -> `["cloudflare-default"]`.
 */
function resolveEnabledRunnerProfilesFromEnv(
  env: CloudflareWorkerEnv,
): readonly RunnerProfile[] {
  return resolveEnabledRunnerProfiles(
    createDefaultRunnerProfiles(),
    env.TAKOSUMI_ENABLED_RUNNER_PROFILES,
  );
}

/**
 * In-process deploy-control seam shared by every single-worker host (the unified
 * Takos worker, the operator platform worker, and the node-postgres composer).
 *
 * It owns the one per-env service cache and the Request normalization that each
 * host used to re-derive. `operations` is the default transport the accounts
 * deploy-control proxy calls (the wired OpenTofu controller, with no Bearer
 * handshake and no JSON round-trip); `fetch` dispatches the same per-env cached
 * service's `app.fetch` and is kept only as a transport fallback.
 */
export function createInProcessDeployControlSeam(
  env: CloudflareWorkerEnv,
): {
  readonly fetch: typeof fetch;
  readonly operations: () => Promise<TakosumiOperations>;
} {
  const service = () => cachedDeployControlService(env);
  const inProcessFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const created = await service();
    const request = input instanceof Request && init === undefined
      ? input
      : new Request(input as RequestInfo | URL, init);
    return await created.app.fetch(request);
  };
  return {
    fetch: inProcessFetch as typeof fetch,
    operations: async () => (await service()).operations,
  };
}

const inProcessDeployControlServices = new WeakMap<
  CloudflareWorkerEnv,
  Promise<CreatedTakosumiService>
>();

function cachedDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  let service = inProcessDeployControlServices.get(env);
  if (!service) {
    service = createDeployControlService(env);
    inProcessDeployControlServices.set(env, service);
  }
  return service;
}

async function createWorkerServiceApp(
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

/**
 * Resolves the queued run's `action` to the controller's plan/apply consumer
 * channel and marks it failed when not already terminal (DLQ backstop).
 */
async function markRunFailedIfNotTerminal(
  controller: { markRunFailed: (
    action: "plan" | "apply",
    runId: string,
    reason: string,
  ) => Promise<boolean> },
  run: OpenTofuRunQueueMessage,
  reason: string,
): Promise<void> {
  // source_sync runs own their own terminal recording in the source consumer;
  // the DLQ backstop only covers plan/apply runs.
  if (run.action === "source_sync") return;
  const action = run.action === "plan" ? "plan" : "apply";
  await controller.markRunFailed(action, run.runId, reason);
}

/**
 * Reduces a dispatch error to a message-only Error so the queue retry path never
 * propagates a credential value or run body that might be embedded in a richer
 * error object. (The container DO already redacts; this is defense in depth.)
 */
function redactedDispatchError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "opentofu run dispatch failed";
  return new Error(message);
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
  if (
    action !== "plan" && action !== "apply" && action !== "destroy" &&
    action !== "source_sync"
  ) {
    throw new Error("OpenTofu run queue message action is invalid");
  }
  const runId = nonEmptyString(record.runId);
  if (!runId) {
    throw new Error("OpenTofu run queue message runId is required");
  }
  const spaceId = nonEmptyString(record.spaceId);
  if (!spaceId) {
    throw new Error("OpenTofu run queue message spaceId is required");
  }
  const requestedAt = nonEmptyString(record.requestedAt);
  const request = record.request;
  const requestObject =
    typeof request === "object" && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : undefined;
  return {
    kind: "takosumi.opentofu-run@v1",
    action,
    runId,
    spaceId,
    ...(requestedAt ? { requestedAt } : {}),
    ...(requestObject ? { request: requestObject } : {}),
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
    // The DO echoes the persisted state pointer (`state.digest`) and, for an
    // apply that produced outputs, the encrypted raw-output artifact key
    // (`rawOutputsKey`, spec §26). Thread both onto the result so the controller
    // records them on the StateSnapshot / OutputSnapshot.
    const state = recordFromRecord(result, "state");
    return {
      ...(recordFromRecord(result, "outputs")
        ? { outputs: recordFromRecord(result, "outputs") as OpenTofuApplyResult["outputs"] }
        : {}),
      ...(state && stringFromRecord(state, "digest")
        ? { stateDigest: stringFromRecord(state, "digest") }
        : {}),
      ...(stringFromRecord(result, "rawOutputsKey")
        ? { rawOutputsKey: stringFromRecord(result, "rawOutputsKey") }
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

  async sourceSync(
    job: OpenTofuSourceSyncJob,
  ): Promise<OpenTofuSourceSyncResult> {
    // The runner resolves the ref, fetches a shallow checkout, builds the
    // deterministic archive, and PUTs its bytes to the source-archive route on
    // the DO (which persists them to R2_SOURCE under archiveObjectKey). It then
    // returns only the resolved commit + archive metadata. The request carries
    // the source-phase mint result (git env + files); never logged.
    const result = await this.#runContainer("source_sync", job.runId, {
      action: "source_sync",
      runId: job.runId,
      source: job.source,
      archiveObjectKey: job.archiveObjectKey,
      ...(job.credentials ? { credentials: job.credentials } : {}),
    });
    // The DO persists the archive to R2_SOURCE and rewrites `sourceArchive` to
    // the object-storage form ({ digest, sizeBytes }); `resolvedCommit` stays at
    // the top level. Read both top-level and `sourceArchive` so either shape is
    // accepted.
    const archive = recordFromRecord(result, "sourceArchive");
    const resolvedCommit = stringFromRecord(result, "resolvedCommit");
    const archiveDigest = stringFromRecord(result, "archiveDigest") ??
      (archive ? stringFromRecord(archive, "digest") : undefined);
    const archiveSizeBytes = typeof result.archiveSizeBytes === "number"
      ? result.archiveSizeBytes
      : (archive && typeof archive.sizeBytes === "number"
        ? archive.sizeBytes
        : undefined);
    if (!resolvedCommit || !archiveDigest || archiveSizeBytes === undefined) {
      throw new Error(
        `OpenTofu runner source_sync ${job.runId} returned an incomplete result`,
      );
    }
    return { resolvedCommit, archiveDigest, archiveSizeBytes };
  }

  async #runContainer(
    action: OpenTofuRunQueueMessage["action"],
    runId: string,
    request: unknown,
  ): Promise<Record<string, unknown>> {
    if (!this.env.RUNNER) {
      throw new Error("RUNNER binding is not configured");
    }
    const id = this.env.RUNNER.idFromName(runId);
    const response = await this.env.RUNNER.get(id).fetch(
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
