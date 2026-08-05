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
import {
  LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
  type ResourceShapeSchemaRegistry,
} from "../../core/domains/resource-shape/mod.ts";
import type {
  InterfaceOAuth2ResourceAuthorizer,
  ResourceInterfaceWorkspaceResolver,
} from "../../core/domains/interfaces/mod.ts";
import { createWorkerServiceApp } from "./worker_service.ts";
import { createCloudflareD1OpenTofuControlStore } from "./d1_opentofu_store.ts";
import {
  TAKOSUMI_INTERNAL_MANAGED_PROVIDER_PROFILE_HEADER,
  TAKOSUMI_INTERNAL_MANAGED_PROVIDER_RUN_TOKEN_HEADER,
} from "./resource_capsule_owner_context.ts";
import {
  managedProviderRunTokenSecret,
  verifyManagedProviderRunToken,
} from "../../core/shared/managed_provider_tokens.ts";
import { ResourceCapsuleOwnerAuthorityError } from "../../core/api/form_host_routes.ts";

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
  readonly resourceShapeSchemaRegistry: ResourceShapeSchemaRegistry;
  readonly resolveResourceInterfaceWorkspace: ResourceInterfaceWorkspaceResolver;
  readonly resolveResourceCapsuleOwner: NonNullable<
    NonNullable<
      Parameters<typeof createWorkerServiceApp>[2]
    >["resolveResourceCapsuleOwner"]
  >;
  readonly hostRuntimeResourceLifecycle?: NonNullable<
    NonNullable<
      Parameters<typeof createWorkerServiceApp>[2]
    >["hostRuntimeResourceLifecycle"]
  >;
  readonly interfaceOAuth2ResourceAuthorizer?: InterfaceOAuth2ResourceAuthorizer;
  readonly mountInternalLedgerRoutes?: boolean;
} {
  const hostComposition = runnerHostCompositionFromEnv(env);
  const managedVanityHostnameSlotsPerOwner = nonNegativeInteger(
    env.TAKOSUMI_MANAGED_VANITY_HOST_SLOTS_PER_OWNER,
  );
  const interfaceOAuth2ResourceAuthorizer =
    interfaceOAuth2ResourceAuthorizerFromEnv(env);
  return {
    runnerProfiles: resolveEnabledRunnerProfilesFromEnv(env, hostComposition),
    // The shipped Takos/Takosumi host explicitly installs the frozen v1alpha1
    // compatibility schemas. Core and the generic Worker factory remain empty.
    resourceShapeSchemaRegistry:
      LEGACY_RESOURCE_SHAPE_COMPATIBILITY_SCHEMA_REGISTRY,
    resolveResourceInterfaceWorkspace:
      platformResourceInterfaceWorkspaceResolver(env),
    resolveResourceCapsuleOwner: platformResourceCapsuleOwnerResolver(env),
    ...(env.TAKOSUMI_HOST_RUNTIME_RESOURCE_LIFECYCLE
      ? {
          hostRuntimeResourceLifecycle:
            env.TAKOSUMI_HOST_RUNTIME_RESOURCE_LIFECYCLE,
        }
      : {}),
    ...(interfaceOAuth2ResourceAuthorizer
      ? { interfaceOAuth2ResourceAuthorizer }
      : {}),
    ...(env.LOCAL_SUBSTRATE_TEST_BED === "1" ||
    env.TAKOSUMI_EXPOSE_INTERNAL_EDGE === "1"
      ? { mountInternalLedgerRoutes: true }
      : {}),
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

function interfaceOAuth2ResourceAuthorizerFromEnv(
  env: CloudflareWorkerEnv,
): InterfaceOAuth2ResourceAuthorizer | undefined {
  const value = env.TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER;
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TypeError(
      "TAKOSUMI_INTERFACE_OAUTH2_RESOURCE_AUTHORIZER must be a host-code function",
    );
  }
  return value;
}

/**
 * The platform public Resource surface uses a verified Workspace id as its
 * portable namespace selector. Preserve Core's independent namespaces by
 * proving that the
 * candidate id exists in the canonical Workspace ledger before returning the
 * bridge; equal-looking strings alone are never authority.
 */
export function platformResourceInterfaceWorkspaceResolver(
  env: CloudflareWorkerEnv,
): ResourceInterfaceWorkspaceResolver {
  const workspaces = createCloudflareD1OpenTofuControlStore(
    env.TAKOSUMI_CONTROL_DB,
    {
      schemaMode: env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE ?? "bootstrap",
    },
  );
  return async ({ resourceSpaceId }) => {
    const workspace = await workspaces.getWorkspace(resourceSpaceId);
    return workspace?.id === resourceSpaceId ? workspace.id : undefined;
  };
}

/**
 * Resolve only the existing signed managed-provider run authority forwarded by
 * platform ingress. Core verifies it again and cross-checks the claims against
 * the internal Capsule ledger; a caller-supplied actor, Capsule id, profile, or
 * matching Workspace string alone never creates Capsule ownership.
 */
export function platformResourceCapsuleOwnerResolver(
  env: CloudflareWorkerEnv,
): NonNullable<
  NonNullable<
    Parameters<typeof createWorkerServiceApp>[2]
  >["resolveResourceCapsuleOwner"]
> {
  const store = createCloudflareD1OpenTofuControlStore(
    env.TAKOSUMI_CONTROL_DB,
    {
      schemaMode: env.TAKOSUMI_CONTROL_D1_SCHEMA_MODE ?? "bootstrap",
    },
  );
  return async ({ actor, request, space }) => {
    const token = request.headers.get(
      TAKOSUMI_INTERNAL_MANAGED_PROVIDER_RUN_TOKEN_HEADER,
    );
    const profile = request.headers
      .get(TAKOSUMI_INTERNAL_MANAGED_PROVIDER_PROFILE_HEADER)
      ?.trim();
    const secret = managedProviderRunTokenSecret(env);
    if (!token && !profile) {
      return undefined;
    }
    if (!token || !profile || profile.length > 256 || !secret) {
      throw new ResourceCapsuleOwnerAuthorityError();
    }
    const verified = await verifyManagedProviderRunToken(token, {
      secret,
      expectedAudience: profile,
      expectedWorkspaceId: space,
      requiredScopes: ["write"],
    });
    if (!verified.ok) throw new ResourceCapsuleOwnerAuthorityError();
    const context = verified.payload;
    if (
      !context.capsuleId ||
      !context.runId ||
      !context.installingPrincipalId ||
      (actor.workspaceId !== undefined &&
        actor.workspaceId !== context.workspaceId)
    ) {
      throw new ResourceCapsuleOwnerAuthorityError();
    }
    const pathname = new URL(request.url).pathname;
    const mutationNeedsApply =
      request.method === "PUT" || pathname.endsWith("/import");
    const mutationNeedsDestroy = request.method === "DELETE";
    if (
      (mutationNeedsApply && context.phase !== "apply") ||
      (mutationNeedsDestroy && context.phase !== "destroy") ||
      (!mutationNeedsApply &&
        !mutationNeedsDestroy &&
        context.phase !== "plan" &&
        context.phase !== "apply" &&
        context.phase !== "destroy")
    ) {
      throw new ResourceCapsuleOwnerAuthorityError();
    }
    let destroyLifecycleAuthority = false;
    if (context.phase === "plan") {
      const run = await store.getPlanRun(context.runId);
      if (
        !run ||
        run.status !== "running" ||
        run.workspaceId !== context.workspaceId ||
        run.capsuleId !== context.capsuleId
      ) {
        throw new ResourceCapsuleOwnerAuthorityError();
      }
      destroyLifecycleAuthority = run.operation === "destroy";
    } else {
      const run = await store.getApplyRun(context.runId);
      if (
        !run ||
        run.status !== "running" ||
        run.workspaceId !== context.workspaceId ||
        run.capsuleId !== context.capsuleId ||
        (run.operation === "destroy") !== (context.phase === "destroy")
      ) {
        throw new ResourceCapsuleOwnerAuthorityError();
      }
      destroyLifecycleAuthority = run.operation === "destroy";
    }
    const runtimeSafety = await store.getCapsuleRuntimeSafety(
      context.capsuleId,
    );
    if (
      runtimeSafety?.phase === "retired" ||
      (runtimeSafety?.phase === "terminating" && !destroyLifecycleAuthority)
    ) {
      throw new ResourceCapsuleOwnerAuthorityError();
    }
    const capsule = await store.getCapsule(context.capsuleId);
    if (
      !capsule ||
      capsule.workspaceId !== context.workspaceId ||
      capsule.installingPrincipalId !== context.installingPrincipalId ||
      capsule.status === "destroyed"
    ) {
      throw new ResourceCapsuleOwnerAuthorityError();
    }
    return {
      kind: "Capsule",
      id: capsule.id,
      workspaceId: capsule.workspaceId,
      installingPrincipalId: context.installingPrincipalId,
    };
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
