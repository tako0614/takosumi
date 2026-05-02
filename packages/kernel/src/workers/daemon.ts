import type { ApplyWorkerJob } from "./apply_worker.ts";
import type {
  RuntimeAgentRegistry,
  StaleAgentDetection,
} from "../agents/mod.ts";
import type { DispatchOutboxOptions } from "./outbox_dispatcher.ts";
import type { RegistryPackageRef } from "./registry_sync_worker.ts";
import type { RepairGroupInput } from "./repair_worker.ts";

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

export interface ApplyWorkerLike {
  process(job: ApplyWorkerJob): Promise<unknown>;
}

export interface ApplyWorkerDaemonTaskOptions extends WorkerDaemonTaskTiming {
  readonly worker: ApplyWorkerLike;
  readonly nextJob: () => MaybePromise<ApplyWorkerJob | undefined>;
  readonly name?: string;
}

export function createApplyWorkerTask(
  options: ApplyWorkerDaemonTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "apply",
    async tick(context) {
      const job = await options.nextJob();
      if (!job || context.signal.aborted) return;
      await options.worker.process(job);
    },
  };
}

export interface OutboxDispatcherLike {
  dispatchPending(options?: DispatchOutboxOptions): Promise<unknown>;
}

export interface OutboxDispatcherDaemonTaskOptions
  extends WorkerDaemonTaskTiming {
  readonly dispatcher: OutboxDispatcherLike;
  readonly limit?: number;
  readonly name?: string;
}

export function createOutboxDispatcherTask(
  options: OutboxDispatcherDaemonTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "outbox",
    tick() {
      return options.dispatcher.dispatchPending({ limit: options.limit });
    },
  };
}

export interface RuntimeAgentStaleDetectionTaskOptions
  extends WorkerDaemonTaskTiming {
  readonly registry: Pick<RuntimeAgentRegistry, "detectStaleAgents">;
  readonly ttlMs: number;
  readonly name?: string;
  readonly onDetection?: (
    detection: StaleAgentDetection,
  ) => MaybePromise<unknown>;
}

export function createRuntimeAgentStaleDetectionTask(
  options: RuntimeAgentStaleDetectionTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "runtime-agent-stale-detection",
    async tick(context) {
      const detection = await options.registry.detectStaleAgents({
        ttlMs: options.ttlMs,
        now: context.now().toISOString(),
      });
      await options.onDetection?.(detection);
    },
  };
}

export interface RegistrySyncWorkerLike {
  syncPackages(refs: readonly RegistryPackageRef[]): Promise<unknown>;
  syncProviderSupport?(): Promise<unknown>;
}

export interface RegistrySyncDaemonTaskOptions extends WorkerDaemonTaskTiming {
  readonly worker: RegistrySyncWorkerLike;
  readonly refs:
    | readonly RegistryPackageRef[]
    | (() => MaybePromise<readonly RegistryPackageRef[]>);
  readonly syncProviderSupport?: boolean;
  readonly name?: string;
}

export function createRegistrySyncWorkerTask(
  options: RegistrySyncDaemonTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "registry-sync",
    async tick() {
      const refs = typeof options.refs === "function"
        ? await options.refs()
        : options.refs;
      await options.worker.syncPackages(refs);
      if (options.syncProviderSupport) {
        await options.worker.syncProviderSupport?.();
      }
    },
  };
}

export interface RepairWorkerLike {
  inspectGroup(input: RepairGroupInput): Promise<unknown>;
}

export interface RepairWorkerDaemonTaskOptions extends WorkerDaemonTaskTiming {
  readonly worker: RepairWorkerLike;
  readonly groups:
    | readonly RepairGroupInput[]
    | (() => MaybePromise<readonly RepairGroupInput[]>);
  readonly name?: string;
}

export function createRepairWorkerTask(
  options: RepairWorkerDaemonTaskOptions,
): WorkerDaemonTask {
  return {
    ...taskTiming(options),
    name: options.name ?? "repair",
    async tick(context) {
      const groups = typeof options.groups === "function"
        ? await options.groups()
        : options.groups;
      for (const group of groups) {
        if (context.signal.aborted) return;
        await options.worker.inspectGroup(group);
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
