/**
 * Stable machine reason returned when an apply/destroy dispatch may have
 * reached a provider but the runner did not receive an authoritative result.
 * Callers must not translate this outcome into an automatic retry.
 */
export const RUNNER_MUTATION_INDETERMINATE_CODE =
  "runner_mutation_indeterminate";

export type RunnerMutationAction = "apply" | "destroy";

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
