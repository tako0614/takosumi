/**
 * Workspaces domain service (Core Specification §4).
 *
 * A Workspace is first a personal purpose/resource boundary under which
 * Projects and Capsules live. Membership is optional composition around that
 * boundary; it is not what gives the Workspace its identity. The stable
 * `@handle` is a technical identifier and presentation input, not user-owned
 * authority. This service owns Workspace creation and lookup over the shared
 * control-plane ledger plus the handle and bootstrap identity invariants.
 *
 * No secret material flows through this service.
 */

import {
  WORKSPACE_HANDLE_PATTERN,
  type AccountWorkspaceListParams,
  type AccountWorkspacePage,
  type Workspace,
  type WorkspaceMember,
  type WorkspaceMemberStatus,
  type WorkspaceRole,
  type WorkspaceType,
} from "takosumi-contract/workspaces";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";
import type { Page, PageParams } from "takosumi-contract/pagination";

// The contract owns the stable technical API-identifier grammar (lowercase
// alnum start, then 1-38 of `[a-z0-9-]`). This service enforces it while the
// dashboard generates and disambiguates handles from purpose/name input.

export interface CreateWorkspaceRequest {
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
}

export interface WorkspacesServiceDependencies {
  readonly store: OpenTofuControlStore;
  /**
   * Composition-owned hook that establishes the canonical per-Workspace
   * default Project. It is idempotent and keeps Workspace creation from
   * producing a Project-less namespace.
   */
  readonly ensureDefaultProject?: (workspaceId: string) => Promise<unknown>;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export interface UpsertWorkspaceMemberRequest {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly roles?: readonly WorkspaceRole[];
  readonly status?: WorkspaceMemberStatus;
  readonly actorAccountId: string;
}

export class WorkspacesService {
  readonly #store: OpenTofuControlStore;
  readonly #ensureDefaultProject?: (workspaceId: string) => Promise<unknown>;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;
  /**
   * Serializes personal-Workspace bootstrap per owner inside one service
   * instance. Durable stores still provide the cross-process owner claim;
   * this closes the in-memory/read-before-write window for concurrent logins.
   */
  readonly #personalEnsures = new Map<string, Promise<Workspace>>();

