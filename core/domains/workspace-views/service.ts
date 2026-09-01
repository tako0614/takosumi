import type {
  ActorContext,
  FormAvailability,
  ResourceManagedBy,
  ResourcePhase,
  ResourceResolutionStatus,
  ResourceShapeKind,
} from "takosumi-contract";
import { TAKOSUMI_API_VERSION } from "takosumi-contract/capabilities";
import type { PublicCapsule } from "takosumi-contract/capsules";
import {
  clampPageLimit,
  type Page,
  type PageParams,
} from "takosumi-contract/pagination";
import { publicCapsule } from "../deploy-control/mod.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type {
  ResourceShapeRecord,
  ResourceShapeStores,
  ResolutionLockRecord,
} from "../resource-shape/mod.ts";
import type { ResourceShapeService } from "../resource-shape/service.ts";

export type WorkspaceViewControlStore = Pick<
  OpenTofuControlStore,
  "getWorkspace" | "getWorkspaceMember" | "listCapsulesPage"
>;

export type WorkspaceViewErrorCode =
  | "workspace_view_access_denied"
  | "workspace_view_cursor_invalid";

export class WorkspaceViewError extends Error {
  readonly code: WorkspaceViewErrorCode;

  constructor(code: WorkspaceViewErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceViewError";
    this.code = code;
  }
}

