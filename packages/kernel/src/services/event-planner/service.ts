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
  const subscriptions = (input.subscriptions ?? subscriptionsFromManifest(
    input.manifest,
    groupId,
  )).filter((subscription) => subscription.source.kind === "queue");
  const candidateSubscriptions = subscriptionsFromManifest(
    input.manifest,
    groupId,
  )
    .filter((subscription) => subscription.source.kind === "queue");
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

  issues.push(
    ...queueDataContractIssues({
      currentSubscriptions: subscriptions,
      candidateSubscriptions,
      items,
      candidateAppReleaseId: input.candidateAppReleaseId,
      primaryAppReleaseId: input.primaryAppReleaseId,
      mismatchAllowed:
        input.policy?.allowQueueDataContractMismatchDuringCanary === true,
    }),
  );

  if (
    !input.switchPlan && items.some((item) => item.requiresExplicitSwitchPlan)
  ) {
    issues.push(Object.freeze({
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
        issue.code === "queue_data_contract_mismatch_requires_policy"
      )
      ? "blocked" as const
      : issues.some((issue) =>
          issue.code === "explicit_switch_plan_required"
        )
      ? "switch-plan-required" as const
      : "ready" as const,
    policy: {
      canaryHttpAutoSwitchesQueueConsumers: false as const,
      explicitSwitchPlanRequired: true as const,
      queueDataContractMismatchAllowed:
        input.policy?.allowQueueDataContractMismatchDuringCanary === true,
    },
    subscriptions: items,
    sideEffectControls: buildSideEffectControls(
      items.map((item) => item.sideEffectControl),
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

function queueDataContractIssues(input: {
  readonly currentSubscriptions: readonly EventSubscription[];
  readonly candidateSubscriptions: readonly EventSubscription[];
  readonly items: readonly EventSubscriptionSwitchItemDto[];
  readonly candidateAppReleaseId?: string;
  readonly primaryAppReleaseId: string;
  readonly mismatchAllowed: boolean;
}): readonly EventSubscriptionSwitchIssueDto[] {
  if (!input.candidateAppReleaseId || input.mismatchAllowed) return [];
  const itemBySubscriptionId = new Map(
    input.items.map((item) => [item.subscriptionId, item]),
  );
  const candidateBySubscriptionId = new Map(
    input.candidateSubscriptions.map((subscription) => [
      subscription.id,
      subscription,
    ]),
  );
  const issues: EventSubscriptionSwitchIssueDto[] = [];

  for (const subscription of input.currentSubscriptions) {
    const currentContract = subscription.dataContractRef;
    if (!currentContract) continue;
    const candidateContract = candidateBySubscriptionId.get(subscription.id)
      ?.dataContractRef;
    if (!candidateContract || candidateContract === currentContract) continue;
    const item = itemBySubscriptionId.get(subscription.id);
    if (!item) continue;
    if (item.previewTargetAppReleaseId !== input.primaryAppReleaseId) {
      continue;
    }
    issues.push(Object.freeze({
      code: "queue_data_contract_mismatch_requires_policy" as const,
      subscriptionId: subscription.id,
      message:
        `candidate ${input.candidateAppReleaseId} emits ${candidateContract} for queue subscription ${subscription.id}, but primary consumer ${input.primaryAppReleaseId} accepts ${currentContract}`,
    }));
  }

  return issues;
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
    reason: "queue-consumer-pinned-during-http-canary" as const,
  });
}

function buildSideEffectControls(
  controls: readonly EventSubscriptionSideEffectControlDto[],
): EventSideEffectControlsDto {
  return Object.freeze({
    kind: "event_side_effect_controls" as const,
    queueAutoSwitchAllowed: false as const,
    queueSwitchRequiresExplicitPlan: true as const,
    controls,
  });
}

function sideEffectControlForPinnedSubscription(
  subscription: EventSubscription,
  currentTargetAppReleaseId: string,
  primaryAppReleaseId: string,
): EventSubscriptionSideEffectControlDto {
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
        kind: "queue" as const,
        name: subscription.sourceName,
      },
      target: {
        kind: subscription.targetKind ?? "component",
        groupId,
        name: subscription.targetName,
      },
      ...(subscription.dataContractRef === undefined
        ? {}
        : { dataContractRef: subscription.dataContractRef }),
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
  return normalized === "queue";
}

function normalizeEventSourceKind(
  protocol: string | undefined,
): "queue" {
  const normalized = protocol?.toLowerCase();
  if (normalized !== "queue") {
    throw new TypeError(`Unsupported event source protocol: ${protocol}`);
  }
  return "queue";
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
    candidate.sourceKind === "queue" &&
    typeof candidate.sourceName === "string" &&
    typeof candidate.targetName === "string" &&
    (candidate.dataContractRef === undefined ||
      typeof candidate.dataContractRef === "string");
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
