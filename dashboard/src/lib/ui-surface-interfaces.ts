import type {
  CapsuleInterfaceBlueprint,
  Interface,
  InterfaceBinding,
} from "takosumi-contract";
import {
  hasCredentialQueryParams,
  isValidInterfaceName,
  parseInterfaceDisplay,
  TAKOSUMI_API_VERSION,
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";

// Contract-owned wire tokens (`takosumi-contract/interface-types`); this
// module stays the dashboard's type/version consumer but no longer redefines
// the literals.
export { UI_SURFACE_INTERFACE_TYPE, UI_SURFACE_INTERFACE_VERSION };
export const UI_SURFACE_PERMISSION = UI_SURFACE_OPEN_PERMISSION;

/**
 * Whether a reviewed InstallConfig promises an installer-authorized launcher.
 * Completion must wait for this projection instead of falling back to a
 * workload link and claiming that the service is ready to open.
 */
export function installConfigRequiresUiSurface(
  blueprints: readonly CapsuleInterfaceBlueprint[] | undefined,
): boolean {
  return (blueprints ?? []).some(
    (blueprint) =>
      blueprint.spec.type === UI_SURFACE_INTERFACE_TYPE &&
      blueprint.spec.version === UI_SURFACE_INTERFACE_VERSION &&
      (blueprint.bindings ?? []).some((binding) =>
        binding.permissions.includes(UI_SURFACE_OPEN_PERMISSION),
      ),
  );
}

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

const MAX_UI_SURFACE_PAGES = 10_000;

export async function listAuthorizedUiSurfaces(
  workspaceId: string,
  options: UiSurfaceReadOptions = {},
): Promise<readonly AuthorizedUiSurface[]> {
  const normalizedWorkspaceId = requiredId(workspaceId, "workspaceId");
  const normalizedCapsuleId =
    options.capsuleId === undefined
      ? undefined
      : requiredId(options.capsuleId, "capsuleId");
  const params = new URLSearchParams();
  if (normalizedCapsuleId !== undefined) {
    params.set("capsuleId", normalizedCapsuleId);
  }
  const basePath = `/api/v1/workspaces/${encodeURIComponent(normalizedWorkspaceId)}/ui-surfaces`;
  const interfaces: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_UI_SURFACE_PAGES; page += 1) {
    const pageParams = new URLSearchParams(params);
    if (cursor !== undefined) pageParams.set("cursor", cursor);
    const query = pageParams.size > 0 ? `?${pageParams.toString()}` : "";
    const body = await fetchJson(`${basePath}${query}`, options);
    if (!isRecord(body) || !Array.isArray(body.interfaces)) {
      throw new Error("UI surface list response is invalid");
    }
    interfaces.push(...body.interfaces);

    if (body.nextCursor === undefined) {
      cursor = undefined;
      break;
    }
    if (typeof body.nextCursor !== "string" || body.nextCursor.trim() === "") {
      throw new Error("UI surface list pagination cursor is invalid");
    }
    if (seenCursors.has(body.nextCursor)) {
      throw new Error("UI surface list pagination cursor repeated");
    }
    seenCursors.add(body.nextCursor);
    cursor = body.nextCursor;
  }
  if (cursor !== undefined) {
    throw new Error("UI surface list pagination exceeded its safety limit");
  }

  const candidates = interfaces
    .map((value) => parseUiSurfaceInterface(value, normalizedWorkspaceId))
    .filter(
      (value): value is UiSurfaceCandidate =>
        value !== null &&
        (normalizedCapsuleId === undefined ||
          value.capsuleId === normalizedCapsuleId),
    );

  return candidates.map(stripInterface).sort(compareAuthorizedUiSurfaces);
}

