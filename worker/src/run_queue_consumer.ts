import type {
  CloudflareWorkerEnv,
  OpenTofuRunQueueMessage,
  QueueBatch,
} from "./bindings.ts";
import { cachedDeployControlService } from "./deploy_control_seam.ts";

// Queue consumer config (mirrors deploy/*/wrangler.toml `max_retries`): one
// initial delivery + this many retries. On the final attempt the consumer
// records the run failed instead of rethrowing, so the message is not endlessly
// redelivered; earlier attempts rethrow so Cloudflare Queues retries.
const OPENTOFU_RUN_MAX_RETRIES = 2;
const OPENTOFU_RUN_DLQ_SUFFIX = "-dlq";
const OPENTOFU_RUN_QUEUE_NAME = "takosumi-runs";

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
export async function consumeOpenTofuRunBatch(
  batch: QueueBatch,
  env: CloudflareWorkerEnv,
): Promise<void> {
  const isDeadLetter = typeof batch.queue === "string" &&
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
      throw new Error("non-OpenTofu message delivered to OpenTofu run consumer");
    }
    if (parsed.kind === "invalid") {
      // Poison OpenTofu message: ack so it does not loop. (Never logged with body.)
      message.ack?.();
      continue;
    }
    const run = parsed.message;
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
        await markOpenTofuRunRetriesExhausted(run, env);
        // Out of retries: stop redelivery after the best-effort ledger update.
        message.ack?.();
        continue;
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
  void error;
  return new Error("opentofu run dispatch failed");
}

function isOpenTofuRunQueue(queue: string): boolean {
  return (
    queue === OPENTOFU_RUN_QUEUE_NAME ||
    queue === `${OPENTOFU_RUN_QUEUE_NAME}${OPENTOFU_RUN_DLQ_SUFFIX}`
  );
}

type OpenTofuRunParseResult =
  | { readonly kind: "ok"; readonly message: OpenTofuRunQueueMessage }
  | { readonly kind: "invalid" }
  | { readonly kind: "not_opentofu" };

function safeParseOpenTofuRunQueueMessage(
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
