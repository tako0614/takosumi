/**
 * Read-only client for a host contribution's managed-resource inventory.
 *
 * The OSS dashboard does not know how a host stores or reconciles these
 * resources. It only consumes the strict, versioned projection advertised by
 * the native `workspace.hosted-resources` contribution.
 */

export const PLATFORM_EXTENSION_CATALOG_PATH =
  "/__takosumi/platform/extensions" as const;
export const HOSTED_RESOURCES_SLOT = "workspace.hosted-resources" as const;
export const HOSTED_RESOURCE_INVENTORY_CAPABILITY =
  "hosted-resource.inventory.v1" as const;
export const HOSTED_RESOURCE_READ_SCOPE = "resources:read" as const;

export const HOSTED_RESOURCE_INVENTORY_KIND =
  "takosumi.hosted-resource-inventory@v1" as const;
export const HOSTED_RESOURCE_INVENTORY_PAGE_SIZE = 25;
export const HOSTED_RESOURCE_COUNTER_MAX_LENGTH = 128;

export interface PlatformExtensionRequestScopeRule {
  readonly path: `/${string}`;
  readonly methods: readonly string[];
  readonly requiredScopes: readonly string[];
}

export interface PlatformExtensionContribution {
  readonly id: string;
  readonly slot: string;
  readonly href: `/${string}`;
  readonly presentation?: "link" | "inline-frame" | "native";
  readonly label: string;
  readonly description?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly descriptions?: Readonly<Record<string, string>>;
  readonly order?: number;
}

export interface PlatformExtensionCompatibilityProfile {
  readonly profile: `compat.${string}`;
  readonly planes: readonly ("control" | "data")[];
}

export interface PlatformExtensionCatalogItem {
  readonly id?: string;
  readonly basePath: `/${string}`;
  readonly matchMode?: "subtree" | "exact";
  readonly configured: boolean;
  readonly capabilities?: readonly string[];
  readonly compatibilityProfiles?: readonly PlatformExtensionCompatibilityProfile[];
  readonly authMode?: "platform" | "handler";
  readonly requiredScopes?: readonly string[];
  readonly selfServicePatScopes?: readonly string[];
  readonly requestScopeRules?: readonly PlatformExtensionRequestScopeRule[];
  readonly workspaceContext?: "query-required" | "query-optional";
  readonly contributions?: readonly PlatformExtensionContribution[];
}

export interface PlatformExtensionCatalog {
  readonly kind: "takosumi.platform-extensions@v1";
  readonly generatedAt: string;
  readonly serviceUrl: string;
  readonly extensions: readonly PlatformExtensionCatalogItem[];
  readonly summary: {
    readonly total: number;
    readonly configured: number;
    readonly missing: number;
  };
}

/** The only host-owned value the native dashboard renderer consumes. */
export interface HostedResourceContribution {
  readonly href: `/${string}`;
}

/** Errors intentionally contain no backend response body or provider detail. */
export class HostedResourceCatalogError extends Error {
  constructor(readonly status: number, message = "Hosted resources unavailable") {
    super(message);
    this.name = "HostedResourceCatalogError";
  }
}

export type HostedResourceConditionStatus = "True" | "False" | "Unknown";

export interface HostedResourceCondition {
  readonly type: string;
  readonly status: HostedResourceConditionStatus;
  readonly reason: string;
  readonly lastTransitionTime: string;
}

export interface HostedResourceFormRef {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly schemaDigest: string;
}

export interface HostedResourceInventoryItem {
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly formRef: HostedResourceFormRef;
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly conditions: readonly HostedResourceCondition[];
  /** Present only when the host can prove a local Takosumi Workload relation. */
  readonly workloadId?: string;
}

export interface HostedResourceInventory {
  readonly kind: typeof HOSTED_RESOURCE_INVENTORY_KIND;
  readonly workspaceId: string;
  readonly items: readonly HostedResourceInventoryItem[];
  readonly nextCursor?: string;
}

