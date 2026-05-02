import type {
  EventSubscriptionRevision,
  EventSubscriptionRevisionInput,
  EventTargetRef,
  EventTargetResolutionContext,
  ResolvedEventTargetRef,
} from "./types.ts";

export function resolveEventTarget(
  target: EventTargetRef,
  context: EventTargetResolutionContext,
): ResolvedEventTargetRef {
  if (target.appReleaseId) {
    return {
      ...target,
      appReleaseId: target.appReleaseId,
      resolvedThrough: "explicit-app-release",
    };
  }
  return {
    ...target,
    appReleaseId: context.primaryAppReleaseId,
    resolvedThrough: "primaryAppReleaseId",
  };
}

export function createEventSubscriptionRevision(
  input: EventSubscriptionRevisionInput,
): EventSubscriptionRevision {
  return {
    id: input.id,
    spaceId: input.spaceId,
    groupId: input.groupId,
    activationId: input.activationId,
    appReleaseId: input.appReleaseId,
    primaryAppReleaseId: input.primaryAppReleaseId,
    subscriptions: input.subscriptions.map((subscription) => ({
      ...subscription,
      target: resolveEventTarget(subscription.target, {
        primaryAppReleaseId: input.primaryAppReleaseId,
      }),
    })),
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    supersedesRevisionId: input.supersedesRevisionId,
  };
}
