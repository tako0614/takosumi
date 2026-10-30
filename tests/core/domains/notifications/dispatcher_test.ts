import { describe, expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { notificationPusherId } from "../../../../accounts/service/src/notification-pushers-store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { NotificationDispatchStore } from "../../../../core/domains/notifications/dispatch_store.ts";
import {
  NOTIFICATION_SETTLE_WINDOW_MS,
  type NotificationRecipientDirectory,
  OwnNotificationDispatcher,
} from "../../../../core/domains/notifications/dispatcher.ts";
import { createOwnNotificationDispatcher } from "../../../../core/domains/notifications/compose.ts";
import { base64UrlEncode } from "../../../../core/domains/notifications/web_push/bytes.ts";
import { deriveWebPushTopicKey } from "../../../../core/domains/notifications/web_push/topic.ts";
import { deriveVapidKeyPair } from "../../../../core/domains/notifications/web_push/vapid.ts";
import {
  createTestUserAgent,
  decryptWebPushBody,
  type TestUserAgent,
  verifyVapidAuthorization,
} from "../../../helpers/web_push_receiver.ts";

const PASSPHRASE = "fixture-only-secret-store-passphrase-0123456789";
const ORIGIN = "https://takosumi.example.test";
const RELAY = "https://relay.example.test";
const OWNER = "tsub_owner";
const STARTER = "tsub_starter";
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);

interface Harness {
  readonly ledger: InMemoryOpenTofuControlStore;
  readonly accounts: InMemoryAccountsStore;
  readonly dispatcher: OwnNotificationDispatcher;
  readonly requests: Request[];
  readonly clock: { now: number };
  answers: number[];
  register(subject: string, lang: string): Promise<{ readonly pusherId: string; readonly agent: TestUserAgent }>;
  record(event: Partial<ActivityEvent> & Pick<ActivityEvent, "id" | "action">, at: number): Promise<void>;
}

async function harness(options: {
  readonly directory?: Partial<NotificationRecipientDirectory>;
  /** The relay's answer for one push; 201 by default. */
  readonly answer?: (pusherId: string) => number;
} = {}): Promise<Harness> {
  const ledger = new InMemoryOpenTofuControlStore();
  const accounts = new InMemoryAccountsStore();
  const clock = { now: T0 };
  const requests: Request[] = [];
  const state = { answers: [] as number[] };
  const vapid = await deriveVapidKeyPair(new TextEncoder().encode(PASSPHRASE));
  const topicKey = await deriveWebPushTopicKey(new TextEncoder().encode(PASSPHRASE));
  const directory: NotificationRecipientDirectory = {
    appOwner: async () => OWNER,
    runStartedBy: async () => STARTER,
    connectionOwner: async () => OWNER,
    appName: async (capsuleId) => (capsuleId === "cap_consumer" ? "Consumer" : "yurucommu"),
    ...options.directory,
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const pusherId = new URL(request.url).pathname.split("/").at(-1)!;
    return new Response(null, { status: state.answers.shift() ?? options.answer?.(pusherId) ?? 201 });
  }) as typeof globalThis.fetch;
  const dispatcher = new OwnNotificationDispatcher({
    events: { listAfter: (input) => ledger.listActivityEventsAfter(input) },
    directory,
    store: accounts as unknown as NotificationDispatchStore,
    vapid: async () => vapid,
    topicKey: async () => topicKey,
    instanceOrigin: ORIGIN,
    fetch,
    now: () => clock.now,
    random: () => 0,
  });
  return {
    ledger,
    accounts,
    dispatcher,
    requests,
    clock,
    get answers() { return state.answers; },
    set answers(value) { state.answers = value; },
    async register(subject, lang) {
      const agent = await createTestUserAgent();
      const pushkey = base64UrlEncode(agent.p256dh);
      const pusherId = await notificationPusherId({ subject: subject as `tsub_${string}`, appId: "com.takosumi", pushkey });
      await accounts.saveNotificationPusher({
        pusherId,
        subject: subject as `tsub_${string}`,
        kind: "webpush",
        appId: "com.takosumi",
        pushkey,
        endpoint: `${RELAY}/push/${pusherId}`,
        auth: base64UrlEncode(agent.auth),
        deviceDisplayName: "Pixel",
        lang,
        createdAt: clock.now,
        updatedAt: clock.now,
      });
      return { pusherId, agent };
    },
    async record(event, at) {
      await ledger.putActivityEvent({
        workspaceId: "workspace_1",
        targetType: "run",
        targetId: `run_${event.id}`,
        metadata: {},
        createdAt: new Date(at).toISOString(),
        ...event,
      } as ActivityEvent);
    },
  };
}

