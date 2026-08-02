export type DashboardE2EMode = "portable" | "live";

function parseHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function isSameOrigin(url: URL, origin: string): boolean {
  try {
    return url.origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function isPortableMonitoredPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname.startsWith("/apis/") ||
    pathname === "/.well-known/takosumi" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/brand/") ||
    pathname === "/tako.png"
  );
}

function isRequiredLivePath(pathname: string): boolean {
  return (
    pathname === "/api/v1/dashboard/bootstrap" ||
    pathname === "/api/v1/workspaces" ||
    pathname.startsWith("/api/v1/workspaces/") ||
    pathname === "/v1/resources" ||
    pathname.startsWith("/v1/resources/") ||
    pathname === "/v1/cloud/s3-access-keys" ||
    pathname.startsWith("/v1/cloud/s3-access-keys/")
  );
}

/**
 * Whether a response status is an actionable browser-check failure.
 *
 * Portable mode owns every same-origin API/asset response. Live mode keeps
 * optional capability probes compatible while treating the required dashboard
 * routes as authoritative; any HTTP 5xx remains fatal in live mode.
 */
export function shouldRecordResponseFailure(
  mode: DashboardE2EMode,
  origin: string,
  urlValue: string,
  status: number,
): boolean {
  if (status < 400) return false;
  const url = parseHttpUrl(urlValue);
  if (!url) return false;
  if (mode === "live" && status >= 500) return true;
  if (!isSameOrigin(url, origin)) return false;
  if (mode === "portable") return isPortableMonitoredPath(url.pathname);
  return status < 500 && isRequiredLivePath(url.pathname);
}

/**
 * Request failures are fatal for real HTTP(S) requests in either mode.
 * Browser-internal/data URLs are ignored because they are not network probes.
 */
export function shouldRecordRequestFailure(urlValue: string): boolean {
  return parseHttpUrl(urlValue) !== undefined;
}
