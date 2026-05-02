import type {
  PublicDeployManifest,
  PublicRouteSpec,
} from "../../domains/deploy/mod.ts";
import type { EventSubscription } from "../../domains/events/mod.ts";
import type {
  EventSideEffectControlsDto,
  EventSubscriptionSideEffectControlDto,
  EventSubscriptionSwitchIssueDto,
  EventSubscriptionSwitchItemDto,
  EventSubscriptionSwitchPlanEntryInput,
  EventSubscriptionSwitchPreviewDto,
  EventSubscriptionSwitchPreviewInput,
  InFlightMessageBehaviorProfileDto,
  ManifestEventSubscriptionSpec,
} from "./types.ts";

export class EventSubscriptionSwitchPlannerService {
  preview(
    input: EventSubscriptionSwitchPreviewInput,
  ): EventSubscriptionSwitchPreviewDto {
    return buildEventSubscriptionSwitchPreview(input);
  }
}

export function buildEventSubscriptionSwitchPreview(
  input: EventSubscriptionSwitchPreviewInput,
): EventSubscriptionSwitchPreviewDto {
  const groupId = input.groupId ?? input.manifest.name;
  const subscriptions = input.subscriptions ?? subscriptionsFromManifest(
    input.manifest,
    groupId,
  );
  const switchEntries = input.switchPlan?.entries ?? [];
  const switchEntryBySubscriptionId = new Map(
    switchEntries.map((entry) => [entry.subscriptionId, entry]),
  );
  const issues: EventSubscriptionSwitchIssueDto[] = [];

  const items = subscriptions.map((subscription) => {
    const entry = switchEntryBySubscriptionId.get(subscription.id);
    if (entry) switchEntryBySubscriptionId.delete(subscription.id);
    return previewSubscription({
      subscription,
      primaryAppReleaseId: input.primaryAppReleaseId,
      switchEntry: entry,
      issues,
    });
  });

  for (const entry of switchEntryBySubscriptionId.values()) {
    issues.push(Object.freeze({
      code: "unknown_switch_plan_subscription" as const,
      subscriptionId: entry.subscriptionId,
      message:
        `switch plan entry references unknown subscription ${entry.subscriptionId}`,
    }));
  }

  if (
    !input.switchPlan && items.some((item) => item.requiresExplicitSwitchPlan)
  ) {
    issues.unshift(Object.freeze({
      code: "explicit_switch_plan_required" as const,
      message:
        "event subscriptions stay pinned to primaryAppReleaseId during HTTP canary; provide an explicit switch plan to move queue consumers",
    }));
  }

  return deepFreeze({
    kind: "event_subscription_switch_preview" as const,
    spaceId: input.spaceId,
    groupId,
    primaryAppReleaseId: input.primaryAppReleaseId,
    candidateAppReleaseId: input.candidateAppReleaseId,
    status: issues.some((issue) =>
        issue.code === "explicit_switch_plan_required"
      )
      ? "switch-plan-required" as const
      : "ready" as const,
    policy: {
      canaryHttpAutoSwitchesQueueConsumers: false as const,
      scheduleEventsTargetAppReleaseId: input.primaryAppReleaseId,
      explicitSwitchPlanRequired: true as const,
    },
    subscriptions: items,
    sideEffectControls: buildSideEffectControls(
      items.map((item) => item.sideEffectControl),
      input.primaryAppReleaseId,
    ),
    switchPlan: {
      required: true as const,
      provided: input.switchPlan !== undefined,
      entries: switchEntries,
    },
    inFlightMessageBehavior: buildInFlightMessageBehaviorProfile(),
    issues,
  });
}

export function buildInFlightMessageBehaviorProfile(): InFlightMessageBehaviorProfileDto {
  return Object.freeze({
    kind: "in_flight_message_behavior_profile" as const,
    ownership: "delivery-attempt-bound" as const,
    previewEffect: "no-consumer-switch" as const,
    switchEffect: "new-deliveries-use-planned-target" as const,
    inFlightEffect:
      "already-delivered-messages-remain-with-current-consumer-attempt" as const,
    retryEffect:
      "provider-redelivery-policy-determines-next-attempt-target" as const,
    requiresDrainForZeroOverlap: true,
  });
}

