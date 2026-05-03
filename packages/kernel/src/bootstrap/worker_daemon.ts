import type { AppContext } from "../app_context.ts";
import type { PaaSProcessRole } from "../process/mod.ts";
import { ApplyWorker, type ApplyWorkerJob } from "../workers/apply_worker.ts";
import {
  NoopOutboxPublisher,
  OutboxDispatcher,
} from "../workers/outbox_dispatcher.ts";
import {
  WorkerDaemon,
  type WorkerDaemonTask,
  type WorkerDaemonTickResult,
} from "../workers/daemon.ts";

export interface RoleWorkerDaemonOptions {
  readonly role: PaaSProcessRole;
  readonly context: AppContext;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly onTick: (result: WorkerDaemonTickResult) => void;
}

export interface WorkerDaemonState {
  readonly startedAt: string;
  readonly lastTickByTask: ReadonlyMap<string, WorkerDaemonTickResult>;
  onTick(result: WorkerDaemonTickResult): void;
}

export interface ShouldStartWorkerDaemonOptions {
  readonly startWorkerDaemon?: boolean;
}

export function shouldStartWorkerDaemon(
  role: PaaSProcessRole,
  options: ShouldStartWorkerDaemonOptions,
): boolean {
  return role === "takosumi-worker" && options.startWorkerDaemon !== false;
}

export function createRoleWorkerDaemon(
  options: RoleWorkerDaemonOptions,
): WorkerDaemon {
  return new WorkerDaemon({
    tasks: createWorkerTasks(options),
    onTick: options.onTick,
    onError: (error, result) => {
      console.error(
        `[paas-worker] ${result.taskName} tick failed: ${errorMessage(error)}`,
      );
    },
  });
}

function createWorkerTasks(
  options: RoleWorkerDaemonOptions,
): readonly WorkerDaemonTask[] {
  if (options.role !== "takosumi-worker") return [];
  const applyQueue = options.runtimeEnv.TAKOSUMI_APPLY_QUEUE ??
    "takos.deploy.apply";
  const intervalMs = positiveInteger(
    options.runtimeEnv.TAKOSUMI_WORKER_POLL_INTERVAL_MS,
    1_000,
  );
  const visibilityTimeoutMs = positiveInteger(
    options.runtimeEnv.TAKOSUMI_WORKER_VISIBILITY_TIMEOUT_MS,
    30_000,
  );
  const applyWorker = new ApplyWorker({
    store: options.context.stores.deploy.deploys,
    deploymentService: options.context.services.deploy.deployments,
    auditStore: options.context.stores.audit.events,
    outboxStore: options.context.services.core.outbox,
  });
  const outboxDispatcher = new OutboxDispatcher(
    options.context.services.core.outbox,
    new NoopOutboxPublisher(),
  );

  return [
    {
      name: "apply",
      intervalMs,
      async tick() {
        const lease = await options.context.adapters.queue.lease<
          ApplyWorkerJob
        >(
          {
            queue: applyQueue,
            visibilityTimeoutMs,
          },
        );
        if (!lease) return;
        try {
          await applyWorker.process(lease.message.payload);
          await options.context.adapters.queue.ack({
            queue: applyQueue,
            messageId: lease.message.id,
            leaseToken: lease.token,
          });
        } catch (error) {
          await options.context.adapters.queue.nack({
            queue: applyQueue,
            messageId: lease.message.id,
            leaseToken: lease.token,
            reason: errorMessage(error),
          });
          throw error;
        }
      },
    },
    {
      name: "outbox",
      intervalMs,
      tick: () =>
        outboxDispatcher.dispatchPending({
          limit: positiveInteger(
            options.runtimeEnv.TAKOSUMI_OUTBOX_DISPATCH_LIMIT,
            100,
          ),
        }),
    },
  ];
}

export function createWorkerDaemonState(): WorkerDaemonState {
  const lastTickByTask = new Map<string, WorkerDaemonTickResult>();
  return {
    startedAt: new Date().toISOString(),
    lastTickByTask,
    onTick(result) {
      lastTickByTask.set(result.taskName, result);
    },
  };
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