async function decrypt(request: Request, agent: TestUserAgent) {
  return JSON.parse(new TextDecoder().decode(
    await decryptWebPushBody(new Uint8Array(await request.arrayBuffer()), agent),
  )) as { web_push: number; notification: Record<string, string> };
}

describe("own-notification dispatcher", () => {
  test("starts at the present, then sends a new approval wait to the owner's device in the same run", async () => {
    const h = await harness();
    const { agent } = await h.register(OWNER, "ja-JP");
    await h.record({ id: "act_history", action: "run.approval_required", metadata: { capsuleId: "cap_1" } }, T0 - 600_000);
    // The first run only places the cursor; history is never sent.
    expect(await h.dispatcher.run()).toMatchObject({ enabled: true, events: 0, enqueued: 0 });
    expect(await h.accounts.getNotificationDispatchCursor()).toEqual({
      generation: 0,
      createdAt: new Date(T0 - NOTIFICATION_SETTLE_WINDOW_MS).toISOString(),
      id: "",
    });

    h.clock.now = T0 + 10_000;
    await h.record({ id: "act_wait", action: "run.approval_required", runId: "run_42", targetId: "run_42", metadata: { capsuleId: "cap_1", operation: "update" } }, T0);
    // Still inside the settle window: left for a later run.
    expect(await h.dispatcher.run()).toMatchObject({ events: 0, enqueued: 0, delivered: 0 });

    h.clock.now = T0 + NOTIFICATION_SETTLE_WINDOW_MS + 1;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 1, delivered: 1 });
    expect(h.requests).toHaveLength(1);
    const [request] = h.requests;
    expect(request!.url.startsWith(`${RELAY}/push/`)).toBe(true);
    expect(request!.headers.get("urgency")).toBe("high");
    const ttl = Number(request!.headers.get("ttl"));
    expect(ttl).toBeGreaterThan(86_400 - 120);
    expect(ttl).toBeLessThanOrEqual(86_400);
    expect(request!.headers.get("topic")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await verifyVapidAuthorization(request!.headers.get("authorization"))).claims).toMatchObject({ aud: RELAY, sub: ORIGIN });
    expect(await decrypt(request!, agent)).toEqual({
      web_push: 8030,
      notification: {
        title: "承認を待っています",
        body: "yurucommu の変更に、削除または置き換えを含むplanがあります",
        navigate: `${ORIGIN}/runs/run_42`,
        lang: "ja-JP",
        tag: "run:run_42",
      },
    });
    const pusher = (await h.accounts.listNotificationPushersForSubject(OWNER))[0]!;
    expect(pusher.lastSuccessAt).toBe(h.clock.now);

    // Running again sends nothing new, and a replayed cursor enqueues nothing twice.
    expect(await h.dispatcher.run()).toMatchObject({ events: 0, enqueued: 0, delivered: 0 });
    const cursor = (await h.accounts.getNotificationDispatchCursor())!;
    await h.accounts.compareAndSetNotificationDispatchCursor({
      expectedGeneration: cursor.generation,
      createdAt: new Date(T0 - 1).toISOString(),
      id: "",
    });
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, delivered: 0 });
    expect(h.requests).toHaveLength(1);
  });

  test("410 removes the pusher, 5xx retries on the schedule, 403 marks it failing", async () => {
    const byEndpoint = new Map<string, number>();
    const h = await harness({ answer: (pusherId) => byEndpoint.get(pusherId) ?? 201 });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    const gone = await h.register(OWNER, "en-US");
    const flaky = await h.register(OWNER, "en-US");
    const broken = await h.register(OWNER, "en-US");
    await h.record({ id: "act_drift", action: "capsule.drift_detected", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0);
    h.clock.now = T0 + NOTIFICATION_SETTLE_WINDOW_MS;
    byEndpoint.set(gone.pusherId, 410).set(flaky.pusherId, 503).set(broken.pusherId, 403);
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 3, delivered: 0, removedPushers: 1, retried: 1, failed: 1 });
    const pushers = await h.accounts.listNotificationPushersForSubject(OWNER);
    expect(pushers.map((pusher) => pusher.pusherId).sort()).toEqual([broken.pusherId, flaky.pusherId].sort());
    expect(pushers.find((pusher) => pusher.pusherId === broken.pusherId)).toMatchObject({ lastFailureStatus: 403 });
    expect(pushers.find((pusher) => pusher.pusherId === flaky.pusherId)?.lastFailureAt).toBeUndefined();

    // Not due yet: nothing is sent.
    h.clock.now += 10_000;
    expect(await h.dispatcher.run()).toMatchObject({ delivered: 0, retried: 0 });
    // After the 30 s backoff the retry goes out and succeeds.
    byEndpoint.set(flaky.pusherId, 201);
    h.clock.now += 30_000;
    expect(await h.dispatcher.run()).toMatchObject({ delivered: 1, retried: 0, failed: 0 });
    expect(h.requests.filter((request) => request.url.endsWith(flaky.pusherId))).toHaveLength(2);
    expect(h.requests.filter((request) => request.url.endsWith(broken.pusherId))).toHaveLength(1);
    expect((await h.accounts.findNotificationPusher(flaky.pusherId))?.lastSuccessAt).toBe(h.clock.now);
  });

  test("resolves recipients from the app owner and named accounts, never system actors", async () => {
    const h = await harness({ directory: { runStartedBy: async (runId) => (runId === "run_auto" ? "system:auto-update" : OWNER) } });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    const owner = await h.register(OWNER, "en-US");
    const member = await h.register("tsub_member", "ja");
    const recipient = await h.register("tsub_recipient", "en");
    await h.record({ id: "act_1", action: "run.failed", runId: "run_manual", targetId: "run_manual", metadata: { capsuleId: "cap_1", phase: "apply" } }, T0);
    await h.record({ id: "act_2", action: "run.failed", runId: "run_auto", targetId: "run_auto", metadata: { capsuleId: "cap_1", phase: "plan" } }, T0 + 1);
    // App ownership rows carry the accounts at the top level, without metadata.
    await h.ledger.putActivityEvent({
      id: "own_3", workspaceId: "workspace_1", action: "app.member_added", targetType: "capsule", targetId: "cap_1",
      memberAccountId: "tsub_member", createdAt: new Date(T0 + 2).toISOString(),
    } as unknown as ActivityEvent);
    await h.ledger.putActivityEvent({
      id: "own_4", workspaceId: "workspace_1", action: "app.ownership_transfer_created", targetType: "capsule", targetId: "cap_1",
      memberAccountId: "tsub_recipient", recipientAccountId: "tsub_recipient", createdAt: new Date(T0 + 3).toISOString(),
    } as unknown as ActivityEvent);
    await h.record({ id: "act_5", action: "interface_link.approval_requested", targetType: "interface_link", targetId: "ifl_1", metadata: { providerCapsuleId: "cap_1", consumerCapsuleId: "cap_consumer" } }, T0 + 4);
    await h.record({ id: "act_6", action: "run.applied", runId: "run_install", targetId: "run_install", metadata: { capsuleId: "cap_1", operation: "create" } }, T0 + 5);
    await h.record({ id: "act_7", action: "run.applied", runId: "run_update", targetId: "run_update", metadata: { capsuleId: "cap_1", operation: "update" } }, T0 + 6);
    await h.record({ id: "act_8", action: "run.plan_created", metadata: { capsuleId: "cap_1" } }, T0 + 7);
    h.clock.now = T0 + NOTIFICATION_SETTLE_WINDOW_MS + 10;
    const result = await h.dispatcher.run();
    // act_1: starter == owner, one row. act_2: owner only. act_3: member.
    // act_4: recipient. act_5: owner. act_6: installer (owner). act_7, act_8: none.
    expect(result).toMatchObject({ events: 8, enqueued: 6, delivered: 6 });
    const bodies = async (target: { readonly pusherId: string; readonly agent: TestUserAgent }) =>
      await Promise.all(h.requests.filter((request) => request.url.endsWith(target.pusherId)).map((request) => decrypt(request.clone(), target.agent)));
    expect((await bodies(owner)).map((body) => body.notification.body).sort()).toEqual([
      "Consumer asks to link with yurucommu",
      "The apply of yurucommu failed",
      "The plan of yurucommu failed",
      "yurucommu is ready to use",
    ].sort());
    expect((await bodies(member)).map((body) => [body.notification.title, body.notification.lang, body.notification.navigate])).toEqual([
      ["メンバーに追加されました", "ja", `${ORIGIN}/apps/cap_1`],
    ]);
    expect((await bodies(recipient)).map((body) => body.notification.body)).toEqual([
      "You are asked to become the owner of yurucommu",
    ]);
  });

  test("an event whose recipients cannot be read is retried, then skipped once old", async () => {
    let failing = true;
    const h = await harness({ directory: { appOwner: async () => { if (failing) throw new Error("ledger unavailable"); return OWNER; } } });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_a", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0);
    await h.record({ id: "act_b", action: "capsule.auto_update_failed", targetType: "capsule", targetId: "cap_1", metadata: {} }, T0 + 1);
    h.clock.now = T0 + NOTIFICATION_SETTLE_WINDOW_MS + 5;
    expect(await h.dispatcher.run()).toMatchObject({ events: 0, enqueued: 0, skippedEvents: 0 });
    failing = false;
    expect(await h.dispatcher.run()).toMatchObject({ events: 2, enqueued: 2, delivered: 2 });

    failing = true;
    await h.record({ id: "act_c", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0 + 2);
    h.clock.now = T0 + 20 * 60_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 0, skippedEvents: 1 });
  });

  test("an event past its TTL is never sent", async () => {
    const h = await harness();
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_old", action: "run.approval_required", runId: "run_1", targetId: "run_1", metadata: { capsuleId: "cap_1" } }, T0);
    h.clock.now = T0 + 86_400_000 + 1;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 0, delivered: 0 });
  });

  test("without a secret-store passphrase nothing is read or sent", async () => {
    const ledger = new InMemoryOpenTofuControlStore();
    const accounts = new InMemoryAccountsStore();
    const operations = {
      activity: { listAfter: (input: Parameters<InMemoryOpenTofuControlStore["listActivityEventsAfter"]>[0]) => ledger.listActivityEventsAfter(input) },
      appOwnership: { getOwnership: async () => ({ ownerAccountId: OWNER }) },
      controller: { getRun: async () => ({ createdBy: OWNER }) },
      capsules: { getCapsule: async () => ({ name: "app" }) },
      connections: { getProviderConnection: async () => ({ ownerAccountId: OWNER }) },
    };
    const disabled = createOwnNotificationDispatcher({ operations, store: accounts, env: {}, issuer: ORIGIN });
    expect(await disabled!.run()).toMatchObject({ enabled: false });
    expect(await accounts.getNotificationDispatchCursor()).toBeUndefined();
    expect(createOwnNotificationDispatcher({ operations, store: {}, env: {}, issuer: ORIGIN })).toBeUndefined();
    expect(createOwnNotificationDispatcher({ operations, store: accounts, env: {}, issuer: "not a url" })).toBeUndefined();
    const enabled = createOwnNotificationDispatcher({
      operations,
      store: accounts,
      env: { TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE },
      issuer: `${ORIGIN}/`,
    });
    expect(await enabled!.run()).toMatchObject({ enabled: true });
    expect(await accounts.getNotificationDispatchCursor()).toMatchObject({ generation: 0 });
  });
});