function previewSubscription(input: {
  readonly subscription: EventSubscription;
  readonly primaryAppReleaseId: string;
  readonly switchEntry?: EventSubscriptionSwitchPlanEntryInput;
  readonly issues: EventSubscriptionSwitchIssueDto[];
}): EventSubscriptionSwitchItemDto {
  const sourceKind = input.subscription.source.kind;
  const explicitTarget = input.subscription.target.appReleaseId;
  const currentTargetAppReleaseId = explicitTarget ?? input.primaryAppReleaseId;

  if (sourceKind === "schedule") {
    if (input.switchEntry) {
      input.issues.push(Object.freeze({
        code: "schedule_switch_not_supported" as const,
        subscriptionId: input.subscription.id,
        message:
          "schedule event subscriptions target primaryAppReleaseId in switch previews",
      }));
    }
    return Object.freeze({
      subscriptionId: input.subscription.id,
      source: input.subscription.source,
      target: input.subscription.target,
      delivery: input.subscription.delivery,
      enabled: input.subscription.enabled,
      currentTargetAppReleaseId,
      previewTargetAppReleaseId: input.primaryAppReleaseId,
      action: "stay-on-primary" as const,
      sideEffectControl: {
        subscriptionId: input.subscription.id,
        surface: "schedule" as const,
        action: "pin-to-primary" as const,
        currentTargetAppReleaseId,
        previewTargetAppReleaseId: input.primaryAppReleaseId,
        sideEffectsAllowed: false,
        enforcementPoint: "event-scheduler-primary-release-pin" as const,
        reason: "schedule-side-effects-pinned-to-primary-release" as const,
      },
      requiresExplicitSwitchPlan: false,
      reason: "schedule-event-targets-primary-release" as const,
    });
  }

  if (input.switchEntry && sourceKind === "queue") {
    return Object.freeze({
      subscriptionId: input.subscription.id,
      source: input.subscription.source,
      target: input.subscription.target,
      delivery: input.subscription.delivery,
      enabled: input.subscription.enabled,
      currentTargetAppReleaseId,
      previewTargetAppReleaseId: input.switchEntry.targetAppReleaseId,
      action: input.switchEntry.mode,
      sideEffectControl: {
        subscriptionId: input.subscription.id,
        surface: "queue" as const,
        action: "allow-explicit-new-deliveries" as const,
        currentTargetAppReleaseId,
        previewTargetAppReleaseId: input.switchEntry.targetAppReleaseId,
        sideEffectsAllowed: true,
        enforcementPoint: "event-subscription-switch-preview" as const,
        reason: "queue-new-deliveries-explicitly-planned" as const,
      },
      requiresExplicitSwitchPlan: true,
      reason: "explicit-switch-plan-entry" as const,
    });
  }

  return Object.freeze({
    subscriptionId: input.subscription.id,
    source: input.subscription.source,
    target: input.subscription.target,
    delivery: input.subscription.delivery,
    enabled: input.subscription.enabled,
    currentTargetAppReleaseId,
    previewTargetAppReleaseId: input.primaryAppReleaseId,
    action: "stay-on-primary" as const,
    sideEffectControl: sideEffectControlForPinnedSubscription(
      input.subscription,
      currentTargetAppReleaseId,
      input.primaryAppReleaseId,
    ),
    requiresExplicitSwitchPlan: sourceKind === "queue",
    reason: sourceKind === "queue"
      ? "queue-consumer-pinned-during-http-canary" as const
      : "event-subscription-pinned-during-http-canary" as const,
  });
}

function buildSideEffectControls(
  controls: readonly EventSubscriptionSideEffectControlDto[],
  primaryAppReleaseId: string,
): EventSideEffectControlsDto {
  return Object.freeze({
    kind: "event_side_effect_controls" as const,
    queueAutoSwitchAllowed: false as const,
    scheduleSwitchAllowed: false as const,
    queueSwitchRequiresExplicitPlan: true as const,
    scheduleTargetAppReleaseId: primaryAppReleaseId,
    controls,
  });
}

