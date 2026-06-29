// Generic, config-driven Cloud extension seam (Seam A) for the OSS platform
// worker.
//
// The OSS platform worker exposes a single additive HTTP seam that the closed
// Takosumi Cloud delta can compose ON TOP of: for a configured base path, the
// worker verifies the platform session and dispatches the request to a named
// logical fetch-handler key on env. The OSS worker stays Cloud-feature-agnostic — it never names
// a Cloud feature (no AI Gateway, no Cloudflare compatibility, no managed
// resource enum). Which paths exist, which handler key each dispatches to, and which
// scopes they require, and any operator-supplied fallback metering rules are
// supplied entirely by the operator/Cloud via the `TAKOSUMI_CLOUD_EXTENSIONS`
// env var. When that env is empty or unset, every extension path 404s.
//
// Descriptors are intentionally generic: `{ basePath, handlerKey,
// requiredScopes?, fallbackUsage? }`. Large operator configs can split
// additional descriptors into `TAKOSUMI_CLOUD_EXTENSIONS_EXTRA`; descriptors
// with the same basePath/handlerKey are merged by concatenating fallbackUsage.
// The OSS seam records priced usage from the generic descriptor shape and
// treats a matching fallbackUsage rule as a preflight billing-context
// requirement, but never names a concrete Cloud feature.

export interface PlatformCloudExtensionRoute {
  /** Path prefix this descriptor matches (and dispatches to its handler). */
  readonly basePath: `/${string}`;
  /** Logical fetch handler key on `env` the matched request is dispatched to. */
  readonly handlerKey: string;
  /**
   * Optional scopes the authenticated caller must hold for this descriptor.
   * When omitted, any authenticated platform session may reach the binding.
   */
  readonly requiredScopes?: readonly string[];
  /**
   * Optional generic metering fallback for closed Cloud extensions that have not
   * yet emitted platform usage headers. The rule describes path/method matching
   * and customer-facing meter names. A request matching a rule must resolve a
   * verified Workspace billing context before the bound service is called. The
   * rule does not encode any provider-specific behavior in OSS code.
   */
  readonly fallbackUsage?: readonly PlatformCloudExtensionFallbackUsageRule[];
}

export interface PlatformCloudExtensionFallbackUsageRule {
  /** Path template relative to `basePath`; supports literal segments, `*`, and `:param`. */
  readonly pathTemplate: `/${string}`;
  /** HTTP methods this rule applies to. Omitted means every method. */
  readonly methods?: readonly string[];
  readonly meterIdPrefix: string;
  readonly resourceFamily?: string;
  readonly resourceIdPrefix?: string;
  readonly resourceIdParam?: string;
  readonly kind: string;
  readonly quantity: number;
  readonly operationByMethod?: Readonly<Record<string, string>>;
}

export const PLATFORM_CLOUD_EXTENSIONS_ENV = "TAKOSUMI_CLOUD_EXTENSIONS";
export const PLATFORM_CLOUD_EXTENSIONS_EXTRA_ENV =
  "TAKOSUMI_CLOUD_EXTENSIONS_EXTRA";

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
  readonly [PLATFORM_CLOUD_EXTENSIONS_EXTRA_ENV]?: unknown;
}): readonly PlatformCloudExtensionRoute[] {
  const primary = platformCloudExtensionRoutesFromRaw(
    env[PLATFORM_CLOUD_EXTENSIONS_ENV],
    PLATFORM_CLOUD_EXTENSIONS_ENV,
  );
  const extra = platformCloudExtensionRoutesFromRaw(
    env[PLATFORM_CLOUD_EXTENSIONS_EXTRA_ENV],
    PLATFORM_CLOUD_EXTENSIONS_EXTRA_ENV,
  );
  return mergePlatformCloudExtensionRoutes([...primary, ...extra]);
}

function platformCloudExtensionRoutesFromRaw(
  raw: unknown,
  envName: string,
): readonly PlatformCloudExtensionRoute[] {
  if (raw === undefined || raw === null || raw === "") return [];
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new TypeError(`${envName} must be valid JSON`, { cause: error });
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `${envName} must be a JSON array of extension descriptors`,
    );
  }
  return parsed.map((entry, index) =>
    platformCloudExtensionRouteFromJson(entry, index, envName),
  );
}