export interface WorkspaceResourceSummary {
  readonly id: string;
  readonly apiVersion: typeof TAKOSUMI_API_VERSION;
  readonly kind: ResourceShapeKind;
  readonly metadata: {
    readonly name: string;
    readonly space: string;
    readonly project?: string;
    readonly environment?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly managedBy: ResourceManagedBy;
  };
  readonly status: {
    readonly phase: ResourcePhase;
    readonly observedGeneration: number;
    readonly resolution?: ResourceResolutionStatus;
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
  readonly workloads: WorkspaceViewPage<PublicCapsule>;
  readonly forms: WorkspaceViewPage<FormAvailability>;
  readonly hasTargetPool: boolean;
}

export interface WorkspaceViews {
  readResources(input: {
    readonly workspaceId: string;
    readonly space: string;
    readonly subject: string;
    readonly credentialWorkspaceId?: string;
    readonly requiredAccess: "read" | "write";
    readonly page: PageParams;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceResourcesView>;
}

export interface WorkspaceResourcesProjectionReader {
  read(input: {
    readonly workspaceId: string;
    readonly space: string;
    /** `null` means this child page was exhausted by an earlier response. */
    readonly resources: PageParams | null;
    readonly workloads: PageParams | null;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly resources: Page<WorkspaceResourceSummary>;
    readonly workloads: Page<PublicCapsule>;
  }>;
}

export type WorkspaceViewControlStoreFactory = () => WorkspaceViewControlStore;

export interface WorkspaceViewsServiceOptions {
  readonly controlStoreFactory: WorkspaceViewControlStoreFactory;
  readonly resourceStores: Pick<
    ResourceShapeStores,
    "resources" | "locks" | "targetPools"
  >;
  readonly resourceShapeService: Pick<
    ResourceShapeService,
    "readFormAvailability"
  >;
  /** Durable operation-shaped projection. Omitted only by in-memory tests. */
  readonly resourcesProjectionReader?: WorkspaceResourcesProjectionReader;
}

const CURSOR_VIEW = "takosumi.workspace-resources";
const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 4096;

interface WorkspaceResourcesCursor {
  readonly view: typeof CURSOR_VIEW;
  readonly version: typeof CURSOR_VERSION;
  /** `null` means this child page was exhausted by an earlier response. */
  readonly resources: string | null;
  readonly workloads: string | null;
  readonly forms: string | null;
}

export class WorkspaceViewsService implements WorkspaceViews {
  readonly #controlStoreFactory: WorkspaceViewControlStoreFactory;
  readonly #resourceStores: WorkspaceViewsServiceOptions["resourceStores"];
  readonly #resourceShapeService: WorkspaceViewsServiceOptions["resourceShapeService"];
  readonly #resourcesProjectionReader: WorkspaceResourcesProjectionReader | undefined;

  constructor(options: WorkspaceViewsServiceOptions) {
    this.#controlStoreFactory = options.controlStoreFactory;
    this.#resourceStores = options.resourceStores;
    this.#resourceShapeService = options.resourceShapeService;
    this.#resourcesProjectionReader = options.resourcesProjectionReader;
  }

  async readResources(
    input: Parameters<WorkspaceViews["readResources"]>[0],
  ): Promise<WorkspaceResourcesView> {
    // Resolve exactly one store for this operation. Worker compositions inject
    // a request-scoped D1 factory; node/in-memory compositions close over the
    // already shared store.
    const controlStore = this.#controlStoreFactory();

    if (
      input.workspaceId === "" ||
      input.space !== input.workspaceId ||
      input.subject === "" ||
      (input.requiredAccess !== "read" && input.requiredAccess !== "write") ||
      (input.credentialWorkspaceId !== undefined &&
        input.credentialWorkspaceId !== input.workspaceId)
    ) {
      throw accessDenied();
    }
    const cursor = decodeWorkspaceResourcesCursor(input.page.cursor);
    throwIfAborted(input.signal);

    const [workspace, member] = await Promise.all([
      controlStore.getWorkspace(input.workspaceId),
      controlStore.getWorkspaceMember(input.workspaceId, input.subject),
    ]);
    if (!workspace) throw accessDenied();

    const isOwner = workspace.ownerUserId === input.subject;
    const isActiveMember =
      member?.workspaceId === input.workspaceId &&
      member.accountId === input.subject &&
      member.status === "active";
    if (!isOwner && !isActiveMember) throw accessDenied();

    const roles = derivedActorRoles({
      isOwner,
      memberRoles: isActiveMember ? member.roles : [],
    });
    if (
      input.requiredAccess === "write" &&
      !roles.includes("owner") &&
      !roles.includes("admin")
    ) {
      throw accessDenied();
    }
    throwIfAborted(input.signal);

    const actor: ActorContext = {
      actorAccountId: input.subject,
      workspaceId: input.workspaceId,
      roles,
      requestId: `workspace-view:${crypto.randomUUID()}`,
      principalKind: "account",
    };
    const limit = clampPageLimit(input.page.limit);
    const resourcesParams =
      cursor?.resources === null
        ? null
        : childPageParams(cursor?.resources, limit);
    const workloadsParams =
      cursor?.workloads === null
        ? null
        : childPageParams(cursor?.workloads, limit);
    const projectionRead = this.#resourcesProjectionReader
      ? this.#resourcesProjectionReader.read({
          workspaceId: input.workspaceId,
          space: input.space,
          resources: resourcesParams,
          workloads: workloadsParams,
          ...(input.signal ? { signal: input.signal } : {}),
        })
      : this.#readGenericProjection({
          controlStore,
          space: input.space,
          workspaceId: input.workspaceId,
          resources: resourcesParams,
          workloads: workloadsParams,
        });
    const formsRead = this.#resourceShapeService.readFormAvailability({
      actor,
      space: input.space,
      includeForms: cursor?.forms !== null,
      page: childPageParams(cursor?.forms, limit),
    });
    const [projection, formAvailability] = await Promise.all([
      projectionRead,
      formsRead,
    ]);
    throwIfAborted(input.signal);

    const resourcePage = projectPage(
      projection.resources,
      cursor?.resources,
      (resource) => resource,
    );
    const workloadPage = projectPage(
      projection.workloads,
      cursor?.workloads,
      (workload) => workload,
    );
    const formPage = projectPage(
      formAvailability.forms,
      cursor?.forms,
      (form) => form,
    );
    const next = nextWorkspaceResourcesCursor({
      resources:
        cursor?.resources === null
          ? null
          : projection.resources.nextCursor ?? null,
      workloads:
        cursor?.workloads === null
          ? null
          : projection.workloads.nextCursor ?? null,
      forms:
        cursor?.forms === null
          ? null
          : formAvailability.forms.nextCursor ?? null,
    });

    return {
      view: "resources.v1",
      workspaceId: input.workspaceId,
      space: input.space,
      ...(next ? { nextCursor: next } : {}),
      resources: resourcePage,
      workloads: workloadPage,
      forms: formPage,
      hasTargetPool: formAvailability.hasTargetPool,
    };
  }

  async #readGenericProjection(input: {
    readonly controlStore: WorkspaceViewControlStore;
    readonly space: string;
    readonly workspaceId: string;
    readonly resources: PageParams | null;
    readonly workloads: PageParams | null;
  }): Promise<{
    readonly resources: Page<WorkspaceResourceSummary>;
    readonly workloads: Page<PublicCapsule>;
  }> {
    const resourcesRead: Promise<Page<ResourceShapeRecord>> = input.resources
      ? this.#resourceStores.resources.listBySpacePage(
          input.space,
          input.resources,
        )
      : Promise.resolve({ items: [] });
    const locksRead = resourcesRead.then((page) =>
      page.items.length === 0
        ? Promise.resolve([] as readonly ResolutionLockRecord[])
        : this.#resourceStores.locks.getMany(page.items.map((item) => item.id)),
    );
    const workloadsRead = input.workloads
      ? input.controlStore.listCapsulesPage(input.workspaceId, {
          ...input.workloads,
          includeDestroyed: false,
        })
      : Promise.resolve({ items: [] });
    const [resources, locks, workloads] = await Promise.all([
      resourcesRead,
      locksRead,
      workloadsRead,
    ]);
    const locksByResourceId = new Map(
      locks.map((lock) => [lock.resourceId, lock] as const),
    );
    return {
      resources: mapPage(resources, (resource) =>
        projectResourceSummary(resource, locksByResourceId.get(resource.id)),
      ),
      workloads: mapPage(workloads, publicCapsule),
    };
  }
}

