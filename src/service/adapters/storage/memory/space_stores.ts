// In-memory implementations of the membership domain stores
// (spaces / groups / space memberships). Each class implements the
// matching store contract from `domains/membership/stores.ts` and operates
// against a Map provided by the surrounding transaction.

import type {
  GroupStore,
  MembershipSpaceStore,
  SpaceMembershipStore,
} from "../../../domains/membership/stores.ts";
import type {
  AccountId,
  Group,
  GroupSlug,
  MembershipSpace,
  SpaceId,
  SpaceMembership,
} from "../../../domains/membership/types.ts";
import { conflict, type DomainError } from "../../../shared/errors.ts";
import { err, ok, type Result } from "../../../shared/result.ts";
import {
  filterValues,
  getFrom,
  immutable,
  membershipKey,
  putValue,
} from "./helpers.ts";

export class MemoryMembershipSpaceStore implements MembershipSpaceStore {
  constructor(private readonly spaces: Map<SpaceId, MembershipSpace>) {}

  create(
    space: MembershipSpace,
  ): Promise<Result<MembershipSpace, DomainError>> {
    if (this.spaces.has(space.id)) {
      return Promise.resolve(
        err(conflict("space already exists", { spaceId: space.id })),
      );
    }
    const value = immutable(space);
    this.spaces.set(space.id, value);
    return Promise.resolve(ok(value));
  }

  get(spaceId: SpaceId): Promise<MembershipSpace | undefined> {
    return getFrom(this.spaces, spaceId);
  }

  list(): Promise<readonly MembershipSpace[]> {
    return filterValues(this.spaces, () => true);
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
    return getFrom(this.groups, groupId);
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
    return filterValues(this.groups, (group) => group.spaceId === spaceId);
  }
}

export class MemorySpaceMembershipStore implements SpaceMembershipStore {
  constructor(private readonly memberships: Map<string, SpaceMembership>) {}

  upsert(membership: SpaceMembership): Promise<SpaceMembership> {
    return putValue(
      this.memberships,
      membershipKey(membership.spaceId, membership.accountId),
      membership,
    );
  }

  get(
    spaceId: SpaceId,
    accountId: AccountId,
  ): Promise<SpaceMembership | undefined> {
    return getFrom(this.memberships, membershipKey(spaceId, accountId));
  }

  listBySpace(spaceId: SpaceId): Promise<readonly SpaceMembership[]> {
    return filterValues(
      this.memberships,
      (membership) => membership.spaceId === spaceId,
    );
  }
}
