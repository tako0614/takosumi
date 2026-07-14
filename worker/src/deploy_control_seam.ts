import {
  type CreatedTakosumiService,
  type TakosumiOperations,
} from "../../core/bootstrap.ts";
import {
  createDefaultRunnerProfiles,
  resolveEnabledRunnerProfiles,
} from "../../core/domains/deploy-control/mod.ts";
import type { RunnerProfile } from "@takosumi/internal/deploy-control-api";
import type { CloudflareWorkerEnv, RunnerHostComposition } from "./bindings.ts";
import type { OpenTofuRunnerExecutorRegistry } from "../../core/domains/deploy-control/mod.ts";
import { createWorkerServiceApp } from "./worker_service.ts";

/**
 * Builds the deploy-control Takosumi service (the `takosumi-api` role) directly,
 * bypassing the worker fetch dispatcher. The unified Takos worker injects the
 * returned service's `app.fetch` as the in-process deploy-control transport for
 * the accounts handler's deploy-control seam — so the deploy-control plane
 * runs in-process and owns no public route.
 */
export function createDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  return createWorkerServiceApp(
    env,
    "takosumi-api",
    deployControlServiceOptions(env),
  );
}

export function deployControlServiceOptions(env: CloudflareWorkerEnv): {
  readonly runnerProfiles: readonly RunnerProfile[];
  readonly runnerExecutors?: OpenTofuRunnerExecutorRegistry;
  readonly defaultRunnerProfileId?: string;
  readonly managedVanityHostnameSlotsPerOwner?: number;
} {
  const hostComposition = runnerHostCompositionFromEnv(env);
  const managedVanityHostnameSlotsPerOwner = nonNegativeInteger(
    env.TAKOSUMI_MANAGED_VANITY_HOST_SLOTS_PER_OWNER,
  );
  return {
    runnerProfiles: resolveEnabledRunnerProfilesFromEnv(env, hostComposition),
    ...(hostComposition?.executors
      ? { runnerExecutors: hostComposition.executors }
      : {}),
    ...(typeof env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID === "string" &&
    env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID.trim()
      ? {
          defaultRunnerProfileId: env.TAKOSUMI_DEFAULT_RUNNER_PROFILE_ID.trim(),
        }
      : {}),
    ...(managedVanityHostnameSlotsPerOwner !== undefined
      ? { managedVanityHostnameSlotsPerOwner }
      : {}),
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value.trim())) {
    return undefined;
  }
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function createRunOwnerDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  // Source sync can create an auto-update Plan, and a completed auto-update
  // Plan can create an Apply. Those are distinct ledger Runs and must be
  // scheduled through their own RunOwner objects. The standard worker-service
  // enqueuer wiring does that; no-op enqueuers strand follow-up Runs as queued.
  return createWorkerServiceApp(
    env,
    "takosumi-api",
    deployControlServiceOptions(env),
  );
}

/**
 * The operator-curated execution surface. The built-in seed is one
 * provider-neutral OpenTofu profile; additional configured profiles represent
 * execution capabilities such as private-network or host-agent access, never a
 * list of supported providers.
 */
function resolveEnabledRunnerProfilesFromEnv(
  env: CloudflareWorkerEnv,
  hostComposition: RunnerHostComposition | undefined,
): readonly RunnerProfile[] {
  const profiles = [
    ...createDefaultRunnerProfiles(),
    ...(hostComposition?.profiles ?? []),
  ];
  assertUniqueRunnerProfileIds(profiles);
  return resolveEnabledRunnerProfiles(
    profiles,
    env.TAKOSUMI_ENABLED_RUNNER_PROFILES,
  );
}

function runnerHostCompositionFromEnv(
  env: CloudflareWorkerEnv,
): RunnerHostComposition | undefined {
  const value = env.TAKOSUMI_RUNNER_HOST_COMPOSITION;
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(
      "TAKOSUMI_RUNNER_HOST_COMPOSITION must be a host-code runtime object",
    );
  }
  if (!Array.isArray(value.profiles)) {
    throw new TypeError(
      "TAKOSUMI_RUNNER_HOST_COMPOSITION.profiles must be an array",
    );
  }
  const executors = value.executors;
  if (
    executors !== undefined &&
    (typeof executors !== "object" ||
      executors === null ||
      typeof executors[Symbol.iterator] !== "function")
  ) {
    throw new TypeError(
      "TAKOSUMI_RUNNER_HOST_COMPOSITION.executors must be an executor registry",
    );
  }
  return value;
}

function assertUniqueRunnerProfileIds(
  profiles: readonly RunnerProfile[],
): void {
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (!profile.id?.trim()) {
      throw new Error("runner host composition contains an empty profile id");
    }
    if (ids.has(profile.id)) {
      throw new Error(
        `runner host composition contains duplicate profile ${profile.id}`,
      );
    }
    ids.add(profile.id);
  }
}

/**
 * In-process deploy-control seam shared by every single-worker host (the unified
 * Takos worker, the operator platform worker, and the node-postgres composer).
 *
 * It owns the one per-env service cache and the Request normalization that each
 * host used to re-derive. `operations` is the default transport the accounts
 * deploy-control facade calls (the wired OpenTofu controller, with no Bearer
 * handshake and no JSON round-trip); `fetch` dispatches the same per-env cached
 * service's `app.fetch` and is kept only as a transport fallback.
 */
export function createInProcessDeployControlSeam(env: CloudflareWorkerEnv): {
  readonly fetch: typeof fetch;
  readonly operations: () => Promise<TakosumiOperations>;
} {
  const service = () => cachedDeployControlService(env);
  const inProcessFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const created = await service();
    const request =
      input instanceof Request && init === undefined
        ? input
        : new Request(input as RequestInfo | URL, init);
    return await created.app.fetch(request);
  };
  return {
    fetch: inProcessFetch as typeof fetch,
    operations: async () => (await service()).operations,
  };
}

const inProcessDeployControlServices = new WeakMap<
  CloudflareWorkerEnv,
  Promise<CreatedTakosumiService>
>();

export function cachedDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  let service = inProcessDeployControlServices.get(env);
  if (!service) {
    service = createDeployControlService(env);
    inProcessDeployControlServices.set(env, service);
  }
  return service;
}

const runOwnerDeployControlServices = new WeakMap<
  CloudflareWorkerEnv,
  Promise<CreatedTakosumiService>
>();

export function cachedRunOwnerDeployControlService(
  env: CloudflareWorkerEnv,
): Promise<CreatedTakosumiService> {
  let service = runOwnerDeployControlServices.get(env);
  if (!service) {
    service = createRunOwnerDeployControlService(env);
    runOwnerDeployControlServices.set(env, service);
  }
  return service;
}
