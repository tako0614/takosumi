import type {
  RevokeDebtCleanupOwnerInput,
  RevokeDebtCleanupResult,
} from "../domains/deploy-records/revoke_debt_cleanup_worker.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface WorkerDaemonTickContext {
  readonly taskName: string;
  readonly signal: AbortSignal;
  readonly iteration: number;
  readonly consecutiveFailures: number;
  readonly now: () => Date;
}

export interface WorkerDaemonTask {
  readonly name: string;
  readonly intervalMs: number;
  readonly initialDelayMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMultiplier?: number;
  readonly maxBackoffMs?: number;
  tick(context: WorkerDaemonTickContext): MaybePromise<unknown>;
}

export interface WorkerDaemonTickResult {
  readonly taskName: string;
  readonly iteration: number;
  readonly ok: boolean;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly consecutiveFailures: number;
  readonly nextDelayMs?: number;
  readonly error?: unknown;
}

export interface WorkerDaemonOptions {
  readonly tasks: readonly WorkerDaemonTask[];
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => Date;
  readonly onTick?: (result: WorkerDaemonTickResult) => MaybePromise<unknown>;
  readonly onError?: (
    error: unknown,
    result: WorkerDaemonTickResult,
  ) => MaybePromise<unknown>;
}

export interface WorkerDaemonHandle {
  readonly signal: AbortSignal;
  readonly completed: Promise<readonly WorkerDaemonTickResult[]>;
  stop(reason?: unknown): void;
}

export class WorkerDaemon {
  readonly #tasks: readonly WorkerDaemonTask[];
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #now: () => Date;
  readonly #onTick?: (result: WorkerDaemonTickResult) => MaybePromise<unknown>;
  readonly #onError?: (
    error: unknown,
    result: WorkerDaemonTickResult,
  ) => MaybePromise<unknown>;
  readonly #controller = new AbortController();

  constructor(options: WorkerDaemonOptions) {
    this.#tasks = options.tasks.map(validateTask);
    this.#sleep = options.sleep ?? sleep;
    this.#now = options.now ?? (() => new Date());
    this.#onTick = options.onTick;
    this.#onError = options.onError;
    if (options.signal) {
      if (options.signal.aborted) {
        this.#controller.abort(options.signal.reason);
      } else {
        options.signal.addEventListener(
          "abort",
          () => this.#controller.abort(options.signal?.reason),
          { once: true },
        );
      }
    }
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  stop(reason?: unknown): void {
    this.#controller.abort(reason);
  }

  start(): WorkerDaemonHandle {
    const completed = Promise.all(
      this.#tasks.map((task) => this.#runLoop(task)),
    )
      .then((results) => results.flat());
    return {
      signal: this.signal,
      completed,
      stop: (reason?: unknown) => this.stop(reason),
    };
  }

  async runOnce(): Promise<readonly WorkerDaemonTickResult[]> {
    if (this.signal.aborted) return [];
    return await Promise.all(
      this.#tasks.map((task) => this.#runTick(task, 0, 0, undefined)),
    );
  }

  async #runLoop(task: WorkerDaemonTask): Promise<WorkerDaemonTickResult[]> {
    const results: WorkerDaemonTickResult[] = [];
    let iteration = 0;
    let consecutiveFailures = 0;
    let pendingDelay = task.initialDelayMs ?? 0;

    while (!this.signal.aborted) {
      if (pendingDelay > 0) {
        await this.#sleep(pendingDelay, this.signal).catch((error) => {
          if (!this.signal.aborted) throw error;
        });
        if (this.signal.aborted) break;
      }

      const result = await this.#runTick(
        task,
        iteration,
        consecutiveFailures,
        pendingDelay,
      );
      results.push(result);
      consecutiveFailures = result.ok ? 0 : result.consecutiveFailures;
      pendingDelay = result.nextDelayMs ?? task.intervalMs;
      iteration += 1;
    }
    return results;
  }

  async #runTick(
    task: WorkerDaemonTask,
    iteration: number,
    consecutiveFailures: number,
    previousDelayMs: number | undefined,
  ): Promise<WorkerDaemonTickResult> {
    const startedAt = this.#now();
    try {
      await task.tick({
        taskName: task.name,
        signal: this.signal,
        iteration,
        consecutiveFailures,
        now: this.#now,
      });
      const result: WorkerDaemonTickResult = {
        taskName: task.name,
        iteration,
        ok: true,
        startedAt,
        finishedAt: this.#now(),
        consecutiveFailures: 0,
        nextDelayMs: task.intervalMs,
      };
      await this.#onTick?.(result);
      return result;
    } catch (error) {
      if (this.signal.aborted) {
        const result: WorkerDaemonTickResult = {
          taskName: task.name,
          iteration,
          ok: false,
          startedAt,
          finishedAt: this.#now(),
          consecutiveFailures: consecutiveFailures + 1,
          nextDelayMs: previousDelayMs,
          error,
        };
        await this.#onTick?.(result);
        return result;
      }
      const failedCount = consecutiveFailures + 1;
      const result: WorkerDaemonTickResult = {
        taskName: task.name,
        iteration,
        ok: false,
        startedAt,
        finishedAt: this.#now(),
        consecutiveFailures: failedCount,
        nextDelayMs: backoffDelay(task, failedCount),
        error,
      };
      await this.#onTick?.(result);
      await this.#onError?.(error, result);
      return result;
    }
  }
}

