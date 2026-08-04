import {
  isAccountsIdentityPath,
  isApiV1Path,
  isExternalStandardPath,
  isInternalV1Path,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "takosumi-contract/api-surface";
import {
  matchPlatformExtensionRoute,
  platformExtensionRoutes,
  type PlatformExtensionRoute,
} from "./platform_extensions.ts";

/** The public surfaces that are proven not to read account or control data. */
export type PlatformDataFreeSurface =
  | "product-discovery"
  | "identity-discovery"
  | "presence-probe"
  | "dashboard-asset"
  | "dashboard-document";

/**
 * A request classification for a host composition's admission/fence layer.
 *
 * The stateful branch intentionally has no more detailed reason. A caller may
 * use the data-free branch to skip a data-plane admission check, but it must
 * treat every other request as requiring that check.
 */
export type PlatformRequestDataAccess =
  | {
      readonly kind: "data-free";
      readonly surface: PlatformDataFreeSurface;
    }
  | {
      readonly kind: "stateful";
      readonly targets: readonly PlatformDataTarget[];
    }
  | { readonly kind: "stateful-or-unknown" };

export type PlatformDataTarget = "accounts" | "control";

/**
 * The only environment values consulted by the classifier. This is a routing
 * port, not a Cloudflare/D1 environment type: the platform worker supplies
 * these existing bindings/configuration values, while other host wrappers can
 * satisfy the same shape without importing a provider-specific contract.
 */
export interface PlatformRoutingEnv {
  /** Existing Static Assets binding used for the dashboard build. */
  readonly ASSETS?: unknown;
  /** Existing JSON extension-route composition input. */
  readonly TAKOSUMI_PLATFORM_EXTENSIONS?: unknown;
}

/**
 * Explicit dashboard document routes. The dashboard's wildcard NotFound route
 * is deliberately not included: an unknown path must remain stateful/unknown
 * at the host admission boundary. Server-owned `/oauth/*` routes are likewise
 * intentionally absent.
 *
 * Keep this list in lockstep with `dashboard/src/index.tsx`; the focused route
 * test reads that source and fails when a concrete SPA route is added without a
 * corresponding admission decision.
 */
export const DASHBOARD_DOCUMENT_ROUTES = [
  "/",
  "/sign-in",
  "/sign-in/callback",
  "/legal/:page",
  "/support",
  "/signup",
  "/login",
  "/settings",
  "/settings/account",
  "/settings/billing",
  "/settings/manage",
  "/workloads",
  "/new",
  "/install",
  "/composition/install",
  "/connections",
  "/workloads/:id",
  "/workloads/:id/:tab",
  "/runs",
  "/runs/:id",
  "/run-groups/:id",
  "/graph",
  "/resources",
  "/resources/:kind/:name",
  "/activity",
  "/notifications",
  "/advanced/workspace",
  "/advanced/workspace/:tab",
  "/workspace/settings",
  "/workspace/settings/:tab",
  "/account",
  "/billing",
  "/store",
  "/home",
  "/apps",
  "/apps/:id",
  "/apps/:id/:tab",
  "/services",
  "/services/:id",
  "/services/:id/:tab",
  "/capsules",
  "/capsules/:id",
  "/capsules/:id/:tab",
  "/members",
  "/backups",
  "/output-shares",
  "/sources",
  "/providers",
  "/account/settings",
  "/account/billing",
  "/account/profile",
  "/account/sessions",
] as const;

/**
 * Public files copied from `dashboard/public`. These are exact paths rather
 * than a broad static prefix. Vite's generated files are admitted separately
 * by the strict hashed-output grammar below.
 */
export const DASHBOARD_PUBLIC_ASSET_PATHS = [
  "/docs",
  "/index.html",
  "/assets/theme-init.js",
  "/brand/computer.svg",
  "/brand/git.svg",
  "/brand/office.svg",
  "/brand/storage.svg",
  "/brand/takos.svg",
  "/brand/yurucommu.svg",
  "/brand/yurumeet.svg",
  "/llms.txt",
  "/robots.txt",
  "/tako.png",
  // Cloudflare's static-assets profile historically treated this path as an
  // asset request even when the public build does not ship a favicon file.
  "/favicon.ico",
] as const;

/**
 * Static namespaces whose complete contents are produced by the dashboard
 * build. `/docs/` is the VitePress tree copied into `dashboard/dist`; no
 * account or control handler owns a route below this prefix.
 */
export const DASHBOARD_STATIC_ASSET_PREFIXES = ["/docs/"] as const;

/**
 * Vite output names are content-hashed and contain one eight-character URL
 * safe digest immediately before the extension. Keep the grammar narrow so a
 * missing/unknown `/assets/*` path cannot be mistaken for a data-free file.
 */
export const DASHBOARD_HASHED_ASSET_REQUEST_PATTERN =
  /^\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*-[A-Za-z0-9_-]{8}\.(?:css|js|json|map|svg|ico|png|jpe?g|webp|gif|woff2?|ttf|otf)$/u;

const DATA_FREE_PRODUCT_DISCOVERY_PATHS = new Set<string>([
  TAKOSUMI_WELL_KNOWN_PATH,
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
]);

const DATA_FREE_IDENTITY_DISCOVERY_PATHS = new Set<string>([
  "/.well-known/openid-configuration",
  "/oauth/jwks",
  "/v1/auth/providers",
]);

const ACCOUNTS_ONLY_READ_PATHS = new Set<string>([
  "/v1/account/session/me",
]);

const DATA_FREE_PRESENCE_PROBE_PATHS = new Set<string>(["/healthz", "/readyz"]);

const STATEFUL_RESERVED_PREFIXES = [
  "/api",
  "/internal",
  "/__takosumi",
  "/.well-known",
  "/oauth",
  "/hooks",
  "/compat",
  "/metrics",
  "/capabilities",
  "/openapi.json",
  "/v1",
  "/apis/forms.takoform.com/v1alpha1",
] as const;

const STATEFUL_RESERVED_EXACT_PATHS = new Set<string>([
  "/livez",
  "/healthz/",
  "/readyz/",
]);

const STATEFUL_UNKNOWN: PlatformRequestDataAccess = Object.freeze({
  kind: "stateful-or-unknown",
});

const DATA_FREE_ASSET: PlatformRequestDataAccess = Object.freeze({
  kind: "data-free",
  surface: "dashboard-asset",
});

const DATA_FREE_DOCUMENT: PlatformRequestDataAccess = Object.freeze({
  kind: "data-free",
  surface: "dashboard-document",
});

const DATA_FREE_DISCOVERY: PlatformRequestDataAccess = Object.freeze({
  kind: "data-free",
  surface: "product-discovery",
});

const DATA_FREE_PROBE: PlatformRequestDataAccess = Object.freeze({
  kind: "data-free",
  surface: "presence-probe",
});

const ACCOUNTS_ONLY: PlatformRequestDataAccess = Object.freeze({
  kind: "stateful",
  targets: Object.freeze(["accounts"] as const),
});

/**
 * Classify a public Platform request before any account/control data access.
 *
 * The classifier is intentionally synchronous and provider-neutral. It only
 * admits exact, known public discovery/probe routes, exact dashboard public
 * files, Vite's hashed output names, and concrete routes in the dashboard SPA
 * registry. Methods, encoded paths, malformed extension configuration, absent
 * asset bindings, reserved server routes, and every unknown are fail-closed.
 */
export function classifyPlatformRequestDataAccess(
  request: Request,
  env: PlatformRoutingEnv,
): PlatformRequestDataAccess {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return STATEFUL_UNKNOWN;
    }

    // URL.pathname intentionally preserves percent escapes. Rejecting an
    // escape in the pathname (rather than in the whole URL) keeps harmless
    // encoded query values from changing an exact public route's decision.
    const pathname = new URL(request.url).pathname;
    if (pathname.includes("%")) return STATEFUL_UNKNOWN;

    // Extension configuration is evaluated first. A configured route is an
    // authority decision and must never be shadowed by a future public-route
    // addition; malformed descriptors fail closed through the catch below.
    if (classifyConfiguredExtension(pathname, env)) {
      return STATEFUL_UNKNOWN;
    }

    const discovery = classifyExactDiscovery(pathname);
    if (discovery) return discovery;

    if (ACCOUNTS_ONLY_READ_PATHS.has(pathname)) return ACCOUNTS_ONLY;

    if (isReservedPlatformPath(pathname)) return STATEFUL_UNKNOWN;

    if (!hasStaticAssetsBinding(env.ASSETS)) return STATEFUL_UNKNOWN;

    if (isDashboardAssetRequestPath(pathname)) return DATA_FREE_ASSET;
    if (isDashboardDocumentPath(pathname)) return DATA_FREE_DOCUMENT;
    return STATEFUL_UNKNOWN;
  } catch {
    // A malformed Request/URL or extension descriptor is never evidence that
    // a request is data-free.
    return STATEFUL_UNKNOWN;
  }
}