/**
 * Load the authenticated extension catalog and bind the native hosted-resource
 * renderer to one extension-owned route. The catalog is intentionally fetched
 * from the authenticated endpoint rather than the public flattened
 * contribution projection: authorization metadata and the contribution must
 * come from the same catalog item.
 */
export async function loadHostedResourceContribution(
  fetchImpl: typeof fetch = fetch,
): Promise<HostedResourceContribution> {
  let response: Response;
  try {
    response = await fetchImpl(PLATFORM_EXTENSION_CATALOG_PATH, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new HostedResourceCatalogError(0);
  }
  if (!response.ok) {
    throw new HostedResourceCatalogError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HostedResourceCatalogError(502);
  }
  return resolveHostedResourceContribution(parsePlatformExtensionCatalog(body));
}

/** Parse the authenticated catalog without trusting any unvalidated field. */
export function parsePlatformExtensionCatalog(
  value: unknown,
): PlatformExtensionCatalog {
  const record = catalogObject(value);
  catalogExactKeys(record, [
    "kind",
    "generatedAt",
    "serviceUrl",
    "extensions",
    "summary",
  ]);
  if (record.kind !== "takosumi.platform-extensions@v1") {
    throw invalidCatalog();
  }
  const generatedAt = catalogString(record.generatedAt);
  const serviceUrl = catalogServiceUrl(record.serviceUrl);
  if (!Array.isArray(record.extensions)) {
    throw invalidCatalog();
  }
  const extensions = record.extensions.map((extension, index) =>
    parsePlatformExtensionCatalogItem(extension, index),
  );
  const summary = parsePlatformExtensionCatalogSummary(record.summary);
  if (
    summary.total !== extensions.length ||
    summary.configured !== extensions.filter((extension) => extension.configured).length ||
    summary.missing !== extensions.length - summary.configured
  ) {
    throw invalidCatalog();
  }
  return {
    kind: "takosumi.platform-extensions@v1",
    generatedAt,
    serviceUrl,
    extensions,
    summary,
  };
}

/**
 * Resolve one and only one configured owner and one native contribution. The
 * returned value deliberately omits caller-authored extension ids: callers
 * receive only the route that was proven to belong to the authorized owner.
 */
export function resolveHostedResourceContribution(
  catalog: PlatformExtensionCatalog,
): HostedResourceContribution {
  const owners = catalog.extensions.filter(
    (extension) =>
      extension.configured &&
      extension.capabilities?.includes(HOSTED_RESOURCE_INVENTORY_CAPABILITY),
  );
  if (owners.length !== 1) {
    throw invalidCatalog();
  }
  const owner = owners[0];
  if (!owner) throw invalidCatalog();
  if (owner.authMode !== undefined && owner.authMode !== "platform") {
    throw invalidCatalog();
  }
  if (owner.workspaceContext !== "query-required") {
    throw invalidCatalog();
  }
  if (!owner.selfServicePatScopes?.includes(HOSTED_RESOURCE_READ_SCOPE)) {
    throw invalidCatalog();
  }

  const contributions = (owner.contributions ?? []).filter(
    (contribution) =>
      contribution.slot === HOSTED_RESOURCES_SLOT &&
      contribution.presentation === "native",
  );
  if (contributions.length !== 1) {
    throw invalidCatalog();
  }
  const contribution = contributions[0];
  if (!contribution || !hostedContributionPathIsSafe(owner, contribution.href)) {
    throw invalidCatalog();
  }
  if (!hostedContributionGetIsAuthorized(owner, contribution.href)) {
    throw invalidCatalog();
  }
  return { href: contribution.href };
}

/** Errors intentionally contain no backend response body or provider detail. */
export class HostedResourceInventoryError extends Error {
  constructor(readonly status: number, message = "Hosted resources unavailable") {
    super(message);
    this.name = "HostedResourceInventoryError";
  }
}

/**
 * Fetch one opaque-cursor page from the native contribution API.
 *
 * `href` is supplied by the trusted same-origin platform contribution. The
 * client appends only the workspace scope, bounded page size, and opaque cursor
 * and never interprets or reuses cursor contents.
 */
export async function listHostedResourceInventoryPage(
  href: string,
  workspaceId: string,
  cursor?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HostedResourceInventory> {
  const endpoint = contributionEndpoint(href);
  endpoint.searchParams.set("workspaceId", workspaceId);
  endpoint.searchParams.set(
    "limit",
    String(HOSTED_RESOURCE_INVENTORY_PAGE_SIZE),
  );
  if (cursor !== undefined) endpoint.searchParams.set("cursor", cursor);

  const response = await fetchImpl(endpoint.toString(), {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new HostedResourceInventoryError(response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HostedResourceInventoryError(502);
  }
  return parseHostedResourceInventory(body, workspaceId);
}

/** Strictly validate the host-owned DTO before any field reaches the UI. */
export function parseHostedResourceInventory(
  value: unknown,
  expectedWorkspaceId: string,
): HostedResourceInventory {
  const record = object(value, "inventory");
  exactKeys(record, ["kind", "workspaceId", "items"], ["nextCursor"]);
  if (record.kind !== HOSTED_RESOURCE_INVENTORY_KIND) {
    throw new HostedResourceInventoryError(502);
  }
  stringField(record.workspaceId, "workspaceId");
  if (record.workspaceId !== expectedWorkspaceId) {
    throw new HostedResourceInventoryError(502);
  }
  if (!Array.isArray(record.items)) {
    throw new HostedResourceInventoryError(502);
  }
  const items = record.items.map((item, index) => parseItem(item, index));
  const nextCursor =
    record.nextCursor === undefined
      ? undefined
      : stringField(record.nextCursor, "nextCursor");
  if (nextCursor !== undefined) {
    if (nextCursor.length === 0) {
      throw new HostedResourceInventoryError(502);
    }
  }
  return {
    kind: HOSTED_RESOURCE_INVENTORY_KIND,
    workspaceId: record.workspaceId,
    items,
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };
}

function parsePlatformExtensionCatalogItem(
  value: unknown,
  index: number,
): PlatformExtensionCatalogItem {
  const record = catalogObject(value);
  catalogExactKeys(
    record,
    ["basePath", "configured"],
    [
      "id",
      "matchMode",
      "capabilities",
      "compatibilityProfiles",
      "authMode",
      "requiredScopes",
      "selfServicePatScopes",
      "requestScopeRules",
      "workspaceContext",
      "contributions",
    ],
  );
  const label = `extensions[${index}]`;
  const basePath = catalogPath(record.basePath);
  if (typeof record.configured !== "boolean") throw invalidCatalog();
  const id = optionalCatalogString(record.id);
  const matchMode = optionalCatalogEnum(
    record.matchMode,
    ["subtree", "exact"],
  );
  const capabilities = optionalCatalogStringArray(record.capabilities);
  const compatibilityProfiles = optionalCompatibilityProfiles(
    record.compatibilityProfiles,
  );
  const authMode = optionalCatalogEnum(record.authMode, ["platform", "handler"]);
  const requiredScopes = optionalCatalogStringArray(record.requiredScopes);
  const selfServicePatScopes = optionalCatalogStringArray(
    record.selfServicePatScopes,
  );
  const requestScopeRules = optionalRequestScopeRules(
    record.requestScopeRules,
  );
  if (requiredScopes && requestScopeRules) throw invalidCatalog();
  const workspaceContext = optionalCatalogEnum(
    record.workspaceContext,
    ["query-required", "query-optional"],
  );
  const contributions = optionalCatalogContributions(
    record.contributions,
    basePath,
  );
  // Keep this local label so future parser changes cannot accidentally make a
  // malformed extension look like a valid one while still retaining the index
  // in a debugger. The public error stays intentionally generic.
  void label;
  return {
    ...(id !== undefined ? { id } : {}),
    basePath,
    ...(matchMode !== undefined ? { matchMode } : {}),
    configured: record.configured,
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(compatibilityProfiles !== undefined ? { compatibilityProfiles } : {}),
    ...(authMode !== undefined ? { authMode } : {}),
    ...(requiredScopes !== undefined ? { requiredScopes } : {}),
    ...(selfServicePatScopes !== undefined ? { selfServicePatScopes } : {}),
    ...(requestScopeRules !== undefined ? { requestScopeRules } : {}),
    ...(workspaceContext !== undefined ? { workspaceContext } : {}),
    ...(contributions !== undefined ? { contributions } : {}),
  };
}

function parsePlatformExtensionCatalogSummary(
  value: unknown,
): PlatformExtensionCatalog["summary"] {
  const record = catalogObject(value);
  catalogExactKeys(record, ["total", "configured", "missing"]);
  const total = catalogCount(record.total);
  const configured = catalogCount(record.configured);
  const missing = catalogCount(record.missing);
  if (configured > total || missing > total) throw invalidCatalog();
  return { total, configured, missing };
}

function optionalCompatibilityProfiles(
  value: unknown,
): readonly PlatformExtensionCompatibilityProfile[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidCatalog();
  const profiles = value.map((entry) => {
    const record = catalogObject(entry);
    catalogExactKeys(record, ["profile", "planes"]);
    const profile = catalogString(record.profile);
    if (!/^compat\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(profile)) {
      throw invalidCatalog();
    }
    if (!Array.isArray(record.planes) || record.planes.length === 0) {
      throw invalidCatalog();
    }
    const planes = record.planes.map((plane) => {
      if (plane !== "control" && plane !== "data") throw invalidCatalog();
      return plane;
    });
    if (new Set(planes).size !== planes.length) throw invalidCatalog();
    return { profile: profile as `compat.${string}`, planes };
  });
  if (
    new Set(profiles.map((profile) => profile.profile)).size !== profiles.length
  ) {
    throw invalidCatalog();
  }
  return profiles;
}

function optionalRequestScopeRules(
  value: unknown,
): readonly PlatformExtensionRequestScopeRule[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidCatalog();
  const seen = new Set<string>();
  const rules = value.map((entry) => {
    const record = catalogObject(entry);
    catalogExactKeys(record, ["path", "methods", "requiredScopes"]);
    const path = catalogRelativePath(record.path);
    if (!Array.isArray(record.methods) || record.methods.length === 0) {
      throw invalidCatalog();
    }
    const methods = record.methods.map((method) => {
      if (
        typeof method !== "string" ||
        !/^[A-Z]+$/u.test(method) ||
        method.length > 16
      ) {
        throw invalidCatalog();
      }
      return method;
    });
    if (new Set(methods).size !== methods.length) throw invalidCatalog();
    // Public preflight rules (for example AI OPTIONS) intentionally require
    // no scopes.  Keep the empty-array exception local to request rules;
    // capability and owner scope declarations remain non-empty.
    const requiredScopes = catalogStringArray(record.requiredScopes, true);
    for (const method of methods) {
      const key = `${path}\u0000${method}`;
      if (seen.has(key)) throw invalidCatalog();
      seen.add(key);
    }
    return { path, methods, requiredScopes };
  });
  return rules;
}

function optionalCatalogContributions(
  value: unknown,
  basePath: `/${string}`,
): readonly PlatformExtensionContribution[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) throw invalidCatalog();
  const seen = new Set<string>();
  const contributions = value.map((entry) => {
    const record = catalogObject(entry);
    catalogExactKeys(
      record,
      ["id", "slot", "href", "label"],
      [
        "presentation",
        "description",
        "labels",
        "descriptions",
        "order",
      ],
    );
    const id = catalogString(record.id);
    const slot = catalogString(record.slot);
    const href = catalogPath(record.href);
    const label = catalogString(record.label);
    const presentation = optionalCatalogEnum(record.presentation, [
      "link",
      "inline-frame",
      "native",
    ]);
    const description = optionalCatalogString(record.description);
    const labels = optionalLocalizedCatalogStrings(record.labels);
    const descriptions = optionalLocalizedCatalogStrings(record.descriptions);
    const order = optionalCatalogOrder(record.order);
    const key = `${slot}\u0000${id}`;
    if (seen.has(key)) throw invalidCatalog();
    seen.add(key);
    if (!catalogPathIsUnderBase(href, basePath)) throw invalidCatalog();
    return {
      id,
      slot,
      href,
      ...(presentation !== undefined ? { presentation } : {}),
      label,
      ...(description !== undefined ? { description } : {}),
      ...(labels !== undefined ? { labels } : {}),
      ...(descriptions !== undefined ? { descriptions } : {}),
      ...(order !== undefined ? { order } : {}),
    };
  });
  return contributions;
}

function optionalLocalizedCatalogStrings(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = catalogObject(value);
  const entries = Object.entries(record);
  if (entries.length === 0) throw invalidCatalog();
  const normalized: Record<string, string> = {};
  for (const [locale, text] of entries) {
    if (!/^[A-Za-z0-9-]{2,35}$/u.test(locale)) throw invalidCatalog();
    normalized[locale] = catalogString(text);
  }
  return normalized;
}

function optionalCatalogStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return catalogStringArray(value);
}

function catalogStringArray(
  value: unknown,
  allowEmpty = false,
): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalidCatalog();
  }
  const values = value.map((entry) => catalogString(entry));
  if (new Set(values).size !== values.length) throw invalidCatalog();
  return values;
}