  constructor(deps: WorkspacesServiceDependencies) {
    this.#store = deps.store;
    this.#ensureDefaultProject = deps.ensureDefaultProject;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  async createWorkspace(request: CreateWorkspaceRequest): Promise<Workspace> {
    requireNonEmptyString(request.handle, "handle");
    requireNonEmptyString(request.displayName, "displayName");
    requireNonEmptyString(request.ownerUserId, "ownerUserId");
    if (request.type !== "personal" && request.type !== "organization") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `type must be one of personal, organization`,
      );
    }
    if (!WORKSPACE_HANDLE_PATTERN.test(request.handle)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `handle ${request.handle} must match ${WORKSPACE_HANDLE_PATTERN.source}`,
      );
    }
    const existing = await this.#store.getWorkspaceByHandle(request.handle);
    if (existing) {
      if (workspaceMatchesCreateRequest(existing, request)) {
        await this.#ensureOwnerMember(existing);
        await this.#ensureDefaultProject?.(existing.id);
        return existing;
      }
      throw new OpenTofuControllerError(
        "failed_precondition",
        "workspace already exists",
      );
    }
    const nowIso = this.#now().toISOString();
    const workspace: Workspace = {
      id: this.#newId("ws"),
      handle: request.handle,
      displayName: request.displayName,
      type: request.type,
      ownerUserId: request.ownerUserId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    let created: Workspace;
    try {
      created = await this.#store.putWorkspace(workspace);
    } catch (error) {
      const recovered = await this.#store.getWorkspaceByHandle(request.handle);
      if (!recovered || !workspaceMatchesCreateRequest(recovered, request)) {
        throw error;
      }
      created = recovered;
    }
    await this.#ensureOwnerMember(created);
    await this.#ensureDefaultProject?.(created.id);
    return created;
  }

  async getWorkspace(id: string): Promise<Workspace> {
    requireNonEmptyString(id, "id");
    const workspace = await this.#store.getWorkspace(id);
    if (!workspace) {
      throw new OpenTofuControllerError("not_found", "workspace not found");
    }
    return workspace;
  }

  async listWorkspacesByIds(
    ids: readonly string[],
  ): Promise<readonly Workspace[]> {
    const normalizedIds = ids.filter((id) => {
      requireNonEmptyString(id, "id");
      return true;
    });
    return await this.#store.listWorkspacesByIds(normalizedIds);
  }

  /**
   * Updates the mutable, non-identity fields of a Workspace (spec §30 `PATCH
   * /internal/v1/workspaces/:workspaceId`). The handle, type, owner, and billing
   * are immutable here. Bumps `updatedAt`.
   */
  async updateWorkspace(
    id: string,
    patch: {
      readonly displayName?: string;
      readonly policy?: Workspace["policy"];
      readonly archived?: boolean;
    },
  ): Promise<Workspace> {
    requireNonEmptyString(id, "id");
    if (patch.displayName !== undefined) {
      requireNonEmptyString(patch.displayName, "displayName");
    }
    if (
      patch.policy !== undefined &&
      (typeof patch.policy !== "object" ||
        patch.policy === null ||
        Array.isArray(patch.policy))
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "policy must be an object",
      );
    }
    if (
      patch.displayName === undefined &&
      patch.policy === undefined &&
      patch.archived === undefined
    ) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "displayName, policy, or archived is required",
      );
    }
    const workspace = await this.getWorkspace(id);
    const nowIso = this.#now().toISOString();
    const updated: Workspace = {
      ...workspace,
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName }
        : {}),
      ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
      ...(patch.archived === true
        ? { archivedAt: workspace.archivedAt ?? nowIso }
        : {}),
      updatedAt: nowIso,
    };
    if (patch.archived === false) {
      delete (updated as { archivedAt?: string }).archivedAt;
    }
    return await this.#store.putWorkspace(updated);
  }

  async getWorkspaceByHandle(handle: string): Promise<Workspace | undefined> {
    requireNonEmptyString(handle, "handle");
    return await this.#store.getWorkspaceByHandle(handle);
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    return await this.#store.listWorkspaces();
  }

  /** Bounded operator scan over the complete durable Workspace ledger. */
  async listWorkspacesPage(params: PageParams): Promise<Page<Workspace>> {
    return await this.#store.listWorkspacesPage(params);
  }

  /**
   * Lists only the Workspaces directly owned by `ownerUserId` (spec §4). Scopes
   * the dashboard session list (`GET /api/v1/workspaces`) to the caller's own
   * workspaces instead of loading every tenant's Workspace and filtering in the
   * route.
   */
  async listWorkspacesByOwner(
    ownerUserId: string,
  ): Promise<readonly Workspace[]> {
    requireNonEmptyString(ownerUserId, "ownerUserId");
    return await this.#store.listWorkspacesByOwner(ownerUserId);
  }

  /** Lists Workspaces where the account has an active canonical membership. */
  async listWorkspacesForAccount(
    accountId: string,
  ): Promise<readonly Workspace[]> {
    requireNonEmptyString(accountId, "accountId");
    const workspaces: Workspace[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.#store.listWorkspacesForAccountPage(accountId, {
        includeArchived: true,
        includeTotal: false,
        order: "created_asc",
        ...(cursor ? { cursor } : {}),
      });
      workspaces.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return workspaces;
  }

  /**
   * Bounded account-scoped list over the canonical active membership join.
   * Durable stores push archive filtering, order, cursor, and limit into SQL.
   */
  async listWorkspacesForAccountPage(
    accountId: string,
    params: AccountWorkspaceListParams,
  ): Promise<AccountWorkspacePage> {
    requireNonEmptyString(accountId, "accountId");
    return await this.#store.listWorkspacesForAccountPage(accountId, params);
  }

  /** Exact active-membership lookup used when a selected Workspace is off-page. */
  async getWorkspaceForAccount(
    accountId: string,
    workspaceId: string,
  ): Promise<Workspace | undefined> {
    requireNonEmptyString(accountId, "accountId");
    requireNonEmptyString(workspaceId, "workspaceId");
    const member = await this.#store.getWorkspaceMember(workspaceId, accountId);
    if (member?.status !== "active") return undefined;
    return await this.#store.getWorkspace(workspaceId);
  }

  /** Exact membership lookup for authorization hot paths. */
  async getWorkspaceMember(
    workspaceId: string,
    accountId: string,
  ): Promise<WorkspaceMember | undefined> {
    requireNonEmptyString(workspaceId, "workspaceId");
    requireNonEmptyString(accountId, "accountId");
    return await this.#store.getWorkspaceMember(workspaceId, accountId);
  }

  /** Returns the single canonical WorkspaceMember roster. */
  async listWorkspaceMembers(
    workspaceId: string,
  ): Promise<readonly WorkspaceMember[]> {
    const workspace = await this.getWorkspace(workspaceId);
    await this.#ensureOwnerMember(workspace);
    return await this.#store.listWorkspaceMembers(workspaceId);
  }

  /**
   * Adds or updates a member after checking the actor against the same durable
   * roster. Removal is represented by `status: "suspended"`.
   */
  async upsertWorkspaceMember(
    request: UpsertWorkspaceMemberRequest,
  ): Promise<WorkspaceMember> {
    requireNonEmptyString(request.workspaceId, "workspaceId");
    requireNonEmptyString(request.accountId, "accountId");
    requireNonEmptyString(request.actorAccountId, "actorAccountId");
    const workspace = await this.getWorkspace(request.workspaceId);
    await this.#ensureOwnerMember(workspace);
    const members = await this.#store.listWorkspaceMembers(workspace.id);
    const actor = members.find(
      (member) => member.accountId === request.actorAccountId,
    );
    if (
      !actor ||
      actor.status !== "active" ||
      (!actor.roles.includes("owner") && !actor.roles.includes("admin"))
    ) {
      throw new OpenTofuControllerError(
        "permission_denied",
        "actor cannot manage Workspace members",
      );
    }
    const existing = members.find(
      (member) => member.accountId === request.accountId,
    );
    const roles = normalizeRoles(
      request.roles ?? existing?.roles ?? ["member"],
    );
    const status = request.status ?? existing?.status ?? "active";
    if (!isWorkspaceMemberStatus(status)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "status must be one of active, invited, suspended",
      );
    }
    if (roles.includes("owner") && !actor.roles.includes("owner")) {
      throw new OpenTofuControllerError(
        "permission_denied",
        "only an owner can grant the owner role",
      );
    }
    if (existing?.roles.includes("owner") && !actor.roles.includes("owner")) {
      throw new OpenTofuControllerError(
        "permission_denied",
        "only an owner can update an owner membership",
      );
    }
    if (request.accountId === workspace.ownerUserId) {
      if (status !== "active" || !roles.includes("owner")) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "the Workspace namespace owner must remain an active owner",
        );
      }
    }
    const dropsActiveOwner =
      existing?.status === "active" &&
      existing.roles.includes("owner") &&
      (status !== "active" || !roles.includes("owner"));
    if (
      dropsActiveOwner &&
      members.filter(
        (member) =>
          member.status === "active" && member.roles.includes("owner"),
      ).length <= 1
    ) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        "cannot remove or demote the last active owner",
      );
    }
    const nowIso = this.#now().toISOString();
    return await this.#store.putWorkspaceMember({
      id: existing?.id ?? this.#newId("wsm"),
      workspaceId: workspace.id,
      accountId: request.accountId,
      roles,
      status,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
  }

  /**
   * Idempotent personal-Workspace creation for the accounts-plane login hook
   * (wired in M9).
   *
   * `handle` is a presentation preference, not an ownership key. A preferred
   * handle may already belong to another account or to an organization, in
   * which case this method derives subject-based fallbacks and, if all
   * predictable handles are occupied, a fresh non-user-derived candidate. The
   * durable store first returns the exact bootstrap claim, otherwise atomically
   * adopts the owner's oldest personal Workspace, and only creates a new row
   * when none exists.
   */
  async ensurePersonalWorkspace(
    ownerUserId: string,
    handle: string,
  ): Promise<Workspace> {
    requireNonEmptyString(ownerUserId, "ownerUserId");
    requireNonEmptyString(handle, "handle");

    const pending = this.#personalEnsures.get(ownerUserId);
    if (pending) return await pending;

    const operation = this.#ensurePersonalWorkspaceOnce(ownerUserId, handle);
    this.#personalEnsures.set(ownerUserId, operation);
    try {
      return await operation;
    } finally {
      if (this.#personalEnsures.get(ownerUserId) === operation) {
        this.#personalEnsures.delete(ownerUserId);
      }
    }
  }

  async #ensurePersonalWorkspaceOnce(
    ownerUserId: string,
    preferredHandle: string,
  ): Promise<Workspace> {
    for (const candidateHandle of personalWorkspaceHandleCandidates(
      ownerUserId,
      preferredHandle,
      freshPersonalWorkspaceHandle,
    )) {
      const nowIso = this.#now().toISOString();
      const claimed = await this.#store.claimPersonalWorkspaceBootstrap(
        ownerUserId,
        {
          id: this.#newId("ws"),
          handle: candidateHandle,
          displayName: candidateHandle,
          type: "personal",
          ownerUserId,
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      );
      if (!claimed) continue;
      if (!isOwnedPersonalWorkspace(claimed, ownerUserId)) {
        throw new OpenTofuControllerError(
          "failed_precondition",
          "personal Workspace bootstrap ownership did not match the requested account",
        );
      }
      return await this.#repairPersonalWorkspace(claimed);
    }
    throw new OpenTofuControllerError(
      "failed_precondition",
      "personal Workspace bootstrap handle candidates are unavailable",
    );
  }

  async #repairPersonalWorkspace(workspace: Workspace): Promise<Workspace> {
    await this.#ensureOwnerMember(workspace);
    await this.#ensureDefaultProject?.(workspace.id);
    return workspace;
  }

  async #ensureOwnerMember(workspace: Workspace): Promise<WorkspaceMember> {
    const existing = await this.#store.getWorkspaceMember(
      workspace.id,
      workspace.ownerUserId,
    );
    if (existing?.status === "active" && existing.roles.includes("owner")) {
      return existing;
    }
    const nowIso = this.#now().toISOString();
    return await this.#store.putWorkspaceMember({
      id: existing?.id ?? this.#newId("wsm"),
      workspaceId: workspace.id,
      accountId: workspace.ownerUserId,
      roles: ["owner"],
      status: "active",
      createdAt: existing?.createdAt ?? workspace.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
  }
}

