import assert from "node:assert/strict";
import type { PublicDeployManifest } from "../../domains/deploy/mod.ts";
import { buildEventSubscriptionSwitchPreview } from "./mod.ts";

Deno.test("HTTP canary preview does not auto-switch queue consumers", () => {
  const preview = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
  });

  const queue = preview.subscriptions.find((item) =>
    item.subscriptionId === "jobs"
  );
  assert.equal(preview.status, "switch-plan-required");
  assert.equal(preview.policy.canaryHttpAutoSwitchesQueueConsumers, false);
  assert.equal(preview.policy.explicitSwitchPlanRequired, true);
  assert.equal(preview.sideEffectControls.queueAutoSwitchAllowed, false);
  assert.equal(
    preview.sideEffectControls.queueSwitchRequiresExplicitPlan,
    true,
  );
  assert.equal(queue?.previewTargetAppReleaseId, "release_primary");
  assert.equal(queue?.action, "stay-on-primary");
  assert.equal(queue?.sideEffectControl.sideEffectsAllowed, false);
  assert.equal(
    queue?.sideEffectControl.reason,
    "queue-side-effects-require-explicit-switch-plan",
  );
  assert.equal(queue?.requiresExplicitSwitchPlan, true);
  assert.equal(queue?.reason, "queue-consumer-pinned-during-http-canary");
  assert.equal(preview.issues[0]?.code, "explicit_switch_plan_required");
});

Deno.test("schedule events target primaryAppReleaseId in switch previews", () => {
  const preview = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    groupId: "worker",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    switchPlan: {
      entries: [{
        subscriptionId: "nightly",
        targetAppReleaseId: "release_canary",
        mode: "switch-new-deliveries",
      }],
    },
  });

  const schedule = preview.subscriptions.find((item) =>
    item.subscriptionId === "nightly"
  );
  assert.equal(
    preview.policy.scheduleEventsTargetAppReleaseId,
    "release_primary",
  );
  assert.equal(preview.sideEffectControls.scheduleSwitchAllowed, false);
  assert.equal(
    preview.sideEffectControls.scheduleTargetAppReleaseId,
    "release_primary",
  );
  assert.equal(schedule?.previewTargetAppReleaseId, "release_primary");
  assert.equal(schedule?.action, "stay-on-primary");
  assert.equal(schedule?.sideEffectControl.sideEffectsAllowed, false);
  assert.equal(
    schedule?.sideEffectControl.enforcementPoint,
    "event-scheduler-primary-release-pin",
  );
  assert.equal(schedule?.requiresExplicitSwitchPlan, false);
  assert.equal(schedule?.reason, "schedule-event-targets-primary-release");
  assert.equal(preview.issues[0]?.code, "schedule_switch_not_supported");
});

Deno.test("explicit switch plan previews queue consumers and in-flight message behavior", () => {
  const preview = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
    switchPlan: {
      entries: [{
        subscriptionId: "jobs",
        targetAppReleaseId: "release_canary",
        mode: "switch-new-deliveries",
      }],
    },
  });

  const queue = preview.subscriptions.find((item) =>
    item.subscriptionId === "jobs"
  );
  assert.equal(preview.status, "ready");
  assert.equal(queue?.previewTargetAppReleaseId, "release_canary");
  assert.equal(queue?.action, "switch-new-deliveries");
  assert.equal(queue?.sideEffectControl.sideEffectsAllowed, true);
  assert.equal(
    queue?.sideEffectControl.reason,
    "queue-new-deliveries-explicitly-planned",
  );
  assert.equal(queue?.reason, "explicit-switch-plan-entry");
  assert.deepEqual(preview.issues, []);
  assert.equal(
    preview.inFlightMessageBehavior.kind,
    "in_flight_message_behavior_profile",
  );
  assert.equal(
    preview.inFlightMessageBehavior.inFlightEffect,
    "already-delivered-messages-remain-with-current-consumer-attempt",
  );
  assert.equal(
    preview.inFlightMessageBehavior.requiresDrainForZeroOverlap,
    true,
  );
});

Deno.test("event switch preview runs before Deployment activation envelope creation", () => {
  const createdDeploymentIds: string[] = [];
  const preview = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    manifest: sampleManifest(),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
    switchPlan: {
      entries: [{
        subscriptionId: "jobs",
        targetAppReleaseId: "release_canary",
        mode: "switch-new-deliveries",
      }],
    },
  });

  assert.deepEqual(createdDeploymentIds, []);
  assert.equal(preview.status, "ready");
  assert.equal(
    preview.subscriptions[0]?.previewTargetAppReleaseId,
    "release_canary",
  );
  assert.equal(
    preview.subscriptions[1]?.previewTargetAppReleaseId,
    "release_primary",
  );
});

function sampleManifest(): PublicDeployManifest {
  return {
    name: "worker",
    version: "1.0.0",
    compute: {
      handler: {
        type: "container",
        image:
          "registry.example.test/worker@sha256:7777777777777777777777777777777777777777777777777777777777777777",
        port: 8080,
      },
    },
    routes: {
      web: {
        target: "handler",
        protocol: "https",
        host: "worker.example.test",
        path: "/",
      },
      jobs: { target: "handler", protocol: "queue", source: "jobs" },
      nightly: { target: "handler", protocol: "schedule", source: "nightly" },
    },
  };
}