/** Return whether a path is an exact public dashboard asset request. */
export function isDashboardAssetRequestPath(pathname: string): boolean {
  return (
    (DASHBOARD_PUBLIC_ASSET_PATHS as readonly string[]).includes(pathname) ||
    DASHBOARD_STATIC_ASSET_PREFIXES.some((prefix) =>
      pathname.startsWith(prefix),
    ) ||
    DASHBOARD_HASHED_ASSET_REQUEST_PATTERN.test(pathname)
  );
}

/** Return whether a canonical path matches one explicit dashboard route. */
export function isDashboardDocumentPath(pathname: string): boolean {
  return DASHBOARD_DOCUMENT_ROUTES.some((route) =>
    dashboardRouteMatches(pathname, route),
  );
}

function classifyExactDiscovery(
  pathname: string,
): PlatformRequestDataAccess | undefined {
  if (DATA_FREE_PRODUCT_DISCOVERY_PATHS.has(pathname)) {
    return DATA_FREE_DISCOVERY;
  }
  if (DATA_FREE_IDENTITY_DISCOVERY_PATHS.has(pathname)) {
    return { kind: "data-free", surface: "identity-discovery" };
  }
  if (DATA_FREE_PRESENCE_PROBE_PATHS.has(pathname)) {
    return DATA_FREE_PROBE;
  }
  return undefined;
}

