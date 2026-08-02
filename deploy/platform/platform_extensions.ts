// Provider-neutral HTTP extension seam for the OSS platform worker.
//
// Operators compose optional services by declaring a path, an env handler key,
// authentication ownership, required platform scopes, and public capability
// tokens. The OSS worker authenticates/authorizes the request and delegates it;
// pricing, metering, commercial policy, and provider-specific behavior belong to
// the extension implementation.

import {
  isTakosumiCompatibilityProfileToken,
  type TakosumiCompatibilityPlane,
} from "takosumi-contract/capabilities";
import {
  PLATFORM_EXTENSION_RESERVED_PREFIXES,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
} from "takosumi-contract/platform-extension-routes";

export interface PlatformCompatibilityProfile {
  /** Exact scoped, versioned capability token, for example `compat.s3.v1`. */
  readonly profile: `compat.${string}`;
  /** Explicit authority planes. Profiles that expose both list both values. */
  readonly planes: readonly TakosumiCompatibilityPlane[];
}

export interface PlatformExtensionRoute {
  /** Stable public catalog id. */
  readonly id?: string;
  /** Path prefix dispatched to the handler. */
  readonly basePath: `/${string}`;
  /** Logical fetch handler key on the platform env. */
  readonly handlerKey: string;
  /** `platform` is the default; `handler` preserves protocol credentials. */
  readonly authMode?: "platform" | "handler";
  /** Scopes required from platform token credentials. */
  readonly requiredScopes?: readonly string[];
  /** Exact method/path scope requirements relative to this basePath. */
  readonly requestScopeRules?: readonly PlatformExtensionRequestScopeRule[];
  /**
   * Binds a caller-supplied `workspaceId` query parameter to verified platform
   * access before dispatch. Optional mode preserves operator-wide reads when
   * the parameter is absent.
   */
  readonly workspaceContext?: "query-required" | "query-optional";
  /**
   * Exact opaque profile accepted for managed-provider run tokens. Omitted
   * routes reject that token class. It is never derived from basePath or host.
   */
  readonly managedProviderProfile?: string;
  /** Public capability tokens advertised by discovery. */
  readonly capabilities?: readonly string[];
  /**
   * Compatibility profiles mounted on this route. Presence switches dispatch
   * to the restricted compatibility handler contract; raw extension fetch is
   * never used for these profiles.
   */
  readonly compatibilityProfiles?: readonly PlatformCompatibilityProfile[];
  /** Safe dashboard links contributed by the extension. */
  readonly contributions?: readonly PlatformExtensionContribution[];
}

/** Exact HTTP method/path scope requirement for a platform extension request. */
export interface PlatformExtensionRequestScopeRule {
  /** Exact relative pathname, such as `/models` or `/chat/completions`. */
  readonly path: `/${string}`;
  /** Exact HTTP methods accepted by the rule. */
  readonly methods: readonly string[];
  /** Scopes required from platform token credentials for this request. */
  readonly requiredScopes: readonly string[];
}

export interface PlatformExtensionContribution {
  readonly id: string;
  /** Open dashboard slot token, such as `navigation.manage`. */
  readonly slot: string;
  /** Same-origin extension-owned destination under this route's basePath. */
  readonly href: `/${string}`;
  /**
   * `link` keeps the extension as a full-document destination. `inline-frame`
   * hosts an extension document inside the slot. `native` activates the
   * dashboard-owned renderer for that slot while `href` remains the
   * same-origin extension API base. Native renderers never move pricing,
   * credentials, or provider behavior into the dashboard.
   */
  readonly presentation?: "link" | "inline-frame" | "native";
  readonly label: string;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly order?: number;
}

// Re-exported so the platform module stays the single import site for route
// composition; the reserved list itself is contract an extension host can read.
export {
  PLATFORM_EXTENSION_RESERVED_PREFIXES,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
};

export const PLATFORM_EXTENSIONS_ENV = "TAKOSUMI_PLATFORM_EXTENSIONS";
export const PLATFORM_EXTENSION_CATALOG_PATH =
  "/__takosumi/platform/extensions" as const;
export const PLATFORM_EXTENSION_CONTRIBUTIONS_PATH =
  "/__takosumi/platform/contributions" as const;

