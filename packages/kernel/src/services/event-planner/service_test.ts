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

Deno.test("queue data contract mismatch during HTTP canary is blocked unless policy allows", () => {
  const blocked = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    manifest: sampleManifestWithQueueContract("data.job@v2"),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
    subscriptions: primarySubscriptions("data.job@v1"),
  });

  assert.equal(blocked.status, "blocked");
  const issue = blocked.issues.find((candidate) =>
    candidate.code === "queue_data_contract_mismatch_requires_policy"
  );
  assert.equal(issue?.subscriptionId, "jobs");
  const queue = blocked.subscriptions.find((candidate) =>
    candidate.subscriptionId === "jobs"
  );
  assert.equal(queue?.previewTargetAppReleaseId, "release_primary");

  const allowed = buildEventSubscriptionSwitchPreview({
    spaceId: "space_a",
    manifest: sampleManifestWithQueueContract("data.job@v2"),
    primaryAppReleaseId: "release_primary",
    candidateAppReleaseId: "release_canary",
    subscriptions: primarySubscriptions("data.job@v1"),
    switchPlan: { entries: [] },
    policy: { allowQueueDataContractMismatchDuringCanary: true },
  });

  assert.equal(allowed.status, "ready");
  assert.equal(
    allowed.issues.some((candidate) =>
      candidate.code === "queue_data_contract_mismatch_requires_policy"
    ),
    false,
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
  assert.equal(preview.subscriptions.length, 1);
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
    },
  };
}

function sampleManifestWithQueueContract(
  dataContractRef: string,
): PublicDeployManifest {
  return {
    ...sampleManifest(),
    overrides: {
      eventSubscriptions: [{
        id: "jobs",
        sourceKind: "queue",
        sourceName: "jobs",
        targetName: "handler",
        dataContractRef,
      }],
    },
  };
}

function primarySubscriptions(dataContractRef: string) {
  return [{
    id: "jobs",
    source: { kind: "queue" as const, name: "jobs" },
    target: {
      kind: "component",
      groupId: "worker",
      name: "handler",
      appReleaseId: "release_primary",
    },
    dataContractRef,
    delivery: "at-least-once" as const,
    enabled: true,
  }];
}
