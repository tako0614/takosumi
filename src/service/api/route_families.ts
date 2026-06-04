import type { TakosumiProcessRole } from "../process/mod.ts";

/**
 * Single source of truth for the optional API route families mounted by
 * {@link createApiApp}. The previous code enumerated the same ~7 families three
 * times — once for the mount-guard defaults in `app.ts`, once for the
 * `mounted` flags surfaced by `/capabilities` (`capabilities.ts`), and once for
 * the OpenAPI family filter (`openapi.ts`) — which let `/capabilities` and
 * `/openapi.json` drift apart and made adding a family a multi-file edit.
 *
 * Each descriptor owns the family `id`, the boolean `flag` key shared across
 * capabilities + OpenAPI options, the OpenAPI `tags` it contributes, and the
 * `defaultMounted` predicate that decides whether the family is mounted when
 * the caller does not pass an explicit `register<Family>` override.
 *
 * `app.ts` still owns the concrete mount calls and per-family option
 * validation/ordering (those are behaviorally sensitive and intentionally kept
 * explicit); this table only collapses the three parallel enumerations of
 * *which* families exist and *when* they are on by default.
 */
export interface RouteFamilyMountInput {
  readonly role: TakosumiProcessRole;
  /** Whether the caller supplied the family's route options object. */
  readonly hasOptions: boolean;
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
}

export type RouteFamilyId =
  | "internal"
  | "runtime-agent"
  | "openapi"
  | "readiness"
  | "artifact"
  | "deployControl-public"
  | "metrics";

export type RouteFamilyFlag =
  | "internalRoutesMounted"
  | "runtimeAgentRoutesMounted"
  | "openApiRouteMounted"
  | "readinessRoutesMounted"
  | "artifactRoutesMounted"
  | "deployControlPublicRoutesMounted"
  | "metricsRoutesMounted";

export type RouteFamilyMountedFlags = Record<RouteFamilyFlag, boolean>;

/**
 * The optional route families, in the same order they are computed/mounted in
 * `app.ts`. Order is not load-bearing for the flag/tag derivations but is kept
 * stable for readability.
 */
export const ROUTE_FAMILIES: readonly RouteFamilyDescriptor[] = [
  {
    id: "internal",
    flag: "internalRoutesMounted",
    openapiTags: ["internal"],
    defaultMounted: ({ role }) => role === "takosumi-api",
  },
  {
    id: "runtime-agent",
    flag: "runtimeAgentRoutesMounted",
    openapiTags: ["runtime-agent"],
    defaultMounted: ({ role }) => role === "takosumi-runtime-agent",
  },
  {
    id: "openapi",
    flag: "openApiRouteMounted",
    openapiTags: ["openapi"],
    defaultMounted: ({ role }) => role === "takosumi-api",
  },
  {
    id: "readiness",
    flag: "readinessRoutesMounted",
    openapiTags: ["readiness", "status"],
    defaultMounted: () => false,
  },
  {
    id: "artifact",
    flag: "artifactRoutesMounted",
    openapiTags: ["artifact"],
    defaultMounted: ({ role, hasOptions }) =>
      role === "takosumi-api" && hasOptions,
  },
  {
    id: "deployControl-public",
    flag: "deployControlPublicRoutesMounted",
    openapiTags: ["deployControl-public"],
    defaultMounted: ({ role }) => role === "takosumi-api",
  },
  {
    id: "metrics",
    flag: "metricsRoutesMounted",
    openapiTags: ["metrics"],
    defaultMounted: ({ role, hasOptions }) =>
      role === "takosumi-api" && hasOptions,
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
    if (flags[family.flag]) {
      for (const tag of family.openapiTags) tags.add(tag);
    }
  }
  return tags;
}
