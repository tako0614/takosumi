export const TAKOSUMI_CLOUDFLARE_FRONT_HEADER =
  "x-takosumi-cloudflare-front" as const;

const KERNEL_CONTROL_PLANE_EXACT_PATHS = new Set([
  "/health",
  "/capabilities",
  "/openapi.json",
  "/livez",
  "/readyz",
  "/status/summary",
  "/metrics",
]);

export function isKernelControlPlanePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  if (KERNEL_CONTROL_PLANE_EXACT_PATHS.has(normalized)) return true;
  return normalized === "/v1" ||
    normalized.startsWith("/v1/") ||
    normalized === "/api/internal/v1" ||
    normalized.startsWith("/api/internal/v1/");
}

export function createKernelWorkerRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.set(TAKOSUMI_CLOUDFLARE_FRONT_HEADER, "worker");
  return new Request(request, { headers });
}

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/g, "");
}
