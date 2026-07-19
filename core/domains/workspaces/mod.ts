/**
 * Workspaces domain service (Core Specification §4).
 *
 * A Workspace is the owner namespace (`@handle`) directly under which Projects
 * and Capsules live — close to a source-forge or organization namespace. This service owns Workspace
 * creation and lookup over the shared control-plane ledger. Members, billing,
 * and policy are layered on later milestones; this milestone covers the
 * identity + handle uniqueness invariants the rest of the model keys on.
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

// The handle grammar (spec §4: lowercase alnum start, then 1-38 of `[a-z0-9-]`,
// 2-39 total) is defined once in the contract so the dashboard create form and
// this service validate against the exact same pattern.

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
    const created = await this.#store.putWorkspace(workspace);
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
   * (wired in M9). Returns the existing Workspace when the handle is already
   * taken so a repeated login never errors or creates a duplicate; otherwise
   * creates a `personal` Workspace owned by the user. The caller is responsible
   * for choosing a handle that uniquely maps to the user.
   */
  async ensurePersonalWorkspace(
    ownerUserId: string,
    handle: string,
  ): Promise<Workspace> {
    requireNonEmptyString(ownerUserId, "ownerUserId");
    requireNonEmptyString(handle, "handle");
    const existing = await this.#store.getWorkspaceByHandle(handle);
    if (existing) {
      await this.#ensureDefaultProject?.(existing.id);
      return existing;
    }
    return await this.createWorkspace({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId,
    });
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
