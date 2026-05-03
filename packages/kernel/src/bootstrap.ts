import type { Hono as HonoApp } from "hono";
import {
  registerProvider,
  registerShape,
  registerTemplate,
} from "takosumi-contract";
import { TAKOSUMI_BUNDLED_SHAPES } from "@takos/takosumi-plugins/shapes";
import { TAKOSUMI_BUNDLED_TEMPLATES } from "@takos/takosumi-plugins/templates";
import { createTakosumiProductionProviders } from "@takos/takosumi-plugins/shape-providers/factories";
import { createApiApp } from "./api/mod.ts";
import type { ReadinessRouteProbes } from "./api/readiness_routes.ts";
import type { RegisterDeployPublicRoutesOptions } from "./api/deploy_public_routes.ts";
import {
  type AppContext,
  type AppContextOptions,
  type AppRuntimeConfig,
  createAppContext,
} from "./app_context.ts";
import { detectRuntimeAgent } from "./bootstrap/agent_detection.ts";
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
import type { SqlClient } from "./adapters/storage/sql.ts";
import {
  InMemoryTakosumiDeploymentRecordStore,
  type TakosumiDeploymentRecordStore,
} from "./domains/deploy/takosumi_deployment_record_store.ts";
import { SqlTakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store_sql.ts";

export interface CreatePaaSAppOptions extends AppContextOptions {
  readonly role?: PaaSProcessRole;
  readonly runtimeEnv?: Record<string, string | undefined>;
  readonly context?: AppContext;
  readonly startWorkerDaemon?: boolean;
  /**
   * Optional SQL client used to back persistence-sensitive records. When
   * supplied, bootstrap instantiates `SqlTakosumiDeploymentRecordStore`
   * so the public deploy lifecycle (`POST /v1/deployments` plus the
   * artifact GC mark-and-sweep) survives kernel restarts. When absent,
   * bootstrap falls back to the in-memory store; that loses deploy
   * state on any restart and should only be used in tests / dev.
   *
   * The `index.ts` boot path constructs this from `TAKOSUMI_DATABASE_URL`
   * via `tryCreatePostgresClient` and threads it in. Tests that drive
   * `createPaaSApp` directly typically leave it unset.
   */
  readonly sqlClient?: SqlClient;
  /**
   * Pre-built record store override. Wins over `sqlClient` so tests can
   * inject a hand-rolled fake without standing up a SqlClient.
   */
  readonly takosumiDeploymentRecordStore?: TakosumiDeploymentRecordStore;
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
  registerBundledShapesAndProviders(runtimeEnv);
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
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const fetchToken = runtimeEnv.TAKOSUMI_ARTIFACT_FETCH_TOKEN;
  const artifactMaxBytes = parsePositiveIntegerEnv(
    runtimeEnv.TAKOSUMI_ARTIFACT_MAX_BYTES,
  );
  // Build the takosumi deploy record store. SqlClient wins so
  // production restarts no longer wipe `(tenantId, name) → applied[]`
  // mappings; without it the kernel falls back to the in-memory store
  // which is fine for tests / single-process dev but loses every
  // applied / destroyed record on process exit.
  const recordStore = resolveTakosumiDeploymentRecordStore(options);
  const deployPublicRouteOptions = role === "takosumi-api" && deployToken
    ? buildDeployPublicRouteOptions({
      context,
      deployToken,
      recordStore,
    })
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
    registerArtifactRoutes: role === "takosumi-api" &&
      Boolean(deployToken) &&
      Boolean(context.adapters?.objectStorage),
    artifactRouteOptions: deployToken && context.adapters?.objectStorage
      ? {
        getDeployToken: () => deployToken,
        objectStorage: context.adapters.objectStorage,
        recordStore,
        ...(fetchToken ? { getArtifactFetchToken: () => fetchToken } : {}),
        ...(artifactMaxBytes !== undefined
          ? { maxBytes: artifactMaxBytes }
          : {}),
      }
      : undefined,
    registerDeployPublicRoutes: deployPublicRouteOptions !== undefined,
    deployPublicRouteOptions,
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

let bundledShapesRegistered = false;

/**
 * Idempotently registers all bundled shapes, templates, and runtime-agent-
 * backed providers into the global contract registry. Called once per
 * `createPaaSApp` invocation; safe to call repeatedly.
 *
 * Provider registration only fires when `TAKOSUMI_AGENT_URL` and
 * `TAKOSUMI_AGENT_TOKEN` are set — otherwise the kernel boots without
 * providers (apply requests will fail with `provider not registered` until
 * an agent is configured).
 */
export function registerBundledShapesAndProviders(
  runtimeEnv: Record<string, string | undefined> = Deno.env.toObject(),
): void {
  if (!bundledShapesRegistered) {
    for (const shape of TAKOSUMI_BUNDLED_SHAPES) registerShape(shape);
    for (const template of TAKOSUMI_BUNDLED_TEMPLATES) {
      registerTemplate(template);
    }
    bundledShapesRegistered = true;
  }
  const agent = detectRuntimeAgent(runtimeEnv);
  if (!agent) {
    console.warn(
      "[takosumi-bootstrap] TAKOSUMI_AGENT_URL / TAKOSUMI_AGENT_TOKEN not set; " +
        "no providers registered (apply requests will return provider_not_registered).",
    );
    return;
  }
  const artifactStore = detectArtifactStore(runtimeEnv);
  const providers = createTakosumiProductionProviders({
    agentUrl: agent.agentUrl,
    token: agent.token,
    ...(artifactStore ? { artifactStore } : {}),
  });
  for (const provider of providers) registerProvider(provider);
  console.log(
    `[takosumi-bootstrap] registered ${providers.length} providers via agent at ${agent.agentUrl}` +
      (artifactStore
        ? ` (artifact store: ${artifactStore.baseUrl})`
        : " (no artifact store: TAKOSUMI_PUBLIC_BASE_URL unset)"),
  );
}

/**
 * Resolves the URL the runtime-agent's connectors should use to fetch
 * uploaded artifacts (e.g. JS bundles for cloudflare-workers). The kernel
 * exposes `POST/GET /v1/artifacts` itself, so the agent simply needs the
 * kernel's externally-reachable base URL plus a token that the artifact
 * routes will accept on GET / HEAD.
 *
 * Token preference: when `TAKOSUMI_ARTIFACT_FETCH_TOKEN` is set we hand
 * the agent the read-only fetch token instead of the deploy token. The
 * artifact routes accept either on read paths but only the deploy token
 * on POST / DELETE / GC, so a compromised agent host gets read-only
 * artifact access rather than full upload / delete / GC power.
 *
 * Returns `undefined` when either the public URL or both tokens are
 * missing — connectors that don't need uploaded artifacts (the OCI-image
 * set) keep working; connectors that do (cloudflare-workers, future
 * lambda-zip / static-bundle) will fail their apply with a clear error
 * that surfaces back to the operator.
 */
function detectArtifactStore(
  runtimeEnv: Record<string, string | undefined>,
):
  | { readonly baseUrl: string; readonly token: string }
  | undefined {
  const publicBaseUrl = runtimeEnv.TAKOSUMI_PUBLIC_BASE_URL;
  const deployToken = runtimeEnv.TAKOSUMI_DEPLOY_TOKEN;
  const fetchToken = runtimeEnv.TAKOSUMI_ARTIFACT_FETCH_TOKEN;
  // The artifact-store locator must point at a token the routes accept
  // on GET. Both the deploy token and the read-only fetch token work; we
  // prefer the read-only one so the agent host never holds upload /
  // delete / GC power.
  const token = fetchToken ?? deployToken;
  if (!publicBaseUrl || !token) return undefined;
  const trimmed = publicBaseUrl.endsWith("/")
    ? publicBaseUrl.slice(0, -1)
    : publicBaseUrl;
  return {
    baseUrl: `${trimmed}/v1/artifacts`,
    token,
  };
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

function positiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Parse a positive-integer env var, returning `undefined` when unset or
 * unparseable so callers can fall back to a downstream default. Used for
 * `TAKOSUMI_ARTIFACT_MAX_BYTES` where the kernel-level default lives in
 * the artifact-routes module.
 */
function parsePositiveIntegerEnv(
  value: string | undefined,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolve the takosumi deploy record store the artifact + public deploy
 * routes share. Preference order:
 *   1. Caller-supplied `takosumiDeploymentRecordStore` — wins so tests
 *      can inject a fake without standing up SQL.
 *   2. `sqlClient` — when present, instantiate a SQL-backed store so the
 *      `(tenantId, name) → applied[]` mapping survives kernel restarts
 *      and the artifact GC reads from the live table.
 *   3. In-memory fallback — fine for single-process dev and the test
 *      suite, but loses every record on process exit.
 *
 * The same store instance is passed to both artifact routes and deploy
 * public routes so the artifact GC's "what is still referenced?" query
 * always agrees with the route that just persisted the record.
 */
function resolveTakosumiDeploymentRecordStore(
  options: CreatePaaSAppOptions,
): TakosumiDeploymentRecordStore {
  if (options.takosumiDeploymentRecordStore) {
    return options.takosumiDeploymentRecordStore;
  }
  if (options.sqlClient) {
    return new SqlTakosumiDeploymentRecordStore({ client: options.sqlClient });
  }
  return new InMemoryTakosumiDeploymentRecordStore();
}

/**
 * Materialise the public deploy route options that bootstrap forwards to
 * `createApiApp` so the kernel mounts `POST /v1/deployments`. The route
 * needs (a) the deploy token, (b) an `appContext` to derive its
 * `PlatformContext` from, and (c) the shared record store. Returning
 * `undefined` from the caller's branch disables the mount entirely.
 */
function buildDeployPublicRouteOptions(input: {
  readonly context: AppContext;
  readonly deployToken: string;
  readonly recordStore: TakosumiDeploymentRecordStore;
}): RegisterDeployPublicRoutesOptions {
  return {
    appContext: input.context,
    getDeployToken: () => input.deployToken,
    recordStore: input.recordStore,
  };
}