function workspaceMatchesCreateRequest(
  workspace: Workspace,
  request: CreateWorkspaceRequest,
): boolean {
  return (
    workspace.handle === request.handle &&
    workspace.displayName === request.displayName &&
    workspace.type === request.type &&
    workspace.ownerUserId === request.ownerUserId
  );
}

function isOwnedPersonalWorkspace(
  workspace: Workspace,
  ownerUserId: string,
): boolean {
  return workspace.type === "personal" && workspace.ownerUserId === ownerUserId;
}

/** Stable, valid fallback shared with the Accounts bootstrap convention. */
function fallbackPersonalWorkspaceHandle(subject: string): string {
  const tail = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 36);
  return `u-${tail.length > 0 ? tail : "anon"}`.slice(0, 39);
}

function* personalWorkspaceHandleCandidates(
  ownerUserId: string,
  preferredHandle: string,
  freshHandle: () => string,
): Iterable<string> {
  const fallback = fallbackPersonalWorkspaceHandle(ownerUserId);
  const suffix = `-${stableSubjectDigest(ownerUserId)}`;
  const room = Math.max(2, 39 - suffix.length);
  const disambiguated = `${fallback.slice(0, room)}${suffix}`.replace(
    /-+$/,
    "",
  );
  const deterministic = new Set(
    [preferredHandle, fallback, disambiguated].filter((candidate) =>
      WORKSPACE_HANDLE_PATTERN.test(candidate),
    ),
  );
  yield* deterministic;

  // Deterministic presentation candidates are intentionally predictable and
  // can all be occupied by unrelated rows. Only generate this final candidate
  // after those claims fail; the durable owner slot, rather than this random
  // handle, remains the cross-process convergence authority.
  const fresh = freshHandle();
  if (!deterministic.has(fresh)) yield fresh;
}

/** Fresh non-user-derived escape hatch when every presentation handle is busy. */
function freshPersonalWorkspaceHandle(): string {
  return `p-${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 39);
}

/** Small synchronous digest used only to disambiguate sanitized subjects. */
function stableSubjectDigest(subject: string): string {
  let hash = 2166136261;
  for (const character of subject) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

const WORKSPACE_ROLES: readonly WorkspaceRole[] = [
  "owner",
  "admin",
  "member",
  "viewer",
];

function normalizeRoles(
  roles: readonly WorkspaceRole[],
): readonly WorkspaceRole[] {
  if (
    roles.length === 0 ||
    roles.some((role) => !WORKSPACE_ROLES.includes(role))
  ) {
    throw new OpenTofuControllerError(
      "invalid_argument",
      "roles must contain one or more of owner, admin, member, viewer",
    );
  }
  return [...new Set(roles)];
}

function isWorkspaceMemberStatus(
  value: string,
): value is WorkspaceMemberStatus {
  return value === "active" || value === "invited" || value === "suspended";
}
