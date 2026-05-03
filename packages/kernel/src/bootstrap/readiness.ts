import type { ReadinessRouteProbes } from "../api/readiness_routes.ts";
import type { AppContext, AppRuntimeConfig } from "../app_context.ts";
import type { PaaSProcessRole } from "../process/mod.ts";
import type {
  WorkerDaemonHandle,
  WorkerDaemonTickResult,
} from "../workers/daemon.ts";

/**
 * Structural shape of the worker daemon state the readiness probe needs.
 *
 * Defined locally (rather than imported from `./worker_daemon.ts`) so the
 * readiness module stays independent of the worker daemon module — see
 * the no-cross-import rule in the bootstrap split. The orchestrator
 * (`bootstrap.ts`) constructs the concrete state and threads it in here;
 * structural typing matches the two interfaces at the call site.
 */
interface ReadinessWorkerDaemonState {
  readonly startedAt: string;
  readonly lastTickByTask: ReadonlyMap<string, WorkerDaemonTickResult>;
}

export interface RoleReadinessProbeOptions {
  readonly role: PaaSProcessRole;
  readonly context: AppContext;
  readonly runtimeConfig: AppRuntimeConfig;
  readonly runtimeEnv: Record<string, string | undefined>;
  readonly workerDaemonState: ReadinessWorkerDaemonState;
  readonly workerDaemon?: WorkerDaemonHandle;
}

export function createRoleReadinessProbes(
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
          if (!options.runtimeEnv.TAKOSUMI_INTERNAL_SERVICE_SECRET) {
            throw new Error("TAKOSUMI_INTERNAL_SERVICE_SECRET is required");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
