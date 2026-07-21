/**
 * Which mounted API paths a host worker must serve from this app at the edge.
 *
 * A host worker (the operator platform worker, the Takos distribution worker)
 * has to route a request before any service exists, so it cannot ask the Hono
 * router. It therefore needs a *static* answer — and the previous static answer
 * was a hand-written prefix list living in the worker, four entries long, with
 * no link to the route modules. Every route added since then
 * (`/v1/form-availability`, the whole `forms.takoform.com/v1alpha1` facade)
 * was mounted, advertised by discovery, called by the dashboard and the CLI,
 * and answered by the account plane's 404 or by the SPA's index.html.
 *
 * So the answer is derived here, from the same {@link ROUTE_FAMILIES}
 * inventory the routes are mounted from:
 *
 *  - every family must be classified — {@link EDGE_EXPOSURE_BY_FAMILY} is a
 *    total `Record<RouteFamilyId, ...>`, so adding a family without deciding
 *    its edge exposure is a type error;
 *  - the matcher is generated from each endpoint's declared path, so a new
 *    endpoint in an exposed family is reachable the moment it is mounted;
 *  - `tests/core/api/edge_public_paths_test.ts` walks the real router and
 *    fails if any mounted path is unclassified, which is the drift this file
 *    exists to make impossible.
 */

import { isInternalV1Path } from "takosumi-contract/api-surface";
import {
  type ApiEndpoint,
  ROUTE_FAMILIES,
  type RouteFamilyId,
} from "./route_families.ts";
import { TAKOFORM_FORM_HOST_WELL_KNOWN_PATH } from "takosumi-contract";

/**
 * `session` — the host routes it through its authenticated ingress seam.
 * `public` — unauthenticated by contract (portable discovery); the host routes
 * it straight through with caller credentials stripped.
 * `off` — never edge-routed: internal seams, operator-bearer surfaces, and
 * process endpoints the host answers itself.
 */
export type EdgeExposure = "session" | "public" | "off";

const EDGE_EXPOSURE_BY_FAMILY: Record<RouteFamilyId, EdgeExposure> = {
  openapi: "off",
  readiness: "off",
  // `/internal/v1/*` by construction; the host reaches it in process.
  "deployControl-internal": "off",
  metrics: "off",
  // The Resource Shape API and the portable Form host facade it mounts.
  "resource-shape": "session",
  // Operator-bearer surface; deliberately not reachable through the public
  // session seam, which injects the deploy-control bearer.
  "form-activations": "off",
  interfaces: "session",
};

const EDGE_EXPOSURE_OVERRIDES: Readonly<Record<string, EdgeExposure>> = {
  // Portable host discovery is unauthenticated by the Takoform contract: a
  // conformance runner reads it before it has any credential.
  [TAKOFORM_FORM_HOST_WELL_KNOWN_PATH]: "public",
};

interface EdgePathRule {
  readonly prefix: string;
  readonly exposure: EdgeExposure;
}

const EDGE_PATH_RULES: readonly EdgePathRule[] = buildEdgePathRules();

/** Exposure for a concrete request pathname, or `undefined` when not routed. */
export function edgeApiPathExposure(
  pathname: string,
): Exclude<EdgeExposure, "off"> | undefined {
  const path = normalizeEdgePath(pathname);
  for (const rule of EDGE_PATH_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}/`)) {
      return rule.exposure === "off" ? undefined : rule.exposure;
    }
  }
  return undefined;
}

/** Declared exposure for a mounted endpoint path (used by the parity test). */
export function edgeExposureForEndpointPath(path: string): EdgeExposure {
  const override = EDGE_EXPOSURE_OVERRIDES[normalizeEdgePath(path)];
  if (override) return override;
  for (const family of ROUTE_FAMILIES) {
    if (family.endpoints.some((endpoint) => endpoint.path === path)) {
      return EDGE_EXPOSURE_BY_FAMILY[family.id];
    }
  }
  // Internal seams are never edge-routed even when a family forgets to say so.
  if (isInternalV1Path(path)) return "off";
  throw new Error(`route path is not covered by any route family: ${path}`);
}

function buildEdgePathRules(): readonly EdgePathRule[] {
  const byPrefix = new Map<string, EdgeExposure>();
  for (const family of ROUTE_FAMILIES) {
    for (const endpoint of family.endpoints) {
      const exposure =
        EDGE_EXPOSURE_OVERRIDES[normalizeEdgePath(endpoint.path)] ??
        EDGE_EXPOSURE_BY_FAMILY[family.id];
      if (exposure === "off") continue;
      const prefix = staticPrefix(endpoint);
      const existing = byPrefix.get(prefix);
      if (existing && existing !== exposure) {
        // Two endpoints sharing a static prefix must agree, or the host would
        // silently pick one auth posture for both.
        throw new Error(
          `conflicting edge exposure for ${prefix}: ${existing} vs ${exposure}`,
        );
      }
      byPrefix.set(prefix, exposure);
    }
  }
  return [...byPrefix.entries()]
    .map(([prefix, exposure]) => ({ prefix, exposure }))
    // Longest prefix first so an overridden leaf wins over its parent.
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The leading literal segments of a Hono route path. Matching by prefix (rather
 * than by a per-route regex) keeps unknown sub-paths inside the owning app, so
 * a typo answers this app's 404 instead of leaking to the account plane.
 */
function staticPrefix(endpoint: ApiEndpoint): string {
  const segments: string[] = [];
  for (const segment of normalizeEdgePath(endpoint.path).split("/")) {
    if (segment.startsWith(":") || segment === "*") break;
    segments.push(segment);
  }
  return segments.join("/") || "/";
}

function normalizeEdgePath(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/u, "");
}
