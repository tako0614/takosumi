import type { Interface, InterfaceBinding } from "takosumi-contract";
import { isValidInterfaceName, TAKOSUMI_API_VERSION } from "takosumi-contract";

export const UI_SURFACE_INTERFACE_TYPE = "interface.ui.surface" as const;
export const UI_SURFACE_INTERFACE_VERSION = "1" as const;
export const UI_SURFACE_PERMISSION = "ui.open" as const;

/**
 * Strict dashboard consumer view of a Capsule-owned launcher Interface.
 * Core keeps `document` opaque; this module is the type/version consumer that
 * validates the UI profile before the dashboard renders an external link.
 */
export interface AuthorizedUiSurface {
  readonly interfaceId: string;
  readonly capsuleId: string;
  readonly resolvedRevision: number;
  readonly name?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly category?: string;
  readonly sortOrder?: number;
  readonly url: string;
}

interface UiSurfaceCandidate extends AuthorizedUiSurface {
  readonly interface: Interface;
}

export interface UiSurfaceReadOptions {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  /** Limit the read to one installed Capsule (for post-Run handoff). */
  readonly capsuleId?: string;
}

export async function listAuthorizedUiSurfaces(
  workspaceId: string,
  subjectId: string,
  options: UiSurfaceReadOptions = {},
): Promise<readonly AuthorizedUiSurface[]> {
  const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
  const normalizedSubjectId = requiredId(subjectId, "subjectId");
  const normalizedCapsuleId =
    options.capsuleId === undefined
      ? undefined
      : requiredId(options.capsuleId, "capsuleId");
  const params = new URLSearchParams({
    workspaceId: normalizedWorkspaceId,
    type: UI_SURFACE_INTERFACE_TYPE,
    phase: "Resolved",
    permission: UI_SURFACE_PERMISSION,
  });
  if (normalizedCapsuleId !== undefined) {
    params.set("ownerKind", "Capsule");
    params.set("ownerId", normalizedCapsuleId);
  }
  const body = await fetchJson(`/v1/interfaces?${params.toString()}`, options);
  if (!isRecord(body) || !Array.isArray(body.interfaces)) {
    throw new Error("Interface list response is invalid");
  }

  const candidates = body.interfaces
    .map((value) => parseUiSurfaceInterface(value, normalizedWorkspaceId))
    .filter(
      (value): value is UiSurfaceCandidate =>
        value !== null &&
        (normalizedCapsuleId === undefined ||
          value.capsuleId === normalizedCapsuleId),
    );

  const authorized = await Promise.all(
    candidates.map(async (candidate) => {
      const bindings = await fetchJson(
        `/v1/interfaces/${encodeURIComponent(candidate.interfaceId)}/bindings?permission=${encodeURIComponent(UI_SURFACE_PERMISSION)}`,
        options,
      );
      if (!isRecord(bindings) || !Array.isArray(bindings.bindings)) {
        throw new Error("InterfaceBinding list response is invalid");
      }
      return bindings.bindings.some((binding) =>
        isReadyUiOpenBinding(binding, candidate.interface, normalizedSubjectId),
      )
        ? stripInterface(candidate)
        : null;
    }),
  );
  return authorized
    .filter((value): value is AuthorizedUiSurface => value !== null)
    .sort(compareAuthorizedUiSurfaces);
}

export function parseUiSurfaceInterface(
  value: unknown,
  workspaceId: string,
): UiSurfaceCandidate | null {
  const record = isRecord(value) ? value : null;
  const metadata = record && isRecord(record.metadata) ? record.metadata : null;
  const ownerRef =
    metadata && isRecord(metadata.ownerRef) ? metadata.ownerRef : null;
  const spec = record && isRecord(record.spec) ? record.spec : null;
  const inputs = spec && isRecord(spec.inputs) ? spec.inputs : null;
  const urlInput = inputs && isRecord(inputs.url) ? inputs.url : null;
  const access = spec && isRecord(spec.access) ? spec.access : null;
  const document = spec && isRecord(spec.document) ? spec.document : null;
  const status = record && isRecord(record.status) ? record.status : null;
  const resolvedInputs =
    status && isRecord(status.resolvedInputs) ? status.resolvedInputs : null;

  const generation = nonNegativeInteger(metadata?.generation);
  const observedGeneration = nonNegativeInteger(status?.observedGeneration);
  const resolvedRevision = nonNegativeInteger(status?.resolvedRevision);
  const interfaceId = text(metadata?.id);
  const interfaceName = text(metadata?.name);
  const capsuleId = text(ownerRef?.id);
  if (
    record?.apiVersion !== TAKOSUMI_API_VERSION ||
    record.kind !== "Interface" ||
    metadata?.workspaceId !== workspaceId ||
    !interfaceId ||
    !interfaceName ||
    !isValidInterfaceName(interfaceName) ||
    ownerRef?.kind !== "Capsule" ||
    !capsuleId ||
    generation === null ||
    generation < 1 ||
    observedGeneration !== generation ||
    spec?.type !== UI_SURFACE_INTERFACE_TYPE ||
    spec.version !== UI_SURFACE_INTERFACE_VERSION ||
    !urlInput ||
    !isSupportedInputSource(urlInput.source) ||
    !document ||
    document.launcher !== true ||
    hasEmbeddedCredentialContract(document) ||
    !access ||
    !isVisibility(access.visibility) ||
    status?.phase !== "Resolved" ||
    resolvedRevision === null ||
    resolvedRevision < 1 ||
    !resolvedInputs
  ) {
    return null;
  }

  const url = safeRuntimeUrl(resolvedInputs.url);
  if (!url) return null;
  const display = isRecord(document.display) ? document.display : null;
  const name = boundedText(display?.title, 256);
  const description = boundedText(display?.description, 1_024);
  const icon = safeUiIcon(display?.icon, url);
  const category = boundedText(display?.category, 64);
  const sortOrder = finiteNumber(display?.sortOrder);
  return {
    interface: value as Interface,
    interfaceId,
    capsuleId,
    resolvedRevision,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(icon ? { icon } : {}),
    ...(category ? { category } : {}),
    ...(sortOrder !== null ? { sortOrder } : {}),
    url,
  };
}

