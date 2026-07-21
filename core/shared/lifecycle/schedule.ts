/**
 * Capped, jittered re-arm schedules for alarm/timer driven runtime loops.
 *
 * Two distinct types on purpose. A Durable Object that re-arms its alarm has
 * two structurally different reasons to wait, and collapsing them into one
 * "retry in 1s" branch is how a control loop turns into a 1 Hz hot loop with no
 * ceiling and no ledger:
 *
 *  - {@link RetrySchedule} — the work *failed*. Attempts are finite; the caller
 *    must handle {@link RetryExhausted} and stop.
 *  - {@link PollSchedule} — the work is *fine and still in flight*; we are
 *    waiting for someone else's state to settle. Polls are not failures, so
 *    they are not counted against a retry budget, but they are bounded by a
 *    wall-clock deadline so an unobservable peer cannot pin the loop forever.
 *
 * The invariants are in the types, not in review discipline:
 *  - `minDelayMs` / `maxDelayMs` / `jitter` are required, so "re-arm at
 *    now + 1000" is not expressible without writing both bounds down.
 *  - `jitter: "none"` does not exist. Synchronised alarms across a shard are a
 *    thundering herd; opting out has to be done by pinning min === max, which
 *    is visible in the call site.
 *  - Every decision carries `attempt`/`poll` and `reason`, so the caller has
 *    something to log and persist. A silent loop cannot be built from these.
 *
 * Both take `now` and the accumulated counters from the caller instead of
 * holding a clock: the state lives in Durable Object storage and must survive
 * eviction, so the schedule is a pure function of persisted counters.
 */

export interface BackoffSpec {
  /** Floor for every computed delay, applied after jitter. Must be > 0. */
  readonly minDelayMs: number;
  /** Ceiling for exponential growth. Must be >= `minDelayMs`. */
  readonly maxDelayMs: number;
  /**
   * `full`: uniform in `[0, capped]`. `equal`: `capped/2 + uniform(capped/2)`.
   * Both are then floored at `minDelayMs`.
   */
  readonly jitter: "full" | "equal";
}

export interface RetryScheduleSpec extends BackoffSpec {
  /** Total attempts allowed, including the one that just failed. Must be >= 1. */
  readonly maxAttempts: number;
}

export interface PollScheduleSpec extends BackoffSpec {
  /**
   * Wall-clock budget for the whole wait, measured from the moment the caller
   * started polling. Must be > `minDelayMs` so at least one poll can happen.
   */
  readonly deadlineMs: number;
}

export interface ScheduleDeps {
  /** Injectable for deterministic tests. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export interface RetryScheduled {
  readonly kind: "retry";
  /** 1-based attempt number this decision schedules. */
  readonly attempt: number;
  readonly at: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface RetryExhausted {
  readonly kind: "exhausted";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
}

export type RetryDecision = RetryScheduled | RetryExhausted;

export interface PollScheduled {
  readonly kind: "poll";
  /** 1-based poll number this decision schedules. */
  readonly poll: number;
  readonly at: number;
  readonly delayMs: number;
  readonly reason: string;
}

export interface PollDeadlineExceeded {
  readonly kind: "deadline-exceeded";
  readonly poll: number;
  readonly elapsedMs: number;
  readonly deadlineMs: number;
  readonly reason: string;
}

export type PollDecision = PollScheduled | PollDeadlineExceeded;

export class RetrySchedule {
  readonly #spec: RetryScheduleSpec;
  readonly #random: () => number;

  constructor(spec: RetryScheduleSpec, deps: ScheduleDeps = {}) {
    assertBackoffSpec(spec);
    if (!Number.isFinite(spec.maxAttempts) || spec.maxAttempts < 1) {
      throw new TypeError("RetrySchedule maxAttempts must be >= 1");
    }
    this.#spec = spec;
    this.#random = deps.random ?? Math.random;
  }

  get maxAttempts(): number {
    return Math.floor(this.#spec.maxAttempts);
  }

  /**
   * @param input.attempts attempts already recorded *before* this failure.
   */
  next(input: {
    readonly attempts: number;
    readonly now: number;
    readonly reason: string;
  }): RetryDecision {
    const attempt = Math.max(0, Math.floor(input.attempts)) + 1;
    if (attempt >= this.maxAttempts) {
      return {
        kind: "exhausted",
        attempt,
        maxAttempts: this.maxAttempts,
        reason: input.reason,
      };
    }
    const delayMs = backoffDelayMs(this.#spec, attempt, this.#random);
    return {
      kind: "retry",
      attempt,
      at: input.now + delayMs,
      delayMs,
      reason: input.reason,
    };
  }
}

export class PollSchedule {
  readonly #spec: PollScheduleSpec;
  readonly #random: () => number;

  constructor(spec: PollScheduleSpec, deps: ScheduleDeps = {}) {
    assertBackoffSpec(spec);
    if (!Number.isFinite(spec.deadlineMs) || spec.deadlineMs <= spec.minDelayMs) {
      throw new TypeError("PollSchedule deadlineMs must exceed minDelayMs");
    }
    this.#spec = spec;
    this.#random = deps.random ?? Math.random;
  }

  get deadlineMs(): number {
    return this.#spec.deadlineMs;
  }

  /**
   * @param input.polls polls already performed for this wait.
   * @param input.elapsedMs time since the wait started, not since the last poll.
   */
  next(input: {
    readonly polls: number;
    readonly elapsedMs: number;
    readonly now: number;
    readonly reason: string;
  }): PollDecision {
    const poll = Math.max(0, Math.floor(input.polls)) + 1;
    const elapsedMs = Math.max(0, input.elapsedMs);
    if (elapsedMs >= this.#spec.deadlineMs) {
      return {
        kind: "deadline-exceeded",
        poll,
        elapsedMs,
        deadlineMs: this.#spec.deadlineMs,
        reason: input.reason,
      };
    }
    const delayMs = backoffDelayMs(this.#spec, poll, this.#random);
    return {
      kind: "poll",
      poll,
      at: input.now + delayMs,
      delayMs,
      reason: input.reason,
    };
  }
}

function assertBackoffSpec(spec: BackoffSpec): void {
  if (!Number.isFinite(spec.minDelayMs) || spec.minDelayMs <= 0) {
    throw new TypeError("backoff minDelayMs must be > 0");
  }
  if (!Number.isFinite(spec.maxDelayMs) || spec.maxDelayMs < spec.minDelayMs) {
    throw new TypeError("backoff maxDelayMs must be >= minDelayMs");
  }
}

function backoffDelayMs(
  spec: BackoffSpec,
  step: number,
  random: () => number,
): number {
  // 2 ** 30 already exceeds any sane cap; clamp the exponent so a resumed
  // record with a corrupt counter cannot produce Infinity.
  const exponent = Math.min(30, Math.max(0, step - 1));
  const capped = Math.min(spec.maxDelayMs, spec.minDelayMs * 2 ** exponent);
  const sample = clampUnit(random());
  const jittered =
    spec.jitter === "full" ? capped * sample : capped / 2 + (capped / 2) * sample;
  return Math.max(spec.minDelayMs, Math.round(jittered));
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}
