import { Hono, type Context, type Hono as HonoApp } from "hono";
import type { TakosumiProcessRole } from "../process/mod.ts";
import { createApiCapabilitiesDescription } from "./capabilities.ts";
import {
  createTakosumiProductCapabilities,
  createTakosumiWellKnownDocument,
  type CreateTakosumiDiscoveryOptions,
  type TakosumiAdapterCapabilities,
  type TakosumiOperatorCapabilities,
  type TakosumiResourceCapabilities,
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
  type DeployControlInternalRouteDependencies,
  mountDeployControlInternalRoutes,
} from "./deploy_control_internal_routes.ts";
import {
  registerMetricsRoutes,
  type RegisterMetricsRoutesOptions,
} from "./metrics_routes.ts";
import {
  authorizeResourceShapeRequest,
  hasFormAvailabilityReadScope,
  type RegisterResourceShapeRoutesOptions,
  registerResourceShapeRoutes,
} from "./resource_routes.ts";
import {
  type RegisterInterfaceRoutesOptions,
  registerInterfaceRoutes,
} from "./interface_routes.ts";
import {
  type RegisterFormActivationRoutesOptions,
  registerFormActivationRoutes,
} from "./form_activation_routes.ts";
import {
  type RegisterOfferingCatalogRoutesOptions,
  registerOfferingCatalogRoutes,
} from "./offering_catalog_routes.ts";
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
  readonly registerOpenApiRoute?: boolean;
  readonly registerReadinessRoutes?: boolean;
  readonly readinessRouteProbes?: ReadinessRouteProbes;
  readonly createOpenApiDocument?: () =>
    OpenApiDocument | Promise<OpenApiDocument>;
  readonly getOpenApiBearerToken?: () => string | undefined;
  /** When set, mounts the v1 OpenTofu plan/apply/destroy internal seam. */
  readonly registerDeployControlInternalRoutes?: boolean;
  readonly deployControlInternalRouteOptions?: DeployControlInternalRouteDependencies;
  readonly registerMetricsRoutes?: boolean;
  readonly metricsRouteOptions?: RegisterMetricsRoutesOptions;
  /** When set, mounts the `/v1/resources` Resource Shape API (Flow B). */
  readonly registerResourceShapeRoutes?: boolean;
  readonly resourceShapeRouteOptions?: RegisterResourceShapeRoutesOptions;
  /** Operator-only generic noncommercial FormActivation lifecycle API. */
  readonly registerFormActivationRoutes?: boolean;
  readonly formActivationRouteOptions?: RegisterFormActivationRoutesOptions;
  /** Operator-only immutable generic noncommercial Offering catalog API. */
  readonly registerOfferingCatalogRoutes?: boolean;
  readonly offeringCatalogRouteOptions?: RegisterOfferingCatalogRoutesOptions;
  /** Takosumi-managed runtime declaration API shared by both authoring flows. */
  readonly registerInterfaceRoutes?: boolean;
  readonly interfaceRouteOptions?: RegisterInterfaceRoutesOptions;
  readonly resourceCapabilities?: Partial<TakosumiResourceCapabilities>;
  readonly adapterCapabilities?: Partial<TakosumiAdapterCapabilities>;
  readonly operatorCapabilities?: Partial<TakosumiOperatorCapabilities>;
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
  const openApiRouteMounted = mounted.openApiRouteMounted;
  const readinessRoutesMounted = mounted.readinessRoutesMounted;
  const deployControlInternalRoutesMounted =
    mounted.deployControlInternalRoutesMounted;
  const metricsRoutesMounted = mounted.metricsRoutesMounted;
  const resourceShapeRoutesMounted = mounted.resourceShapeRoutesMounted;
  const formActivationRoutesMounted = mounted.formActivationRoutesMounted;
  const offeringCatalogRoutesMounted = mounted.offeringCatalogRoutesMounted;
  const interfaceRoutesMounted = mounted.interfaceRoutesMounted;

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
          resourceCapabilities: options.resourceCapabilities,
          enabledResourceShapeKinds:
            options.resourceShapeRouteOptions?.enabledResourceShapeKinds,
          adapterCapabilities: options.adapterCapabilities,
          operatorCapabilities: options.operatorCapabilities,
        }),
      ),
    );
  });

  app.get(TAKOSUMI_PRODUCT_CAPABILITIES_PATH, async (c) => {
    let formAvailability;
    const space = c.req.query("space")?.trim();
    if (space && options.resourceShapeRouteOptions) {
      const auth = await authorizeResourceShapeRequest(
        c,
        options.resourceShapeRouteOptions,
      );
      if (!auth.ok) return auth.response;
      if (!hasFormAvailabilityReadScope(auth.actor)) {
        return c.json(
          apiError(
            "permission_denied",
            "form availability requires forms:read or resources:read scope",
            undefined,
            requestIdFromContext(c),
          ),
          403,
        );
      }
      formAvailability = (
        await options.resourceShapeRouteOptions.service.listFormAvailability({
          actor: auth.actor,
          space,
        })
      ).items;
    }
    return c.json(
      createTakosumiProductCapabilities(
        createProductDiscoveryOptions({
          origin: new URL(c.req.url).origin,
          mounted,
          resourceCapabilities: options.resourceCapabilities,
          enabledResourceShapeKinds:
            options.resourceShapeRouteOptions?.enabledResourceShapeKinds,
          adapterCapabilities: options.adapterCapabilities,
          operatorCapabilities: options.operatorCapabilities,
          formAvailability,
        }),
      ),
    );
  });

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

  if (formActivationRoutesMounted) {
    if (!options.formActivationRouteOptions) {
      throw new Error(
        "registerFormActivationRoutes was requested but " +
          "formActivationRouteOptions (with service and operator bearer) was not supplied",
      );
    }
    registerFormActivationRoutes(app, options.formActivationRouteOptions);
  }

  if (offeringCatalogRoutesMounted) {
    if (!options.offeringCatalogRouteOptions) {
      throw new Error(
        "registerOfferingCatalogRoutes was requested but " +
          "offeringCatalogRouteOptions was not supplied",
      );
    }
    registerOfferingCatalogRoutes(app, options.offeringCatalogRouteOptions);
  }

  if (interfaceRoutesMounted) {
    if (!options.interfaceRouteOptions) {
      throw new Error(
        "registerInterfaceRoutes was requested but " +
          "interfaceRouteOptions (with service) was not supplied",
      );
    }
    registerInterfaceRoutes(app, options.interfaceRouteOptions);
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
    openApiRouteMounted: {
      override: options.registerOpenApiRoute,
      hasOptions: options.createOpenApiDocument !== undefined,
    },
    readinessRoutesMounted: {
      override: options.registerReadinessRoutes,
      hasOptions: options.readinessRouteProbes !== undefined,
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
    formActivationRoutesMounted: {
      override: options.registerFormActivationRoutes,
      hasOptions: options.formActivationRouteOptions !== undefined,
    },
    offeringCatalogRoutesMounted: {
      override: options.registerOfferingCatalogRoutes,
      hasOptions: options.offeringCatalogRouteOptions !== undefined,
    },
    interfaceRoutesMounted: {
      override: options.registerInterfaceRoutes,
      hasOptions: options.interfaceRouteOptions !== undefined,
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
  readonly resourceCapabilities?: Partial<TakosumiResourceCapabilities>;
  readonly enabledResourceShapeKinds?: readonly string[];
  readonly adapterCapabilities?: Partial<TakosumiAdapterCapabilities>;
  readonly operatorCapabilities?: Partial<TakosumiOperatorCapabilities>;
  readonly formAvailability?: readonly import("takosumi-contract").FormAvailability[];
}): CreateTakosumiDiscoveryOptions {
  const resourceShapes = input.mounted.resourceShapeRoutesMounted;
  const stacks = input.mounted.deployControlInternalRoutesMounted;
  const resources: Partial<TakosumiResourceCapabilities> = {
    Stack: stacks,
    ...Object.fromEntries(
      (input.enabledResourceShapeKinds ?? []).map((kind) => [
        kind,
        resourceShapes,
      ]),
    ),
    ...(input.resourceCapabilities ?? {}),
  };
  const adapters: Partial<TakosumiAdapterCapabilities> = {
    opentofu: stacks || resourceShapes,
    ...(input.adapterCapabilities ?? {}),
  };
  return {
    origin: input.origin,
    resources,
    adapters,
    ...(input.operatorCapabilities
      ? { operator: input.operatorCapabilities }
      : {}),
    resourceShapesEnabled:
      input.resourceCapabilities === undefined
        ? resourceShapes
        : resourceShapeCapabilitiesEnabled(resources),
    interfacesEnabled: input.mounted.interfaceRoutesMounted,
    ...(input.formAvailability !== undefined
      ? { formAvailability: input.formAvailability }
      : {}),
  };
}

function resourceShapeCapabilitiesEnabled(
  resources: Partial<TakosumiResourceCapabilities>,
): boolean {
  return Object.entries(resources).some(
    ([token, enabled]) => token !== "Stack" && enabled === true,
  );
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
