// Generic, config-driven Cloud extension seam (Seam A) for the OSS platform
// worker.
//
// The OSS platform worker exposes a single additive HTTP seam that the closed
// Takosumi Cloud delta can compose ON TOP of: for a configured base path, the
// worker verifies the platform session and proxies the request to a named
// service binding. The OSS worker stays Cloud-feature-agnostic — it never names
// a Cloud feature (no AI Gateway, no Cloudflare compatibility, no managed
// resource enum). Which paths exist, which binding each proxies to, and which
// scopes they require are supplied entirely by the operator/Cloud via the
// `TAKOSUMI_CLOUD_EXTENSIONS` env var. When that env is empty or unset, every
// extension path 404s.
//
// Descriptors are intentionally opaque: `{ basePath, bindingName, requiredScopes? }`.

export interface PlatformCloudExtensionRoute {
  /** Path prefix this descriptor matches (and proxies to its binding). */
  readonly basePath: `/${string}`;
  /** Name of the service binding on `env` the matched request is proxied to. */
  readonly bindingName: string;
  /**
   * Optional scopes the authenticated caller must hold for this descriptor.
   * When omitted, any authenticated platform session may reach the binding.
   */
  readonly requiredScopes?: readonly string[];
}

export const PLATFORM_CLOUD_EXTENSIONS_ENV = "TAKOSUMI_CLOUD_EXTENSIONS";

export const PLATFORM_CLOUD_EXTENSION_CATALOG_PATH =
  "/__takosumi/cloud/extensions" as const;

/**
 * Parse the operator/Cloud-supplied extension descriptors from `env`. Returns an
 * empty list when the env is unset/empty (every extension path then 404s). A
 * malformed value throws a `TypeError` so misconfiguration fails loudly instead
 * of silently dropping a configured extension.
 */
export function platformCloudExtensionRoutes(env: {
  readonly [PLATFORM_CLOUD_EXTENSIONS_ENV]?: unknown;
}): readonly PlatformCloudExtensionRoute[] {
  const raw = env[PLATFORM_CLOUD_EXTENSIONS_ENV];
  if (raw === undefined || raw === null || raw === "") return [];
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new TypeError(
        `${PLATFORM_CLOUD_EXTENSIONS_ENV} must be valid JSON`,
        { cause: error },
      );
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `${PLATFORM_CLOUD_EXTENSIONS_ENV} must be a JSON array of extension descriptors`,
    );
  }
  return parsed.map(platformCloudExtensionRouteFromJson);
}

function platformCloudExtensionRouteFromJson(
  value: unknown,
  index: number,
): PlatformCloudExtensionRoute {
  const label = `${PLATFORM_CLOUD_EXTENSIONS_ENV}[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const basePath = record.basePath;
  if (typeof basePath !== "string" || !basePath.startsWith("/")) {
    throw new TypeError(`${label}.basePath must be a path starting with "/"`);
  }
  const bindingName = record.bindingName;
  if (typeof bindingName !== "string" || bindingName.trim() === "") {
    throw new TypeError(`${label}.bindingName must be a non-empty string`);
  }
  const requiredScopes = platformCloudExtensionRequiredScopes(
    record.requiredScopes,
    label,
  );
  return {
    basePath: basePath as `/${string}`,
    bindingName,
    ...(requiredScopes ? { requiredScopes } : {}),
  };
}

function platformCloudExtensionRequiredScopes(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.requiredScopes must be an array of strings`);
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== "string" || scope.trim() === "") {
      throw new TypeError(
        `${label}.requiredScopes entries must be non-empty strings`,
      );
    }
    return scope.trim();
  });
  return scopes.length > 0 ? scopes : undefined;
}

export function matchPlatformCloudExtensionRoute(
  pathname: string,
  routes: readonly PlatformCloudExtensionRoute[],
): PlatformCloudExtensionRoute | undefined {
  return routes.find((route) => pathIsUnderBase(pathname, route.basePath));
}

export function isPlatformCloudExtensionCatalogPath(pathname: string): boolean {
  return pathname === PLATFORM_CLOUD_EXTENSION_CATALOG_PATH;
}

export function pathIsUnderBase(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}