function accessDenied(): WorkspaceViewError {
  return new WorkspaceViewError(
    "workspace_view_access_denied",
    "Workspace view access denied",
  );
}

function invalidCursor(): WorkspaceViewError {
  return new WorkspaceViewError(
    "workspace_view_cursor_invalid",
    "Workspace view cursor is invalid",
  );
}

function derivedActorRoles(input: {
  readonly isOwner: boolean;
  readonly memberRoles: readonly string[];
}): string[] {
  const roles = new Set<string>();
  if (input.isOwner) roles.add("owner");
  for (const role of input.memberRoles) {
    // The Workspace row is the owner authority. A stale/malformed member row
    // must never manufacture owner authority for a different subject.
    if (role !== "owner" || input.isOwner) roles.add(role);
  }
  return [...roles].sort();
}

function projectResourceSummary(
  resource: ResourceShapeRecord,
  lock: ResolutionLockRecord | undefined,
): WorkspaceResourceSummary {
  return {
    id: resource.id,
    apiVersion: TAKOSUMI_API_VERSION,
    kind: resource.kind,
    metadata: {
      name: resource.name,
      space: resource.spaceId,
      ...(resource.project !== undefined ? { project: resource.project } : {}),
      ...(resource.environment !== undefined
        ? { environment: resource.environment }
        : {}),
      ...(resource.labels !== undefined
        ? { labels: { ...resource.labels } }
        : {}),
      managedBy: resource.managedBy,
    },
    status: {
      phase: resource.phase,
      observedGeneration: resource.observedGeneration,
      ...(lock
        ? {
            resolution: {
              selectedImplementation: lock.selectedImplementation,
              target: lock.target,
              locked: lock.locked,
              portability: lock.portability ?? "partial",
            },
          }
        : {}),
    },
  };
}

function projectPage<T, U>(
  page: Page<T>,
  inputCursor: string | null | undefined,
  project: (item: T) => U,
): WorkspaceViewPage<U> {
  if (inputCursor === null) return { items: [] };
  return {
    items: page.items.map(project),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function mapPage<T, U>(page: Page<T>, project: (item: T) => U): Page<U> {
  return {
    items: page.items.map(project),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  };
}

function childPageParams<T extends object>(
  cursor: string | null | undefined,
  limit: number,
  extra?: T,
): PageParams & T {
  return {
    ...(extra ?? ({} as T)),
    limit,
    ...(typeof cursor === "string" ? { cursor } : {}),
  };
}

function nextWorkspaceResourcesCursor(input: {
  readonly resources: string | null;
  readonly workloads: string | null;
  readonly forms: string | null;
}): string | undefined {
  if (
    input.resources === null &&
    input.workloads === null &&
    input.forms === null
  ) {
    return undefined;
  }
  return encodeBase64Url(
    JSON.stringify({
      view: CURSOR_VIEW,
      version: CURSOR_VERSION,
      resources: input.resources,
      workloads: input.workloads,
      forms: input.forms,
    } satisfies WorkspaceResourcesCursor),
  );
}

function decodeWorkspaceResourcesCursor(
  value: string | undefined,
): WorkspaceResourcesCursor | undefined {
  if (value === undefined) return undefined;
  if (
    value === "" ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length % 4 === 1
  ) {
    throw invalidCursor();
  }
  try {
    const decoded = decodeBase64Url(value);
    const parsed = JSON.parse(decoded) as unknown;
    if (!isWorkspaceResourcesCursor(parsed)) throw invalidCursor();
    return parsed;
  } catch (error) {
    if (error instanceof WorkspaceViewError) throw error;
    throw invalidCursor();
  }
}

function isWorkspaceResourcesCursor(
  value: unknown,
): value is WorkspaceResourcesCursor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const cursor = value as Partial<WorkspaceResourcesCursor>;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 5 ||
    keys.join(",") !== "forms,resources,version,view,workloads" ||
    cursor.view !== CURSOR_VIEW ||
    cursor.version !== CURSOR_VERSION
  ) {
    return false;
  }
  const validChild = (child: unknown): child is string | null =>
    child === null ||
    (typeof child === "string" &&
      child.length > 0 &&
      child.length <= MAX_CURSOR_LENGTH &&
      /^[A-Za-z0-9_-]+$/u.test(child));
  return (
    validChild(cursor.resources) &&
    validChild(cursor.workloads) &&
    validChild(cursor.forms) &&
    (cursor.resources !== null ||
      cursor.workloads !== null ||
      cursor.forms !== null)
  );
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string {
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
