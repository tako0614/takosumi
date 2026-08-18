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
import type { WorkspaceRole } from "takosumi-contract/workspaces";
import {
  canonicalProviderSource,
  isProviderEnvName,
  isReservedProviderEnvName,
} from "takosumi-contract/provider-env-rules";
import {
  PLATFORM_EXTENSION_RESERVED_PREFIXES,
  pathIsUnderBase,
  platformExtensionBasePathIsReserved,
  platformExtensionRouteMatchesPath,
  type PlatformExtensionMatchMode,
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
  /** `subtree` is the default; `exact` claims one canonical leaf only. */
  readonly matchMode?: PlatformExtensionMatchMode;
  /** Logical fetch handler key on the platform env. */
  readonly handlerKey: string;
  /** `platform` is the default; `handler` preserves protocol credentials. */
  readonly authMode?: "platform" | "handler";
  /** `headers` is the default; `context` uses the typed authenticated seam. */
  readonly authDelivery?: "headers" | "context";
  /** Reject any parent/child route overlap when this route owns its subtree. */
  readonly ownsPathSubtree?: boolean;
  /** Scopes required from platform token credentials. */
  readonly requiredScopes?: readonly string[];
  /**
   * Explicit scopes an account session may grant to a self-service PAT for
   * this route. This declaration is never inferred from `requiredScopes`.
   */
  readonly selfServicePatScopes?: readonly string[];
  /** Exact method/path scope requirements relative to this basePath. */
  readonly requestScopeRules?: readonly PlatformExtensionRequestScopeRule[];
  /**
   * Binds a caller-supplied `workspaceId` query parameter to verified platform
   * access before dispatch. Optional mode preserves operator-wide reads when
   * the parameter is absent.
   */
  readonly workspaceContext?: "query-required" | "query-optional";
  /**
   * Exact audience and scope set accepted for generic Run credentials. Both
   * must equal the installed Credential Recipe descriptor at verification.
   * Omitted routes reject that token class. Run credentials require the typed
   * context seam, so their raw bearer is never delivered to a handler.
   */
  readonly runCredential?: PlatformExtensionRunCredential;
  /**
   * Optional generic provider bridge owned by this exact authenticated route.
   * It contributes one fixed run-issued ProviderConnection without embedding
   * provider behavior or credentials in OSS.
   */
  readonly providerCredentialBroker?: PlatformExtensionProviderCredentialBroker;
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

export interface PlatformExtensionRunCredential {
  readonly audience: string;
  readonly requiredScopes: readonly string[];
}

export interface PlatformExtensionProviderCredentialBroker {
  readonly connectionId: string;
  readonly recipeId: string;
  readonly providerSource: string;
  readonly displayName: string;
  /** Relative path appended to this route's basePath. */
  readonly exchangePath: `/${string}`;
  readonly envNames: readonly string[];
}

/** Provider-neutral authenticated identity delivered across the platform seam. */
export type PlatformExtensionAuthenticatedAuthKind =
  | "service-token"
  | "oauth-access-token"
  | "personal-access-token"
  | "session"
  | "interface-oauth-token"
  | "run-credential";

export interface PlatformExtensionAuthenticatedContext {
  readonly authKind: PlatformExtensionAuthenticatedAuthKind;
  readonly subject: string;
  readonly workspaceId?: string;
  readonly workspaceRole?: WorkspaceRole;
  readonly scopes?: readonly string[];
  readonly capsuleId?: string;
  readonly runId?: string;
  readonly installingPrincipalId?: string;
  readonly audience?: string;
  readonly phase?: "plan" | "apply" | "destroy";
}

/** Handler contract for routes using `authDelivery: "context"`. */
export interface PlatformExtensionAuthenticatedHandler {
  fetchAuthenticated(
    request: Request,
    context: PlatformExtensionAuthenticatedContext,
  ): Response | Promise<Response>;
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
/** Closed until each new PAT authority has a matching storage and route proof. */
export const PLATFORM_EXTENSION_SELF_SERVICE_PAT_SCOPE_ALLOWLIST = [
  "resources:read",
  "ai.models.read",
  "ai.chat",
  "ai.embeddings",
] as const;
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
  const matchMode = platformExtensionMatchMode(record.matchMode, label);
  const effectiveMatchMode = matchMode ?? "subtree";
  if (platformExtensionBasePathIsReserved(basePath, effectiveMatchMode)) {
    throw new TypeError(
      `${label}.basePath ${basePath} overlaps a Takosumi core route prefix`,
    );
  }
  const handlerKey = nonEmptyString(record.handlerKey);
  if (!handlerKey) {
    throw new TypeError(`${label}.handlerKey must be a non-empty string`);
  }
  const authMode = platformExtensionAuthMode(record.authMode, label);
  const authDelivery = platformExtensionAuthDelivery(
    record.authDelivery,
    label,
  );
  const ownsPathSubtree = platformExtensionOwnsPathSubtree(
    record.ownsPathSubtree,
    label,
  );
  if (effectiveMatchMode === "exact" && ownsPathSubtree === true) {
    throw new TypeError(
      `${label}.matchMode=exact cannot enable ownsPathSubtree`,
    );
  }
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
  const selfServicePatScopes = optionalSelfServicePatScopes(
    record.selfServicePatScopes,
    label,
    requiredScopes,
    requestScopeRules,
  );
  if (selfServicePatScopes && authMode === "handler") {
    throw new TypeError(
      `${label}.selfServicePatScopes requires platform authentication`,
    );
  }
  const runCredential = optionalRunCredential(record.runCredential, label);
  const providerCredentialBroker = optionalProviderCredentialBroker(
    record.providerCredentialBroker,
    label,
  );
  const declaredCapabilities = optionalStringArray(
    record.capabilities,
    label,
    "capabilities",
  );
  const compatibilityProfiles = optionalCompatibilityProfiles(
    record.compatibilityProfiles,
    label,
  );
  if (authDelivery === "context" && authMode === "handler") {
    throw new TypeError(
      `${label}.authDelivery=context requires platform authentication`,
    );
  }
  if (runCredential && authDelivery !== "context") {
    throw new TypeError(
      `${label}.runCredential requires authDelivery=context`,
    );
  }
  if (providerCredentialBroker && !runCredential) {
    throw new TypeError(
      `${label}.providerCredentialBroker requires runCredential`,
    );
  }
  if (authDelivery === "context" && (compatibilityProfiles?.length ?? 0) > 0) {
    throw new TypeError(
      `${label}.authDelivery=context is not supported for compatibilityProfiles`,
    );
  }
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
    ...(matchMode ? { matchMode } : {}),
    handlerKey,
    ...(authMode ? { authMode } : {}),
    ...(authDelivery ? { authDelivery } : {}),
    ...(ownsPathSubtree !== undefined ? { ownsPathSubtree } : {}),
    ...(workspaceContext ? { workspaceContext } : {}),
    ...(requiredScopes ? { requiredScopes } : {}),
    ...(selfServicePatScopes ? { selfServicePatScopes } : {}),
    ...(requestScopeRules ? { requestScopeRules } : {}),
    ...(runCredential ? { runCredential } : {}),
    ...(providerCredentialBroker ? { providerCredentialBroker } : {}),
    ...(capabilities.length > 0 ? { capabilities } : {}),
    ...(compatibilityProfiles ? { compatibilityProfiles } : {}),
    ...(contributions ? { contributions } : {}),
  };
}

