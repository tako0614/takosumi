/**
 * Spaces domain service (Core Specification §4).
 *
 * A Space is the owner namespace (`@handle`) directly under which Installations
 * live — close to a GitHub user/org. This service owns Space creation and
 * lookup over the shared control-plane ledger. Members, billing, and policy are
 * layered on later milestones; this milestone covers the identity + handle
 * uniqueness invariants the rest of the model keys on.
 *
 * No secret material flows through this service.
 */

import type { Space, SpaceType } from "takosumi-contract/spaces";
import {
  OpenTofuControllerError,
  requireNonEmptyString,
} from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";

/**
 * Space handle grammar (spec §4): lowercase alnum start, then 1-38 of
 * `[a-z0-9-]`, for a total length of 2-39. Mirrors the GitHub-style owner
 * namespace shape so `@handle` stays a stable URL segment.
 */
const SPACE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

export interface CreateSpaceRequest {
  readonly handle: string;
  readonly displayName: string;
  readonly type: SpaceType;
  readonly ownerUserId: string;
  readonly billingAccountId?: string;
}

export interface SpacesServiceDependencies {
  readonly store: OpenTofuDeploymentStore;
  readonly newId?: (prefix: string) => string;
  readonly now?: () => Date;
}

export class SpacesService {
  readonly #store: OpenTofuDeploymentStore;
  readonly #newId: (prefix: string) => string;
  readonly #now: () => Date;

  constructor(deps: SpacesServiceDependencies) {
    this.#store = deps.store;
    this.#newId = deps.newId ?? defaultId;
    this.#now = deps.now ?? (() => new Date());
  }

  async createSpace(request: CreateSpaceRequest): Promise<Space> {
    requireNonEmptyString(request.handle, "handle");
    requireNonEmptyString(request.displayName, "displayName");
    requireNonEmptyString(request.ownerUserId, "ownerUserId");
    if (request.type !== "personal" && request.type !== "organization") {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `type must be one of personal, organization`,
      );
    }
    if (!SPACE_HANDLE_PATTERN.test(request.handle)) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        `handle ${request.handle} must match ${SPACE_HANDLE_PATTERN.source}`,
      );
    }
    const existing = await this.#store.getSpaceByHandle(request.handle);
    if (existing) {
      throw new OpenTofuControllerError(
        "failed_precondition",
        `space handle @${request.handle} is already taken`,
      );
    }
    const nowIso = this.#now().toISOString();
    const space: Space = {
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
    return await this.#store.putSpace(space);
  }

  async getSpace(id: string): Promise<Space> {
    requireNonEmptyString(id, "id");
    const space = await this.#store.getSpace(id);
    if (!space) {
      throw new OpenTofuControllerError("not_found", `space ${id} not found`);
    }
    return space;
  }

  /**
   * Updates the mutable, non-identity fields of a Space (spec §30 `PATCH
   * /internal/v1/spaces/:spaceId`). The handle, type, owner, and billing are immutable
   * here. Bumps `updatedAt`.
   */
  async updateSpace(
    id: string,
    patch: {
      readonly displayName?: string;
      readonly policy?: Space["policy"];
    },
  ): Promise<Space> {
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
    if (patch.displayName === undefined && patch.policy === undefined) {
      throw new OpenTofuControllerError(
        "invalid_argument",
        "displayName or policy is required",
      );
    }
    const space = await this.getSpace(id);
    const updated: Space = {
      ...space,
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName }
        : {}),
      ...(patch.policy !== undefined ? { policy: patch.policy } : {}),
      updatedAt: this.#now().toISOString(),
    };
    return await this.#store.putSpace(updated);
  }

  async getSpaceByHandle(handle: string): Promise<Space | undefined> {
    requireNonEmptyString(handle, "handle");
    return await this.#store.getSpaceByHandle(handle);
  }

  async listSpaces(): Promise<readonly Space[]> {
    return await this.#store.listSpaces();
  }

  /**
   * Lists only the Spaces directly owned by `ownerUserId` (spec §4). Scopes the
   * dashboard session list (`GET /api/v1/spaces`) to the caller's own spaces
   * instead of loading every tenant's Space and filtering in the route.
   */
  async listSpacesByOwner(ownerUserId: string): Promise<readonly Space[]> {
    requireNonEmptyString(ownerUserId, "ownerUserId");
    return await this.#store.listSpacesByOwner(ownerUserId);
  }

  /**
   * Idempotent personal-Space creation for the accounts-plane login hook (wired
   * in M9). Returns the existing Space when the handle is already taken so a
   * repeated login never errors or creates a duplicate; otherwise creates a
   * `personal` Space owned by the user. The caller is responsible for choosing a
   * handle that uniquely maps to the user.
   */
  async ensurePersonalSpace(
    ownerUserId: string,
    handle: string,
  ): Promise<Space> {
    requireNonEmptyString(ownerUserId, "ownerUserId");
    requireNonEmptyString(handle, "handle");
    const existing = await this.#store.getSpaceByHandle(handle);
    if (existing) return existing;
    return await this.createSpace({
      handle,
      displayName: handle,
      type: "personal",
      ownerUserId,
    });
  }
}

function defaultId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
