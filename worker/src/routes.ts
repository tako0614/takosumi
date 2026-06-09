export const TAKOSUMI_CLOUDFLARE_FRONT_HEADER =
  "x-takosumi-cloudflare-front" as const;

const SERVICE_CONTROL_PLANE_EXACT_PATHS = new Set([
  "/health",
  "/capabilities",
  "/openapi.json",
  "/livez",
  "/readyz",
  "/metrics",
]);

export function isServiceControlPlanePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (SERVICE_CONTROL_PLANE_EXACT_PATHS.has(normalized)) return true;
  return (
    normalized === "/api/internal/v1" ||
    normalized.startsWith("/api/internal/v1/") ||
    normalized === "/v1/runner-profiles" ||
    normalized === "/v1/plan-runs" ||
    normalized.startsWith("/v1/plan-runs/") ||
    normalized === "/v1/apply-runs" ||
    normalized.startsWith("/v1/apply-runs/") ||
    /^\/v1\/installations\/(?:ins|inst)_[0-9A-Za-z]+(?:$|\/(?:deployments|deployment-outputs)$)/.test(
      normalized,
    )
  );
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