function isReservedPlatformPath(pathname: string): boolean {
  if (STATEFUL_RESERVED_EXACT_PATHS.has(pathname)) return true;
  // Keep the canonical taxonomy in the decision even though the broader
  // reserved prefixes below defend future/unknown siblings as well.
  if (
    isApiV1Path(pathname) ||
    isAccountsIdentityPath(pathname) ||
    isInternalV1Path(pathname) ||
    isExternalStandardPath(pathname)
  ) {
    return true;
  }
  return STATEFUL_RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function classifyConfiguredExtension(
  pathname: string,
  env: PlatformRoutingEnv,
): PlatformExtensionRoute | undefined {
  // A malformed or conflicting extension descriptor throws. Let that error
  // reach the caller's fail-closed catch rather than silently ignoring it.
  const routes = platformExtensionRoutes(
    env as PlatformRoutingEnv & { readonly [key: string]: unknown },
  );
  return matchPlatformExtensionRoute(pathname, routes);
}

function hasStaticAssetsBinding(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly fetch?: unknown }).fetch === "function"
  );
}

function dashboardRouteMatches(pathname: string, route: string): boolean {
  if (route === pathname) return true;
  const routeSegments = route.slice(1).split("/");
  const pathSegments = pathname.slice(1).split("/");
  if (routeSegments.length !== pathSegments.length) return false;
  return routeSegments.every((segment, index) => {
    if (segment.startsWith(":")) {
      const value = pathSegments[index];
      return value !== undefined && value.length > 0;
    }
    return segment === pathSegments[index];
  });
}
