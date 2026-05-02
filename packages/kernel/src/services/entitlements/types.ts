import type {
  AccountId,
  CoreRole,
  GroupId,
  SpaceId,
  SpaceMembership,
} from "../../domains/core/mod.ts";

export type EntitlementCapability =
  | "deploy.read"
  | "deploy.plan"
  | "deploy.apply"
  | "deploy.rollback"
  | "resource.read"
  | "resource.create"
  | "resource.update"
  | "resource.delete"
  | "resource.bind"
  | "resource.migrate"
  | "resource.restore"
  | "runtime.read"
  | "runtime.scale"
  | "runtime.restart"
  | "runtime-agent.read"
  | "runtime-agent.enqueue"
  | "runtime-agent.register"
  | "runtime-agent.drain"
  | "runtime-agent.revoke";

export type EntitlementLimitKey =
  | "deploysPerDay"
  | "resourceInstances"
  | "runtimeServices"
  | "runtimeAgentConcurrentLeases";

export type EntitlementLimits = Partial<Record<EntitlementLimitKey, number>>;

export interface PolicyGrantDto {
  readonly capabilities?: readonly EntitlementCapability[];
  readonly limits?: EntitlementLimits;
}

export interface PolicyOverlayDto extends PolicyGrantDto {
  readonly addCapabilities?: readonly EntitlementCapability[];
  readonly removeCapabilities?: readonly EntitlementCapability[];
}

export interface LocalEntitlementPolicyConfigDto {
  readonly defaults?: PolicyGrantDto;
  readonly roles?: Partial<Record<CoreRole, PolicyGrantDto>>;
  readonly spaces?: Record<SpaceId, PolicyOverlayDto>;
  readonly groups?: Record<`${SpaceId}:${GroupId}`, PolicyOverlayDto>;
}

export interface EntitlementSubject {
  readonly accountId: AccountId;
  readonly roles: readonly CoreRole[];
  readonly membership: SpaceMembership;
}

export interface EffectiveEntitlementsQuery {
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly accountId: AccountId;
}

export interface EffectiveEntitlements {
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly accountId: AccountId;
  readonly roles: readonly CoreRole[];
  readonly capabilities: readonly EntitlementCapability[];
  readonly limits: EntitlementLimits;
}

export type MutationBoundaryOperation =
  | "deploy.plan"
  | "deploy.apply"
  | "deploy.rollback"
  | "resource.create"
  | "resource.update"
  | "resource.delete"
  | "resource.bind"
  | "resource.migrate"
  | "resource.restore"
  | "runtime.scale"
  | "runtime.restart"
  | "runtime-agent.enqueue"
  | "runtime-agent.register"
  | "runtime-agent.drain"
  | "runtime-agent.revoke";

export interface MutationBoundaryCheckInput {
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly accountId: AccountId;
  readonly operation: MutationBoundaryOperation;
}

export interface EntitlementDecision {
  readonly allowed: boolean;
  readonly capability: EntitlementCapability;
  readonly reason: string;
  readonly entitlements?: EffectiveEntitlements;
}
