import type { PublicDeployManifest } from "../../domains/deploy/mod.ts";
import type {
  AppReleaseId,
  EventDeliverySemantics,
  EventSourceKind,
  EventSourceRef,
  EventSubscription,
  EventSubscriptionId,
  EventTargetKind,
  EventTargetRef,
  GroupId,
  SpaceId,
} from "../../domains/events/mod.ts";

export type EventSwitchPreviewStatus = "ready" | "switch-plan-required";
export type EventSwitchPlanEntryMode = "switch-new-deliveries";
export type EventSubscriptionSwitchAction =
  | "stay-on-primary"
  | "switch-new-deliveries";
export type EventSideEffectSurface = "queue" | "schedule";
export type EventSideEffectControlAction =
  | "pin-to-primary"
  | "allow-explicit-new-deliveries"
  | "reject-switch-plan";
export type InFlightMessageOwnership =
  | "delivery-attempt-bound"
  | "unknown-provider-specific";

export interface EventSubscriptionSwitchPreviewInput {
  readonly spaceId: SpaceId;
  readonly groupId?: GroupId;
  readonly manifest: PublicDeployManifest;
  readonly primaryAppReleaseId: AppReleaseId;
  readonly candidateAppReleaseId?: AppReleaseId;
  readonly subscriptions?: readonly EventSubscription[];
  readonly switchPlan?: EventSubscriptionSwitchPlanInput;
}

export interface EventSubscriptionSwitchPlanInput {
  readonly entries: readonly EventSubscriptionSwitchPlanEntryInput[];
}

export interface EventSubscriptionSwitchPlanEntryInput {
  readonly subscriptionId: EventSubscriptionId;
  readonly targetAppReleaseId: AppReleaseId;
  readonly mode: EventSwitchPlanEntryMode;
}

export interface EventSubscriptionSwitchPreviewDto {
  readonly kind: "event_subscription_switch_preview";
  readonly spaceId: SpaceId;
  readonly groupId: GroupId;
  readonly primaryAppReleaseId: AppReleaseId;
  readonly candidateAppReleaseId?: AppReleaseId;
  readonly status: EventSwitchPreviewStatus;
  readonly policy: EventSwitchPolicyDto;
  readonly subscriptions: readonly EventSubscriptionSwitchItemDto[];
  readonly sideEffectControls: EventSideEffectControlsDto;
  readonly switchPlan: EventSubscriptionSwitchPlanPreviewDto;
  readonly inFlightMessageBehavior: InFlightMessageBehaviorProfileDto;
  readonly issues: readonly EventSubscriptionSwitchIssueDto[];
}

export interface EventSwitchPolicyDto {
  readonly canaryHttpAutoSwitchesQueueConsumers: false;
  readonly scheduleEventsTargetAppReleaseId: AppReleaseId;
  readonly explicitSwitchPlanRequired: true;
}

export interface EventSubscriptionSwitchItemDto {
  readonly subscriptionId: EventSubscriptionId;
  readonly source: EventSourceRef;
  readonly target: EventTargetRef;
  readonly delivery: EventDeliverySemantics;
  readonly enabled: boolean;
  readonly currentTargetAppReleaseId: AppReleaseId;
  readonly previewTargetAppReleaseId: AppReleaseId;
  readonly action: EventSubscriptionSwitchAction;
  readonly sideEffectControl: EventSubscriptionSideEffectControlDto;
  readonly requiresExplicitSwitchPlan: boolean;
  readonly reason:
    | "queue-consumer-pinned-during-http-canary"
    | "schedule-event-targets-primary-release"
    | "event-subscription-pinned-during-http-canary"
    | "explicit-switch-plan-entry";
}

export interface EventSideEffectControlsDto {
  readonly kind: "event_side_effect_controls";
  readonly queueAutoSwitchAllowed: false;
  readonly scheduleSwitchAllowed: false;
  readonly queueSwitchRequiresExplicitPlan: true;
  readonly scheduleTargetAppReleaseId: AppReleaseId;
  readonly controls: readonly EventSubscriptionSideEffectControlDto[];
}

export interface EventSubscriptionSideEffectControlDto {
  readonly subscriptionId: EventSubscriptionId;
  readonly surface: EventSideEffectSurface;
  readonly action: EventSideEffectControlAction;
  readonly currentTargetAppReleaseId: AppReleaseId;
  readonly previewTargetAppReleaseId: AppReleaseId;
  readonly sideEffectsAllowed: boolean;
  readonly enforcementPoint:
    | "event-subscription-switch-preview"
    | "event-scheduler-primary-release-pin";
  readonly reason:
    | "queue-side-effects-require-explicit-switch-plan"
    | "queue-new-deliveries-explicitly-planned"
    | "schedule-side-effects-pinned-to-primary-release";
}

export interface EventSubscriptionSwitchPlanPreviewDto {
  readonly required: true;
  readonly provided: boolean;
  readonly entries: readonly EventSubscriptionSwitchPlanEntryInput[];
}

export interface InFlightMessageBehaviorProfileDto {
  readonly kind: "in_flight_message_behavior_profile";
  readonly ownership: InFlightMessageOwnership;
  readonly previewEffect: "no-consumer-switch";
  readonly switchEffect: "new-deliveries-use-planned-target";
  readonly inFlightEffect:
    "already-delivered-messages-remain-with-current-consumer-attempt";
  readonly retryEffect:
    "provider-redelivery-policy-determines-next-attempt-target";
  readonly requiresDrainForZeroOverlap: boolean;
}

export interface EventSubscriptionSwitchIssueDto {
  readonly code:
    | "explicit_switch_plan_required"
    | "unknown_switch_plan_subscription"
    | "schedule_switch_not_supported";
  readonly subscriptionId?: EventSubscriptionId;
  readonly message: string;
}

export interface ManifestEventSubscriptionSpec {
  readonly id: EventSubscriptionId;
  readonly sourceKind: EventSourceKind;
  readonly sourceName: string;
  readonly targetKind?: EventTargetKind;
  readonly targetName: string;
  readonly delivery?: EventDeliverySemantics;
  readonly enabled?: boolean;
}
