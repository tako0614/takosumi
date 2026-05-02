import type {
  InternalSpaceSummary,
  TakosumiActorContext,
} from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type AccountId = string;
export type SpaceId = string;
export type GroupId = string;
export type GroupSlug = string;
export type EntitlementKey = string;

export type CoreRole = "owner" | "admin" | "member" | "viewer";
export type MembershipStatus = "active" | "invited" | "suspended";

export interface Space {
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
  readonly roles: readonly CoreRole[];
  readonly status: MembershipStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface EntitlementDecision {
  readonly allowed: boolean;
  readonly key: EntitlementKey;
  readonly reason: string;
}

export interface CreateSpaceCommand {
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
  readonly roles?: readonly CoreRole[];
  readonly status?: MembershipStatus;
}

export interface CheckEntitlementQuery {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
  readonly key: EntitlementKey;
}

export interface ListSpacesQuery {
  readonly actor: TakosumiActorContext;
}

export interface ListGroupsQuery {
  readonly actor: TakosumiActorContext;
  readonly spaceId: SpaceId;
}

export function toInternalSpaceSummary(space: Space): InternalSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    actorAccountId: space.createdByAccountId,
  };
}
