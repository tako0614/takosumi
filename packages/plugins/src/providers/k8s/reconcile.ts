/**
 * Reconciler primitives shared by every k8s materializer.
 *
 * The deepening pass adds three pieces of production-grade behaviour on top of
 * the simple "fire one apply call" v0 path:
 *
 *   1. retry-with-backoff for transient errors (Conflict / Throttled / Timeout
 *      / 5xx) bounded by `maxAttempts` and a wall-clock `timeoutMs` budget,
 *   2. drift detection — when a `get` client is wired, the reconciler compares
 *      the observed object's labels / annotations / spec-fragment against the
 *      desired projection and surfaces a `K8sDriftError` when they diverge,
 *   3. condition emission — every attempt records a structured condition that
 *      can be folded onto `Deployment.conditions[]` by the deployment service.
 */
import {
  isRetryable,
  K8sProviderError,
  K8sThrottledError,
  K8sTimeoutError,
} from "./errors.ts";

export type K8sConditionStatus = "true" | "false" | "unknown";

export interface K8sCondition {
  readonly type: string;
  readonly status: K8sConditionStatus;
  readonly reason?: string;
  readonly message?: string;
  readonly observedAt: string;
  readonly attempt: number;
}

export type K8sConditionSink = (condition: K8sCondition) => void;

export interface K8sReconcileOptions {
  readonly maxAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly timeoutMs?: number;
  readonly clock?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly conditionSink?: K8sConditionSink;
  readonly conditionType?: string;
}

export interface K8sReconcileContext extends K8sReconcileOptions {
  readonly objectAddress?: string;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_INITIAL_BACKOFF_MS = 100;
export const DEFAULT_MAX_BACKOFF_MS = 5_000;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_K8S_LONG_RUNNING_THRESHOLD_MS = 30_000;

/**
 * Runtime-agent handoff hook (Phase 17B). Long-running k8s operations
 * (rollout completion, pvc bind, statefulset reconcile) frequently exceed
 * the inline retry budget. The reconciler calls
 * {@link K8sRuntimeAgentHandoff.enqueue} when a `K8sRuntimeContext` exposes
 * one and the op crosses the threshold; the kernel persists the handoff
 * descriptor on `Deployment.conditions[]`.
 */
export interface K8sRuntimeAgentHandoff {
  enqueue(input: K8sRuntimeAgentEnqueueInput): Promise<string>;
}

export interface K8sRuntimeAgentEnqueueInput {
  readonly descriptor: string;
  readonly desiredStateId: string;
  readonly targetId?: string;
  readonly idempotencyKey?: string;
  readonly enqueuedAt?: string;
  readonly payload?: Record<string, unknown>;
}

export interface K8sRuntimeHooks {
  readonly longRunningThresholdMs?: number;
  readonly runtimeAgentHandoff?: K8sRuntimeAgentHandoff;
}

export function shouldK8sHandoff(
  elapsedMs: number,
  hooks?: K8sRuntimeHooks,
): boolean {
  if (!hooks?.runtimeAgentHandoff) return false;
  const threshold = hooks.longRunningThresholdMs ??
    DEFAULT_K8S_LONG_RUNNING_THRESHOLD_MS;
  return Number.isFinite(elapsedMs) && elapsedMs >= threshold;
}

export function deriveK8sHandoffKey(
  descriptor: string,
  desiredStateId: string,
  targetId?: string,
): string {
  return `k8s-${descriptor}-${desiredStateId}-${targetId ?? "default"}`;
}

/**
 * Run `operation` with retry / backoff / timeout. Each attempt emits a
 * condition (succeeded / failed / retrying). Throws the *last* error if every
 * attempt fails or the timeout budget is exhausted.
 */
export async function reconcile<T>(
  operation: () => Promise<T>,
  context: K8sReconcileContext = {},
): Promise<T> {
  const maxAttempts = context.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialBackoff = context.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoff = context.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const timeoutMs = context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clock = context.clock ?? (() => new Date());
  const sleep = context.sleep ?? defaultSleep;
  const sink = context.conditionSink;
  const conditionType = context.conditionType ?? "Reconcile";
  const startMs = clock().getTime();
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (clock().getTime() - startMs > timeoutMs) {
      const timeoutError = new K8sTimeoutError(
        `reconcile timed out after ${timeoutMs}ms`,
        {
          objectAddress: context.objectAddress,
          details: { attempts: attempt - 1, timeoutMs },
        },
      );
      emit(
        sink,
        conditionType,
        "false",
        "Timeout",
        attempt,
        clock,
        timeoutError,
      );
      throw timeoutError;
    }
    try {
      const value = await operation();
      emit(sink, conditionType, "true", "Succeeded", attempt, clock);
      return value;
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts) {
        emit(
          sink,
          conditionType,
          "false",
          reasonOf(error),
          attempt,
          clock,
          error,
        );
        throw error;
      }
      emit(
        sink,
        conditionType,
        "unknown",
        `Retrying:${reasonOf(error)}`,
        attempt,
        clock,
        error,
      );
      const delay = clamp(
        retryAfterFor(error) ?? initialBackoff * 2 ** (attempt - 1),
        initialBackoff,
        maxBackoff,
      );
      const remaining = timeoutMs - (clock().getTime() - startMs);
      if (remaining <= 0) {
        const timeoutError = new K8sTimeoutError(
          `reconcile budget exhausted after ${timeoutMs}ms`,
          {
            objectAddress: context.objectAddress,
            cause: error,
            details: { attempts: attempt, timeoutMs },
          },
        );
        emit(
          sink,
          conditionType,
          "false",
          "Timeout",
          attempt,
          clock,
          timeoutError,
        );
        throw timeoutError;
      }
      await sleep(Math.min(delay, remaining));
    }
  }
  // Unreachable, but TS likes the fallthrough guard.
  throw lastError instanceof Error
    ? lastError
    : new K8sProviderError("unavailable", String(lastError));
}

