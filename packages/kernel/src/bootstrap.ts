import type { Hono as HonoApp } from "hono";
import { createApiApp } from "./api/mod.ts";
import type { ReadinessRouteProbes } from "./api/readiness_routes.ts";
import {
  type AppContext,
  type AppContextOptions,
  type AppRuntimeConfig,
  createAppContext,
} from "./app_context.ts";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import { loadKernelPluginsFromEnv } from "./plugins/mod.ts";
import { isPaaSProcessRole, type PaaSProcessRole } from "./process/mod.ts";
import { ApplyWorker, type ApplyWorkerJob } from "./workers/apply_worker.ts";
import {
  NoopOutboxPublisher,
  OutboxDispatcher,
} from "./workers/outbox_dispatcher.ts";
import {
  WorkerDaemon,
  type WorkerDaemonHandle,
  type WorkerDaemonTask,
  type WorkerDaemonTickResult,
} from "./workers/daemon.ts";

export interface CreatePaaSAppOptions extends AppContextOptions {
  readonly role?: PaaSProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly context?: AppContext;
  readonly startWorkerDaemon?: boolean;
}

export interface CreatedPaaSApp {
  readonly app: HonoApp;
  readonly context: AppContext;
  readonly role: PaaSProcessRole;
  readonly workerDaemon?: WorkerDaemonHandle;
}

export async function createPaaSApp(
  options: CreatePaaSAppOptions = {},
): Promise<CreatedPaaSApp> {
  const runtimeEnv = options.runtimeEnv ?? Deno.env.toObject();
  const runtimeConfig = options.runtimeConfig ??
    await loadRuntimeConfigFromEnv({ env: runtimeEnv });
  const role = options.role ?? processRoleFromRuntimeConfig(runtimeConfig);
  const context = options.context ?? await createAppContext({
    ...options,
    runtimeEnv,
    runtimeConfig,
    plugins: options.plugins ?? await loadKernelPluginsFromEnv(runtimeEnv),
  });
  const workerDaemonState = createWorkerDaemonState();
  const workerDaemon = shouldStartWorkerDaemon(role, options)
    ? createRoleWorkerDaemon({
      role,
      context,
      runtimeEnv,
      onTick: workerDaemonState.onTick,
    }).start()
    : undefined;
  const app = await createApiApp({
    role,
    context,
    registerInternalRoutes: role === "takosumi-api",
    registerPublicRoutes: role === "takosumi-api" &&
      runtimeConfig.routes?.publicRoutesEnabled === true,
    registerRuntimeAgentRoutes: role === "takosumi-runtime-agent",
    registerReadinessRoutes: true,
    registerOpenApiRoute: role === "takosumi-api",
    readinessRouteProbes: createRoleReadinessProbes({
      role,
      context,
      runtimeConfig,
      runtimeEnv,
      workerDaemonState,
      workerDaemon,
    }),
  });
  return { app, context, role, workerDaemon };
}

function processRoleFromRuntimeConfig(
  runtimeConfig: AppRuntimeConfig,
): PaaSProcessRole {
  const role = runtimeConfig.processRole;
  return role && isPaaSProcessRole(role) ? role : "takosumi-api";
}

interface RoleWorkerDaemonOptions {
  readonly role: PaaSProcessRole;
  readonly context: AppContext;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly onTick: (result: WorkerDaemonTickResult) => void;
}

function shouldStartWorkerDaemon(
  role: PaaSProcessRole,
  options: CreatePaaSAppOptions,
): boolean {
  return role === "takosumi-worker" && options.startWorkerDaemon !== false;
}

function createRoleWorkerDaemon(
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
  const applyQueue = options.runtimeEnv.TAKOS_APPLY_QUEUE ??
    "takos.deploy.apply";
  const intervalMs = positiveInteger(
    options.runtimeEnv.TAKOS_WORKER_POLL_INTERVAL_MS,
    1_000,
  );
  const visibilityTimeoutMs = positiveInteger(
    options.runtimeEnv.TAKOS_WORKER_VISIBILITY_TIMEOUT_MS,
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
            options.runtimeEnv.TAKOS_OUTBOX_DISPATCH_LIMIT,
            100,
          ),
        }),
    },
  ];
}

interface WorkerDaemonState {
  readonly startedAt: string;
  readonly lastTickByTask: ReadonlyMap<string, WorkerDaemonTickResult>;
  onTick(result: WorkerDaemonTickResult): void;
}

function createWorkerDaemonState(): WorkerDaemonState {
  const lastTickByTask = new Map<string, WorkerDaemonTickResult>();
  return {
    startedAt: new Date().toISOString(),
    lastTickByTask,
    onTick(result) {
      lastTickByTask.set(result.taskName, result);
    },
  };
}