function optionalCatalogString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return catalogString(value);
}

function optionalCatalogEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw invalidCatalog();
  }
  return value as T[number];
}

function optionalCatalogOrder(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidCatalog();
  }
  return value;
}

function catalogCount(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw invalidCatalog();
  }
  return value;
}

function catalogServiceUrl(value: unknown): string {
  const serviceUrl = catalogString(value);
  let parsed: URL;
  try {
    parsed = new URL(serviceUrl);
  } catch {
    throw invalidCatalog();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw invalidCatalog();
  }
  return serviceUrl;
}

function catalogObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidCatalog();
  }
  return value as Record<string, unknown>;
}

function catalogExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in record))
  ) {
    throw invalidCatalog();
  }
}

function catalogString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw invalidCatalog();
  }
  return value;
}

function catalogPath(value: unknown): `/${string}` {
  const path = catalogString(value);
  if (!canonicalCatalogPath(path)) throw invalidCatalog();
  return path as `/${string}`;
}

function catalogRelativePath(value: unknown): `/${string}` {
  const path = catalogString(value);
  if (!canonicalCatalogRelativePath(path)) throw invalidCatalog();
  return path as `/${string}`;
}

function canonicalCatalogPath(value: string): boolean {
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
  return segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function canonicalCatalogRelativePath(value: string): boolean {
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
  return value.slice(1).split("/").every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}

function catalogPathIsUnderBase(
  path: `/${string}`,
  basePath: `/${string}`,
): boolean {
  return path === basePath || path.startsWith(`${basePath}/`);
}

function hostedContributionPathIsSafe(
  owner: PlatformExtensionCatalogItem,
  href: `/${string}`,
): boolean {
  if (!catalogPathIsUnderBase(href, owner.basePath)) return false;
  if (owner.matchMode === "exact") return href === owner.basePath;
  return true;
}

function hostedContributionGetIsAuthorized(
  owner: PlatformExtensionCatalogItem,
  href: `/${string}`,
): boolean {
  if (owner.requiredScopes?.includes(HOSTED_RESOURCE_READ_SCOPE)) return true;
  const relativePath =
    href === owner.basePath ? "/" : href.slice(owner.basePath.length);
  return (
    owner.requestScopeRules?.some(
      (rule) =>
        rule.path === relativePath &&
        rule.methods.includes("GET") &&
        rule.requiredScopes.includes(HOSTED_RESOURCE_READ_SCOPE),
    ) ?? false
  );
}

function invalidCatalog(): HostedResourceCatalogError {
  return new HostedResourceCatalogError(502);
}

function contributionEndpoint(href: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(href, browserOrigin());
  } catch {
    throw new HostedResourceInventoryError(0);
  }
  if (endpoint.origin !== browserOrigin()) {
    throw new HostedResourceInventoryError(0);
  }
  return endpoint;
}

