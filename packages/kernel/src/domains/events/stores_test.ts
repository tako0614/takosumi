import assert from "node:assert/strict";
import {
  createEventSubscriptionRevision,
  InMemoryEventSubscriptionRevisionStore,
} from "./mod.ts";

Deno.test("event subscription revisions resolve implicit targets through primaryAppReleaseId", async () => {
  const store = new InMemoryEventSubscriptionRevisionStore();
  const revision = createEventSubscriptionRevision({
    id: "events_rev_1",
    spaceId: "space_a",
    groupId: "worker",
    activationId: "act_worker_1",
    appReleaseId: "release_worker_canary",
    primaryAppReleaseId: "release_worker_primary",
    subscriptions: [{
      id: "sub_queue_default",
      source: { kind: "queue", name: "jobs" },
      target: { kind: "component", groupId: "worker", name: "handler" },
      delivery: "at-least-once",
      enabled: true,
    }, {
      id: "sub_event_pinned",
      source: { kind: "event", name: "docs.published" },
      target: {
        kind: "component",
        groupId: "worker",
        name: "pinned-handler",
        appReleaseId: "release_worker_pinned",
      },
      delivery: "at-most-once",
      enabled: true,
    }],
    createdAt: "2026-04-27T00:00:00.000Z",
  });

  await store.put(revision);

  assert.equal(
    revision.subscriptions[0]?.target.appReleaseId,
    "release_worker_primary",
  );
  assert.equal(
    revision.subscriptions[0]?.target.resolvedThrough,
    "primaryAppReleaseId",
  );
  assert.equal(
    revision.subscriptions[1]?.target.appReleaseId,
    "release_worker_pinned",
  );
  assert.equal(
    revision.subscriptions[1]?.target.resolvedThrough,
    "explicit-app-release",
  );
  assert.equal(
    (await store.latestForGroup("space_a", "worker"))?.id,
    "events_rev_1",
  );
});

Deno.test("event subscription revision store lists by activation and release", async () => {
  const store = new InMemoryEventSubscriptionRevisionStore();
  await store.put(createEventSubscriptionRevision({
    id: "events_rev_1",
    spaceId: "space_a",
    groupId: "worker",
    activationId: "act_1",
    appReleaseId: "release_1",
    primaryAppReleaseId: "release_1",
    subscriptions: [],
    createdAt: "2026-04-27T00:00:00.000Z",
  }));
  await store.put(createEventSubscriptionRevision({
    id: "events_rev_2",
    spaceId: "space_a",
    groupId: "worker",
    activationId: "act_2",
    appReleaseId: "release_2",
    primaryAppReleaseId: "release_2",
    subscriptions: [],
    createdAt: "2026-04-27T00:01:00.000Z",
    supersedesRevisionId: "events_rev_1",
  }));

  assert.deepEqual(
    (await store.list({ activationId: "act_2" })).map((item) => item.id),
    ["events_rev_2"],
  );
  assert.deepEqual(
    (await store.list({ appReleaseId: "release_1" })).map((item) => item.id),
    ["events_rev_1"],
  );
  assert.equal(
    (await store.latestForGroup("space_a", "worker"))?.id,
    "events_rev_2",
  );
});

Deno.test("queue consumer records are owned by an AppRelease", async () => {
  const store = new InMemoryEventSubscriptionRevisionStore();
  const revision = createEventSubscriptionRevision({
    id: "events_rev_queue_owner",
    spaceId: "space_a",
    groupId: "worker",
    activationId: "act_queue",
    appReleaseId: "release_worker_primary",
    primaryAppReleaseId: "release_worker_primary",
    subscriptions: [{
      id: "jobs",
      source: { kind: "queue", name: "jobs" },
      target: { kind: "component", groupId: "worker", name: "handler" },
      delivery: "at-least-once",
      enabled: true,
    }],
    createdAt: "2026-04-27T00:02:00.000Z",
  });

  await store.put(revision);

  const queue = revision.subscriptions.find((subscription) =>
    subscription.source.kind === "queue"
  );
  assert.equal(revision.appReleaseId, "release_worker_primary");
  assert.equal(queue?.target.appReleaseId, "release_worker_primary");
  assert.equal(queue?.target.resolvedThrough, "primaryAppReleaseId");
  assert.deepEqual(
    (await store.list({ appReleaseId: "release_worker_primary" })).map((
      item,
    ) => item.id),
    ["events_rev_queue_owner"],
  );
});
