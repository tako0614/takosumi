import type { AppContext } from "../app_context.ts";
import type { TakosumiProcessRole } from "../process/mod.ts";
import type { RevokeDebtStore } from "../domains/deploy-records/revoke_debt_store.ts";
import { RevokeDebtCleanupWorker } from "../domains/deploy-records/revoke_debt_cleanup_worker.ts";
import type {
  TakosumiDeploymentRecordStore,
} from "../domains/deploy-records/deployment_record_store.ts";
import {
  NoopOutboxPublisher,
  OutboxDispatcher,
} from "../workers/outbox_dispatcher.ts";
import {
  createRevokeDebtCleanupWorkerTask,
  WorkerDaemon,
  type WorkerDaemonTask,
  type WorkerDaemonTickResult,
} from "../workers/daemon.ts";
import { log } from "../shared/log.ts";
import { errorMessage } from "../shared/errors.ts";
import type {
  PlatformContext,
  RefResolver,
} from "takosumi-contract/internal/provider-adapter";
import type { JsonObject } from "takosumi-contract/reference/types";

export interface RoleWorkerDaemonOptions {
  readonly role: TakosumiProcessRole;
  readonly context: AppContext;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly deploymentRecordStore?: TakosumiDeploymentRecordStore;
  readonly revokeDebtStore?: RevokeDebtStore;
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
  role: TakosumiProcessRole,
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
      log.error("service.worker.tick_failed", {
        taskName: result.taskName,
        message: errorMessage(error),
      });
    },
  });
}

function createWorkerTasks(
  options: RoleWorkerDaemonOptions,
): readonly WorkerDaemonTask[] {
  if (options.role !== "takosumi-worker") return [];
  const intervalMs = positiveInteger(
    options.runtimeEnv.TAKOSUMI_WORKER_POLL_INTERVAL_MS,
    1_000,
  );
  const outboxDispatcher = new OutboxDispatcher(
    options.context.services.space.outbox,
    new NoopOutboxPublisher(),
  );
  const revokeDebtStore = options.revokeDebtStore;
  const revokeDebtCleanupWorker = revokeDebtStore
    ? new RevokeDebtCleanupWorker({
      revokeDebtStore,
      ...(options.deploymentRecordStore
        ? { deploymentRecordStore: options.deploymentRecordStore }
        : {}),
      context: (ownerSpaceId) =>
        platformContextFromAppContext(options.context, ownerSpaceId),
    })
    : undefined;
  const revokeDebtCleanupIntervalMs = positiveInteger(
    options.runtimeEnv.TAKOSUMI_REVOKE_DEBT_CLEANUP_INTERVAL_MS,
    intervalMs,
  );
  const revokeDebtCleanupLimit = positiveInteger(
    options.runtimeEnv.TAKOSUMI_REVOKE_DEBT_CLEANUP_LIMIT,
    50,
  );

  return [
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
    ...(revokeDebtCleanupWorker && revokeDebtStore
      ? [
        createRevokeDebtCleanupWorkerTask({
          intervalMs: revokeDebtCleanupIntervalMs,
          limit: revokeDebtCleanupLimit,
          worker: revokeDebtCleanupWorker,
          ownerSpaces: () => revokeDebtStore.listOpenOwnerSpaces(),
        }),
      ]
      : []),
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

function platformContextFromAppContext(
  appContext: AppContext,
  ownerSpaceId: string,
): PlatformContext {
  const adapters = appContext.adapters;
  return {
    tenantId: ownerSpaceId,
    spaceId: ownerSpaceId,
    secrets: adapters.secrets as PlatformContext["secrets"],
    observability: adapters.observability as PlatformContext["observability"],
    kms: adapters.kms as PlatformContext["kms"],
    objectStorage: adapters.objectStorage as PlatformContext["objectStorage"],
    refResolver: WORKER_DAEMON_REF_RESOLVER,
    resolvedOutputs: new Map<string, JsonObject>(),
  };
}

const WORKER_DAEMON_REF_RESOLVER: RefResolver = {
  resolve(_expression: string) {
    return null;
  },
};