export function parseUiSurfaceInterface(
  value: unknown,
  workspaceId: string,
): UiSurfaceCandidate | null {
  const record = isRecord(value) ? value : null;
  const metadata = record && isRecord(record.metadata) ? record.metadata : null;
  const ownerRef =
    metadata && isRecord(metadata.ownerRef) ? metadata.ownerRef : null;
  const launcherOwner =
    record && isRecord(record.launcherOwner) ? record.launcherOwner : null;
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
  const capsuleOwned = ownerRef?.kind === "Capsule";
  const resourceOwned = ownerRef?.kind === "Resource";
  const capsuleId = capsuleOwned
    ? text(ownerRef?.id)
    : resourceOwned
      ? text(launcherOwner?.capsuleId)
      : null;
  const legacyUiSurface =
    capsuleOwned &&
    spec?.type === UI_SURFACE_INTERFACE_TYPE &&
    spec.version === UI_SURFACE_INTERFACE_VERSION &&
    Boolean(urlInput && isSupportedInputSource(urlInput.source));
  const portableLauncher =
    resourceOwned && explicitLauncherInput(document, inputs) !== null;
  if (
    record?.apiVersion !== TAKOSUMI_API_VERSION ||
    record.kind !== "Interface" ||
    metadata?.workspaceId !== workspaceId ||
    !interfaceId ||
    !interfaceName ||
    !isValidInterfaceName(interfaceName) ||
    (!capsuleOwned && !resourceOwned) ||
    !capsuleId ||
    generation === null ||
    generation < 1 ||
    observedGeneration !== generation ||
    (!legacyUiSurface && !portableLauncher) ||
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

  const url = legacyUiSurface
    ? safeRuntimeUrl(resolvedInputs.url)
    : portableLauncherUrl(document, inputs, resolvedInputs);
  if (!url) return null;
  // The dashboard origin is where the tile <img> is fetched from, and that
  // fetch carries the account session cookie. Hand it to the parser so a
  // Capsule can never point its icon at our own credentialed endpoints.
  const display = parseInterfaceDisplay(document.display, {
    surfaceUrl: url,
    ...(typeof location === "undefined"
      ? {}
      : { viewerOrigin: location.origin }),
  });
  const icon =
    display.icon === undefined
      ? undefined
      : display.icon.kind === "image"
        ? display.icon.url
        : display.icon.glyph;
  return {
    interface: value as Interface,
    interfaceId,
    capsuleId,
    resolvedRevision,
    ...(display.title !== undefined ? { name: display.title } : {}),
    ...(display.description !== undefined
      ? { description: display.description }
      : {}),
    ...(icon !== undefined ? { icon } : {}),
    ...(display.category !== undefined ? { category: display.category } : {}),
    ...(display.sortOrder !== undefined
      ? { sortOrder: display.sortOrder }
      : {}),
    url,
  };
}

function explicitLauncherInput(
  document: Record<string, unknown> | null,
  inputs: Record<string, unknown> | null,
): string | null {
  const endpoint =
    document && isRecord(document.endpoint) ? document.endpoint : null;
  const inputName = text(endpoint?.originInput);
  const declared = inputName && inputs ? inputs[inputName] : undefined;
  return inputName &&
    isRecord(declared) &&
    isSupportedInputSource(declared.source) &&
    (endpoint?.path === undefined ||
      (typeof endpoint.path === "string" && endpoint.path.startsWith("/")))
    ? inputName
    : null;
}

function portableLauncherUrl(
  document: Record<string, unknown> | null,
  inputs: Record<string, unknown> | null,
  resolvedInputs: Record<string, unknown>,
): string | null {
  const inputName = explicitLauncherInput(document, inputs);
  if (!inputName || !document) return null;
  const endpoint = isRecord(document.endpoint) ? document.endpoint : null;
  const origin = safeRuntimeUrl(resolvedInputs[inputName]);
  if (!origin || !endpoint) return null;
  const path = typeof endpoint.path === "string" ? endpoint.path : "/";
  try {
    return safeRuntimeUrl(new URL(path, origin).toString());
  } catch {
    return null;
  }
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
    if (hasCredentialQueryParams(url.searchParams)) return null;
    return url.toString();
  } catch {
    return null;
  }
}