function sideEffectControlForPinnedSubscription(
  subscription: EventSubscription,
  currentTargetAppReleaseId: string,
  primaryAppReleaseId: string,
): EventSubscriptionSideEffectControlDto {
  if (subscription.source.kind === "schedule") {
    return Object.freeze({
      subscriptionId: subscription.id,
      surface: "schedule" as const,
      action: "pin-to-primary" as const,
      currentTargetAppReleaseId,
      previewTargetAppReleaseId: primaryAppReleaseId,
      sideEffectsAllowed: false,
      enforcementPoint: "event-scheduler-primary-release-pin" as const,
      reason: "schedule-side-effects-pinned-to-primary-release" as const,
    });
  }
  return Object.freeze({
    subscriptionId: subscription.id,
    surface: "queue" as const,
    action: "pin-to-primary" as const,
    currentTargetAppReleaseId,
    previewTargetAppReleaseId: primaryAppReleaseId,
    sideEffectsAllowed: false,
    enforcementPoint: "event-subscription-switch-preview" as const,
    reason: "queue-side-effects-require-explicit-switch-plan" as const,
  });
}

function subscriptionsFromManifest(
  manifest: PublicDeployManifest,
  groupId: string,
): readonly EventSubscription[] {
  const routeSubscriptions = routeEntries(manifest)
    .filter((route) => isEventProtocol(route.spec.protocol))
    .flatMap(({ name, spec }) => {
      const targetName = spec.target;
      if (!targetName) return [];
      return [{
        id: name,
        source: {
          kind: normalizeEventSourceKind(spec.protocol),
          name: sourceName(spec, name),
        },
        target: {
          kind: "component",
          groupId,
          name: targetName,
        },
        delivery: "at-least-once" as const,
        enabled: true,
      }];
    });

  const overrideSubscriptions = manifestEventSubscriptions(manifest, groupId);
  return [...routeSubscriptions, ...overrideSubscriptions];
}

function manifestEventSubscriptions(
  manifest: PublicDeployManifest,
  groupId: string,
): readonly EventSubscription[] {
  const raw: unknown = manifest.overrides?.eventSubscriptions;
  if (!Array.isArray(raw)) return [];
  return (raw as readonly unknown[])
    .filter(isManifestEventSubscriptionSpec)
    .map((subscription) => ({
      id: subscription.id,
      source: {
        kind: subscription.sourceKind,
        name: subscription.sourceName,
      },
      target: {
        kind: subscription.targetKind ?? "component",
        groupId,
        name: subscription.targetName,
      },
      delivery: subscription.delivery ?? "at-least-once",
      enabled: subscription.enabled ?? true,
    }));
}

function routeEntries(manifest: PublicDeployManifest): readonly {
  readonly name: string;
  readonly spec: PublicRouteSpec;
}[] {
  const routes = manifest.routes ?? {};
  if (Array.isArray(routes)) {
    return routes.map((spec, index) => ({ name: `route-${index}`, spec }));
  }
  return Object.entries(routes).map(([name, spec]) => ({ name, spec }));
}

function isEventProtocol(protocol: string | undefined): boolean {
  const normalized = protocol?.toLowerCase();
  return normalized === "queue" || normalized === "schedule" ||
    normalized === "event";
}

function normalizeEventSourceKind(
  protocol: string | undefined,
): "queue" | "schedule" | "event" {
  const normalized = protocol?.toLowerCase();
  if (normalized === "queue" || normalized === "schedule") return normalized;
  return "event";
}

function sourceName(spec: PublicRouteSpec, fallback: string): string {
  return typeof spec.source === "string" ? spec.source : fallback;
}

function isManifestEventSubscriptionSpec(
  value: unknown,
): value is ManifestEventSubscriptionSpec {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" &&
    typeof candidate.sourceKind === "string" &&
    typeof candidate.sourceName === "string" &&
    typeof candidate.targetName === "string";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