interface RoleReadinessProbeOptions {
  readonly role: PaaSProcessRole;
  readonly context: AppContext;
  readonly runtimeConfig: AppRuntimeConfig;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly workerDaemonState: WorkerDaemonState;
  readonly workerDaemon?: WorkerDaemonHandle;
}

function createRoleReadinessProbes(
  options: RoleReadinessProbeOptions,
): ReadinessRouteProbes {
  return {
    ready: async () => {
      const checks: Record<string, unknown> = {};
      const failures: string[] = [];
      await recordCheck(checks, failures, "role", () => {
        if (
          options.runtimeConfig.processRole &&
          options.runtimeConfig.processRole !== options.role
        ) {
          throw new Error(
            `runtime config role ${options.runtimeConfig.processRole} does not match process role ${options.role}`,
          );
        }
        return options.runtimeConfig.processRole ?? options.role;
      });
      await recordCheck(checks, failures, "storage", async () => {
        await options.context.adapters.storage.transaction(() => undefined);
        return "ok";
      });
      await recordCheck(checks, failures, "plugins", () => {
        const strict = options.runtimeConfig.environment === "production" ||
          options.runtimeConfig.environment === "staging";
        const selected = Object.keys(options.runtimeConfig.plugins ?? {})
          .length;
        if (strict && selected === 0) {
          throw new Error("strict runtime has no selected kernel plugins");
        }
        return { selected, strict };
      });
      if (requiresInternalServiceSecret(options.role)) {
        await recordCheck(checks, failures, "internalServiceSecret", () => {
          if (!options.runtimeEnv.TAKOS_INTERNAL_SERVICE_SECRET) {
            throw new Error("TAKOS_INTERNAL_SERVICE_SECRET is required");
          }
          return "configured";
        });
      }
      if (options.role === "takosumi-worker") {
        await recordCheck(
          checks,
          failures,
          "workerDaemon",
          () => workerDaemonReadiness(options),
        );
      }
      return {
        ok: failures.length === 0,
        service: "takosumi",
        role: options.role,
        checkedAt: new Date().toISOString(),
        checks,
        ...(failures.length > 0 ? { reason: failures.join("; ") } : {}),
      };
    },
    live: () => ({
      ok: true,
      service: "takosumi",
      role: options.role,
      checkedAt: new Date().toISOString(),
    }),
    statusSummary: () => ({
      spaceId: "system",
      groupId: "takosumi",
      activationId: `${options.role}:process`,
      status: "active",
      projectedAt: new Date().toISOString(),
      desired: {
        status: "committed",
        conditions: [{ type: "ActivationCommitted", status: "true" }],
      },
      serving: {
        status: "converged",
        conditions: [{ type: "RuntimeConverged", status: "true" }],
      },
      dependencies: {
        status: "ready",
        conditions: [{ type: "DependenciesReady", status: "true" }],
      },
      security: {
        status: "trusted",
        conditions: [{ type: "SecurityTrusted", status: "true" }],
      },
      providers: [],
      conditions: [
        { type: "ActivationCommitted", status: "true" },
        { type: "ServingConverged", status: "true" },
        { type: "DependenciesReady", status: "true" },
        { type: "SecurityTrusted", status: "true" },
      ],
    }),
  };
}

async function recordCheck(
  checks: Record<string, unknown>,
  failures: string[],
  name: string,
  fn: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    checks[name] = await fn();
  } catch (error) {
    const message = errorMessage(error);
    checks[name] = { ok: false, error: message };
    failures.push(`${name}: ${message}`);
  }
}

function requiresInternalServiceSecret(role: PaaSProcessRole): boolean {
  return role === "takosumi-api" || role === "takosumi-runtime-agent";
}

function workerDaemonReadiness(
  options: RoleReadinessProbeOptions,
): Record<string, unknown> {
  if (!options.workerDaemon) {
    throw new Error("worker daemon is not running");
  }
  if (options.workerDaemon.signal.aborted) {
    throw new Error("worker daemon is stopped");
  }
  const tasks = [...options.workerDaemonState.lastTickByTask.values()];
  if (tasks.length === 0) {
    throw new Error("worker daemon has not completed an initial tick");
  }
  const failed = tasks.filter((task) => !task.ok);
  if (failed.length > 0) {
    throw new Error(
      failed.map((task) =>
        `${task.taskName} failed ${task.consecutiveFailures} time(s)`
      ).join("; "),
    );
  }
  return {
    startedAt: options.workerDaemonState.startedAt,
    tasks: Object.fromEntries(
      tasks.map((task) => [
        task.taskName,
        {
          ok: task.ok,
          iteration: task.iteration,
          finishedAt: task.finishedAt.toISOString(),
        },
      ]),
    ),
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