export function platformExtensionRoutes(env: {
  readonly [PLATFORM_EXTENSIONS_ENV]?: unknown;
}): readonly PlatformExtensionRoute[] {
  return mergePlatformExtensionRoutes(
    platformExtensionRoutesFromRaw(
      env[PLATFORM_EXTENSIONS_ENV],
      PLATFORM_EXTENSIONS_ENV,
    ),
  );
}

function platformExtensionRoutesFromRaw(
  raw: unknown,
  envName: string,
): readonly PlatformExtensionRoute[] {
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
    platformExtensionRouteFromJson(entry, index, envName),
  );
}

function platformExtensionRouteFromJson(
  value: unknown,
  index: number,
  envName: string,
): PlatformExtensionRoute {
  const label = `${envName}[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const basePath = record.basePath;
  if (
    typeof basePath !== "string" ||
    !canonicalPlatformExtensionPath(basePath)
  ) {
    throw new TypeError(
      `${label}.basePath must be a canonical absolute path prefix`,
    );
  }
  if (platformExtensionBasePathIsReserved(basePath)) {
    throw new TypeError(
      `${label}.basePath ${basePath} overlaps a Takosumi core route prefix`,
    );
  }
  const handlerKey = nonEmptyString(record.handlerKey);
  if (!handlerKey) {
    throw new TypeError(`${label}.handlerKey must be a non-empty string`);
  }
  const authMode = platformExtensionAuthMode(record.authMode, label);
  const workspaceContext = platformExtensionWorkspaceContext(
    record.workspaceContext,
    label,
  );
  if (workspaceContext && authMode === "handler") {
    throw new TypeError(
      `${label}.workspaceContext requires platform authentication`,
    );
  }
  const requiredScopes = optionalStringArray(
    record.requiredScopes,
    label,
    "requiredScopes",
  );
  const requestScopeRules = optionalRequestScopeRules(
    record.requestScopeRules,
    label,
  );
  if (requiredScopes && requestScopeRules) {
    throw new TypeError(
      `${label}.requestScopeRules cannot be combined with requiredScopes`,
    );
  }
  const managedProviderProfile = nonEmptyString(record.managedProviderProfile);
  if (record.managedProviderProfile !== undefined && !managedProviderProfile) {
    throw new TypeError(
      `${label}.managedProviderProfile must be a non-empty string`,
    );
  }
  const declaredCapabilities = optionalStringArray(
    record.capabilities,
    label,
    "capabilities",
  );
  const compatibilityProfiles = optionalCompatibilityProfiles(
    record.compatibilityProfiles,
    label,
  );
  const declaredCompatibilityTokens = (declaredCapabilities ?? []).filter(
    isCompatibilityProfileToken,
  );
  const typedCompatibilityTokens = new Set(
    (compatibilityProfiles ?? []).map(({ profile }) => profile),
  );
  const untypedCompatibilityToken = declaredCompatibilityTokens.find(
    (token) => !typedCompatibilityTokens.has(token),
  );
  if (untypedCompatibilityToken) {
    throw new TypeError(
      `${label}.capabilities profile ${untypedCompatibilityToken} requires an explicit compatibilityProfiles control/data declaration`,
    );
  }
  if (
    pathIsUnderBase(basePath, "/compat") &&
    (compatibilityProfiles?.length ?? 0) === 0
  ) {
    throw new TypeError(
      `${label}.basePath under /compat requires compatibilityProfiles`,
    );
  }
  const capabilities = uniqueStrings([
    ...(declaredCapabilities ?? []),
    ...(compatibilityProfiles ?? []).map(({ profile }) => profile),
  ]);
  const contributions = optionalContributions(
    record.contributions,
    label,
    basePath,
  );
  return {
    ...(nonEmptyString(record.id) ? { id: nonEmptyString(record.id) } : {}),
    basePath: basePath as `/${string}`,
    handlerKey,
    ...(authMode ? { authMode } : {}),
    ...(workspaceContext ? { workspaceContext } : {}),
    ...(requiredScopes ? { requiredScopes } : {}),
    ...(requestScopeRules ? { requestScopeRules } : {}),
    ...(managedProviderProfile ? { managedProviderProfile } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(compatibilityProfiles ? { compatibilityProfiles } : {}),
    ...(contributions ? { contributions } : {}),
  };
}

function platformExtensionAuthMode(
  value: unknown,
  label: string,
): "platform" | "handler" | undefined {
  if (value === undefined) return undefined;
  if (value === "platform" || value === "handler") return value;
  throw new TypeError(`${label}.authMode must be platform or handler`);
}

function platformExtensionWorkspaceContext(
  value: unknown,
  label: string,
): "query-required" | "query-optional" | undefined {
  if (value === undefined) return undefined;
  if (value === "query-required" || value === "query-optional") return value;
  throw new TypeError(
    `${label}.workspaceContext must be query-required or query-optional`,
  );
}

function mergePlatformExtensionRoutes(
  routes: readonly PlatformExtensionRoute[],
): readonly PlatformExtensionRoute[] {
  const merged = new Map<string, PlatformExtensionRoute>();
  const managedProfileOwners = new Map<string, string>();
  const compatibilityProfileOwners = new Map<string, string>();
  for (const route of routes) {
    if (route.managedProviderProfile) {
      const owner = managedProfileOwners.get(route.managedProviderProfile);
      if (owner && owner !== route.basePath) {
        throw new TypeError(
          `managed provider profile ${route.managedProviderProfile} has multiple route owners`,
        );
      }
      managedProfileOwners.set(route.managedProviderProfile, route.basePath);
    }
    for (const { profile } of route.compatibilityProfiles ?? []) {
      const owner = compatibilityProfileOwners.get(profile);
      if (owner && owner !== route.basePath) {
        throw new TypeError(
          `compatibility profile ${profile} has multiple route owners`,
        );
      }
      compatibilityProfileOwners.set(profile, route.basePath);
    }
    const existing = merged.get(route.basePath);
    if (
      existing &&
      (existing.handlerKey !== route.handlerKey ||
        (existing.authMode ?? "platform") !== (route.authMode ?? "platform") ||
        existing.workspaceContext !== route.workspaceContext ||
        !sameStrings(existing.requiredScopes, route.requiredScopes) ||
        !sameRequestScopeRules(
          existing.requestScopeRules,
          route.requestScopeRules,
        ) ||
        existing.managedProviderProfile !== route.managedProviderProfile)
    ) {
      throw new TypeError(
        `platform extension basePath ${route.basePath} has multiple owners`,
      );
    }
    merged.set(
      route.basePath,
      existing
        ? (() => {
            const capabilities = uniqueStrings([
              ...(existing.capabilities ?? []),
              ...(route.capabilities ?? []),
            ]);
            const contributions = uniqueContributions([
              ...(existing.contributions ?? []),
              ...(route.contributions ?? []),
            ]);
            const compatibilityProfiles = mergeCompatibilityProfiles([
              ...(existing.compatibilityProfiles ?? []),
              ...(route.compatibilityProfiles ?? []),
            ]);
            return {
              ...existing,
              ...(capabilities.length > 0 ? { capabilities } : {}),
              ...(contributions.length > 0 ? { contributions } : {}),
              ...(compatibilityProfiles.length > 0
                ? { compatibilityProfiles }
                : {}),
            };
          })()
        : route,
    );
  }
  return [...merged.values()];
}

function optionalCompatibilityProfiles(
  value: unknown,
  label: string,
): readonly PlatformCompatibilityProfile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.compatibilityProfiles must be an array`);
  }
  const profiles = value.map((entry, index) => {
    const itemLabel = `${label}.compatibilityProfiles[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`${itemLabel} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const profile = nonEmptyString(record.profile);
    if (!profile || !isCompatibilityProfileToken(profile)) {
      throw new TypeError(
        `${itemLabel}.profile must be a scoped compat.* version token`,
      );
    }
    if (!Array.isArray(record.planes) || record.planes.length === 0) {
      throw new TypeError(`${itemLabel}.planes must contain control or data`);
    }
    const planes = uniqueStrings(
      record.planes.map((plane) => {
        if (plane !== "control" && plane !== "data") {
          throw new TypeError(
            `${itemLabel}.planes entries must be control or data`,
          );
        }
        return plane;
      }),
    ) as readonly TakosumiCompatibilityPlane[];
    return { profile, planes } as PlatformCompatibilityProfile;
  });
  const merged = mergeCompatibilityProfiles(profiles);
  return merged.length > 0 ? merged : undefined;
}

