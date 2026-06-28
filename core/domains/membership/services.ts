import type { InternalSpaceSummary } from "takosumi-contract/reference/compat";
import {
  conflict,
  type DomainError,
  invalidArgument,
  permissionDenied,
} from "../../shared/errors.ts";
import {
  createDomainEvent,
  type DomainEvent,
  InMemoryOutboxStore,
  type OutboxStore,
} from "../../shared/events.ts";
import { createId, type IdGenerator } from "../../shared/ids.ts";
import type { Result } from "../../shared/result.ts";
import { err, ok } from "../../shared/result.ts";
import { type Clock, type IsoTimestamp, nowIso } from "../../shared/time.ts";
import {
  type GroupStore,
  InMemoryGroupStore,
  InMemoryMembershipSpaceStore,
  InMemorySpaceMembershipStore,
  type MembershipSpaceStore,
  requireMembershipSpace,
  type SpaceMembershipStore,
} from "./stores.ts";
import type {
  CheckEntitlementQuery,
  SpaceRole,
  CreateGroupCommand,
  CreateMembershipSpaceCommand,
  EntitlementDecision,
  Group,
  ListGroupsQuery,
  ListMembershipSpacesQuery,
  MembershipSpace,
  SpaceMembership,
  UpsertSpaceMembershipCommand,
} from "./types.ts";
import { toInternalSpaceSummary } from "./types.ts";

export interface MembershipDomainDependencies {
  readonly spaces: MembershipSpaceStore;
  readonly groups: GroupStore;
  readonly memberships: SpaceMembershipStore;
  readonly outbox: OutboxStore;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
}

export interface MembershipDomainServices {
  readonly spaces: MembershipSpaceCommandService;
  readonly spaceQueries: MembershipSpaceQueryService;
  readonly groups: GroupCommandService;
  readonly groupQueries: GroupQueryService;
  readonly memberships: MembershipRoleEntitlementService;
  readonly outbox: OutboxStore;
}

export class MembershipSpaceCommandService {
  constructor(private readonly dependencies: MembershipDomainDependencies) {}