function optionalProviderCredentialBroker(
  value: unknown,
  label: string,
): PlatformExtensionProviderCredentialBroker | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}.providerCredentialBroker must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "connectionId",
    "displayName",
    "envNames",
    "exchangePath",
    "providerSource",
    "recipeId",
  ];
  if (
    JSON.stringify(Object.keys(record).sort()) !==
    JSON.stringify(expectedKeys)
  ) {
    throw new TypeError(`${label}.providerCredentialBroker has unknown or missing fields`);
  }
  const connectionId = nonEmptyString(record.connectionId);
  const recipeId = nonEmptyString(record.recipeId);
  const providerSource = nonEmptyString(record.providerSource);
  const displayName = nonEmptyString(record.displayName);
  const exchangePath = record.exchangePath;
  if (!connectionId || !/^conn_[0-9A-Za-z]{8,64}$/u.test(connectionId)) {
    throw new TypeError(`${label}.providerCredentialBroker.connectionId is invalid`);
  }
  if (!recipeId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(recipeId)) {
    throw new TypeError(`${label}.providerCredentialBroker.recipeId is invalid`);
  }
  if (
    !providerSource ||
    canonicalProviderSource(providerSource) !== providerSource ||
    !/^[a-z0-9.-]+\/[a-z0-9_-]+\/[a-z0-9_-]+$/u.test(providerSource)
  ) {
    throw new TypeError(`${label}.providerCredentialBroker.providerSource must be canonical`);
  }
  if (
    !displayName ||
    displayName.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(displayName)
  ) {
    throw new TypeError(`${label}.providerCredentialBroker.displayName is invalid`);
  }
  if (
    typeof exchangePath !== "string" ||
    exchangePath === "/" ||
    !canonicalPlatformExtensionPath(exchangePath)
  ) {
    throw new TypeError(`${label}.providerCredentialBroker.exchangePath is invalid`);
  }
  if (!Array.isArray(record.envNames) || record.envNames.length === 0 || record.envNames.length > 16) {
    throw new TypeError(`${label}.providerCredentialBroker.envNames is invalid`);
  }
  const envNames = record.envNames.map((entry) => {
    if (
      typeof entry !== "string" ||
      !isProviderEnvName(entry) ||
      isReservedProviderEnvName(entry)
    ) {
      throw new TypeError(`${label}.providerCredentialBroker.envNames contains an invalid name`);
    }
    return entry;
  });
  if (new Set(envNames).size !== envNames.length) {
    throw new TypeError(`${label}.providerCredentialBroker.envNames contains duplicates`);
  }
  return Object.freeze({
    connectionId,
    recipeId,
    providerSource,
    displayName,
    exchangePath: exchangePath as `/${string}`,
    envNames: Object.freeze([...envNames]),
  });
}

