import type { TakosumiProcessRole } from "../process/mod.ts";
import {
  isInternalV1Path,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "takosumi-contract/api-surface";
import { DEPLOY_CONTROL_INTERNAL_ENDPOINTS } from "./deploy_control_internal_routes.ts";
import { ARTIFACT_ENDPOINTS } from "./artifact_routes.ts";
import { RUNTIME_AGENT_ENDPOINTS } from "./runtime_agent_routes.ts";
import { READINESS_ENDPOINTS } from "./readiness_routes.ts";
import { METRICS_ENDPOINTS } from "./metrics_routes.ts";
import { OPENAPI_ENDPOINTS } from "./openapi_endpoint.ts";
import { RESOURCE_SHAPE_ENDPOINTS } from "./resource_routes.ts";

/**
 * Single source of truth for the API route inventory mounted by
 * {@link createApiApp}. The previous code enumerated the same endpoints three
 * times — once for the `mounted` flags + per-endpoint summaries surfaced by
 * `/capabilities` (`capabilities.ts`), once for the OpenAPI document paths
 * (`openapi.ts`), and once as the concrete `app.get/post` mount calls — which
 * let `/capabilities` and `/openapi.json` drift apart (e.g. deployment-outputs
 * and `/v1/artifacts/kinds` were missing from one or both, summaries diverged,
 * and capabilities invented a `metrics-token` auth value OpenAPI never used)
 * and made adding an endpoint a multi-file edit.
 *
 * Each {@link RouteFamilyDescriptor} now carries an `endpoints` list of
 * {@link ApiEndpoint} descriptors co-located with the family's route module.
 * `capabilities.ts` and `openapi.ts` both derive their published inventory from
 * these descriptors after filtering out host-internal seams, so the customer-safe
 * process inventory can no longer drift apart.
 *
 * `app.ts` still owns the concrete mount calls and per-family option
 * validation/ordering (those are behaviorally sensitive and intentionally kept
 * explicit); this table collapses the parallel enumerations of *which*
 * families/endpoints exist and *when* they are on by default.
 */
export interface RouteFamilyMountInput {
  readonly role: TakosumiProcessRole;
  /** Whether the caller supplied the family's route options object. */
  readonly hasOptions: boolean;
}

/**
 * Unified auth vocabulary shared by capabilities + OpenAPI. The previous code
 * had two divergent enums (capabilities invented `metrics-token`; OpenAPI used
 * the `metrics-scrape` `x-takos-auth` value). This is the single canonical set.
 */
export type ApiEndpointAuth =
  | "none"
  | "internal-service"
  | "inventory-bearer"
  | "deploy-token"
  | "artifact-read"
  | "deploy-control-token"
  | "metrics-scrape";

export type ApiEndpointMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

/**
 * OpenAPI-specific wiring for an endpoint. Lives next to the shared fields so
 * the OpenAPI document and capabilities never enumerate endpoints separately.
 */
export interface ApiEndpointOpenApi {
  /** Response schema component name for the success status. */
  readonly okSchema: string;
  readonly okStatus?: "200" | "201" | "202" | "204";
  /** Request body schema component name (`application/json`). */
  readonly requestSchema?: string;
  /** Explicit request body object (e.g. multipart upload). */
  readonly requestBody?: Record<string, unknown>;
  readonly query?: readonly string[];
  readonly pathParams?: readonly string[];
  /**
   * Fully custom OpenAPI operation. When present the derived builder uses it
   * verbatim instead of synthesizing one from the fields above (used by the
   * Prometheus `/metrics` exposition endpoint which has a non-JSON response).
   */
  readonly customOperation?: Record<string, unknown>;
}

export interface ApiEndpoint {
  readonly method: ApiEndpointMethod;
  /** Hono-style route path (uses `:param` for path parameters). */
  readonly path: string;
  readonly summary: string;
  readonly auth: ApiEndpointAuth;
  readonly operationId: string;
  /**
   * Compatibility/RPC routes can be mounted without being advertised through
   * `/capabilities` or `/openapi.json`. All `/internal/v1/*` routes are also
   * suppressed from published inventory regardless of this flag.
   */
  readonly discoverable?: boolean;
  /** Primary OpenAPI tag for the endpoint (defaults to the family `id`). */
  readonly tag?: string;
  readonly openapi: ApiEndpointOpenApi;
}

export interface RouteFamilyDescriptor {
  /** Stable family identifier (matches the OpenAPI primary tag). */
  readonly id: RouteFamilyId;
  /**
   * Key used both in the capabilities `mounted` flags and in the OpenAPI
   * `CreateTakosumiOpenApiDocumentOptions`. The string is `${id}Mounted`-ish
   * but kept explicit to match the existing option names exactly.
   */
  readonly flag: RouteFamilyFlag;
  /** OpenAPI tags contributed when this family is mounted. */
  readonly openapiTags: readonly string[];
  /** Default-on predicate when no explicit `register<Family>` override is set. */
  readonly defaultMounted: (input: RouteFamilyMountInput) => boolean;
  /** Endpoints contributed when this family is mounted. */
  readonly endpoints: readonly ApiEndpoint[];
}

export type RouteFamilyId =
  | "runtime-agent"
  | "openapi"
  | "readiness"
  | "artifact"
  | "deployControl-internal"
  | "metrics"
  | "resource-shape";

export type RouteFamilyFlag =
  | "runtimeAgentRoutesMounted"
  | "openApiRouteMounted"
  | "readinessRoutesMounted"
  | "artifactRoutesMounted"
  | "deployControlInternalRoutesMounted"
  | "metricsRoutesMounted"
  | "resourceShapeRoutesMounted";

export type RouteFamilyMountedFlags = Record<RouteFamilyFlag, boolean>;

/**
 * Endpoints that are always mounted regardless of family flags
 * (`/capabilities`). Tagged `process`; surfaced by both capabilities + OpenAPI.
 * Liveness probes (`/healthz` / `/readyz` / `/livez`) are worker-level concerns
 * (`HEALTH_PATHS` in `takosumi-contract/api-surface`), handled by the host
 * worker shells, not the in-process API app.
 */
export const ALWAYS_MOUNTED_ENDPOINTS: readonly ApiEndpoint[] = [
  {
    method: "GET",
    path: TAKOSUMI_WELL_KNOWN_PATH,
    summary:
      "Returns Takosumi product discovery metadata for providers and CLIs.",
    auth: "none",
    operationId: "getTakosumiDiscovery",
    tag: "process",
    openapi: { okSchema: "TakosumiWellKnownResponse" },
  },
  {
    method: "GET",
    path: TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
    summary:
      "Returns product capabilities for stacks, resource shapes, adapters, compatibility profiles, identity, and commercial features.",
    auth: "none",
    operationId: "getTakosumiProductCapabilities",
    tag: "process",
    openapi: { okSchema: "TakosumiProductCapabilitiesResponse" },
  },
  {
    method: "GET",
    path: "/capabilities",
    summary:
      "Describes the current process role, declared capabilities, and route guards.",
    auth: "inventory-bearer",
    operationId: "getCapabilities",
    tag: "process",
    openapi: { okSchema: "CapabilitiesResponse" },
  },
] as const;

/**
 * The optional route families, in the same order they are computed/mounted in
 * `app.ts`. Order is not load-bearing for the flag/tag derivations but is kept
 * stable for readability.
 */
export const ROUTE_FAMILIES: readonly RouteFamilyDescriptor[] = [
  {
    id: "runtime-agent",
    flag: "runtimeAgentRoutesMounted",
    openapiTags: ["runtime-agent"],
    defaultMounted: ({ role }) => role === "takosumi-runtime-agent",
    endpoints: RUNTIME_AGENT_ENDPOINTS,
  },
  {
    id: "openapi",
    flag: "openApiRouteMounted",
    openapiTags: ["openapi"],
    defaultMounted: ({ role }) => role === "takosumi-api",
    endpoints: OPENAPI_ENDPOINTS,
  },
  {
    id: "readiness",
    flag: "readinessRoutesMounted",
    openapiTags: ["readiness", "status"],
    defaultMounted: () => false,
    endpoints: READINESS_ENDPOINTS,
  },
  {
    id: "artifact",
    flag: "artifactRoutesMounted",
    openapiTags: ["artifact"],
    defaultMounted: ({ role, hasOptions }) =>
      role === "takosumi-api" && hasOptions,
    endpoints: ARTIFACT_ENDPOINTS,
  },
  {
    id: "deployControl-internal",
    flag: "deployControlInternalRoutesMounted",
    openapiTags: ["deployControl-internal"],
    defaultMounted: ({ role }) => role === "takosumi-api",
    endpoints: DEPLOY_CONTROL_INTERNAL_ENDPOINTS,
  },
  {
    id: "metrics",
    flag: "metricsRoutesMounted",
    openapiTags: ["metrics"],
    defaultMounted: ({ role, hasOptions }) =>
      role === "takosumi-api" && hasOptions,
    endpoints: METRICS_ENDPOINTS,
  },
  {
    id: "resource-shape",
    flag: "resourceShapeRoutesMounted",
    openapiTags: ["resource-shape"],
    defaultMounted: ({ role, hasOptions }) =>
      role === "takosumi-api" && hasOptions,
    endpoints: RESOURCE_SHAPE_ENDPOINTS,
  },
] as const;

/** OpenAPI tags that are always present regardless of mounted families. */
export const ALWAYS_MOUNTED_OPENAPI_TAGS: readonly string[] = ["process"];

/**
 * Derives the OpenAPI `mountedTags` set from the per-family flags using
 * {@link ROUTE_FAMILIES} as the single source of which tags each family owns.
 */
export function mountedOpenApiTags(
  flags: Partial<RouteFamilyMountedFlags>,
): Set<string> {
  const tags = new Set<string>(ALWAYS_MOUNTED_OPENAPI_TAGS);
  for (const family of ROUTE_FAMILIES) {
    if (
      flags[family.flag] &&
      family.endpoints.some(isPublishedInventoryEndpoint)
    ) {
      for (const tag of family.openapiTags) tags.add(tag);
    }
  }
  return tags;
}

/**
 * Returns the endpoints for the families whose flag is set, prefixed by the
 * always-mounted endpoints. Single source consumed by both `capabilities.ts`
 * and `openapi.ts`.
 */
export function mountedEndpoints(
  flags: Partial<RouteFamilyMountedFlags>,
): readonly ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [
    ...ALWAYS_MOUNTED_ENDPOINTS.filter(isPublishedInventoryEndpoint),
  ];
  for (const family of ROUTE_FAMILIES) {
    if (flags[family.flag]) {
      endpoints.push(...family.endpoints.filter(isPublishedInventoryEndpoint));
    }
  }
  return endpoints;
}

/** The OpenAPI primary tag for an endpoint (defaults to its family `id`). */
export function endpointTag(endpoint: ApiEndpoint, familyId: string): string {
  return endpoint.tag ?? familyId;
}

function isPublishedInventoryEndpoint(endpoint: ApiEndpoint): boolean {
  return endpoint.discoverable !== false && !isInternalV1Path(endpoint.path);
}