/**
 * Compares a projected desired payload against the observed object's metadata
 * (labels / annotations) and a caller-provided extractor for spec-fragments.
 * Returns a list of drifted field paths (empty when in sync).
 */
export function detectDrift(
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
  options: {
    readonly fields?: readonly string[];
    readonly compareLabels?: boolean;
    readonly compareAnnotations?: boolean;
  } = {},
): readonly string[] {
  if (!observed) return ["object:absent"];
  const drifted: string[] = [];
  const fields = options.fields ?? Object.keys(desired);
  for (const field of fields) {
    if (!stableEqual(desired[field], observed[field])) {
      drifted.push(field);
    }
  }
  if (options.compareLabels !== false) {
    const desiredLabels = (desired.labels ??
      (desired.metadata as Record<string, unknown> | undefined)?.labels) as
        | Record<string, unknown>
        | undefined;
    const observedLabels = (observed.labels ??
      (observed.metadata as Record<string, unknown> | undefined)?.labels) as
        | Record<string, unknown>
        | undefined;
    if (desiredLabels && !subsetMatches(desiredLabels, observedLabels)) {
      drifted.push("metadata.labels");
    }
  }
  if (options.compareAnnotations === true) {
    const desiredAnn = (desired.annotations ??
      (desired.metadata as Record<string, unknown> | undefined)
        ?.annotations) as Record<string, unknown> | undefined;
    const observedAnn = (observed.annotations ??
      (observed.metadata as Record<string, unknown> | undefined)
        ?.annotations) as Record<string, unknown> | undefined;
    if (desiredAnn && !subsetMatches(desiredAnn, observedAnn)) {
      drifted.push("metadata.annotations");
    }
  }
  return drifted;
}

/**
 * Convenience helper: runs `list` with a paged cursor until the cursor is
 * exhausted or `limit` items have been collected. Returns the flattened items.
 */
export async function paginate<T>(
  list: (cursor?: string) => Promise<{
    readonly items: readonly T[];
    readonly nextCursor?: string;
  }>,
  options: { readonly limit?: number; readonly maxPages?: number } = {},
): Promise<readonly T[]> {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const maxPages = options.maxPages ?? 100;
  const out: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await list(cursor);
    out.push(...result.items);
    if (out.length >= limit) return out.slice(0, limit);
    if (!result.nextCursor) return out;
    cursor = result.nextCursor;
  }
  return out;
}

/**
 * Builds an in-memory condition sink suitable for tests and short-lived
 * reconciliation transcripts.
 */
export function memoryConditionSink(): {
  readonly sink: K8sConditionSink;
  readonly conditions: readonly K8sCondition[];
} {
  const conditions: K8sCondition[] = [];
  return {
    sink: (condition) => {
      conditions.push(condition);
    },
    get conditions() {
      return conditions;
    },
  };
}

function emit(
  sink: K8sConditionSink | undefined,
  type: string,
  status: K8sConditionStatus,
  reason: string,
  attempt: number,
  clock: () => Date,
  error?: unknown,
): void {
  if (!sink) return;
  sink({
    type,
    status,
    reason,
    message: error instanceof Error ? error.message : undefined,
    observedAt: clock().toISOString(),
    attempt,
  });
}

function reasonOf(error: unknown): string {
  if (error instanceof K8sProviderError) {
    return error.reason ?? error.code;
  }
  return error instanceof Error ? error.name : "Unknown";
}

function retryAfterFor(error: unknown): number | undefined {
  if (error instanceof K8sThrottledError && error.retryAfterMs) {
    return error.retryAfterMs;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function stableEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (typeof left !== "object") return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function subsetMatches(
  desired: Record<string, unknown>,
  observed: Record<string, unknown> | undefined,
): boolean {
  if (!observed) return false;
  for (const [key, value] of Object.entries(desired)) {
    if (!stableEqual(value, observed[key])) return false;
  }
  return true;
}