function browserOrigin(): string {
  return typeof window === "undefined" ? "https://takosumi.invalid" : window.location.origin;
}

function parseItem(value: unknown, index: number): HostedResourceInventoryItem {
  const record = object(value, `items[${index}]`);
  exactKeys(record, [
    "apiVersion",
    "kind",
    "name",
    "formRef",
    "uid",
    "generation",
    "revision",
    "conditions",
  ], ["workloadId"]);
  const formRef = parseFormRef(record.formRef, index);
  if (!Array.isArray(record.conditions)) {
    throw new HostedResourceInventoryError(502);
  }
  return {
    apiVersion: stringField(record.apiVersion, `items[${index}].apiVersion`),
    kind: stringField(record.kind, `items[${index}].kind`),
    name: stringField(record.name, `items[${index}].name`),
    formRef,
    uid: stringField(record.uid, `items[${index}].uid`),
    generation: decimalField(
      record.generation,
      `items[${index}].generation`,
    ),
    revision: decimalField(record.revision, `items[${index}].revision`),
    conditions: record.conditions.map((condition, conditionIndex) =>
      parseCondition(condition, index, conditionIndex),
    ),
    ...(record.workloadId === undefined
      ? {}
      : {
          workloadId: stringField(
            record.workloadId,
            `items[${index}].workloadId`,
          ),
        }),
  };
}

