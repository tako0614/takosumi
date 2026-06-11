import type {
  InternalSpaceSummary,
  TakosumiActorContext,
} from "takosumi-contract/reference/compat";
import type { IsoTimestamp } from "../../shared/time.ts";
import type { SpaceId } from "../../shared/ids.ts";

export type { SpaceId };
export type AccountId = string;
export type GroupId = string;
export type GroupSlug = string;
export type EntitlementKey = string;

export type SpaceRole = "owner" | "admin" | "member" | "viewer";
export type MembershipStatus = "active" | "invited" | "suspended";

/**
 * The membership domain's own space record (a container for groups and
 * memberships, keyed by {@link SpaceId}). This is intentionally distinct from
 * the Core-Spec `Space` (owner namespace `@handle`) owned by `domains/spaces`;
 * the two model different concerns and must not be conflated.
 */
export interface MembershipSpace {
  readonly id: SpaceId;
  readonly name: string;
  readonly metadata: Record<string, unknown>;
  readonly createdByAccountId: AccountId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface Group {
  readonly id: GroupId;
  readonly spaceId: SpaceId;
  readonly slug: GroupSlug;
  readonly displayName: string;
  readonly metadata: Record<string, unknown>;
  readonly createdByAccountId: AccountId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface SpaceMembership {
  readonly id: string;
  readonly spaceId: SpaceId;
  readonly accountId: AccountId;
  readonly roles: readonly SpaceRole[];
  readonly status: MembershipStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface EntitlementDecision {
  readonly allowed: boolean;
  readonly key: EntitlementKey;
  readonly reason: string;
}

export interface CreateMembershipSpaceCommand {
  readonly actor: TakosumiActorContext;
  readonly spaceId?: SpaceId;
  readonly name?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateGroupCommand {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly slug: GroupSlug;
  readonly displayName?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface UpsertSpaceMembershipCommand {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
  readonly accountId: AccountId;
  readonly roles?: readonly SpaceRole[];
  readonly status?: MembershipStatus;
}

export interface CheckEntitlementQuery {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
  readonly key: EntitlementKey;
}

export interface ListMembershipSpacesQuery {
  readonly actor: TakosumiActorContext;
}

export interface ListGroupsQuery {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
}

export function toInternalSpaceSummary(
  space: MembershipSpace,
): InternalSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    actorAccountId: space.createdByAccountId,
  };
}
