import { describe, expect, test } from "bun:test";
import type { ActivityEvent } from "takosumi-contract/activity";

import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { notificationPusherId } from "../../../../accounts/service/src/notification-pushers-store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type { NotificationDispatchStore } from "../../../../core/domains/notifications/dispatch_store.ts";
import {
  NOTIFICATION_REREAD_WINDOW_MS,
  type NotificationRecipientDirectory,
  OwnNotificationDispatcher,
} from "../../../../core/domains/notifications/dispatcher.ts";
import { createOwnNotificationDispatcher, deliverOwnNotificationNow } from "../../../../core/domains/notifications/compose.ts";
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
  readonly relayOrigins?: readonly string[];
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
  /** How long one push takes on the harness clock. */
  readonly sendTakesMs?: number;
  /** Wraps the by-id ledger read of parked events. */
  readonly getEvent?: (id: string, read: () => Promise<ActivityEvent | undefined>, clock: { now: number }) => Promise<ActivityEvent | undefined>;
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
    appName: async (capsuleId) => (capsuleId === "cap_consumer" ? "Consumer" : "yurucommu"),
    ...options.directory,
  };
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request.clone());
    const pusherId = new URL(request.url).pathname.split("/").at(-1)!;
    clock.now += options.sendTakesMs ?? 0;
    return new Response(null, { status: state.answers.shift() ?? options.answer?.(pusherId) ?? 201 });
  }) as typeof globalThis.fetch;
  const dispatcher = new OwnNotificationDispatcher({
    events: {
      listAfter: (input) => ledger.listActivityEventsAfter(input),
      get: (id) => options.getEvent
        ? options.getEvent(id, () => ledger.getActivityEvent(id), clock)
        : ledger.getActivityEvent(id),
    },
    directory,
    store: accounts as unknown as NotificationDispatchStore,
    vapid: async () => vapid,
    topicKey: async () => topicKey,
    instanceOrigin: ORIGIN,
    relayOrigins: options.relayOrigins ?? [RELAY],
    fetch,
    now: () => clock.now,
    random: () => 0,
    ...(options.log ? { log: options.log } : {}),
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
  test("starts at the present, sends a new approval wait in the next pass, and re-reads without resending", async () => {
    const h = await harness();
    const { agent } = await h.register(OWNER, "ja-JP");
    await h.record({ id: "act_history", action: "run.approval_required", metadata: { capsuleId: "cap_1" } }, T0 - 600_000);
    // The first run only places the cursor; history is never sent.
    expect(await h.dispatcher.run()).toMatchObject({ enabled: true, idle: false, events: 0, enqueued: 0 });
    expect(await h.accounts.getNotificationDispatchCursor()).toEqual({
      generation: 0,
      createdAt: new Date(T0).toISOString(),
      id: "",
      parked: [],
    });

    // An event recorded a moment ago is read at once (no settle delay).
    h.clock.now = T0 + 2_000;
    await h.record({ id: "act_wait", action: "run.approval_required", runId: "run_42", targetId: "run_42", metadata: { capsuleId: "cap_1", operation: "update" } }, T0 + 1_000);
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

    // Inside the re-read window the event is read again but adds no row and
    // is not resent; the cursor stays behind it.
    h.clock.now = T0 + 60_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 0, delivered: 0 });
    expect((await h.accounts.getNotificationDispatchCursor())?.createdAt).toBe(new Date(T0).toISOString());
    // Once older than the window, the cursor passes it and it is not read again.
    h.clock.now = T0 + NOTIFICATION_REREAD_WINDOW_MS + 5_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 0 });
    expect(await h.accounts.getNotificationDispatchCursor()).toMatchObject({ createdAt: new Date(T0 + 1_000).toISOString(), id: "act_wait" });
    expect(await h.dispatcher.run()).toMatchObject({ events: 0, enqueued: 0 });
    expect(h.requests).toHaveLength(1);
  });

  test("an event committed late within the window is still sent", async () => {
    const h = await harness();
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0).toISOString(), id: "" });
    await h.register(OWNER, "en");
    h.clock.now = T0 + 10_000;
    await h.record({ id: "act_b", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0 + 9_000);
    expect(await h.dispatcher.run()).toMatchObject({ enqueued: 1, delivered: 1 });
    // A row whose createdAt is earlier but which committed after that run.
    await h.record({ id: "act_a", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_2", metadata: { capsuleId: "cap_2" } }, T0 + 5_000);
    h.clock.now = T0 + 20_000;
    expect(await h.dispatcher.run()).toMatchObject({ enqueued: 1, delivered: 1 });
    expect(h.requests).toHaveLength(2);
  });

  test("an instance without any pusher only moves the cursor, keeping the re-read window", async () => {
    const h = await harness();
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 3_600_000).toISOString(), id: "" });
    await h.record({ id: "act_old", action: "run.approval_required", runId: "run_1", targetId: "run_1", metadata: { capsuleId: "cap_1" } }, T0 - 3_000_000);
    h.clock.now = T0;
    expect(await h.dispatcher.run()).toEqual({
      enabled: true, idle: true, events: 0, enqueued: 0, delivered: 0, retried: 0, failed: 0,
      removedPushers: 0, skippedEvents: 0, parkedEvents: 0, expiredEvents: 0,
    });
    expect((await h.accounts.getNotificationDispatchCursor())?.createdAt)
      .toBe(new Date(T0 - NOTIFICATION_REREAD_WINDOW_MS).toISOString());
    // An event that commits late inside the window still reaches a device
    // that registers now; what happened before the window does not.
    await h.record({ id: "act_late", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0 - 60_000);
    await h.register(OWNER, "en");
    h.clock.now = T0 + 1_000;
    expect(await h.dispatcher.run()).toMatchObject({ idle: false, events: 1, enqueued: 1, delivered: 1 });
  });

  test("410 removes the pusher, 5xx retries on the schedule, 403 marks it failing, a removed relay origin stops receiving", async () => {
    const byEndpoint = new Map<string, number>();
    const h = await harness({ answer: (pusherId) => byEndpoint.get(pusherId) ?? 201 });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    const gone = await h.register(OWNER, "en-US");
    const flaky = await h.register(OWNER, "en-US");
    const broken = await h.register(OWNER, "en-US");
    await h.record({ id: "act_drift", action: "capsule.drift_detected", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0);
    h.clock.now = T0 + 1_000;
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

    // The operator removes the relay origin: the pusher is no longer sent to.
    const moved = await harness({ relayOrigins: ["https://other-relay.example.test"] });
    await moved.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    const stranded = await moved.register(OWNER, "en");
    await moved.record({ id: "act_x", action: "capsule.drift_detected", targetType: "capsule", targetId: "cap_1", metadata: { capsuleId: "cap_1" } }, T0);
    moved.clock.now = T0 + 1_000;
    expect(await moved.dispatcher.run()).toMatchObject({ enqueued: 1, delivered: 0, failed: 1 });
    expect(moved.requests).toHaveLength(0);
    expect((await moved.accounts.findNotificationPusher(stranded.pusherId))?.lastFailureAt).toBe(moved.clock.now);
  });

  test("resolves recipients from the app owner and named accounts, never system actors", async () => {
    const h = await harness({ directory: { runStartedBy: async (runId) => (runId === "run_auto" ? "system:auto-update" : OWNER) } });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    const owner = await h.register(OWNER, "en-US");
    const member = await h.register("tsub_member", "ja");
    const recipient = await h.register("tsub_recipient", "en");
    const connectionOwner = await h.register("tsub_conn_owner", "en");
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
    // The stored event never names a revoked Connection's owner: catch-up sends nothing.
    await h.record({ id: "act_9", action: "connection.revoked", targetType: "connection", targetId: "conn_gone", metadata: { provider: "x" } }, T0 + 8);
    h.clock.now = T0 + 1_000;
    const result = await h.dispatcher.run();
    // act_1: starter == owner, one row. act_2: owner only. act_3: member.
    // act_4: recipient. act_5: owner. act_6: installer (owner). act_7, act_8, act_9: none.
    expect(result).toMatchObject({ events: 9, enqueued: 6, delivered: 6 });
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
    expect(await bodies(connectionOwner)).toEqual([]);
  });

  test("an event whose recipients cannot be read is parked so the cursor moves on, then retried, and given up after six hours", async () => {
    let failing = true;
    const logs: string[] = [];
    const h = await harness({
      directory: { appOwner: async (capsuleId) => { if (failing && capsuleId === "cap_bad") throw new Error("ledger unavailable"); return OWNER; } },
      log: (event) => logs.push(event),
    });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_a", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_bad", metadata: { capsuleId: "cap_bad" } }, T0);
    await h.record({ id: "act_b", action: "capsule.auto_update_failed", targetType: "capsule", targetId: "cap_good", metadata: {} }, T0 + 1);
    // Hourly cron: the unreadable event is parked, the later one goes out and
    // the cursor passes both.
    h.clock.now = T0 + 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 2, enqueued: 1, delivered: 1, parkedEvents: 1, skippedEvents: 0 });
    expect(await h.accounts.getNotificationDispatchCursor()).toMatchObject({
      id: "act_b",
      parked: [{ eventId: "act_a", createdAt: new Date(T0).toISOString(), attempts: 1 }],
    });
    // Still unreadable an hour later: it stays parked.
    h.clock.now += 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 0, enqueued: 0, parkedEvents: 0 });
    expect((await h.accounts.getNotificationDispatchCursor())?.parked).toEqual([
      { eventId: "act_a", createdAt: new Date(T0).toISOString(), attempts: 2 },
    ]);
    // Readable again: sent and unparked.
    failing = false;
    h.clock.now += 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ enqueued: 1, delivered: 1 });
    expect((await h.accounts.getNotificationDispatchCursor())?.parked).toEqual([]);

    failing = true;
    await h.record({ id: "act_c", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_bad", metadata: { capsuleId: "cap_bad" } }, h.clock.now - 1_000);
    expect(await h.dispatcher.run()).toMatchObject({ parkedEvents: 1 });
    h.clock.now += 6 * 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ enqueued: 0, skippedEvents: 1 });
    expect((await h.accounts.getNotificationDispatchCursor())?.parked).toEqual([]);
    expect(logs).toContain("own_notification_event_skipped");
  });

  test("an event past its TTL is never sent, and the drop is logged and counted", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const h = await harness({ log: (event, fields) => logs.push([event, fields]) });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_old", action: "run.approval_required", runId: "run_1", targetId: "run_1", metadata: { capsuleId: "cap_1" } }, T0);
    h.clock.now = T0 + 86_400_000 + 1;
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 0, delivered: 0, expiredEvents: 1 });
    expect(logs).toContainEqual(["own_notification_event_expired", { eventId: "act_old", action: "run.approval_required" }]);
  });

  test("the immediate path enqueues and sends only the given event, without the cursor", async () => {
    const byEndpoint = new Map<string, number>();
    const h = await harness({ answer: (pusherId) => byEndpoint.get(pusherId) ?? 201 });
    const { agent } = await h.register(OWNER, "en");
    const flaky = await h.register(OWNER, "en");
    byEndpoint.set(flaky.pusherId, 503);
    await h.record({ id: "act_other", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_2", metadata: { capsuleId: "cap_2" } }, T0);
    const event = { id: "act_now", workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_9", runId: "run_9", metadata: { capsuleId: "cap_1", operation: "update" }, createdAt: new Date(T0).toISOString() };
    await h.ledger.putActivityEvent(event);
    expect(await h.dispatcher.deliverEvent(event)).toEqual({ enqueued: 2, delivered: 1, retried: 1, failed: 0, removedPushers: 0, leftOver: 0 });
    expect(await h.accounts.getNotificationDispatchCursor()).toBeUndefined();
    expect(h.requests).toHaveLength(2);
    expect((await decrypt(h.requests.find((request) => !request.url.endsWith(flaky.pusherId))!, agent)).notification.navigate).toBe(`${ORIGIN}/runs/run_9`);
    // Repeating it adds nothing: the rows exist and one is settled, one waits for its retry.
    expect(await h.dispatcher.deliverEvent(event)).toMatchObject({ enqueued: 0, delivered: 0, retried: 0 });
    // The catch-up run later retries the leftover and also covers the other event.
    byEndpoint.set(flaky.pusherId, 201);
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    h.clock.now = T0 + 31_000;
    expect(await h.dispatcher.run()).toMatchObject({ enqueued: 2, delivered: 3 });
    // Revoked Connection: only the unstored context names the owner, and only
    // a revocation by someone else is notified.
    const revoked = { id: "act_rev", workspaceId: "ws", action: "connection.revoked", targetType: "connection", targetId: "conn_1", metadata: { provider: "x" }, createdAt: new Date(h.clock.now).toISOString() };
    expect(await h.dispatcher.deliverEvent(revoked, { ownerAccountId: OWNER, actorAccountId: OWNER })).toMatchObject({ enqueued: 0 });
    expect(await h.dispatcher.deliverEvent(revoked, { ownerAccountId: OWNER, actorAccountId: "tsub_operator" })).toMatchObject({ enqueued: 2, delivered: 2 });
  });

  test("the immediate path leaves unsent rows due for catch-up when no whole send fits", async () => {
    const h = await harness();
    for (let index = 0; index < 3; index += 1) await h.register(OWNER, "en");
    const event = { id: "act_slow", workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_9", runId: "run_9", metadata: { capsuleId: "cap_1" }, createdAt: new Date(T0).toISOString() };
    // A deadline already reached: rows are enqueued, none is leased or sent.
    expect(await h.dispatcher.deliverEvent(event, undefined, { timeoutMs: 0 })).toEqual({ enqueued: 3, delivered: 0, retried: 0, failed: 0, removedPushers: 0, leftOver: 3 });
    expect(h.requests).toHaveLength(0);
    // They are due at once for the catch-up run, not after a lease.
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0).toISOString(), id: "" });
    h.clock.now = T0 + 1_000;
    expect(await h.dispatcher.run()).toMatchObject({ delivered: 3 });
  });

  test("a send never starts unless its whole timeout fits; the rest keep their lease unattempted", async () => {
    const h = await harness({ sendTakesMs: 11_000 });
    for (let index = 0; index < 9; index += 1) await h.register(OWNER, "en");
    const event = { id: "act_many", workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_9", runId: "run_9", metadata: { capsuleId: "cap_1" }, createdAt: new Date(T0).toISOString() };
    // Eight sends start together. Each push takes 11 of the 18 seconds, so
    // once one is answered less than a send's 8-second timeout is left and
    // the ninth row is not started (rather than started and cut short).
    expect(await h.dispatcher.deliverEvent(event, undefined, { timeoutMs: 18_000 })).toEqual({ enqueued: 9, delivered: 8, retried: 0, failed: 0, removedPushers: 0, leftOver: 1 });
    expect(h.requests).toHaveLength(8);
    // The leftover row is not charged an attempt: after its lease it is due
    // again exactly as it was enqueued.
    const now = T0 + 3 * 60_000;
    const leftover = await h.accounts.claimNotificationDeliveries({ now, limit: 10, leaseToken: "check", leaseExpiresAt: now + 1 });
    expect(leftover.map((row) => [row.attempts, row.lastStatus])).toEqual([[0, undefined]]);
  });

  test("the immediate path does nothing at all while no account has a pusher", async () => {
    const h = await harness({ directory: { appOwner: () => Promise.reject(new Error("must not be read")) } });
    const event = { id: "act_none", workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_9", runId: "run_9", metadata: { capsuleId: "cap_1" }, createdAt: new Date(T0).toISOString() };
    expect(await h.dispatcher.deliverEvent(event)).toEqual({ enqueued: 0, delivered: 0, retried: 0, failed: 0, removedPushers: 0, leftOver: 0 });
    expect(await h.accounts.claimNotificationDeliveries({ now: T0, limit: 10, leaseToken: "l", leaseExpiresAt: T0 + 1 })).toEqual([]);
  });

  test("a slow parked retry never holds the cursor back", async () => {
    let slow = false;
    const h = await harness({
      directory: { appOwner: async (capsuleId) => { if (capsuleId === "cap_bad") throw new Error("ledger unavailable"); return OWNER; } },
      // A by-id read that takes longer than the whole run.
      getEvent: async (_id, read, clock) => { if (slow) clock.now += 60_000; return await read(); },
    });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_bad", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_bad", metadata: { capsuleId: "cap_bad" } }, T0);
    h.clock.now = T0 + 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ parkedEvents: 1 });
    slow = true;
    await h.record({ id: "act_new", action: "capsule.auto_update_failed", targetType: "capsule", targetId: "cap_good", metadata: {} }, h.clock.now - 20 * 60_000);
    // The ledger is read before the parked retry: the new event is enqueued and
    // the cursor passes it although the retry then uses up the run.
    expect(await h.dispatcher.run()).toMatchObject({ events: 1, enqueued: 1 });
    expect(await h.accounts.getNotificationDispatchCursor()).toMatchObject({
      id: "act_new",
      parked: [{ eventId: "act_bad", attempts: 2 }],
    });
    // The next run sends what that one had no time left for.
    slow = false;
    expect(await h.dispatcher.run()).toMatchObject({ delivered: 1 });
  });

  test("past fifty parked events the oldest are given up, logged and counted", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const h = await harness({
      directory: { appOwner: () => Promise.reject(new Error("ledger unavailable")) },
      log: (event, fields) => logs.push([event, fields]),
    });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    for (let index = 0; index < 52; index += 1) {
      const id = `act_${String(index).padStart(2, "0")}`;
      await h.record({ id, action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_bad", metadata: { capsuleId: "cap_bad" } }, T0 + index);
    }
    h.clock.now = T0 + 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ events: 52, parkedEvents: 52, skippedEvents: 2 });
    const cursor = await h.accounts.getNotificationDispatchCursor();
    expect(cursor?.id).toBe("act_51");
    expect(cursor?.parked).toHaveLength(50);
    expect(cursor?.parked?.map((entry) => entry.eventId)).not.toContain("act_00");
    expect(cursor?.parked?.map((entry) => entry.eventId)).not.toContain("act_01");
    expect(logs.filter(([event, fields]) => event === "own_notification_event_skipped" && fields.reason === "parking_full")
      .map(([, fields]) => fields.eventId)).toEqual(["act_00", "act_01"]);
  });

  test("a parked event that is gone from the ledger is given up, logged and counted", async () => {
    const gone = new Set<string>();
    const logs: Array<[string, Record<string, unknown>]> = [];
    const h = await harness({
      directory: { appOwner: async (capsuleId) => { if (capsuleId === "cap_bad") throw new Error("ledger unavailable"); return OWNER; } },
      getEvent: async (id, read) => (gone.has(id) ? undefined : await read()),
      log: (event, fields) => logs.push([event, fields]),
    });
    await h.accounts.compareAndSetNotificationDispatchCursor({ expectedGeneration: undefined, createdAt: new Date(T0 - 1).toISOString(), id: "" });
    await h.register(OWNER, "en");
    await h.record({ id: "act_gone", action: "capsule.uninstall_blocked", targetType: "capsule", targetId: "cap_bad", metadata: { capsuleId: "cap_bad" } }, T0);
    h.clock.now = T0 + 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ parkedEvents: 1 });
    gone.add("act_gone");
    h.clock.now += 3_600_000;
    expect(await h.dispatcher.run()).toMatchObject({ skippedEvents: 1, enqueued: 0 });
    expect((await h.accounts.getNotificationDispatchCursor())?.parked).toEqual([]);
    expect(logs).toContainEqual(["own_notification_event_skipped", { eventId: "act_gone", reason: "event_missing" }]);
  });

  test("without a secret-store passphrase nothing is read or sent", async () => {
    const ledger = new InMemoryOpenTofuControlStore();
    const accounts = new InMemoryAccountsStore();
    const operations = {
      activity: {
        listAfter: (input: Parameters<InMemoryOpenTofuControlStore["listActivityEventsAfter"]>[0]) => ledger.listActivityEventsAfter(input),
        get: (id: string) => ledger.getActivityEvent(id),
      },
      appOwnership: { getOwnership: async () => ({ ownerAccountId: OWNER }) },
      controller: { getRun: async () => ({ createdBy: OWNER }) },
      capsules: { getCapsule: async () => ({ name: "app" }) },
    };
    const disabled = createOwnNotificationDispatcher({ operations, store: accounts, env: {}, issuer: ORIGIN });
    expect(await disabled!.run()).toMatchObject({ enabled: false });
    expect(await accounts.getNotificationDispatchCursor()).toBeUndefined();
    expect(createOwnNotificationDispatcher({ operations, store: {}, env: {}, issuer: ORIGIN })).toBeUndefined();
    expect(createOwnNotificationDispatcher({ operations, store: accounts, env: {}, issuer: "not a url" })).toBeUndefined();
    expect(createOwnNotificationDispatcher({
      operations, store: accounts, env: { TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: "not json" }, issuer: ORIGIN,
    })).toBeUndefined();
    const enabled = createOwnNotificationDispatcher({
      operations,
      store: accounts,
      env: { TAKOSUMI_SECRET_STORE_PASSPHRASE: PASSPHRASE, TAKOSUMI_NOTIFICATION_PUSH_RELAY_ORIGINS: JSON.stringify([RELAY]) },
      issuer: `${ORIGIN}/`,
    });
    // No pusher anywhere: idle, and the cursor is placed at the present.
    expect(await enabled!.run()).toMatchObject({ enabled: true, idle: true });
    expect(await accounts.getNotificationDispatchCursor()).toMatchObject({ generation: 0 });
  });

  test("the immediate entry never throws and logs only values-free fields", async () => {
    const logs: Array<[string, Record<string, unknown>]> = [];
    const event = { id: "act_x", workspaceId: "ws", action: "run.approval_required", targetType: "run", targetId: "run_1", runId: "run_1", metadata: {}, createdAt: new Date(T0).toISOString() };
    await deliverOwnNotificationNow({
      dispatcher: { deliverEvent: () => Promise.reject(new TypeError("store down")) } as never,
      event,
      log: (name, fields) => logs.push([name, fields]),
    });
    await deliverOwnNotificationNow({
      dispatcher: { deliverEvent: async () => ({ enqueued: 2, delivered: 1, retried: 1, failed: 0, removedPushers: 0, leftOver: 0 }) } as never,
      event,
      log: (name, fields) => logs.push([name, fields]),
    });
    expect(logs).toEqual([
      ["own_notification_immediate_failed", { eventId: "act_x", errorName: "TypeError" }],
      ["own_notification_immediate", { eventId: "act_x", enqueued: 2, delivered: 1, retried: 1, failed: 0, removedPushers: 0, leftOver: 0 }],
    ]);
  });
});