  async createSpace(
    command: CreateMembershipSpaceCommand,
  ): Promise<Result<MembershipSpace, DomainError>> {
    const name = normalizeName(command.name ?? "Untitled space");
    if (!name.ok) return name;

    const now = currentTime(this.dependencies.clock);
    const space: MembershipSpace = {
      id: command.spaceId ?? createId("space", this.dependencies.idGenerator),
      name: name.value,
      metadata: command.metadata ?? {},
      createdByAccountId: command.actor.actorAccountId,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.dependencies.spaces.create(space);
    if (!created.ok) return created;

    await this.dependencies.outbox.append(
      createDomainEvent(
        {
          type: "space.space.created",
          aggregateType: "space",
          aggregateId: space.id,
          payload: {
            spaceId: space.id,
            actorAccountId: command.actor.actorAccountId,
          },
          metadata: { requestId: command.actor.requestId },
        },
        this.eventOptions(),
      ),
    );

    await this.dependencies.memberships.upsert({
      id: createId("membership", this.dependencies.idGenerator),
      workspaceId: space.id,
      spaceId: space.id,
      accountId: command.actor.actorAccountId,
      roles: ["owner"],
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return ok(space);
  }

  private eventOptions(): { clock?: Clock; idGenerator?: IdGenerator } {
    return {
      clock: this.dependencies.clock,
      idGenerator: this.dependencies.idGenerator,
    };
  }
}

export class MembershipSpaceQueryService {
  constructor(
    private readonly spaces: MembershipSpaceStore,
    private readonly memberships: SpaceMembershipStore,
  ) {}

  async listSpaces(
    query: ListMembershipSpacesQuery,
  ): Promise<readonly MembershipSpace[]> {
    // SECURITY (cross-tenant disclosure): the internal spaces endpoint forwards a
    // user-derived actor and the trusting gateway assumes this list is already
    // membership-filtered. Return ONLY spaces the actor's account is an active
    // member of, never the full deployment-wide inventory.
    const all = await this.spaces.list();
    const accountId = query.actor.actorAccountId;
    const visible: MembershipSpace[] = [];
    for (const space of all) {
      if (await isActiveMember(this.memberships, space.id, accountId)) {
        visible.push(space);
      }
    }
    return visible;
  }

  async listInternalSpaceSummaries(
    query: ListMembershipSpacesQuery,
  ): Promise<readonly InternalSpaceSummary[]> {
    const spaces = await this.listSpaces(query);
    return spaces.map(toInternalSpaceSummary);
  }

  async getSpace(spaceId: string): Promise<MembershipSpace | undefined> {
    return await this.spaces.get(spaceId);
  }
}

export class GroupCommandService {
  constructor(private readonly dependencies: MembershipDomainDependencies) {}

  async createGroup(
    command: CreateGroupCommand,
  ): Promise<Result<Group, DomainError>> {
    const space = await requireMembershipSpace(
      this.dependencies.spaces,
      command.spaceId,
    );
    if (!space.ok) return space;

    const slug = normalizeSlug(command.slug);
    if (!slug.ok) return slug;

    const displayName = normalizeName(command.displayName ?? slug.value);
    if (!displayName.ok) return displayName;

    const allowed = await canManageSpace(
      this.dependencies.memberships,
      command.spaceId,
      command.actor.actorAccountId,
    );
    if (!allowed) {
      return err(
        permissionDenied("actor cannot manage groups", {
          spaceId: command.spaceId,
        }),
      );
    }

    const existing = await this.dependencies.groups.findBySlug(
      command.spaceId,
      slug.value,
    );
    if (existing) {
      return err(
        conflict("group slug already exists", {
          spaceId: command.spaceId,
          slug: slug.value,
        }),
      );
    }

    const now = currentTime(this.dependencies.clock);
    const group: Group = {
      id: command.groupId ?? createId("group", this.dependencies.idGenerator),
      spaceId: command.spaceId,
      slug: slug.value,
      displayName: displayName.value,
      metadata: command.metadata ?? {},
      createdByAccountId: command.actor.actorAccountId,
      createdAt: now,
      updatedAt: now,
    };

    const created = await this.dependencies.groups.create(group);
    if (!created.ok) return created;

    await this.dependencies.outbox.append(
      createDomainEvent(
        {
          type: "space.group.created",
          aggregateType: "group",
          aggregateId: group.id,
          payload: {
            groupId: group.id,
            spaceId: group.spaceId,
            slug: group.slug,
            actorAccountId: command.actor.actorAccountId,
          },
          metadata: { requestId: command.actor.requestId },
        },
        {
          clock: this.dependencies.clock,
          idGenerator: this.dependencies.idGenerator,
        },
      ),
    );

    return ok(group);
  }
}

export class GroupQueryService {
  constructor(
    private readonly groups: GroupStore,
    private readonly memberships: SpaceMembershipStore,
  ) {}

  async listGroups(query: ListGroupsQuery): Promise<readonly Group[]> {
    // SECURITY (cross-tenant IDOR): spaceId is attacker-chosen on the internal
    // groups endpoint. Only return groups when the actor's account is an active
    // member of the requested space; otherwise return nothing (do not leak
    // another tenant's group listing).
    const member = await isActiveMember(
      this.memberships,
      query.spaceId,
      query.actor.actorAccountId,
    );
    if (!member) return [];
    return await this.groups.listBySpace(query.spaceId);
  }

  async getGroup(groupId: string): Promise<Group | undefined> {
    return await this.groups.get(groupId);
  }
}

export class MembershipRoleEntitlementService {
  constructor(private readonly dependencies: MembershipDomainDependencies) {}

  async upsertSpaceMembership(
    command: UpsertSpaceMembershipCommand,
  ): Promise<Result<SpaceMembership, DomainError>> {
    const space = await requireMembershipSpace(
      this.dependencies.spaces,
      command.spaceId,
    );
    if (!space.ok) return space;

    const allowed = await canManageSpace(
      this.dependencies.memberships,
      command.spaceId,
      command.actor.actorAccountId,
    );
    if (!allowed) {
      return err(
        permissionDenied("actor cannot manage memberships", {
          spaceId: command.spaceId,
        }),
      );
    }

    const existing = await this.dependencies.memberships.get(
      command.spaceId,
      command.accountId,
    );
    const now = currentTime(this.dependencies.clock);
    const membership: SpaceMembership = {
      id: existing?.id ?? createId("membership", this.dependencies.idGenerator),
      workspaceId: command.spaceId,
      spaceId: command.spaceId,
      accountId: command.accountId,
      roles: command.roles ?? existing?.roles ?? ["member"],
      status: command.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.dependencies.memberships.upsert(membership);
    await this.dependencies.outbox.append(
      membershipEvent(
        "space.membership.upserted",
        membership,
        command.actor.requestId,
        {
          clock: this.dependencies.clock,
          idGenerator: this.dependencies.idGenerator,
        },
      ),
    );

    return ok(membership);
  }

  async listSpaceMemberships(
    spaceId: string,
  ): Promise<readonly SpaceMembership[]> {
    return await this.dependencies.memberships.listBySpace(spaceId);
  }

  async checkEntitlement(
    query: CheckEntitlementQuery,
  ): Promise<EntitlementDecision> {
    const membership = await this.dependencies.memberships.get(
      query.spaceId,
      query.actor.actorAccountId,
    );
    if (!membership || membership.status !== "active") {
      return {
        allowed: false,
        key: query.key,
        reason: "no active membership",
      };
    }
    if (hasAnyRole(membership.roles, ["owner", "admin"])) {
      return {
        allowed: true,
        key: query.key,
        reason: "owner/admin role grants entitlement",
      };
    }
    return {
      allowed: false,
      key: query.key,
      reason: "entitlement requires owner/admin role",
    };
  }
}

export function createInMemoryMembershipDomainDependencies(
  overrides: Partial<MembershipDomainDependencies> = {},
): MembershipDomainDependencies {
  const outbox = overrides.outbox ?? new InMemoryOutboxStore();
  return {
    spaces: overrides.spaces ?? new InMemoryMembershipSpaceStore(),
    groups: overrides.groups ?? new InMemoryGroupStore(),
    memberships: overrides.memberships ?? new InMemorySpaceMembershipStore(),
    outbox,
    clock: overrides.clock,
    idGenerator: overrides.idGenerator,
  };
}

export function createMembershipDomainServices(
  dependencies: MembershipDomainDependencies =
    createInMemoryMembershipDomainDependencies(),
): MembershipDomainServices {
  return {
    spaces: new MembershipSpaceCommandService(dependencies),
    spaceQueries: new MembershipSpaceQueryService(
      dependencies.spaces,
      dependencies.memberships,
    ),
    groups: new GroupCommandService(dependencies),
    groupQueries: new GroupQueryService(
      dependencies.groups,
      dependencies.memberships,
    ),
    memberships: new MembershipRoleEntitlementService(dependencies),
    outbox: dependencies.outbox,
  };
}

function currentTime(clock: Clock | undefined): IsoTimestamp {
  return nowIso(clock);
}

function normalizeName(name: string): Result<string, DomainError> {
  const trimmed = name.trim();
  if (!trimmed) return err(invalidArgument("name is required"));
  return ok(trimmed);
}

function normalizeSlug(slug: string): Result<string, DomainError> {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalized)) {
    return err(
      invalidArgument(
        "slug must be 1-63 lower-case alphanumeric or hyphen characters",
      ),
    );
  }
  return ok(normalized);
}

async function canManageSpace(
  memberships: SpaceMembershipStore,
  spaceId: string,
  accountId: string,
): Promise<boolean> {
  const membership = await memberships.get(spaceId, accountId);
  return membership?.status === "active" &&
    hasAnyRole(membership.roles, ["owner", "admin"]);
}

/** True when the account has any active membership in the space (any role). */
async function isActiveMember(
  memberships: SpaceMembershipStore,
  spaceId: string,
  accountId: string,
): Promise<boolean> {
  const membership = await memberships.get(spaceId, accountId);
  return membership?.status === "active";
}

function hasAnyRole(
  roles: readonly SpaceRole[],
  expected: readonly SpaceRole[],
): boolean {
  return roles.some((role) => expected.includes(role));
}

function membershipEvent(
  type: string,
  membership: SpaceMembership,
  requestId: string,
  options: { clock?: Clock; idGenerator?: IdGenerator },
): DomainEvent {
  return createDomainEvent(
    {
      type,
      aggregateType: "membership",
      aggregateId: membership.id,
      payload: {
        membershipId: membership.id,
        spaceId: membership.spaceId,
        accountId: membership.accountId,
        roles: [...membership.roles],
        status: membership.status,
      },
      metadata: { requestId },
    },
    options,
  );
}