function mergeCompatibilityProfiles(
  profiles: readonly PlatformCompatibilityProfile[],
): readonly PlatformCompatibilityProfile[] {
  const merged = new Map<string, Set<TakosumiCompatibilityPlane>>();
  for (const { profile, planes } of profiles) {
    const existing =
      merged.get(profile) ?? new Set<TakosumiCompatibilityPlane>();
    for (const plane of planes) existing.add(plane);
    merged.set(profile, existing);
  }
  return [...merged].map(([profile, planes]) => ({
    profile: profile as `compat.${string}`,
    planes: [...planes].sort(),
  }));
}

function isCompatibilityProfileToken(
  value: string,
): value is `compat.${string}` {
  return isTakosumiCompatibilityProfileToken(value);
}

function optionalContributions(
  value: unknown,
  label: string,
  basePath: string,
): readonly PlatformExtensionContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.contributions must be an array`);
  }
  const contributions = value.map((entry, index) => {
    const itemLabel = `${label}.contributions[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`${itemLabel} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const slot = nonEmptyString(record.slot);
    const href = nonEmptyString(record.href);
    const contributionLabel = nonEmptyString(record.label);
    if (!id || !slot || !href || !contributionLabel) {
      throw new TypeError(`${itemLabel} requires id, slot, href, and label`);
    }
    if (
      !canonicalPlatformExtensionPath(href) ||
      !pathIsUnderBase(href, basePath)
    ) {
      throw new TypeError(`${itemLabel}.href must stay under ${basePath}`);
    }
    const order = record.order;
    if (
      order !== undefined &&
      (typeof order !== "number" || !Number.isSafeInteger(order))
    ) {
      throw new TypeError(`${itemLabel}.order must be a safe integer`);
    }
    const description = nonEmptyString(record.description);
    const labels = optionalLocalizedStrings(record.labels, itemLabel, "labels");
    const descriptions = optionalLocalizedStrings(
      record.descriptions,
      itemLabel,
      "descriptions",
    );
    const rawPresentation = record.presentation;
    if (
      rawPresentation !== undefined &&
      rawPresentation !== "link" &&
      rawPresentation !== "inline-frame" &&
      rawPresentation !== "native"
    ) {
      throw new TypeError(
        `${itemLabel}.presentation must be link, inline-frame, or native`,
      );
    }
    const presentation: PlatformExtensionContribution["presentation"] =
      rawPresentation === "link" ||
      rawPresentation === "inline-frame" ||
      rawPresentation === "native"
        ? rawPresentation
        : undefined;
    return {
      id,
      slot,
      href: href as `/${string}`,
      ...(presentation ? { presentation } : {}),
      label: contributionLabel,
      ...(description ? { description } : {}),
      ...(labels ? { labels } : {}),
      ...(descriptions ? { descriptions } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  });
  return contributions.length > 0
    ? uniqueContributions(contributions)
    : undefined;
}

function optionalLocalizedStrings(
  value: unknown,
  label: string,
  field: string,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}.${field} must be an object`);
  }
  const normalized: Record<string, string> = {};
  for (const [locale, text] of Object.entries(value)) {
    const string = nonEmptyString(text);
    if (!/^[A-Za-z0-9-]{2,35}$/u.test(locale) || !string) {
      throw new TypeError(`${label}.${field} must contain locale strings`);
    }
    normalized[locale] = string;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function canonicalPlatformExtensionPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value === "/" ||
    value.startsWith("//") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  const segments = value.slice(1).split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    return false;
  }
  return true;
}

