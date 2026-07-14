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
 * probe was dropped in the health-dedup stage. The unified `/internal/v1` seam
 * is classified separately so the host can keep it edge-closed by default and
 * open it only for local-substrate/private probe ingress.
 */
const SERVICE_CONTROL_PLANE_EXACT_PATHS = new Set<string>([
  ...PROCESS_OBSERVABILITY_PATHS,
]);

export function isServiceControlPlanePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return SERVICE_CONTROL_PLANE_EXACT_PATHS.has(normalized);
}

export function isInternalControlPlanePath(pathname: string): boolean {
  return isInternalV1Path(normalizePathname(pathname));
}

export function isInterfaceApiPath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/v1/interfaces" ||
    normalized.startsWith("/v1/interfaces/");
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
