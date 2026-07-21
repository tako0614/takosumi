/**
 * Virtual alarm clock for Durable Object alarm loops.
 *
 * The failure mode this exists to catch is not "the code threw" — it is "the
 * object keeps re-arming its alarm forever at a tiny fixed delay". A test that
 * calls `alarm()` twice and asserts a counter cannot see that; it terminates
 * because the *test* stopped, not because the object did.
 *
 * So the harness owns the clock and the storage, drives the alarm until the
 * object stops arming one, and fails on the two things a bounded loop must
 * never do:
 *
 *  - dispatch more than `maxDispatches` times before going quiet, and
 *  - re-arm sooner than `minDelayMs` after an alarm ran.
 *
 * Both bounds are required arguments: a caller cannot opt out of the invariant
 * by leaving one off.
 */

export class AlarmLoopUnboundedError extends Error {
  constructor(
    readonly dispatches: number,
    readonly maxDispatches: number,
    readonly lastDelayMs: number | undefined,
  ) {
    super(
      `alarm re-armed ${dispatches} times without settling (max ${maxDispatches}, last delay ${String(lastDelayMs)}ms)`,
    );
    this.name = "AlarmLoopUnboundedError";
  }
}

export class AlarmTooEagerError extends Error {
  constructor(
    readonly delayMs: number,
    readonly minDelayMs: number,
    readonly dispatch: number,
  ) {
    super(
      `alarm ${dispatch} re-armed after ${delayMs}ms, below the ${minDelayMs}ms floor`,
    );
    this.name = "AlarmTooEagerError";
  }
}

export interface VirtualAlarmStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface VirtualAlarmRun {
  /** Number of times the alarm callback ran before the object went quiet. */
  readonly dispatches: number;
  /** Delay, in ms, of every re-arm observed after an alarm ran. */
  readonly delaysMs: readonly number[];
}

export interface VirtualAlarmClock {
  now(): number;
  readonly storage: VirtualAlarmStorage;
  /** Runs `alarm` until no alarm is armed, or fails the bound. */
  drain(alarm: () => Promise<void>): Promise<VirtualAlarmRun>;
}

export function createVirtualAlarmClock(options: {
  readonly startedAt: number;
  readonly maxDispatches: number;
  readonly minDelayMs: number;
}): VirtualAlarmClock {
  if (!Number.isFinite(options.maxDispatches) || options.maxDispatches < 1) {
    throw new TypeError("maxDispatches must be >= 1");
  }
  if (!Number.isFinite(options.minDelayMs) || options.minDelayMs < 0) {
    throw new TypeError("minDelayMs must be >= 0");
  }
  const values = new Map<string, unknown>();
  let current = options.startedAt;
  let alarmAt: number | undefined;

  const storage: VirtualAlarmStorage = {
    get<T>(key: string): Promise<T | undefined> {
      return Promise.resolve(
        values.has(key)
          ? (structuredClone(values.get(key)) as T)
          : undefined,
      );
    },
    put<T>(key: string, value: T): Promise<void> {
      values.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete(key: string): Promise<boolean> {
      return Promise.resolve(values.delete(key));
    },
    getAlarm(): Promise<number | null> {
      return Promise.resolve(alarmAt ?? null);
    },
    setAlarm(scheduledTime: number): Promise<void> {
      alarmAt = scheduledTime;
      return Promise.resolve();
    },
    deleteAlarm(): Promise<void> {
      alarmAt = undefined;
      return Promise.resolve();
    },
  };

  return {
    now: () => current,
    storage,
    async drain(alarm: () => Promise<void>): Promise<VirtualAlarmRun> {
      const delaysMs: number[] = [];
      let dispatches = 0;
      while (alarmAt !== undefined) {
        // Alarms never fire early; advancing to the armed time is the only
        // way real time moves in this harness.
        current = Math.max(current, alarmAt);
        alarmAt = undefined;
        dispatches += 1;
        const firedAt = current;
        await alarm();
        if (alarmAt === undefined) break;
        const delayMs = alarmAt - firedAt;
        delaysMs.push(delayMs);
        if (delayMs < options.minDelayMs) {
          throw new AlarmTooEagerError(
            delayMs,
            options.minDelayMs,
            dispatches,
          );
        }
        if (dispatches >= options.maxDispatches) {
          throw new AlarmLoopUnboundedError(
            dispatches,
            options.maxDispatches,
            delayMs,
          );
        }
      }
      return { dispatches, delaysMs };
    },
  };
}
