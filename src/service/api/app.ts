import { Hono, type Hono as HonoApp } from "hono";
import type { AppContext } from "../app_context.ts";
import { InMemoryRuntimeAgentRegistry } from "../agents/registry.ts";
import { createSpaceDomainServices } from "../domains/space/mod.ts";
import { assertRoleCapability, type TakosumiProcessRole } from "../process/mod.ts";
import { currentRuntime } from "../shared/runtime/index.ts";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import { registerApiErrorHandler } from "./errors.ts";
import {
  createTakosumiOpenApiDocument,
  type OpenApiDocument,
} from "./openapi.ts";
import {
  type InternalRouteServices,
  registerInternalRoutes,
} from "./internal_routes.ts";
import type { ReplayProtectionStore } from "../adapters/replay-protection/mod.ts";
import {
  type ReadinessRouteProbes,
  registerReadinessRoutes,
} from "./readiness_routes.ts";
import {
  registerRuntimeAgentRoutes,
  type RegisterRuntimeAgentRoutesOptions,
} from "./runtime_agent_routes.ts";
import {
  registerArtifactRoutes,
  type RegisterArtifactRoutesOptions,
} from "./artifact_routes.ts";
import {
  type DeployControlPublicRouteDependencies,
  mountDeployControlPublicRoutes,
} from "./deploy_control_public_routes.ts";
import {
  registerMetricsRoutes,
  type RegisterMetricsRoutesOptions,
} from "./metrics_routes.ts";
import {
  registerRequestCorrelation,
  type RegisterRequestCorrelationOptions,
} from "./request_correlation.ts";
import { DefaultGroupSummaryStatusProjector } from "../services/status/mod.ts";
import {
  ROUTE_FAMILIES,
  type RouteFamilyFlag,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

export interface CreateApiAppOptions {
  readonly role?: TakosumiProcessRole;
  readonly context?: AppContext;
  readonly internalRouteServices?: InternalRouteServices;
  readonly getInternalServiceSecret?: () => string | undefined;
  /**
   * Shared replay-protection store injected into the internal-RPC authenticator.
   * Omitting it falls back to a per-process in-memory store, which cannot defend
   * against cross-replica replay in multi-replica deployments.
   */
  readonly replayProtectionStore?: ReplayProtectionStore;
  readonly registerInternalRoutes?: boolean;
  readonly registerOpenApiRoute?: boolean;
  readonly registerReadinessRoutes?: boolean;
  readonly readinessRouteProbes?: ReadinessRouteProbes;
  readonly createOpenApiDocument?: () =>
    | OpenApiDocument
    | Promise<OpenApiDocument>;
  readonly registerRuntimeAgentRoutes?: boolean;
  readonly runtimeAgentRouteOptions?: RegisterRuntimeAgentRoutesOptions;
  readonly registerArtifactRoutes?: boolean;
  readonly artifactRouteOptions?: RegisterArtifactRoutesOptions;
  /** When set, mounts the v1 OpenTofu plan/apply/destroy public surface. */
  readonly registerDeployControlPublicRoutes?: boolean;
  readonly deployControlPublicRouteOptions?: DeployControlPublicRouteDependencies;
  readonly registerMetricsRoutes?: boolean;
  readonly metricsRouteOptions?: RegisterMetricsRoutesOptions;
  /**
   * HTTP request/correlation id propagation is mounted by default. Pass
   * `false` only for low-level route tests that need to exercise raw Hono
   * behavior without service middleware.
   */
  readonly requestCorrelation?: RegisterRequestCorrelationOptions | false;
  /** Optional extension point for mounting current/future route modules. */
  readonly configure?: (app: HonoApp) => void | Promise<void>;
}

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<HonoApp> {
  const role = options.role ?? "takosumi-api";
  assertRoleCapability(role, "api.health.read");
  assertRoleCapability(role, "api.capabilities.read");

  const app: HonoApp = new Hono();
  registerApiErrorHandler(app);
  if (options.requestCorrelation !== false) {
    registerRequestCorrelation(app, options.requestCorrelation ?? {});
  }
  const defaultRouteServices = createDefaultRouteServices(options);

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      service: "takosumi",
      domains: ["space", "deploy-control"],
    });
  });

  const mounted = resolveMountedRouteFamilies(role, options);
  const internalRoutesMounted = mounted.internalRoutesMounted;
  const runtimeAgentRoutesMounted = mounted.runtimeAgentRoutesMounted;
  const openApiRouteMounted = mounted.openApiRouteMounted;
  const readinessRoutesMounted = mounted.readinessRoutesMounted;
  const artifactRoutesMounted = mounted.artifactRoutesMounted;
  const deployControlPublicRoutesMounted =
    mounted.deployControlPublicRoutesMounted;
  const metricsRoutesMounted = mounted.metricsRoutesMounted;

  if (internalRoutesMounted) assertRoleCapability(role, "api.internal.host");
  if (runtimeAgentRoutesMounted) {
    assertRoleCapability(role, "runtime.agent.lease");
    assertRoleCapability(role, "runtime.agent.observe");
  }

  app.get("/capabilities", (c) => {
    return c.json(createApiCapabilitiesDescription(role, {
      internalRoutesMounted,
      deployControlPublicRoutesMounted,
      artifactRoutesMounted,
      runtimeAgentRoutesMounted,
      openApiRouteMounted,
      readinessRoutesMounted,
      metricsRoutesMounted,
    }));
  });

  if (internalRoutesMounted) {
    registerInternalRoutes(app, {
      services: options.internalRouteServices ??
        (await defaultRouteServices).internal,
      getInternalServiceSecret: options.getInternalServiceSecret,
      replayProtectionStore: options.replayProtectionStore,
    });
  }

  if (runtimeAgentRoutesMounted) {
    registerRuntimeAgentRoutes(app, createRuntimeAgentRouteOptions(options));
  }

  if (artifactRoutesMounted) {
    if (!options.artifactRouteOptions) {
      throw new Error(
        "registerArtifactRoutes was requested but artifactRouteOptions " +
          "(with objectStorage) was not supplied",
      );
    }
    registerArtifactRoutes(app, options.artifactRouteOptions);
  }

  if (deployControlPublicRoutesMounted) {
    mountDeployControlPublicRoutes(
      app,
      options.deployControlPublicRouteOptions ?? {},
    );
  }

  if (metricsRoutesMounted) {
    if (!options.metricsRouteOptions) {
      throw new Error(
        "registerMetricsRoutes was requested but metricsRouteOptions " +
          "(with observability) was not supplied",
      );
    }
    registerMetricsRoutes(app, options.metricsRouteOptions);
  }

  if (readinessRoutesMounted) {
    registerReadinessRoutes(app, {
      probes: options.readinessRouteProbes ?? createDefaultReadinessProbes(),
    });
  }

  if (openApiRouteMounted) {
    const createOpenApiDocument = options.createOpenApiDocument ??
      (() =>
        createTakosumiOpenApiDocument({
          internalRoutesMounted,
          deployControlPublicRoutesMounted,
          artifactRoutesMounted,
          runtimeAgentRoutesMounted,
          readinessRoutesMounted,
          metricsRoutesMounted,
          openApiRouteMounted,
        }));
    app.get(
      "/openapi.json",
      async (c) => c.json(await createOpenApiDocument()),
    );
  }

  await options.configure?.(app);

  return app;
}

