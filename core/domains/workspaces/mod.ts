/**
 * Workspaces domain service (Core Specification §4).
 *
 * A Workspace is the owner namespace (`@handle`) directly under which Projects
 * and Capsules live — close to a GitHub user/org. This service owns Workspace
 * creation and lookup over the shared control-plane ledger. Members, billing,
 * and policy are layered on later milestones; this milestone covers the
 * identity + handle uniqueness invariants the rest of the model keys on.
 *
 * No secret material flows through this service.
 *
 * (Formerly `SpacesService` / `Space`. The transient `Space` contract alias and
 * the spine store's `*Space*` method names stay until the rename converges.)
 */

import type { Workspace, WorkspaceType } from "takosumi-contract/workspaces";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/**
 * Workspace handle grammar (spec §4): lowercase alnum start, then 1-38 of
 * `[a-z0-9-]`, for a total length of 2-39. Mirrors the GitHub-style owner
 * namespace shape so `@handle` stays a stable URL segment.
 */
const WORKSPACE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

export interface CreateWorkspaceRequest {
  readonly handle: string;
  readonly displayName: string;
  readonly type: WorkspaceType;
  readonly ownerUserId: string;
  readonly billingAccountId?: string;
}

export interface WorkspacesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export class WorkspacesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(deps: WorkspacesServiceDependencies) {
    this.#store = deps.store;
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
    const existing = await this.#store.getSpaceByHandle(request.handle);
    if (existing) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `workspace handle @${request.handle} is already taken`,
      );
    }
    const nowIso = this.#now().toISOString();
    const workspace: Workspace = {
      // The `space_` id prefix is a persistent identifier kept stable across the
      // Space -> Workspace rename (the rename targets type/field/table names, not
      // existing id strings).
      id: this.#newId("space"),
      handle: request.handle,
      displayName: request.displayName,
      type: request.type,
      ownerUserId: request.ownerUserId,
      ...(request.billingAccountId
        ? { billingAccountId: request.billingAccountId }
        : {}),
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return await this.#store.putSpace(workspace);
  }

  async getWorkspace(id: string): Promise<Workspace> {
    requireNonEmptyString(id, "id");
    const workspace = await this.#store.getSpace(id);
    if (!workspace) {
      throw new OpenTofuControllerError(
        "not_found",
        `workspace ${id} not found`,
      );
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
    return await this.#store.listSpacesByIds(normalizedIds);
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
    return await this.#store.putSpace(updated);
  }

  async getWorkspaceByHandle(handle: string): Promise<Workspace | undefined> {
    requireNonEmptyString(handle, "handle");
    return await this.#store.getSpaceByHandle(handle);
  }

  async listWorkspaces(): Promise<readonly Workspace[]> {
    return await this.#store.listSpaces();
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
    return await this.#store.listSpacesByOwner(ownerUserId);
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
    const existing = await this.#store.getSpaceByHandle(handle);
    if (existing) return existing;
    return await this.createWorkspace({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId,
    });
  }

  // --- Transient deprecated aliases (removed at rename convergence) ----------

  /** @deprecated transient alias for {@link createWorkspace}. */
  async createSpace(request: CreateWorkspaceRequest): Promise<Workspace> {
    return await this.createWorkspace(request);
  }

  /** @deprecated transient alias for {@link getWorkspace}. */
  async getSpace(id: string): Promise<Workspace> {
    return await this.getWorkspace(id);
  }

  /** @deprecated transient alias for {@link updateWorkspace}. */
  async updateSpace(
    id: string,
    patch: {
      readonly displayName?: string;
      readonly policy?: Workspace["policy"];
      readonly archived?: boolean;
    },
  ): Promise<Workspace> {
    return await this.updateWorkspace(id, patch);
  }

  /** @deprecated transient alias for {@link getWorkspaceByHandle}. */
  async getSpaceByHandle(handle: string): Promise<Workspace | undefined> {
    return await this.getWorkspaceByHandle(handle);
  }

  /** @deprecated transient alias for {@link listWorkspaces}. */
  async listSpaces(): Promise<readonly Workspace[]> {
    return await this.listWorkspaces();
  }

  /** @deprecated transient alias for {@link listWorkspacesByOwner}. */
  async listSpacesByOwner(ownerUserId: string): Promise<readonly Workspace[]> {
    return await this.listWorkspacesByOwner(ownerUserId);
  }

  /** @deprecated transient alias for {@link ensurePersonalWorkspace}. */
  async ensurePersonalSpace(
    ownerUserId: string,
    handle: string,
  ): Promise<Workspace> {
    return await this.ensurePersonalWorkspace(ownerUserId, handle);
  }
}

/** @deprecated transient alias for {@link CreateWorkspaceRequest}. */
export type CreateSpaceRequest = CreateWorkspaceRequest;

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
