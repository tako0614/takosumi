import { expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { notificationPusherId } from "../../../accounts/service/src/notification-pushers-store.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { base64UrlEncode } from "../../../core/domains/notifications/web_push/bytes.ts";
import {
  type OwnNotificationDispatchTarget,
  ownNotificationActivityObserver,
  runWithOwnNotificationScope,
  withOwnNotificationsSettled,
} from "../../../worker/src/own_notification_dispatch.ts";
import { createTestUserAgent } from "../../helpers/web_push_receiver.ts";

const ORIGIN = "https://takosumi.example.test";
const RELAY = "https://relay.example.test";
const OWNER = "tsub_owner";

async function fixture() {
  const ledger = new InMemoryOpenTofuControlStore();
  const accounts = new InMemoryAccountsStore();
  const agent = await createTestUserAgent();
  const pushkey = base64UrlEncode(agent.p256dh);
  const pusherId = await notificationPusherId({ subject: OWNER, appId: "com.takosumi", pushkey });
  await accounts.saveNotificationPusher({
    pusherId, subject: OWNER, kind: "webpush", appId: "com.takosumi", pushkey,
    endpoint: `${RELAY}/push/${pusherId}`, auth: base64UrlEncode(agent.auth),
    deviceDisplayName: "Pixel", lang: "en", createdAt: 1, updatedAt: 1,
  });
  // The cursor sits just before now, as after an earlier scheduled pass.
  await accounts.compareAndSetNotificationDispatchCursor({
    expectedGeneration: undefined,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    id: "",
  });
  const requests: Request[] = [];
  const target: OwnNotificationDispatchTarget = {
    operations: {
      activity: { listAfter: (input) => ledger.listActivityEventsAfter(input) },
      appOwnership: { getOwnership: async () => ({ ownerAccountId: OWNER }) },
      controller: { getRun: async () => ({ createdBy: OWNER }) },
      capsules: { getCapsule: async () => ({ name: "yurucommu" }) },
    },
    store: accounts,
    env: {
      TAKOSUMI_SECRET_STORE_PASSPHRASE: "fixture-only-secret-store-passphrase-0123456789",
      TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: JSON.stringify([RELAY]),
    },
    issuer: ORIGIN,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 201 });
    }) as typeof fetch,
  };
  const record = async (id: string, action: string): Promise<ActivityEvent> => {
    const event: ActivityEvent = {
      id, workspaceId: "ws", action, targetType: "run", targetId: `run_${id}`, runId: `run_${id}`,
      metadata: { capsuleId: "cap_1", operation: "update" }, createdAt: new Date().toISOString(),
    };
    await ledger.putActivityEvent(event);
    return event;
  };
  return { target, requests, record };
}

test("a notified event recorded inside an invocation is sent before the invocation settles", async () => {
  const { target, requests, record } = await fixture();
  const observe = ownNotificationActivityObserver(() => target);
  await withOwnNotificationsSettled(async () => {
    observe(await record("act_wait", "run.approval_required"));
    // Not notified: no pass of its own.
    observe(await record("act_plan", "run.plan_created"));
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get("urgency")).toBe("high");
});

test("outside an invocation scope the scheduled pass is left to send it", async () => {
  const { target, requests, record } = await fixture();
  let resolved = 0;
  const observe = ownNotificationActivityObserver(() => {
    resolved += 1;
    return target;
  });
  observe(await record("act_wait", "run.approval_required"));
  expect(resolved).toBe(0);
  expect(requests).toHaveLength(0);
});

test("events recorded while a pass runs are picked up by one more pass", async () => {
  const { target, requests, record } = await fixture();
  const observe = ownNotificationActivityObserver(() => target);
  const pending: Promise<unknown>[] = [];
  await runWithOwnNotificationScope((task) => { pending.push(task); }, async () => {
    observe(await record("act_one", "run.approval_required"));
    observe(await record("act_two", "run.approval_required"));
  });
  // The second observation joined the running pass instead of starting another.
  expect(new Set(pending).size).toBe(1);
  await Promise.all(pending);
  expect(requests).toHaveLength(2);
});
