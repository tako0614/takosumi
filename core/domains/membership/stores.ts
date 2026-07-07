import { conflict, type DomainError, notFound } from "../../shared/errors.ts";
import type { Result } from "../../shared/result.ts";
import { err, ok } from "../../shared/result.ts";
import type {
  AccountId,
  Group,
  GroupSlug,
  MembershipSpace,
  SpaceId,
  SpaceMembership,
} from "./types.ts";

export interface MembershipSpaceStore {
  create(space: MembershipSpace): Promise<Result<MembershipSpace, DomainError>>;
  get(spaceId: SpaceId): Promise<MembershipSpace | undefined>;
  list(): Promise<readonly MembershipSpace[]>;
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

export class InMemoryMembershipSpaceStore implements MembershipSpaceStore {
  readonly #spaces = new Map<SpaceId, MembershipSpace>();

  create(
    space: MembershipSpace,
  ): Promise<Result<MembershipSpace, DomainError>> {
    if (this.#spaces.has(space.id)) {
      return Promise.resolve(err(conflict("space already exists")));
    }
    this.#spaces.set(space.id, space);
    return Promise.resolve(ok(space));
  }

  get(spaceId: SpaceId): Promise<MembershipSpace | undefined> {
    return Promise.resolve(this.#spaces.get(spaceId));
  }

  list(): Promise<readonly MembershipSpace[]> {
    return Promise.resolve([...this.#spaces.values()]);
  }
}

export class InMemoryGroupStore implements GroupStore {
  readonly #groups = new Map<string, Group>();

  create(group: Group): Promise<Result<Group, DomainError>> {
    if (this.#groups.has(group.id)) {
      return Promise.resolve(err(conflict("group already exists")));
    }
    for (const existing of this.#groups.values()) {
      if (existing.spaceId === group.spaceId && existing.slug === group.slug) {
        return Promise.resolve(err(conflict("group slug already exists")));
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
      [...this.#memberships.values()].filter(
        (membership) => membership.spaceId === spaceId,
      ),
    );
  }
}

export async function requireMembershipSpace(
  store: MembershipSpaceStore,
  spaceId: SpaceId,
): Promise<Result<MembershipSpace, DomainError>> {
  const space = await store.get(spaceId);
  if (!space) return err(notFound("space not found"));
  return ok(space);
}

function keyFor(spaceId: SpaceId, accountId: AccountId): string {
  return `${spaceId}:${accountId}`;
}