function platformExtensionMatchMode(
  value: unknown,
  label: string,
): PlatformExtensionMatchMode | undefined {
  if (value === undefined) return undefined;
  if (value === "subtree" || value === "exact") return value;
  throw new TypeError(`${label}.matchMode must be subtree or exact`);
}

function optionalRunCredential(
  value: unknown,
  label: string,
): PlatformExtensionRunCredential | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}.runCredential must be an object`);
  }
  const record = value as Record<string, unknown>;
  const audience = nonEmptyString(record.audience);
  if (!audience) {
    throw new TypeError(
      `${label}.runCredential.audience must be a non-empty string`,
    );
  }
  const requiredScopes = optionalStringArray(
    record.requiredScopes,
    `${label}.runCredential`,
    "requiredScopes",
  );
  if (!requiredScopes || requiredScopes.length === 0) {
    throw new TypeError(
      `${label}.runCredential.requiredScopes must contain at least one scope`,
    );
  }
  if (requiredScopes.includes("admin")) {
    throw new TypeError(
      `${label}.runCredential.requiredScopes cannot grant admin`,
    );
  }
  return Object.freeze({
    audience,
    requiredScopes: Object.freeze([...requiredScopes]),
  });
}

function platformExtensionAuthDelivery(
  value: unknown,
  label: string,
): "headers" | "context" | undefined {
  if (value === undefined) return undefined;
  if (value === "headers" || value === "context") return value;
  throw new TypeError(`${label}.authDelivery must be headers or context`);
}

function platformExtensionOwnsPathSubtree(
  value: unknown,
  label: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new TypeError(`${label}.ownsPathSubtree must be a boolean`);
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
  for (let leftIndex = 0; leftIndex < routes.length; leftIndex += 1) {
    const left = routes[leftIndex];
    if (!left) continue;
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < routes.length;
      rightIndex += 1
    ) {
      const right = routes[rightIndex];
      if (!right || left.basePath === right.basePath) continue;
      const overlaps =
        pathIsUnderBase(left.basePath, right.basePath) ||
        pathIsUnderBase(right.basePath, left.basePath);
      if (
        overlaps &&
        ((left.ownsPathSubtree ?? false) ||
          (right.ownsPathSubtree ?? false))
      ) {
        throw new TypeError(
          `platform extension route subtree ownership overlaps ${left.basePath} and ${right.basePath}`,
        );
      }
    }
  }
  const merged = new Map<string, PlatformExtensionRoute>();
  const runCredentialAudienceOwners = new Map<string, string>();
  const compatibilityProfileOwners = new Map<string, string>();
  for (const route of routes) {
    if (route.runCredential) {
      const owner = runCredentialAudienceOwners.get(
        route.runCredential.audience,
      );
      if (owner && owner !== route.basePath) {
        throw new TypeError(
          `run credential audience ${route.runCredential.audience} has multiple route owners`,
        );
      }
      runCredentialAudienceOwners.set(
        route.runCredential.audience,
        route.basePath,
      );
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
        (existing.matchMode ?? "subtree") !== (route.matchMode ?? "subtree") ||
        (existing.authMode ?? "platform") !== (route.authMode ?? "platform") ||
        (existing.authDelivery ?? "headers") !==
          (route.authDelivery ?? "headers") ||
        (existing.ownsPathSubtree ?? false) !==
          (route.ownsPathSubtree ?? false) ||
        existing.workspaceContext !== route.workspaceContext ||
        !sameStrings(existing.requiredScopes, route.requiredScopes) ||
        !sameRequestScopeRules(
          existing.requestScopeRules,
          route.requestScopeRules,
        ) ||
        !sameStrings(
          existing.selfServicePatScopes,
          route.selfServicePatScopes,
        ) ||
        !sameRunCredential(existing.runCredential, route.runCredential) ||
        !sameProviderCredentialBroker(
          existing.providerCredentialBroker,
          route.providerCredentialBroker,
        ))
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

function sameProviderCredentialBroker(
  left: PlatformExtensionProviderCredentialBroker | undefined,
  right: PlatformExtensionProviderCredentialBroker | undefined,
): boolean {
  return (
    left?.connectionId === right?.connectionId &&
    left?.recipeId === right?.recipeId &&
    left?.providerSource === right?.providerSource &&
    left?.displayName === right?.displayName &&
    left?.exchangePath === right?.exchangePath &&
    sameStrings(left?.envNames, right?.envNames)
  );
}

function sameRunCredential(
  left: PlatformExtensionRunCredential | undefined,
  right: PlatformExtensionRunCredential | undefined,
): boolean {
  return (
    left?.audience === right?.audience &&
    sameStrings(left?.requiredScopes, right?.requiredScopes)
  );
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

function optionalSelfServicePatScopes(
  value: unknown,
  label: string,
  requiredScopes: readonly string[] | undefined,
  requestScopeRules: readonly PlatformExtensionRequestScopeRule[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(
      `${label}.selfServicePatScopes must be a non-empty array`,
    );
  }
  const scopes = optionalStringArray(
    value,
    label,
    "selfServicePatScopes",
  );
  if (!scopes || scopes.length === 0) {
    throw new TypeError(
      `${label}.selfServicePatScopes must be a non-empty array`,
    );
  }
  const referenced = new Set([
    ...(requiredScopes ?? []),
    ...(requestScopeRules ?? []).flatMap((rule) => rule.requiredScopes),
  ]);
  for (const scope of scopes) {
    if (
      !(PLATFORM_EXTENSION_SELF_SERVICE_PAT_SCOPE_ALLOWLIST as readonly string[]).includes(
        scope,
      )
    ) {
      throw new TypeError(
        `${label}.selfServicePatScopes contains unsupported scope ${scope}`,
      );
    }
    if (!referenced.has(scope)) {
      throw new TypeError(
        `${label}.selfServicePatScopes scope ${scope} must be explicitly referenced by requiredScopes or requestScopeRules`,
      );
    }
  }
  return scopes;
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
    .filter((route) =>
      platformExtensionRouteMatchesPath(
        pathname,
        route.basePath,
        route.matchMode,
      ),
    )
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
  const pathname = new URL(request.url).pathname;
  if (
    !platformExtensionRouteMatchesPath(
      pathname,
      route.basePath,
      route.matchMode,
    )
  ) {
    return undefined;
  }
  const rules = route.requestScopeRules;
  if (!rules) return route;
  const relativePath =
    pathname === route.basePath ? "/" : pathname.slice(route.basePath.length);
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

/**
 * Return the explicitly declared, allowlisted self-service PAT scopes from a
 * parsed extension route set. Required route scopes alone never contribute.
 */
export function platformExtensionSelfServicePatScopes(
  routes: readonly PlatformExtensionRoute[],
): readonly string[] {
  const declared = new Set(
    routes.flatMap((route) => route.selfServicePatScopes ?? []),
  );
  return PLATFORM_EXTENSION_SELF_SERVICE_PAT_SCOPE_ALLOWLIST.filter((scope) =>
    declared.has(scope),
  );
}

export function isPlatformExtensionCatalogPath(pathname: string): boolean {
  return pathname === PLATFORM_EXTENSION_CATALOG_PATH;
}

export function isPlatformExtensionContributionsPath(
  pathname: string,
): boolean {
  return pathname === PLATFORM_EXTENSION_CONTRIBUTIONS_PATH;
}