function parseFormRef(value: unknown, index: number): HostedResourceFormRef {
  const record = object(value, `items[${index}].formRef`);
  exactKeys(record, [
    "apiVersion",
    "kind",
    "definitionVersion",
    "schemaDigest",
  ]);
  return {
    apiVersion: stringField(
      record.apiVersion,
      `items[${index}].formRef.apiVersion`,
    ),
    kind: stringField(record.kind, `items[${index}].formRef.kind`),
    definitionVersion: stringField(
      record.definitionVersion,
      `items[${index}].formRef.definitionVersion`,
    ),
    schemaDigest: stringField(
      record.schemaDigest,
      `items[${index}].formRef.schemaDigest`,
    ),
  };
}

function parseCondition(
  value: unknown,
  itemIndex: number,
  conditionIndex: number,
): HostedResourceCondition {
  const record = object(
    value,
    `items[${itemIndex}].conditions[${conditionIndex}]`,
  );
  exactKeys(record, ["type", "status", "reason", "lastTransitionTime"]);
  const status = record.status;
  if (status !== "True" && status !== "False" && status !== "Unknown") {
    throw new HostedResourceInventoryError(502);
  }
  return {
    type: stringField(record.type, "condition.type"),
    status,
    reason: stringField(record.reason, "condition.reason"),
    lastTransitionTime: stringField(
      record.lastTransitionTime,
      "condition.lastTransitionTime",
    ),
  };
}

function object(value: unknown, _path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostedResourceInventoryError(502);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...keys, ...optional]);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    throw new HostedResourceInventoryError(502);
  }
}

function stringField(value: unknown, _path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HostedResourceInventoryError(502);
  }
  return value;
}

function decimalField(value: unknown, _path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > HOSTED_RESOURCE_COUNTER_MAX_LENGTH ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new HostedResourceInventoryError(502);
  }
  return value;
}