function platformCloudExtensionRouteFromJson(
  value: unknown,
  index: number,
  envName = PLATFORM_CLOUD_EXTENSIONS_ENV,
): PlatformCloudExtensionRoute {
  const label = `${envName}[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const basePath = record.basePath;
  if (typeof basePath !== "string" || !basePath.startsWith("/")) {
    throw new TypeError(`${label}.basePath must be a path starting with "/"`);
  }
  const handlerKey = record.handlerKey;
  if (typeof handlerKey !== "string" || handlerKey.trim() === "") {
    throw new TypeError(`${label}.handlerKey must be a non-empty string`);
  }
  const requiredScopes = platformCloudExtensionRequiredScopes(
    record.requiredScopes,
    label,
  );
  const fallbackUsage = platformCloudExtensionFallbackUsage(
    record.fallbackUsage,
    label,
  );
  return {
    basePath: basePath as `/${string}`,
    handlerKey,
    ...(requiredScopes ? { requiredScopes } : {}),
    ...(fallbackUsage ? { fallbackUsage } : {}),
  };
}

function mergePlatformCloudExtensionRoutes(
  routes: readonly PlatformCloudExtensionRoute[],
): readonly PlatformCloudExtensionRoute[] {
  const merged = new Map<string, PlatformCloudExtensionRoute>();
  for (const route of routes) {
    const key = [
      route.basePath,
      route.handlerKey,
      ...(route.requiredScopes ?? []),
    ].join("\0");
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, route);
      continue;
    }
    merged.set(key, {
      ...existing,
      fallbackUsage: [
        ...(existing.fallbackUsage ?? []),
        ...(route.fallbackUsage ?? []),
      ],
    });
  }
  return [...merged.values()];
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

function platformCloudExtensionFallbackUsage(
  value: unknown,
  label: string,
): readonly PlatformCloudExtensionFallbackUsageRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.fallbackUsage must be an array of objects`);
  }
  const rules = value.map((entry, index) =>
    platformCloudExtensionFallbackUsageRuleFromJson(
      entry,
      `${label}.fallbackUsage[${index}]`,
    ),
  );
  return rules.length > 0 ? rules : undefined;
}

function platformCloudExtensionFallbackUsageRuleFromJson(
  value: unknown,
  label: string,
): PlatformCloudExtensionFallbackUsageRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const pathTemplate = record.pathTemplate;
  if (
    typeof pathTemplate !== "string" ||
    !pathTemplate.startsWith("/") ||
    pathTemplate.includes("//")
  ) {
    throw new TypeError(
      `${label}.pathTemplate must be a path template starting with "/"`,
    );
  }
  const meterIdPrefix = nonEmptyString(record.meterIdPrefix);
  if (!meterIdPrefix) {
    throw new TypeError(`${label}.meterIdPrefix must be a non-empty string`);
  }
  const kind = nonEmptyString(record.kind);
  if (!kind) {
    throw new TypeError(`${label}.kind must be a non-empty string`);
  }
  const methods = platformCloudExtensionFallbackUsageMethods(
    record.methods,
    label,
  );
  const operationByMethod = platformCloudExtensionOperationByMethod(
    record.operationByMethod,
    label,
  );
  const quantity =
    typeof record.quantity === "number" &&
    Number.isFinite(record.quantity) &&
    record.quantity >= 0
      ? record.quantity
      : 1;
  return {
    pathTemplate: pathTemplate as `/${string}`,
    ...(methods ? { methods } : {}),
    meterIdPrefix,
    ...(nonEmptyString(record.resourceFamily)
      ? { resourceFamily: nonEmptyString(record.resourceFamily) }
      : {}),
    ...(typeof record.resourceIdPrefix === "string" &&
    record.resourceIdPrefix.length > 0
      ? { resourceIdPrefix: record.resourceIdPrefix }
      : {}),
    ...(nonEmptyString(record.resourceIdParam)
      ? { resourceIdParam: nonEmptyString(record.resourceIdParam) }
      : {}),
    kind,
    quantity,
    ...(operationByMethod ? { operationByMethod } : {}),
  };
}

function platformCloudExtensionFallbackUsageMethods(
  value: unknown,
  label: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.methods must be an array of strings`);
  }
  const methods = value.map((method) => {
    const normalized = nonEmptyString(method)?.toUpperCase();
    if (!normalized) {
      throw new TypeError(`${label}.methods entries must be non-empty strings`);
    }
    return normalized;
  });
  return methods.length > 0 ? methods : undefined;
}

function platformCloudExtensionOperationByMethod(
  value: unknown,
  label: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}.operationByMethod must be an object`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  for (const [method, operation] of entries) {
    const normalizedMethod = method.trim().toUpperCase();
    const normalizedOperation = nonEmptyString(operation);
    if (!normalizedMethod || !normalizedOperation) {
      throw new TypeError(
        `${label}.operationByMethod must map methods to non-empty strings`,
      );
    }
    normalized[normalizedMethod] = normalizedOperation;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
