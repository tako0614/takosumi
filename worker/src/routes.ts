import {
  isInternalV1Path,
  PROCESS_OBSERVABILITY_PATHS,
} from "takosumi-contract/api-surface";

export const TAKOSUMI_CLOUDFLARE_FRONT_HEADER =
  "x-takosumi-cloudflare-front" as const;

/**
 * Always-on process / observability endpoints, served regardless of role:
 * the canonical probes (`/healthz` / `/readyz` / `/livez`) plus
 * capabilities/openapi/metrics from the prefix registry. The legacy `/health`
 * probe was dropped in the health-dedup stage. Everything else routed to the
 * service app is the unified `/internal/v1` seam — derived from
 * {@link isInternalV1Path} so this classifier never drifts from the contract
 * taxonomy.
 */
const SERVICE_CONTROL_PLANE_EXACT_PATHS = new Set<string>([
  ...PROCESS_OBSERVABILITY_PATHS,
]);

export function isServiceControlPlanePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (SERVICE_CONTROL_PLANE_EXACT_PATHS.has(normalized)) return true;
  return isInternalV1Path(normalized);
}

export function createServiceWorkerRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(TAKOSUMI_CLOUDFLARE_FRONT_HEADER, "worker");
  return new Request(request, { headers });
}

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/g, "");
}
