import type { JsonObject } from "takosumi-contract";
import type { IsoTimestamp } from "../../shared/time.ts";

export type EventSubscriptionRevisionId = string;
export type EventSubscriptionId = string;
export type SpaceId = string;
export type GroupId = string;
export type AppReleaseId = string;
export type ActivationId = string;

export type EventSourceKind = "queue";
export type EventTargetKind = "component" | "route" | "output" | string;
export type EventDeliverySemantics = "at-least-once" | "at-most-once";

export interface EventSourceRef {
  readonly kind: EventSourceKind;
  readonly name: string;
  readonly address?: string;
}

export interface EventTargetRef {
  readonly kind: EventTargetKind;
  readonly groupId: GroupId;
  readonly name: string;
  readonly appReleaseId?: AppReleaseId;
}

export interface EventTargetResolutionContext {
  readonly primaryAppReleaseId: AppReleaseId;
}

export interface ResolvedEventTargetRef extends EventTargetRef {
  readonly appReleaseId: AppReleaseId;
  readonly resolvedThrough: "explicit-app-release" | "primaryAppReleaseId";
}

export interface EventSubscription {
  readonly id: EventSubscriptionId;
  readonly source: EventSourceRef;
  readonly target: EventTargetRef;
  readonly filter?: JsonObject;
  readonly delivery: EventDeliverySemantics;
  readonly enabled: boolean;
}

export interface ResolvedEventSubscription extends EventSubscription {
  readonly target: ResolvedEventTargetRef;
}

export interface EventSubscriptionRevision {
  readonly id: EventSubscriptionRevisionId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly activationId?: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly primaryAppReleaseId: AppReleaseId;
  readonly subscriptions: readonly ResolvedEventSubscription[];
  readonly createdAt: IsoTimestamp;
  readonly createdBy?: string;
  readonly supersedesRevisionId?: EventSubscriptionRevisionId;
}

export interface EventSubscriptionRevisionInput {
  readonly id: EventSubscriptionRevisionId;
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly activationId?: ActivationId;
  readonly appReleaseId?: AppReleaseId;
  readonly primaryAppReleaseId: AppReleaseId;
  readonly subscriptions: readonly EventSubscription[];
  readonly createdAt: IsoTimestamp;
  readonly createdBy?: string;
  readonly supersedesRevisionId?: EventSubscriptionRevisionId;
}

export interface EventSubscriptionRevisionQuery {
  readonly spaceId?: SpaceId;
  readonly groupId?: GroupId;
  readonly activationId?: ActivationId;
  readonly appReleaseId?: AppReleaseId;
}
