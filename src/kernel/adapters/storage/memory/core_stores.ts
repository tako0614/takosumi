// In-memory implementations of the core domain stores
// (spaces / groups / space memberships). Each class implements the
// matching store contract from `domains/core/stores.ts` and operates
// against a Map provided by the surrounding transaction.

import type {
  GroupStore,
  SpaceMembershipStore,
  SpaceStore,
} from "../../../domains/core/stores.ts";
import type {
  AccountId,
  Group,
  GroupSlug,
  Space,
  SpaceId,
  SpaceMembership,
} from "../../../domains/core/types.ts";
import { conflict, type DomainError } from "../../../shared/errors.ts";
import { err, ok, type Result } from "../../../shared/result.ts";
import { immutable, membershipKey } from "./helpers.ts";

export class MemorySpaceStore implements SpaceStore {
  constructor(private readonly spaces: Map<SpaceId, Space>) {}

  create(space: Space): Promise<Result<Space, DomainError>> {
    if (this.spaces.has(space.id)) {
      return Promise.resolve(
        err(conflict("space already exists", { spaceId: space.id })),
      );
    }
    const value = immutable(space);
    this.spaces.set(space.id, value);
    return Promise.resolve(ok(value));
  }

  get(spaceId: SpaceId): Promise<Space | undefined> {
    return Promise.resolve(this.spaces.get(spaceId));
  }

  list(): Promise<readonly Space[]> {
    return Promise.resolve([...this.spaces.values()]);
  }
}

export class MemoryGroupStore implements GroupStore {
  constructor(private readonly groups: Map<string, Group>) {}

  create(group: Group): Promise<Result<Group, DomainError>> {
    if (this.groups.has(group.id)) {
      return Promise.resolve(
        err(conflict("group already exists", { groupId: group.id })),
      );
    }
    for (const existing of this.groups.values()) {
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
    const value = immutable(group);
    this.groups.set(group.id, value);
    return Promise.resolve(ok(value));
  }

  get(groupId: string): Promise<Group | undefined> {
    return Promise.resolve(this.groups.get(groupId));
  }

  findBySlug(spaceId: SpaceId, slug: GroupSlug): Promise<Group | undefined> {
    for (const group of this.groups.values()) {
      if (group.spaceId === spaceId && group.slug === slug) {
        return Promise.resolve(group);
      }
    }
    return Promise.resolve(undefined);
  }

  listBySpace(spaceId: SpaceId): Promise<readonly Group[]> {
    return Promise.resolve(
      [...this.groups.values()].filter((group) => group.spaceId === spaceId),
    );
  }
}

export class MemorySpaceMembershipStore implements SpaceMembershipStore {
  constructor(private readonly memberships: Map<string, SpaceMembership>) {}

  upsert(membership: SpaceMembership): Promise<SpaceMembership> {
    const value = immutable(membership);
    this.memberships.set(
      membershipKey(membership.spaceId, membership.accountId),
      value,
    );
    return Promise.resolve(value);
  }

  get(
    spaceId: SpaceId,
    accountId: AccountId,
  ): Promise<SpaceMembership | undefined> {
    return Promise.resolve(
      this.memberships.get(membershipKey(spaceId, accountId)),
    );
  }

  listBySpace(spaceId: SpaceId): Promise<readonly SpaceMembership[]> {
    return Promise.resolve(
      [...this.memberships.values()].filter((membership) =>
        membership.spaceId === spaceId
      ),
    );
  }
}
