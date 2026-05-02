// Phase 18.3 — Canary rollout drift watcher.
//
// During a canary rollout, each step applies a fresh Deployment that shifts
// HTTP traffic toward the canary release. After the Deployment is applied the
// runtime adapters stream `ProviderObservation` records back into the
// observation store. A subset of drift reasons (`security-drift`,
// `config-drift`) are considered severe enough that the canary should not
// continue: the partially-rolled-out canary may be exposing a broken or
// insecure surface to the canary slice of traffic, and the safe action is to
// abort the rollout and (optionally) revert the GroupHead pointer to the
// previously-current Deployment.
//
// This module owns the small isolation surface around that decision so the
// `RolloutCanaryService` stays focused on per-step Deployment choreography:
//
//   - `DriftWatcher` interface: how the rollout service samples observations
//     for a given Deployment id mid-run.
//   - `ProviderObservationDriftWatcher`: an adapter over the
//     `ProviderObservationStore` that surfaces post-apply observations.
//   - `evaluateDriftSeverity` / `DEFAULT_ABORT_DRIFT_REASONS`: pure helpers
//     that decide whether a sampled observation should trigger abort.
//
// The watcher does NOT call `rollbackGroup()` itself — that decision is made
// by `RolloutCanaryService` based on the operator policy
// (`autoRollbackOnDrift`).

import type {
  ProviderObservation,
  ProviderObservationStore,
  RuntimeProviderObservationDriftReason,
} from "../../domains/runtime/mod.ts";

/**
 * Drift reasons that, by default, cause the canary rollout to abort. Both are
 * "severe" in the sense that they invalidate the safety story of the rollout:
 *
 *   - `security-drift`: the runtime provider is exposing a surface whose
 *     security posture (auth, network policy, secrets binding) no longer
 *     matches the desired Deployment. Letting more canary traffic through is
 *     unsafe.
 *   - `config-drift`: the runtime provider is serving a configuration that
 *     does not match the desired Deployment. Continuing the canary would
 *     amplify an inconsistent rollout state.
 *
 * Other reasons (e.g. `cache-drift`, `status-drift`) are observed but do not
 * abort by default — they typically resolve on their own or through normal
 * convergence loops.
 */
export const DEFAULT_ABORT_DRIFT_REASONS: ReadonlySet<
  RuntimeProviderObservationDriftReason
> = new Set<RuntimeProviderObservationDriftReason>([
  "security-drift",
  "config-drift",
]);

/**
 * Verdict returned by `evaluateDriftSeverity`. `abort` means the rollout
 * service MUST stop the run and surface a `CanaryAbortedOnDrift` condition
 * on the most-recent step Deployment. `none` means the observation is
 * informational only and the rollout may proceed.
 */
export type DriftSeverityVerdict = "none" | "abort";

/**
 * Pure decision helper. Given a single observation and a threshold set,
 * decide whether the observation should abort the canary.
 *
 * - `observed_state !== "drifted"` is always `none` (only drift signals
 *   reach the threshold).
 * - `observed_state === "drifted"` with no `driftReason` defaults to `none`
 *   (insufficient information — adapters that want to abort must stamp a
 *   reason).
 * - Otherwise the verdict is `abort` iff the reason is in the threshold set.
 */
export function evaluateDriftSeverity(
  observation: ProviderObservation,
  threshold: ReadonlySet<RuntimeProviderObservationDriftReason> =
    DEFAULT_ABORT_DRIFT_REASONS,
): DriftSeverityVerdict {
  if (observation.observedState !== "drifted") return "none";
  const reason = observation.driftReason;
  if (!reason) return "none";
  return threshold.has(reason) ? "abort" : "none";
}

/**
 * Drift-watch sample taken after a canary step is applied. Returned by
 * `DriftWatcher.sample` so the rollout service can surface the offending
 * observation in the `CanaryAbortedOnDrift` condition message.
 */
export interface DriftSample {
  readonly verdict: DriftSeverityVerdict;
  readonly observation?: ProviderObservation;
}

/**
 * Mid-run drift sampler used by `RolloutCanaryService`. Implementations may
 * subscribe to a live observation stream or poll the
 * `ProviderObservationStore`. The contract is intentionally simple — the
 * rollout service samples once per step after `applyDeployment` resolves.
 */
export interface DriftWatcher {
  /**
   * Sample observations for `deploymentId` and decide whether the canary
   * step has drifted past the abort threshold. Returns the offending
   * observation when the verdict is `abort` so the rollout service can
   * surface it in `Deployment.conditions[]`.
   */
  sample(input: DriftWatcherSampleInput): Promise<DriftSample>;
}

export interface DriftWatcherSampleInput {
  readonly deploymentId: string;
  readonly stepId: string;
  /** Materializations the rollout step touched. */
  readonly materializationIds: readonly string[];
  /**
   * Wall clock for the sampling window. The watcher only considers
   * observations whose `observedAt >= sampledSince`. Defaults to the step's
   * apply timestamp — observations that predate the step are part of a
   * previous Deployment and MUST not abort the new step.
   */
  readonly sampledSince?: string;
}

export interface ProviderObservationDriftWatcherOptions {
  readonly observationStore: ProviderObservationStore;
  /** Drift reasons that trigger abort. Defaults to `DEFAULT_ABORT_DRIFT_REASONS`. */
  readonly abortReasons?: ReadonlySet<RuntimeProviderObservationDriftReason>;
}

/**
 * Default `DriftWatcher` implementation backed by the
 * `ProviderObservationStore`. For each sampled materialization id it pulls
 * the post-apply observations and runs `evaluateDriftSeverity` against the
 * configured threshold. The first abort-worthy observation wins; subsequent
 * observations are not consulted because the rollout service only needs one
 * reason to abort.
 */
export class ProviderObservationDriftWatcher implements DriftWatcher {
  readonly #store: ProviderObservationStore;
  readonly #abortReasons: ReadonlySet<RuntimeProviderObservationDriftReason>;

  constructor(options: ProviderObservationDriftWatcherOptions) {
    this.#store = options.observationStore;
    this.#abortReasons = options.abortReasons ?? DEFAULT_ABORT_DRIFT_REASONS;
  }

  async sample(input: DriftWatcherSampleInput): Promise<DriftSample> {
    const since = input.sampledSince;
    for (const materializationId of input.materializationIds) {
      const observations = await this.#store.listByMaterialization(
        materializationId,
      );
      for (const observation of observations) {
        if (since && observation.observedAt < since) continue;
        const verdict = evaluateDriftSeverity(observation, this.#abortReasons);
        if (verdict === "abort") {
          return { verdict, observation };
        }
      }
    }
    return { verdict: "none" };
  }
}

/**
 * Convenience factory. Stitches a `ProviderObservationStore` into a watcher
 * with the canonical abort threshold. Phase 18.3 callers should prefer this
 * over instantiating `ProviderObservationDriftWatcher` directly so the
 * default reason set stays consistent across services.
 */
export function createProviderObservationDriftWatcher(
  options: ProviderObservationDriftWatcherOptions,
): DriftWatcher {
  return new ProviderObservationDriftWatcher(options);
}
