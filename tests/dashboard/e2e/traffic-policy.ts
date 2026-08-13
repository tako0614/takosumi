export type DashboardE2EMode = "portable" | "live" | "public-live";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

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

/**
 * Responses owned by the hosted Worker must carry the exact immutable
 * Version identity supplied to the live run. The authenticated live profile
 * scopes evidence to top-level documents and control/API responses; the
 * public-live profile intentionally expands that fence to the whole official
 * origin.
 */
export function requiresLiveWorkerVersionHeader(
  mode: DashboardE2EMode,
  origin: string,
  urlValue: string,
  resourceType: string,
): boolean {
  if (mode !== "live" && mode !== "public-live") return false;
  const url = parseHttpUrl(urlValue);
  if (!url || !isSameOrigin(url, origin)) return false;
  // The public profile is intentionally a whole-origin read-only probe. It
  // cannot rely on a session or a fixture, so every response served by the
  // official origin is evidence for the exact published Worker Version.
  if (mode === "public-live") return true;
  if (resourceType === "document") return true;
  return (
    url.pathname.startsWith("/api/v1/") ||
    url.pathname === "/.well-known/openid-configuration" ||
    url.pathname === "/oauth/jwks" ||
    url.pathname === "/healthz" ||
    url.pathname === "/readyz"
  );
}

/** Return a fail-closed diagnostic for a missing or substituted Version id. */
export function workerVersionHeaderFailure(input: {
  readonly mode: DashboardE2EMode;
  readonly origin: string;
  readonly url: string;
  readonly resourceType: string;
  readonly expectedWorkerVersionId: string;
  readonly observedWorkerVersionId: string | null | undefined;
}): string | undefined {
  if (
    !requiresLiveWorkerVersionHeader(
      input.mode,
      input.origin,
      input.url,
      input.resourceType,
    )
  ) {
    return undefined;
  }
  const observed = input.observedWorkerVersionId?.trim() || "<missing>";
  if (observed === input.expectedWorkerVersionId) return undefined;
  return `expected x-takosumi-version-id ${input.expectedWorkerVersionId}, observed ${observed}`;
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
    pathname.startsWith("/api/v1/workspaces/")
  );
}

function isControlPlanePath(pathname: string): boolean {
  return (
    pathname === "/api/v1" ||
    pathname.startsWith("/api/v1/") ||
    pathname === "/v1" ||
    pathname.startsWith("/v1/")
  );
}

/**
 * Record only mutating requests that could change the dashboard control
 * plane. External telemetry (for example Cloudflare Browser Insights' RUM
 * POST) and Store/provider requests are intentionally outside this fence.
 */
export function shouldRecordControlPlaneMutation(
  mode: DashboardE2EMode,
  origin: string,
  urlValue: string,
  method: string,
): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false;
  const url = parseHttpUrl(urlValue);
  if (!url || !isSameOrigin(url, origin)) return false;
  // Keep portable and live collection scoped to the configured dashboard
  // origin. In live mode this is app-staging.takosumi.com; the fixture uses
  // the local origin while preserving the same path fence.
  if (mode !== "portable" && origin.trim() === "") return false;
  return isControlPlanePath(url.pathname);
}

/**
 * Whether a response status is an actionable browser-check failure.
 *
 * Portable mode owns every same-origin API/asset response. Live mode keeps
 * optional capability probes compatible while treating the required dashboard
 * routes as authoritative; public-live owns every same-origin response.
 */
export function shouldRecordResponseFailure(
  mode: DashboardE2EMode,
  origin: string,
  urlValue: string,
  status: number,
): boolean {
  if (mode === "public-live" && status >= 300) {
    const url = parseHttpUrl(urlValue);
    // The signed-out SPA intentionally probes this protected endpoint and
    // must receive 401 before it falls back to the public session mirror.
    if (
      status === 401 &&
      url !== undefined &&
      isSameOrigin(url, origin) &&
      url.pathname === "/api/v1/dashboard/bootstrap"
    ) {
      return false;
    }
    return url !== undefined && isSameOrigin(url, origin);
  }
  if (status < 400) return false;
  const url = parseHttpUrl(urlValue);
  if (!url) return false;
  if (mode === "live" && status >= 500) return true;
  if (!isSameOrigin(url, origin)) return false;
  if (mode === "portable") return isPortableMonitoredPath(url.pathname);
  if (mode === "public-live") return true;
  return status < 500 && isRequiredLivePath(url.pathname);
}

/**
 * Request failures are fatal for real HTTP(S) requests in either mode.
 * Browser-internal/data URLs are ignored because they are not network probes.
 */
export function shouldRecordRequestFailure(urlValue: string): boolean {
  return parseHttpUrl(urlValue) !== undefined;
}