export function isReadyUiOpenBinding(
  value: unknown,
  iface: Interface,
  subjectId: string,
): value is InterfaceBinding {
  const record = isRecord(value) ? value : null;
  const metadata = record && isRecord(record.metadata) ? record.metadata : null;
  const spec = record && isRecord(record.spec) ? record.spec : null;
  const subjectRef = spec && isRecord(spec.subjectRef) ? spec.subjectRef : null;
  const delivery = spec && isRecord(spec.delivery) ? spec.delivery : null;
  const status = record && isRecord(record.status) ? record.status : null;
  const generation = nonNegativeInteger(metadata?.generation);
  return (
    record?.apiVersion === TAKOSUMI_API_VERSION &&
    record.kind === "InterfaceBinding" &&
    metadata?.workspaceId === iface.metadata.workspaceId &&
    Boolean(text(metadata?.id)) &&
    generation !== null &&
    generation >= 1 &&
    spec?.interfaceId === iface.metadata.id &&
    subjectRef?.kind === "Principal" &&
    subjectRef.id === subjectId &&
    Array.isArray(spec.permissions) &&
    spec.permissions.includes(UI_SURFACE_PERMISSION) &&
    delivery?.type === "none" &&
    delivery.credentialRef === undefined &&
    delivery.options === undefined &&
    status?.phase === "Ready" &&
    status.observedInterfaceRevision === iface.status.resolvedRevision
  );
}

function stripInterface(candidate: UiSurfaceCandidate): AuthorizedUiSurface {
  const { interface: _interface, ...surface } = candidate;
  return surface;
}

function compareAuthorizedUiSurfaces(
  left: AuthorizedUiSurface,
  right: AuthorizedUiSurface,
): number {
  const declaredOrder =
    (left.sortOrder ?? Number.MAX_SAFE_INTEGER) -
    (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
  if (declaredOrder !== 0) return declaredOrder;
  const displayOrder = (left.name ?? "").localeCompare(right.name ?? "");
  return displayOrder || left.interfaceId.localeCompare(right.interfaceId);
}

async function fetchJson(
  path: string,
  options: UiSurfaceReadOptions,
): Promise<unknown> {
  const response = await (options.fetch ?? fetch)(path, {
    method: "GET",
    headers: { accept: "application/json" },
    credentials: "include",
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`Interface API request failed (${response.status})`);
  }
  return await response.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  const normalized = text(value);
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isSupportedInputSource(value: unknown): boolean {
  return (
    value === "literal" ||
    value === "capsule_output" ||
    value === "resource_output"
  );
}

function isVisibility(value: unknown): boolean {
  return value === "private" || value === "workspace" || value === "public";
}

function hasEmbeddedCredentialContract(
  document: Record<string, unknown>,
): boolean {
  return (
    document.auth !== undefined ||
    document.authentication !== undefined ||
    document.delivery !== undefined ||
    document.credentialDelivery !== undefined
  );
}

function safeRuntimeUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.hash) return null;
    if (hasCredentialQuery(url.searchParams)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeUiIcon(value: unknown, runtimeUrl: string): string | undefined {
  const raw = boundedText(value, 2_048);
  if (!raw) return undefined;
  // A short non-path token is presentation text (typically an emoji/glyph).
  if (![...raw].some((char) => "/.:".includes(char))) {
    return [...raw].length <= 16 ? raw : undefined;
  }
  try {
    const url = new URL(raw, runtimeUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.hash) return undefined;
    if (hasCredentialQuery(url.searchParams)) return undefined;
    return raw.startsWith("/") ? raw : url.toString();
  } catch {
    return undefined;
  }
}

const CREDENTIAL_QUERY_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "credential",
  "credentials",
  "jwt",
  "password",
  "refreshtoken",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "sig",
  "signature",
  "token",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
  "xapikey",
]);

function hasCredentialQuery(parameters: URLSearchParams): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    if (value.trim() && CREDENTIAL_QUERY_NAMES.has(normalizedName)) return true;
  }
  return false;
}