function uniqueContributions(
  values: readonly PlatformExtensionContribution[],
): readonly PlatformExtensionContribution[] {
  return [
    ...new Map(
      values.map((value) => [`${value.slot}\0${value.id}`, value] as const),
    ).values(),
  ];
}

function optionalStringArray(
  value: unknown,
  label: string,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}.${field} must be an array of strings`);
  }
  const values = value.map((entry) => {
    const normalized = nonEmptyString(entry);
    if (!normalized) {
      throw new TypeError(
        `${label}.${field} entries must be non-empty strings`,
      );
    }
    return normalized;
  });
  return values.length > 0 ? uniqueStrings(values) : undefined;
}

function optionalRequestScopeRules(
  value: unknown,
  label: string,
): readonly PlatformExtensionRequestScopeRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label}.requestScopeRules must be a non-empty array`);
  }
  const seen = new Set<string>();
  const rules = value.map((entry, index) => {
    const itemLabel = `${label}.requestScopeRules[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`${itemLabel} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const path = record.path;
    if (typeof path !== "string" || !canonicalRelativeExtensionPath(path)) {
      throw new TypeError(
        `${itemLabel}.path must be a canonical relative absolute path`,
      );
    }
    if (!Array.isArray(record.methods) || record.methods.length === 0) {
      throw new TypeError(`${itemLabel}.methods must be a non-empty array`);
    }
    const methods = record.methods.map((method) => {
      if (
        typeof method !== "string" ||
        !/^[A-Z]+$/u.test(method) ||
        method.length > 16
      ) {
        throw new TypeError(
          `${itemLabel}.methods entries must be uppercase HTTP methods`,
        );
      }
      return method;
    });
    const uniqueMethods = [...new Set(methods)];
    const requiredScopes =
      record.requiredScopes === undefined
        ? undefined
        : (optionalStringArray(
              record.requiredScopes,
              itemLabel,
              "requiredScopes",
            ) ?? []);
    if (!requiredScopes) {
      throw new TypeError(
        `${itemLabel}.requiredScopes must be an array`,
      );
    }
    for (const method of uniqueMethods) {
      const key = `${path}\0${method}`;
      if (seen.has(key)) {
        throw new TypeError(
          `${label}.requestScopeRules has duplicate path/method ${path} ${method}`,
        );
      }
      seen.add(key);
    }
    return {
      path: path as `/${string}`,
      methods: uniqueMethods,
      requiredScopes,
    } as const;
  });
  return rules;
}

