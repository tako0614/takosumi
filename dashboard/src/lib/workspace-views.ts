import {
  ControlApiError,
  controlFetch,
  type FormAvailability,
  type Capsule,
} from "./control-api.ts";

export interface WorkspaceResourceSummary {
  readonly id: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly project?: string;
    readonly environment?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly managedBy: string;
  };
  readonly status?: {
    readonly phase: string;
    readonly observedGeneration: number;
    readonly resolution?: {
      readonly selectedImplementation: string;
      readonly target: string;
      readonly locked: boolean;
      readonly portability: string;
    };
  };
}

export interface WorkspaceViewPage<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface WorkspaceResourcesView {
  readonly view: "resources.v1";
  readonly workspaceId: string;
  readonly space: string;
  readonly nextCursor?: string;
  readonly resources: WorkspaceViewPage<WorkspaceResourceSummary>;
  readonly workloads: WorkspaceViewPage<Capsule>;
  readonly forms: WorkspaceViewPage<FormAvailability>;
  readonly hasTargetPool: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_ACCUMULATED_PAGES = 20;

export async function readWorkspaceResourcesView(
  workspaceId: string,
  options: {
    readonly limit?: number;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<WorkspaceResourcesView> {
  const requestedLimit =
    options.limit !== undefined && Number.isFinite(options.limit)
      ? options.limit
      : DEFAULT_LIMIT;
  const limit = Math.min(Math.max(1, Math.trunc(requestedLimit)), MAX_LIMIT);
  let page = await readWorkspaceResourcesViewPage(workspaceId, {
    limit,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const seenCursors = new Set<string>();
  if (options.cursor) seenCursors.add(options.cursor);

  for (
    let pageNumber = 1;
    pageNumber < MAX_ACCUMULATED_PAGES && page.nextCursor;
    pageNumber += 1
  ) {
    const cursor = page.nextCursor;
    if (seenCursors.has(cursor)) break;
    seenCursors.add(cursor);
    const nextPage = await readWorkspaceResourcesViewPage(workspaceId, {
      limit,
      cursor,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    page = mergeWorkspaceResourcesViews(page, nextPage);
  }
  return page;
}

async function readWorkspaceResourcesViewPage(
  workspaceId: string,
  options: {
    readonly limit: number;
    readonly cursor?: string;
    readonly signal?: AbortSignal;
  },
): Promise<WorkspaceResourcesView> {
  const params = new URLSearchParams({ limit: String(options.limit) });
  if (options.cursor) params.set("cursor", options.cursor);
  const body = await controlFetch<unknown>(
    `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/views/resources.v1?${params.toString()}`,
    { signal: options.signal },
  );
  return parseWorkspaceResourcesView(body, workspaceId);
}

function mergeWorkspaceResourcesViews(
  current: WorkspaceResourcesView,
  next: WorkspaceResourcesView,
): WorkspaceResourcesView {
  return {
    ...next,
    ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
    resources: mergeWorkspaceViewPage(current.resources, next.resources),
    workloads: mergeWorkspaceViewPage(current.workloads, next.workloads),
    forms: mergeWorkspaceViewPage(current.forms, next.forms),
  };
}

function mergeWorkspaceViewPage<T>(
  current: WorkspaceViewPage<T>,
  next: WorkspaceViewPage<T>,
): WorkspaceViewPage<T> {
  return {
    items: [...current.items, ...next.items],
    ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
  };
}

function parseWorkspaceResourcesView(
  value: unknown,
  workspaceId: string,
): WorkspaceResourcesView {
  if (!isRecord(value)) throw invalidViewResponse();
  if (
    value.view !== "resources.v1" ||
    value.workspaceId !== workspaceId ||
    value.space !== workspaceId ||
    typeof value.hasTargetPool !== "boolean" ||
    (value.nextCursor !== undefined && typeof value.nextCursor !== "string")
  ) {
    throw invalidViewResponse();
  }
  return {
    view: "resources.v1",
    workspaceId,
    space: workspaceId,
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
    resources: parsePage(value.resources, parseResourceSummary),
    workloads: parsePage(value.workloads, parseCapsule),
    forms: parsePage(value.forms, parseFormAvailability),
    hasTargetPool: value.hasTargetPool,
  };
}

function parsePage<T>(
  value: unknown,
  parseItem: (value: unknown) => T,
): WorkspaceViewPage<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw invalidViewResponse();
  }
  if (value.nextCursor !== undefined && typeof value.nextCursor !== "string") {
    throw invalidViewResponse();
  }
  return {
    items: value.items.map(parseItem),
    ...(typeof value.nextCursor === "string"
      ? { nextCursor: value.nextCursor }
      : {}),
  };
}

function parseResourceSummary(value: unknown): WorkspaceResourceSummary {
  if (!isRecord(value) || !isRecord(value.metadata)) {
    throw invalidViewResponse();
  }
  const metadata = value.metadata;
  if (
    !isString(value.id) ||
    !isString(value.apiVersion) ||
    !isString(value.kind) ||
    !isString(metadata.name) ||
    !isString(metadata.space) ||
    !isString(metadata.managedBy)
  ) {
    throw invalidViewResponse();
  }
  if (
    (metadata.project !== undefined && !isString(metadata.project)) ||
    (metadata.environment !== undefined && !isString(metadata.environment)) ||
    (metadata.labels !== undefined && !isStringRecord(metadata.labels))
  ) {
    throw invalidViewResponse();
  }
  if (value.status !== undefined) {
    if (
      !isRecord(value.status) ||
      !isString(value.status.phase) ||
      !Number.isSafeInteger(value.status.observedGeneration)
    ) {
      throw invalidViewResponse();
    }
  }
  return value as unknown as WorkspaceResourceSummary;
}

function parseCapsule(value: unknown): Capsule {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.workspaceId) ||
    !isString(value.name) ||
    !isString(value.slug) ||
    !isString(value.installConfigId) ||
    !isString(value.environment) ||
    !Number.isSafeInteger(value.currentStateGeneration) ||
    !isString(value.status) ||
    !isString(value.createdAt) ||
    !isString(value.updatedAt)
  ) {
    throw invalidViewResponse();
  }
  return value as unknown as Capsule;
}

function parseFormAvailability(value: unknown): FormAvailability {
  if (
    !isRecord(value) ||
    !isRecord(value.form) ||
    !isString(value.form.type) ||
    !isString(value.form.version) ||
    !isString(value.form.schemaDigest) ||
    !isString(value.form.packageDigest) ||
    !isBoolean(value.definitionKnown) ||
    !isBoolean(value.installed) ||
    !isBoolean(value.executable) ||
    !isBoolean(value.activated) ||
    !isBoolean(value.availableToPrincipal) ||
    !isStringArray(value.operations) ||
    !isStringArray(value.compatibleAdapterIds) ||
    !isStringArray(value.eligibleTargetPoolClasses) ||
    !isBoolean(value.deprecated)
  ) {
    throw invalidViewResponse();
  }
  return value as unknown as FormAvailability;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function invalidViewResponse(): never {
  throw new ControlApiError(
    502,
    "invalid_response",
    "Resources Workspace view response is invalid",
  );
}
