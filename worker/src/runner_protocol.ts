/**
 * Stable machine reason returned when an apply/destroy dispatch may have
 * reached a provider but the runner did not receive an authoritative result.
 * Callers must not translate this outcome into an automatic retry.
 */
export const RUNNER_MUTATION_INDETERMINATE_CODE =
  "runner_mutation_indeterminate";

/**
 * Stable machine reason returned when an apply/destroy failed while the runner
 * Durable Object held only `preparing` authority. The container never received
 * the mutating request, so no provider mutation can have started, and the
 * object durably fences these exact semantics as `not_dispatched`: they are
 * never dispatched later, and every replay answers this same outcome. Only the
 * Durable Object's own pre-dispatch path emits it; a container-reported code
 * with the same value is normalized away and never relayed.
 */
export const RUNNER_MUTATION_NOT_DISPATCHED_CODE =
  "runner_mutation_not_dispatched";

export type RunnerMutationAction = "apply" | "destroy";

export interface RunnerMutationNotDispatchedPayload {
  readonly error: "OpenTofu runner mutation failed before provider dispatch";
  readonly errorCode: typeof RUNNER_MUTATION_NOT_DISPATCHED_CODE;
  readonly status: "failed";
  readonly phase: RunnerMutationAction;
  readonly retryable: false;
  readonly outcome: "not_dispatched";
  readonly evidence: {
    readonly kind: typeof RUNNER_MUTATION_NOT_DISPATCHED_CODE;
    readonly action: RunnerMutationAction;
    readonly redispatchBlocked: true;
  };
  /** Finite, value-free classification of the pre-dispatch failure. */
  readonly reason: string;
  readonly detail: string;
  /** Present, with HTTP 413, when an artifact exceeded its byte limit. */
  readonly artifact?: string;
  readonly maxBytes?: number;
  readonly observedBytes?: number;
}

export interface RunnerMutationIndeterminatePayload {
  readonly error: "OpenTofu runner mutation outcome is indeterminate";
  readonly errorCode: typeof RUNNER_MUTATION_INDETERMINATE_CODE;
  readonly status: "failed";
  readonly phase: RunnerMutationAction;
  readonly retryable: false;
  readonly outcome: "indeterminate";
  readonly evidence: {
    readonly kind: typeof RUNNER_MUTATION_INDETERMINATE_CODE;
    readonly action: RunnerMutationAction;
    readonly redispatchBlocked: true;
  };
  readonly detail: string;
}

/**
 * Adapter-to-runner-object header: the absolute epoch-millisecond instant by
 * which the host invocation carrying this run must have the runner's reply.
 *
 * The Cloudflare run owner dispatches inside a Durable Object alarm, whose
 * wall time is capped. Without this bound the alarm is cut off first, the
 * reply has no receiver, and an Apply ends indeterminate with its partial
 * state lost. Transport metadata only: it is not part of the run body, so it
 * never enters mutation identity.
 */
export const RUN_DEADLINE_AT_HEADER = "x-takosumi-run-deadline-at";

/**
 * Runner-object-to-container header: milliseconds left for the whole run,
 * computed at the moment of forwarding so the container never compares its
 * clock with the Worker's. Mirrors `runner/lib/run_deadline.ts`.
 */
export const RUNNER_RUN_BUDGET_MS_HEADER = "x-takosumi-runner-budget-ms";

/**
 * Retryable answer of the runner object when the caller's deadline leaves too
 * little time to dispatch. Nothing reached the container, so the exact Run may
 * be redelivered under a fresh invocation deadline.
 */
export const RUNNER_RUN_DEADLINE_EXCEEDED_CODE = "runner_run_deadline_exceeded";

/**
 * Fixed machine reason for "stopped by the dispatching host's run deadline",
 * both for a refused dispatch and for a runner command the deadline cut off.
 */
export const RUN_DEADLINE_EXCEEDED_REASON = "run_deadline_exceeded";

/** Strict epoch-ms parse; anything else means "no deadline", as before. */
export function parseRunDeadlineAt(value: string | null): number | undefined {
  if (value === null || !/^\d{1,16}$/u.test(value)) return undefined;
  const deadlineAt = Number(value);
  return Number.isSafeInteger(deadlineAt) && deadlineAt > 0
    ? deadlineAt
    : undefined;
}

/** Header value for a deadline the caller supplied, or `undefined`. */
export function runDeadlineAtHeaderValue(
  deadlineAt: number | undefined,
): string | undefined {
  return deadlineAt !== undefined &&
      Number.isFinite(deadlineAt) &&
      deadlineAt > 0
    ? String(Math.floor(deadlineAt))
    : undefined;
}
