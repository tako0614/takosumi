import { Hono, type Context, type Hono as HonoApp } from "hono";
import type { AppContext } from "../app_context.ts";
import { InMemoryRuntimeAgentRegistry } from "../agents/registry.ts";
import type { TakosumiProcessRole } from "../process/mod.ts";
import { currentRuntime } from "../shared/runtime/index.ts";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  type CreateTakosumiDiscoveryOptions,
} from "takosumi-contract/capabilities";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "takosumi-contract/api-surface";
import { registerApiErrorHandler } from "./errors.ts";
import {
  createTakosumiOpenApiDocument,
  type OpenApiDocument,
} from "./openapi.ts";
import { apiError, requestIdFromContext } from "./errors.ts";
import { constantTimeEqualsString } from "../shared/constant_time.ts";
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
  type DeployControlInternalRouteDependencies,
  mountDeployControlInternalRoutes,
} from "./deploy_control_internal_routes.ts";
import {
  registerMetricsRoutes,
  type RegisterMetricsRoutesOptions,
} from "./metrics_routes.ts";
import {
  type RegisterResourceShapeRoutesOptions,
  registerResourceShapeRoutes,
} from "./resource_routes.ts";
import {
  registerRequestCorrelation,
  type RegisterRequestCorrelationOptions,
} from "./request_correlation.ts";
import {
  ROUTE_FAMILIES,
  type RouteFamilyFlag,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

export interface CreateApiAppOptions {
  readonly role?: TakosumiProcessRole;
  readonly context?: AppContext;
  readonly getInternalServiceSecret?: () => string | undefined;
  readonly registerOpenApiRoute?: boolean;
  readonly registerReadinessRoutes?: boolean;
  readonly readinessRouteProbes?: ReadinessRouteProbes;
  readonly createOpenApiDocument?: () =>
    OpenApiDocument | Promise<OpenApiDocument>;
  readonly getOpenApiBearerToken?: () => string | undefined;
  readonly registerRuntimeAgentRoutes?: boolean;
  readonly runtimeAgentRouteOptions?: RegisterRuntimeAgentRoutesOptions;
  readonly registerArtifactRoutes?: boolean;
  readonly artifactRouteOptions?: RegisterArtifactRoutesOptions;
  /** When set, mounts the v1 OpenTofu plan/apply/destroy internal seam. */
  readonly registerDeployControlInternalRoutes?: boolean;
  readonly deployControlInternalRouteOptions?: DeployControlInternalRouteDependencies;
  readonly registerMetricsRoutes?: boolean;
  readonly metricsRouteOptions?: RegisterMetricsRoutesOptions;
  /** When set, mounts the `/v1/resources` Resource Shape API (Flow B). */
  readonly registerResourceShapeRoutes?: boolean;
  readonly resourceShapeRouteOptions?: RegisterResourceShapeRoutesOptions;
  /**
   * HTTP request/correlation id propagation is mounted by default. Pass
   * `false` only for low-level route tests that need to exercise raw Hono
   * behavior without service middleware.
   */
  readonly requestCorrelation?: RegisterRequestCorrelationOptions | false;
}

export async function createApiApp(
  options: CreateApiAppOptions = {},
): Promise<HonoApp> {
  const role = options.role ?? "takosumi-api";

  const app: HonoApp = new Hono();
  registerApiErrorHandler(app);
  if (options.requestCorrelation !== false) {
    registerRequestCorrelation(app, options.requestCorrelation ?? {});
  }

  const mounted = resolveMountedRouteFamilies(role, options);
  const runtimeAgentRoutesMounted = mounted.runtimeAgentRoutesMounted;
  const openApiRouteMounted = mounted.openApiRouteMounted;
  const readinessRoutesMounted = mounted.readinessRoutesMounted;
  const artifactRoutesMounted = mounted.artifactRoutesMounted;
  const deployControlInternalRoutesMounted =
    mounted.deployControlInternalRoutesMounted;
  const metricsRoutesMounted = mounted.metricsRoutesMounted;
  const resourceShapeRoutesMounted = mounted.resourceShapeRoutesMounted;

  app.get("/capabilities", (c) => {
    const guard = authorizeInventoryRoute(c, options, "capabilities");
    if (guard) return guard;
    return c.json(createApiCapabilitiesDescription(role, mounted));
  });

  app.get(TAKOSUMI_WELL_KNOWN_PATH, (c) => {
    return c.json(
      createTakosumiWellKnownDocument(
        createProductDiscoveryOptions({
          origin: new URL(c.req.url).origin,
          mounted,
        }),
      ),
    );
  });

  app.get(TAKOSUMI_PRODUCT_CAPABILITIES_PATH, (c) => {
    return c.json(
      createTakosumiProductCapabilities(
        createProductDiscoveryOptions({
          origin: new URL(c.req.url).origin,
          mounted,
        }),
      ),
    );
  });

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

  if (deployControlInternalRoutesMounted) {
    mountDeployControlInternalRoutes(
      app,
      options.deployControlInternalRouteOptions ?? {},
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

  if (resourceShapeRoutesMounted) {
    if (!options.resourceShapeRouteOptions) {
      throw new Error(
        "registerResourceShapeRoutes was requested but " +
          "resourceShapeRouteOptions (with service) was not supplied",
      );
    }
    registerResourceShapeRoutes(app, options.resourceShapeRouteOptions);
  }

  if (readinessRoutesMounted) {
    registerReadinessRoutes(app, {
      probes: options.readinessRouteProbes ?? createDefaultReadinessProbes(),
    });
  }

  if (openApiRouteMounted) {
    const createOpenApiDocument =
      options.createOpenApiDocument ??
      (() => createTakosumiOpenApiDocument(mounted));
    app.get("/openapi.json", async (c) => {
      const guard = authorizeInventoryRoute(c, options, "openapi");
      if (guard) return guard;
      return c.json(await createOpenApiDocument());
    });
  }

  return app;
}

function authorizeInventoryRoute(
  c: Context,
  options: CreateApiAppOptions,
  surface: "capabilities" | "openapi",
): Response | undefined {
  const expected = options.getOpenApiBearerToken?.();
  if (!expected) {
    return c.json(
      apiError(
        "not_found",
        `${surface} inventory disabled`,
        undefined,
        requestIdFromContext(c),
      ),
      404,
    );
  }
  const presented = bearerTokenFromAuthorization(
    c.req.header("authorization") ?? "",
  );
  if (!presented || !constantTimeEqualsString(presented, expected)) {
    return c.json(
      apiError(
        "unauthenticated",
        `invalid ${surface} bearer`,
        undefined,
        requestIdFromContext(c),
      ),
      401,
    );
  }
  return undefined;
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
    deployControlInternalRoutesMounted: {
      override: options.registerDeployControlInternalRoutes,
      hasOptions: options.deployControlInternalRouteOptions !== undefined,
    },
    metricsRoutesMounted: {
      override: options.registerMetricsRoutes,
      hasOptions: options.metricsRouteOptions !== undefined,
    },
    resourceShapeRoutesMounted: {
      override: options.registerResourceShapeRoutes,
      hasOptions: options.resourceShapeRouteOptions !== undefined,
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
    flags[family.flag] =
      override ?? family.defaultMounted({ role, hasOptions });
  }
  return flags;
}

function createProductDiscoveryOptions(input: {
  readonly origin: string;
  readonly mounted: RouteFamilyMountedFlags;
}): CreateTakosumiDiscoveryOptions {
  const resourceShapes = input.mounted.resourceShapeRoutesMounted;
  const stacks = input.mounted.deployControlInternalRoutesMounted;
  return {
    origin: input.origin,
    resources: {
      Stack: stacks,
      EdgeWorker: resourceShapes,
      AIEndpoint: resourceShapes,
    },
    adapters: {
      opentofu: stacks || resourceShapes,
      aws: resourceShapes,
      cloudflare: resourceShapes,
      kubernetes: resourceShapes,
      vm: resourceShapes,
      takosumi_native: resourceShapes,
      ai_provider: resourceShapes,
    },
    resourceShapesEnabled: resourceShapes,
  };
}

function createRuntimeAgentRouteOptions(
  options: CreateApiAppOptions,
): RegisterRuntimeAgentRoutesOptions {
  if (options.runtimeAgentRouteOptions) {
    return {
      getInternalServiceSecret:
        options.getInternalServiceSecret ?? defaultInternalServiceSecret,
      ...options.runtimeAgentRouteOptions,
    };
  }
  return {
    registry:
      options.context?.adapters.runtimeAgent ??
      new InMemoryRuntimeAgentRegistry(),
    getInternalServiceSecret:
      options.getInternalServiceSecret ?? defaultInternalServiceSecret,
  };
}

function defaultInternalServiceSecret(): string | undefined {
  return currentRuntime().env.get("TAKOSUMI_INTERNAL_API_SECRET");
}

function bearerTokenFromAuthorization(header: string): string | undefined {
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (!scheme || scheme.toLowerCase() !== "bearer") return undefined;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : undefined;
}

function createDefaultReadinessProbes(): ReadinessRouteProbes {
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
  };
}
