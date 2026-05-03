import type { Hono as HonoApp } from "hono";
import { createApiApp } from "./api/mod.ts";
import {
  type AppContext,
  type AppContextOptions,
  type AppRuntimeConfig,
  createAppContext,
} from "./app_context.ts";
import { loadRuntimeConfigFromEnv } from "./config/mod.ts";
import { loadKernelPluginsFromEnv } from "./plugins/mod.ts";
import { isPaaSProcessRole, type PaaSProcessRole } from "./process/mod.ts";
import type { WorkerDaemonHandle } from "./workers/daemon.ts";
import type { SqlClient } from "./adapters/storage/sql.ts";
import type { TakosumiDeploymentRecordStore } from "./domains/deploy/takosumi_deployment_record_store.ts";
import { registerBundledShapesAndProviders } from "./bootstrap/registry_setup.ts";
import {
  createRoleWorkerDaemon,
  createWorkerDaemonState,
  shouldStartWorkerDaemon,
} from "./bootstrap/worker_daemon.ts";
import { createRoleReadinessProbes } from "./bootstrap/readiness.ts";
import {
  buildDeployPublicRouteOptions,
  resolveTakosumiDeploymentRecordStore,
} from "./bootstrap/deploy_record_store.ts";

export { registerBundledShapesAndProviders };

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
