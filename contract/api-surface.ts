/**
 * Single source of truth for the Takosumi HTTP path-prefix taxonomy.
 *
 * Historically the worker surface grew several overlapping prefix conventions
 * ("internal" was spelled `/v1`, `/api/internal/v1`, AND `/internal`; "v1"
 * named four unrelated namespaces) and the edge dispatchers hand-maintained
 * four parallel path classifiers that had to stay in lockstep. This module
 * defines the canonical taxonomy so every classifier derives from one place.
 *
 * Taxonomy:
 * - {@link API_V1_PREFIX}     ONE edge-public customer surface (deploy-control +
 *                             Capsule lifecycle). Auth resolves from an
 *                             account session or PAT. Operator bearer belongs
 *                             to host-internal seams, not this prefix.
 * - {@link INTERNAL_V1_PREFIX} ONE internal seam: the in-process deploy-control
 *                             ledger contract and OpenTofu Runner callbacks.
 *                             Never edge-public.
 * - {@link ACCOUNTS_IDENTITY_PREFIX} accounts identity/billing (OIDC issuer
 *                             session surface): `/v1/account`, `/v1/auth`,
 *                             `/v1/billing`, passkeys. Sibling to `/oauth`.
 * - {@link EXTERNAL_STANDARD_PREFIXES} external / standards-compliant surfaces
 *                             that MUST stay stable (OIDC, install link, webhooks).
 * - {@link HEALTH_PATHS}      process liveness/readiness probes.
 */

/** The single edge-public API surface. Versioned. */
export const API_V1_PREFIX = "/api/v1" as const;

/** The single internal seam prefix (in-process + container callbacks). */
export const INTERNAL_V1_PREFIX = "/internal/v1" as const;

/** Accounts identity/billing surface (OIDC issuer session API). */
export const ACCOUNTS_IDENTITY_PREFIX = "/v1" as const;

/**
 * External / standards-compliant prefixes that must not be renamed: the OIDC
 * authorization/discovery surface (`/oauth`, `/.well-known`) and inbound
 * webhooks (`/hooks`). (`/install` — the external install link — is a plain SPA
 * path: the dashboard client reads its query.)
 */
export const EXTERNAL_STANDARD_PREFIXES = [
  "/oauth",
  "/.well-known",
  "/hooks",
] as const;

/** Takosumi product discovery document used by providers and CLIs. */
export const TAKOSUMI_WELL_KNOWN_PATH = "/.well-known/takosumi" as const;

/** Public product capability document, distinct from process route inventory. */
export const TAKOSUMI_PRODUCT_CAPABILITIES_PATH =
  "/v1/capabilities" as const;

/** Process health/readiness/liveness probe paths (k8s/LB convention). */
export const HEALTH_PATHS = ["/healthz", "/readyz", "/livez"] as const;

/**
 * Process/observability exact paths that are always mounted regardless of
 * role: probes plus the capabilities/openapi/metrics endpoints.
 */
export const PROCESS_OBSERVABILITY_PATHS = [
  ...HEALTH_PATHS,
  TAKOSUMI_WELL_KNOWN_PATH,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  "/metrics",
  "/capabilities",
  "/openapi.json",
] as const;

function normalizePathname(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/g, "");
}

/** True for the prefix itself or any path nested under it. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  const path = normalizePathname(pathname);
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** True for the edge-public `/api/v1` surface. */
export function isApiV1Path(pathname: string): boolean {
  return matchesPrefix(pathname, API_V1_PREFIX);
}

/** True for the internal `/internal/v1` seam (never edge-public). */
export function isInternalV1Path(pathname: string): boolean {
  return matchesPrefix(pathname, INTERNAL_V1_PREFIX);
}

/**
 * True for the accounts identity/billing surface. Note `/v1/account` etc. is a
 * strict subset of `/v1`; callers that also handle `/api/v1` must test that
 * first (it is NOT under `/v1`).
 */
export function isAccountsIdentityPath(pathname: string): boolean {
  return matchesPrefix(pathname, ACCOUNTS_IDENTITY_PREFIX);
}

/** True for an external/standard prefix (OIDC, install link, webhooks). */
export function isExternalStandardPath(pathname: string): boolean {
  return EXTERNAL_STANDARD_PREFIXES.some((prefix) =>
    matchesPrefix(pathname, prefix),
  );
}

/** True for a process health/readiness/liveness probe path. */
export function isHealthPath(pathname: string): boolean {
  return HEALTH_PATHS.some((path) => normalizePathname(pathname) === path);
}