export function runWorkerDaemonOnce(
  options: WorkerDaemonOptions,
): Promise<readonly WorkerDaemonTickResult[]> {
  return new WorkerDaemon(options).runOnce();
}

export interface RevokeDebtCleanupWorkerLike {
  processOwnerSpace(
    input: RevokeDebtCleanupOwnerInput,
  ): Promise<RevokeDebtCleanupResult>;
}

export interface RevokeDebtCleanupDaemonTaskOptions
  extends WorkerDaemonTaskTiming {
  readonly worker: RevokeDebtCleanupWorkerLike;
  readonly ownerSpaces:
    | readonly string[]
    | (() => MaybePromise<readonly string[]>);
  readonly limit?: number;
  readonly name?: string;
}

export function createRevokeDebtCleanupWorkerTask(
  options: RevokeDebtCleanupDaemonTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "revoke-debt-cleanup",
    async tick(context) {
      const ownerSpaces = typeof options.ownerSpaces === "function"
        ? await options.ownerSpaces()
        : options.ownerSpaces;
      for (const ownerSpaceId of ownerSpaces) {
        if (context.signal.aborted) return;
        await options.worker.processOwnerSpace({
          ownerSpaceId,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
      }
    },
  };
}

export interface WorkerDaemonTaskTiming {
  readonly intervalMs: number;
  readonly initialDelayMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMultiplier?: number;
  readonly maxBackoffMs?: number;
}

function taskTiming(options: WorkerDaemonTaskTiming): WorkerDaemonTaskTiming {
  return {
    intervalMs: options.intervalMs,
    initialDelayMs: options.initialDelayMs,
    backoffBaseMs: options.backoffBaseMs,
    backoffMultiplier: options.backoffMultiplier,
    maxBackoffMs: options.maxBackoffMs,
  };
}

function validateTask(task: WorkerDaemonTask): WorkerDaemonTask {
  if (!task.name) throw new Error("worker daemon task name is required");
  if (!Number.isFinite(task.intervalMs) || task.intervalMs < 0) {
    throw new Error(`worker daemon task ${task.name} has invalid intervalMs`);
  }
  return task;
}

function backoffDelay(
  task: WorkerDaemonTask,
  consecutiveFailures: number,
): number {
  const base = task.backoffBaseMs ?? task.intervalMs;
  const multiplier = task.backoffMultiplier ?? 2;
  const max = task.maxBackoffMs ?? Math.max(base, task.intervalMs) * 16;
  const delay = base * multiplier ** Math.max(0, consecutiveFailures - 1);
  return Math.min(max, delay);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(cleanup, ms);
    const abort = () => cleanup();
    function cleanup() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