/**
 * Per-family explicit `register<Family>` overrides plus the `hasOptions` probe
 * the default-on predicate consults. Keyed by the family flag so the registry
 * in {@link ROUTE_FAMILIES} stays the single enumeration of families.
 */
function routeFamilyMountInputs(
  options: CreateApiAppOptions,
): Record<
  RouteFamilyFlag,
  { readonly override: boolean | undefined; readonly hasOptions: boolean }
> {
  return {
    internalRoutesMounted: {
      override: options.registerInternalRoutes,
      hasOptions: options.internalRouteServices !== undefined,
    },
    runtimeAgentRoutesMounted: {
      override: options.registerRuntimeAgentRoutes,
      hasOptions: options.runtimeAgentRouteOptions !== undefined,
    },
    openApiRouteMounted: {
      override: options.registerOpenApiRoute,
      hasOptions: options.createOpenApiDocument !== undefined,
    },
    readinessRoutesMounted: {
      override: options.registerReadinessRoutes,
      hasOptions: options.readinessRouteProbes !== undefined,
    },
    artifactRoutesMounted: {
      override: options.registerArtifactRoutes,
      hasOptions: options.artifactRouteOptions !== undefined,
    },
    deployControlPublicRoutesMounted: {
      override: options.registerDeployControlPublicRoutes,
      hasOptions: options.deployControlPublicRouteOptions !== undefined,
    },
    metricsRoutesMounted: {
      override: options.registerMetricsRoutes,
      hasOptions: options.metricsRouteOptions !== undefined,
    },
  };
}

/**
 * Resolves the mounted-state of each optional route family by driving the
 * {@link ROUTE_FAMILIES} registry: an explicit `register<Family>` override wins,
 * otherwise the family's `defaultMounted` predicate decides.
 */
function resolveMountedRouteFamilies(
  role: TakosumiProcessRole,
  options: CreateApiAppOptions,
): RouteFamilyMountedFlags {
  const inputs = routeFamilyMountInputs(options);
  const flags = {} as Record<RouteFamilyFlag, boolean>;
  for (const family of ROUTE_FAMILIES) {
    const { override, hasOptions } = inputs[family.flag];
    flags[family.flag] = override ??
      family.defaultMounted({ role, hasOptions });
  }
  return flags;
}

async function createDefaultRouteServices(
  options: CreateApiAppOptions,
): Promise<{
  readonly internal: InternalRouteServices;
}> {
  const context = options.context;
  if (context) {
    return {
      internal: {
        space: context.services.space,
        entitlements: context.services.entitlements.policy,
      },
    };
  }
  const space = createSpaceDomainServices();
  return {
    internal: { space },
  };
}

function createRuntimeAgentRouteOptions(
  options: CreateApiAppOptions,
): RegisterRuntimeAgentRoutesOptions {
  if (options.runtimeAgentRouteOptions) {
    return {
      getInternalServiceSecret: options.getInternalServiceSecret ??
        defaultInternalServiceSecret,
      ...options.runtimeAgentRouteOptions,
    };
  }
  return {
    registry: options.context?.adapters.runtimeAgent ??
      new InMemoryRuntimeAgentRegistry(),
    getInternalServiceSecret: options.getInternalServiceSecret ??
      defaultInternalServiceSecret,
  };
}

function defaultInternalServiceSecret(): string | undefined {
  return currentRuntime().env.get("TAKOSUMI_INTERNAL_API_SECRET");
}

function createDefaultReadinessProbes(): ReadinessRouteProbes {
  const projector = new DefaultGroupSummaryStatusProjector();
  return {
    ready: () => ({
      ok: true,
      service: "takosumi",
      checkedAt: new Date().toISOString(),
    }),
    live: () => ({
      ok: true,
      service: "takosumi",
      checkedAt: new Date().toISOString(),
    }),
    statusSummary: () =>
      projector.project({
        spaceId: "system",
        groupId: "takosumi",
      }),
  };
}
