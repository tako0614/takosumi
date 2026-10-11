/**
 * Stable machine reason returned when an apply/destroy dispatch may have
 * reached a provider but the runner did not receive an authoritative result.
 * Callers must not translate this outcome into an automatic retry.
 */
export const RUNNER_MUTATION_INDETERMINATE_CODE =
  "runner_mutation_indeterminate";

/**
 * Stable machine reason returned when an apply/destroy failed while the runner
 * Durable Object still held only `preparing` authority and that preparation
 * was durably released. The container never received the mutating request,
 * so no provider mutation can have started. Only the Durable Object's own
 * pre-dispatch failure path emits this code; a container-reported code with
 * the same value is normalized away and never relayed.
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
    readonly preparationReleased: true;
  };
  /** Finite, value-free classification of the pre-dispatch failure. */
  readonly reason: string;
  readonly detail: string;
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
