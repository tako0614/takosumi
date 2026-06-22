import type {
  CloudflareWorkerEnv,
  OpenTofuRunQueueMessage,
  QueueBatch,
} from "./bindings.ts";
import { cachedDeployControlService } from "./deploy_control_seam.ts";
import { InstallationLeaseBusyError } from "../../core/domains/deploy-control/installation_lease.ts";
import { recordWorkerMetric, type WorkerMetricSink } from "./metrics.ts";

// Queue consumer config (mirrors deploy/*/wrangler.toml `max_retries`): one
// initial delivery + this many retries for scheduling the per-run owner DO. On
// the final scheduling attempt the consumer records the run failed instead of
// rethrowing, so a broken binding/message is not endlessly redelivered; run
// execution retries happen inside OpenTofuRunOwnerObject.
const OPENTOFU_RUN_MAX_RETRIES = 2;
const OPENTOFU_RUN_DLQ_SUFFIX = "-dlq";
const OPENTOFU_RUN_QUEUE_NAME = "takosumi-runs";

/**
 * Backoff before redelivering a run that is parked on a busy installation lease
 * (another write run for the same (Installation, environment) holds it). The
 * run stays `queued` and is NOT counted toward the retry budget, so a long
 * sibling apply does not exhaust the lease-blocked run's retries.
 */
const OPENTOFU_RUN_LEASE_BUSY_DELAY_SECONDS = 10;

/**
 * Drives a batch of OpenTofu run-dispatch messages.
 *
 * Main queue: validate the identity-only run message, persist it into the
 * per-run `OpenTofuRunOwnerObject`, then `ack`. The owner DO drives the
 * idempotency-guarded controller consumer, credentials minting, container
 * dispatch, retries, and final failure bookkeeping. Queue delivery lifetime no
 * longer bounds a long OpenTofu run.
 *
 * DLQ: a run that exhausted retries is marked failed ("retries-exhausted") if it
 * is not already terminal, then acked.
 */
/**
 * Injection seam for {@link consumeOpenTofuRunBatch}: the two side-effecting
 * steps a unit test overrides (the run-owner schedule and the DLQ
 * failure-record). The production caller omits `deps` and gets the real Durable
 * Object schedule path.
 */
export interface ConsumeOpenTofuRunDeps {
  readonly dispatch: (
    run: OpenTofuRunQueueMessage,
    env: CloudflareWorkerEnv,
    metadata: {
      readonly messageId: string;
      readonly queueAttempt: number;
    },
  ) => Promise<void>;
  readonly markRetriesExhausted: (
    run: OpenTofuRunQueueMessage,
    env: CloudflareWorkerEnv,
  ) => Promise<void>;
  readonly metricSink?: (
    env: CloudflareWorkerEnv,
  ) => Promise<WorkerMetricSink | undefined>;
}

export async function consumeOpenTofuRunBatch(
  batch: QueueBatch,
  env: CloudflareWorkerEnv,
  deps: ConsumeOpenTofuRunDeps = {
    dispatch: dispatchOpenTofuRun,
    markRetriesExhausted: markOpenTofuRunRetriesExhausted,
    metricSink: opentofuRunQueueMetricSink,
  },
): Promise<void> {
  const isDeadLetter =
    typeof batch.queue === "string" &&
    batch.queue.endsWith(OPENTOFU_RUN_DLQ_SUFFIX);
  if (typeof batch.queue === "string" && !isOpenTofuRunQueue(batch.queue)) {
    throw new Error("non-OpenTofu queue delivered to OpenTofu run consumer");
  }
  for (const message of batch.messages) {
    const parsed = safeParseOpenTofuRunQueueMessage(message.body);
    if (parsed.kind === "not_opentofu") {
      // A different queue's payload reached the OpenTofu run consumer. Do not
      // ack it: throwing makes the wiring bug visible instead of silently
      // dropping another subsystem's work.
      throw new Error(
        "non-OpenTofu message delivered to OpenTofu run consumer",
      );
    }
    if (parsed.kind === "invalid") {
      // Poison OpenTofu message: ack so it does not loop. (Never logged with body.)
      message.ack?.();
      continue;
    }
    const run = parsed.message;
    await recordQueueAgeMetric(run, env, deps);
    if (isDeadLetter) {
      await deps.markRetriesExhausted(run, env);
      message.ack?.();
      continue;
    }
    const attempt = typeof message.attempts === "number" ? message.attempts : 1;
    const finalAttempt = attempt > OPENTOFU_RUN_MAX_RETRIES;
    try {
      await deps.dispatch(run, env, {
        messageId: message.id,
        queueAttempt: attempt,
      });
      message.ack?.();
    } catch (error) {
      // Lease-busy is SCHEDULING, not failure: another write run for the same
      // (Installation, environment) currently holds the lease, so this run could
      // not be dispatched. Re-enqueue with a backoff and DO NOT count this toward
      // the retry budget — it must never reach the final-attempt
      // "retries-exhausted" branch. The run stays `queued` (no claim happened).
      if (error instanceof InstallationLeaseBusyError) {
        if (typeof message.retry === "function") {
          message.retry({
            delaySeconds: OPENTOFU_RUN_LEASE_BUSY_DELAY_SECONDS,
          });
        }
        continue;
      }
      if (finalAttempt) {
        await deps.markRetriesExhausted(run, env);
        // Out of retries: stop redelivery after the best-effort ledger update.
        message.ack?.();
        continue;
      }
      // Rethrow so Cloudflare Queues counts the failure and retries the message.
      throw redactedDispatchError(error);
    }
  }
}