function canonicalRelativeExtensionPath(value: string): boolean {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    (value !== "/" && value.endsWith("/")) ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("%") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  if (value === "/") return true;
  const segments = value.slice(1).split("/");
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function sameStrings(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const leftValues = [...(left ?? [])].sort();
  const rightValues = [...(right ?? [])].sort();
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  );
}

function sameRequestScopeRules(
  left: readonly PlatformExtensionRequestScopeRule[] | undefined,
  right: readonly PlatformExtensionRequestScopeRule[] | undefined,
): boolean {
  if (!left && !right) return true;
  if (!left || !right || left.length !== right.length) return false;
  const normalize = (rules: readonly PlatformExtensionRequestScopeRule[]) =>
    rules
      .flatMap((rule) =>
        rule.methods.map(
          (method) =>
            `${rule.path}\0${method}\0${[...rule.requiredScopes].sort().join("\0")}`,
        ),
      )
      .sort();
  const leftValues = normalize(left);
  const rightValues = normalize(right);
  return leftValues.every((value, index) => value === rightValues[index]);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function matchPlatformExtensionRoute(
  pathname: string,
  routes: readonly PlatformExtensionRoute[],
): PlatformExtensionRoute | undefined {
  return routes
    .filter((route) => pathIsUnderBase(pathname, route.basePath))
    .sort((left, right) => right.basePath.length - left.basePath.length)[0];
}

/**
 * Resolve an exact request scope rule while preserving the route basePath used
 * as the Interface OAuth audience. Routes without rules retain legacy scope
 * behavior; a configured ruleset fails closed when no rule matches.
 */
export function resolvePlatformExtensionRequestScopeRoute(
  request: Request,
  route: PlatformExtensionRoute,
): PlatformExtensionRoute | undefined {
  const rules = route.requestScopeRules;
  if (!rules) return route;
  const pathname = new URL(request.url).pathname;
  const relativePath =
    pathname === route.basePath
      ? "/"
      : pathname.startsWith(`${route.basePath}/`)
        ? pathname.slice(route.basePath.length)
        : undefined;
  if (!relativePath) return undefined;
  const rule = rules.find(
    (candidate) =>
      candidate.path === relativePath &&
      candidate.methods.includes(request.method),
  );
  if (!rule) return undefined;
  return {
    ...route,
    requiredScopes: rule.requiredScopes,
  };
}

export function isPlatformExtensionCatalogPath(pathname: string): boolean {
  return pathname === PLATFORM_EXTENSION_CATALOG_PATH;
}

export function isPlatformExtensionContributionsPath(
  pathname: string,
): boolean {
  return pathname === PLATFORM_EXTENSION_CONTRIBUTIONS_PATH;
}
