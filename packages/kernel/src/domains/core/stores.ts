import { conflict, type DomainError, notFound } from "../../shared/errors.ts";
import type { Result } from "../../shared/result.ts";
import { err, ok } from "../../shared/result.ts";
import type {
  AccountId,
  Group,
  GroupSlug,
  Space,
  SpaceId,
  SpaceMembership,
} from "./types.ts";

export interface SpaceStore {
  create(space: Space): Promise<Result<Space, DomainError>>;
  get(spaceId: SpaceId): Promise<Space | undefined>;
  list(): Promise<readonly Space[]>;
}

export interface GroupStore {
  create(group: Group): Promise<Result<Group, DomainError>>;
  get(groupId: string): Promise<Group | undefined>;
  findBySlug(spaceId: SpaceId, slug: GroupSlug): Promise<Group | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly Group[]>;
}

export interface SpaceMembershipStore {
  upsert(membership: SpaceMembership): Promise<SpaceMembership>;
  get(
    spaceId: SpaceId,
    accountId: AccountId,
  ): Promise<SpaceMembership | undefined>;
  listBySpace(spaceId: SpaceId): Promise<readonly SpaceMembership[]>;
}

export class InMemorySpaceStore implements SpaceStore {
  readonly #spaces = new Map<SpaceId, Space>();

  create(space: Space): Promise<Result<Space, DomainError>> {
    if (this.#spaces.has(space.id)) {
      return Promise.resolve(
        err(conflict("space already exists", { spaceId: space.id })),
      );
    }
    this.#spaces.set(space.id, space);
    return Promise.resolve(ok(space));
  }

  get(spaceId: SpaceId): Promise<Space | undefined> {
    return Promise.resolve(this.#spaces.get(spaceId));
  }

  list(): Promise<readonly Space[]> {
    return Promise.resolve([...this.#spaces.values()]);
  }
}

export class InMemoryGroupStore implements GroupStore {
  readonly #groups = new Map<string, Group>();

  create(group: Group): Promise<Result<Group, DomainError>> {
    if (this.#groups.has(group.id)) {
      return Promise.resolve(
        err(conflict("group already exists", { groupId: group.id })),
      );
    }
    for (const existing of this.#groups.values()) {
      if (existing.spaceId === group.spaceId && existing.slug === group.slug) {
        return Promise.resolve(
          err(
            conflict("group slug already exists", {
              spaceId: group.spaceId,
              slug: group.slug,
            }),
          ),
        );
      }
    }
    this.#groups.set(group.id, group);
    return Promise.resolve(ok(group));
  }

  get(groupId: string): Promise<Group | undefined> {
    return Promise.resolve(this.#groups.get(groupId));
  }

  findBySlug(spaceId: SpaceId, slug: GroupSlug): Promise<Group | undefined> {
    for (const group of this.#groups.values()) {
      if (group.spaceId === spaceId && group.slug === slug) {
        return Promise.resolve(group);
      }
    }
    return Promise.resolve(undefined);
  }

  listBySpace(spaceId: SpaceId): Promise<readonly Group[]> {
    return Promise.resolve(
      [...this.#groups.values()].filter((group) => group.spaceId === spaceId),
    );
  }
}

export class InMemorySpaceMembershipStore implements SpaceMembershipStore {
  readonly #memberships = new Map<string, SpaceMembership>();

  upsert(membership: SpaceMembership): Promise<SpaceMembership> {
    this.#memberships.set(
      keyFor(membership.spaceId, membership.accountId),
      membership,
    );
    return Promise.resolve(membership);
  }

  get(
    spaceId: SpaceId,
    accountId: AccountId,
  ): Promise<SpaceMembership | undefined> {
    return Promise.resolve(this.#memberships.get(keyFor(spaceId, accountId)));
  }

  listBySpace(spaceId: SpaceId): Promise<readonly SpaceMembership[]> {
    return Promise.resolve(
      [...this.#memberships.values()].filter((membership) =>
        membership.spaceId === spaceId
      ),
    );
  }
}

export async function requireSpace(
  store: SpaceStore,
  spaceId: SpaceId,
): Promise<Result<Space, DomainError>> {
  const space = await store.get(spaceId);
  if (!space) return err(notFound("space not found", { spaceId }));
  return ok(space);
}

function keyFor(spaceId: SpaceId, accountId: AccountId): string {
  return `${spaceId}:${accountId}`;
}
