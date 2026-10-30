import { expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import { InMemoryAccountsStore } from "../../../accounts/service/src/store.ts";
import { notificationPusherId } from "../../../accounts/service/src/notification-pushers-store.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { base64UrlEncode } from "../../../core/domains/notifications/web_push/bytes.ts";
import {
  type OwnNotificationDispatchTarget,
  ownNotificationActivityObserver,
  runOwnNotificationDispatch,
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
  const requests: Request[] = [];
  const target: OwnNotificationDispatchTarget = {
    operations: {
      activity: {
        listAfter: (input) => ledger.listActivityEventsAfter(input),
        get: (id) => ledger.getActivityEvent(id),
      },
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
  return { target, accounts, requests, record };
}

test("a notified event is delivered under the recording invocation's waitUntil, without the cursor", async () => {
  const { target, accounts, requests, record } = await fixture();
  const attached: Promise<unknown>[] = [];
  const observe = ownNotificationActivityObserver(() => target, { waitUntil: (task) => attached.push(task) });
  observe(await record("act_wait", "run.approval_required"));
  // Not notified: nothing is attached.
  observe(await record("act_plan", "run.plan_created"));
  expect(attached).toHaveLength(1);
  // The hook returned at once; the delivery finishes inside the attached task.
  await Promise.all(attached);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.headers.get("urgency")).toBe("high");
  expect(await accounts.getNotificationDispatchCursor()).toBeUndefined();
});

test("each event gets its own task; two invocations never share or wait for each other", async () => {
  const { target, record } = await fixture();
  const first: Promise<unknown>[] = [];
  const second: Promise<unknown>[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delivered: string[] = [];
  const deliver = async (_target: OwnNotificationDispatchTarget, event: ActivityEvent) => {
    if (event.id === "act_slow") await blocked;
    delivered.push(event.id);
  };
  ownNotificationActivityObserver(() => target, { waitUntil: (task) => first.push(task), deliver })(
    await record("act_slow", "run.approval_required"),
  );
  ownNotificationActivityObserver(() => target, { waitUntil: (task) => second.push(task), deliver })(
    await record("act_fast", "run.approval_required"),
  );
  // The second invocation's delivery finishes while the first is still blocked.
  await Promise.all(second);
  expect(delivered).toEqual(["act_fast"]);
  release();
  await Promise.all(first);
  expect(delivered).toEqual(["act_fast", "act_slow"]);
});

test("with no invocation to attach to, nothing starts and the catch-up pass sends it", async () => {
  const { target, accounts, requests, record } = await fixture();
  let started = 0;
  const deliver = async () => {
    started += 1;
  };
  await accounts.compareAndSetNotificationDispatchCursor({
    expectedGeneration: undefined,
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    id: "",
  });
  ownNotificationActivityObserver(() => target, {
    waitUntil: () => {
      throw new Error("no current request");
    },
    deliver,
  })(await record("act_throwing", "run.approval_required"));
  // No waitUntil passed in by the entry (and no test hook): nothing starts.
  ownNotificationActivityObserver(() => target, { deliver })(await record("act_none", "run.approval_required"));
  await Promise.resolve();
  expect(started).toBe(0);
  expect(requests).toHaveLength(0);

  await runOwnNotificationDispatch(target);
  expect(requests).toHaveLength(2);
});

test("a delivery failure stays inside the task and never reaches the recorder", async () => {
  const { target, accounts, requests, record } = await fixture();
  const attached: Promise<unknown>[] = [];
  const store = Object.create(accounts) as InMemoryAccountsStore;
  store.enqueueNotificationDeliveries = () => Promise.reject(new Error("store down"));
  const observe = ownNotificationActivityObserver(() => ({ ...target, store }), { waitUntil: (task) => attached.push(task) });
  observe(await record("act_wait", "run.approval_required"));
  expect(attached).toHaveLength(1);
  await expect(Promise.all(attached)).resolves.toBeDefined();
  expect(requests).toHaveLength(0);
});