async function recordQueueAgeMetric(
  run: OpenTofuRunQueueMessage,
  env: CloudflareWorkerEnv,
  deps: ConsumeOpenTofuRunDeps,
): Promise<void> {
  const requestedAt = run.requestedAt ? Date.parse(run.requestedAt) : NaN;
  const queueAgeSeconds = Number.isFinite(requestedAt)
    ? Math.max(0, (Date.now() - requestedAt) / 1000)
    : 0;
  const observability = await deps.metricSink?.(env);
  await recordWorkerMetric({
    observability,
    env,
    name: "takosumi_runner_queue_age_seconds",
    kind: "gauge",
    value: queueAgeSeconds,
    tags: {
      operationKind: run.action,
      status: "dequeued",
      space_id: run.spaceId,
    },
  });
}

/**
 * Schedules the per-run owner Durable Object. The owner persists only the run
 * identity and queue metadata, then later invokes deploy-control dispatch from
 * its alarm handler. This function never serializes or logs the run body or any
 * credential value.
 */
async function dispatchOpenTofuRun(
  run: OpenTofuRunQueueMessage,
  env: CloudflareWorkerEnv,
  metadata: {
    readonly messageId: string;
    readonly queueAttempt: number;
  },
): Promise<void> {
  const namespace = env.RUN_OWNER;
  if (!namespace) {
    throw new Error("RUN_OWNER binding is not configured");
  }
  const id = namespace.idFromName(run.runId);
  const response = await namespace.get(id).fetch(
    new Request("https://opentofu-run-owner/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "takosumi.opentofu-run-owner.start@v1",
        action: run.action,
        runId: run.runId,
        spaceId: run.spaceId,
        queueAttempt: metadata.queueAttempt,
        messageId: metadata.messageId,
      }),
    }),
  );
  if (!response.ok) {
    throw new Error("opentofu run owner scheduling failed");
  }
}

async function opentofuRunQueueMetricSink(
  env: CloudflareWorkerEnv,
): Promise<WorkerMetricSink | undefined> {
  try {
    return (await cachedDeployControlService(env)).context.adapters
      .observability;
  } catch {
    return undefined;
  }
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
 * Resolves the queued run's `action` to the controller's plan/apply consumer
 * channel and marks it failed when not already terminal (DLQ backstop).
 */
async function markRunFailedIfNotTerminal(
  controller: {
    markRunFailed: (
      action: "plan" | "apply" | "restore",
      runId: string,
      reason: string,
    ) => Promise<boolean>;
  },
  run: OpenTofuRunQueueMessage,
  reason: string,
): Promise<void> {
  // source_sync runs own their own terminal recording in the source consumer;
  // the DLQ backstop only covers plan/apply runs.
  if (
    run.action === "source_sync" ||
    run.action === "backup" ||
    run.action === "compatibility_check"
  ) {
    return;
  }
  const action =
    run.action === "plan"
      ? "plan"
      : run.action === "restore"
        ? "restore"
        : "apply";
  await controller.markRunFailed(action, run.runId, reason);
}

/**
 * Reduces a dispatch error to a message-only Error so the queue retry path never
 * propagates a credential value or run body that might be embedded in a richer
 * error object. (The container DO already redacts; this is defense in depth.)
 */
function redactedDispatchError(error: unknown): Error {
  void error;
  return new Error("opentofu run dispatch failed");
}

function isOpenTofuRunQueue(queue: string): boolean {
  if (queue === OPENTOFU_RUN_QUEUE_NAME) return true;
  if (queue === `${OPENTOFU_RUN_QUEUE_NAME}${OPENTOFU_RUN_DLQ_SUFFIX}`) {
    return true;
  }
  const environmentQueuePrefix = `${OPENTOFU_RUN_QUEUE_NAME}-`;
  if (!queue.startsWith(environmentQueuePrefix)) return false;

  const suffix = queue.slice(environmentQueuePrefix.length);
  const environment = suffix.endsWith(OPENTOFU_RUN_DLQ_SUFFIX)
    ? suffix.slice(0, -OPENTOFU_RUN_DLQ_SUFFIX.length)
    : suffix;
  if (environment === OPENTOFU_RUN_DLQ_SUFFIX.slice(1)) return false;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(environment);
}

export type OpenTofuRunParseResult =
  | { readonly kind: "ok"; readonly message: OpenTofuRunQueueMessage }
  | { readonly kind: "invalid" }
  | { readonly kind: "not_opentofu" };

/**
 * Exported for tests: classify a raw queue body as a dispatchable OpenTofu run
 * message, a poison/invalid message, or another subsystem's payload. A body
 * carrying an action outside {@link OpenTofuRunAction} is `invalid`, so it is
 * acked and dropped rather than dispatched.
 */
export function safeParseOpenTofuRunQueueMessage(
  value: unknown,
): OpenTofuRunParseResult {
  try {
    const parsed = parseOpenTofuRunQueueMessage(value);
    return parsed ? { kind: "ok", message: parsed } : { kind: "not_opentofu" };
  } catch {
    return { kind: "invalid" };
  }
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
    action !== "plan" &&
    action !== "apply" &&
    action !== "destroy" &&
    action !== "source_sync" &&
    action !== "compatibility_check" &&
    action !== "backup" &&
    action !== "restore"
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
