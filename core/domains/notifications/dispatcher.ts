/**
 * Dispatcher for the instance's own notifications to Takosumi Mobile.
 *
 * Each run does two bounded steps:
 *
 * 1. Enqueue. Read the Activity ledger (`audit_events`, every Workspace) in
 *    `(createdAt, id)` order after the cursor, up to now. Some writers record
 *    Activity straight into the ledger without ActivityService (app
 *    ownership), so the ledger, not the service, is the source. For each
 *    notified event, resolve the recipients from the app owner and the
 *    accounts the event names, and add one row per (event, pusher). The row
 *    id is derived from that pair, so reading an event again adds nothing.
 *    That lets the cursor trail the present by a re-read window: `createdAt`
 *    is minted before the row commits and isolates can commit slightly out of
 *    order, so the last ten minutes are read again on every run instead of
 *    being deferred. An event whose recipients cannot be read keeps the cursor
 *    behind it (later events are still enqueued) until it succeeds or is six
 *    hours old. The first run starts at the present: history is never sent.
 * 2. Deliver. Lease the rows that are due and send each once with the
 *    answer rules of `web_push/delivery.ts`; retries come back on a later run.
 *
 * While no account has a pusher, a run only moves the cursor to the present,
 * so an idle instance reads nothing. On Cloudflare a pass runs on every
 * scheduled tick and, right after a notified event is recorded, once more in
 * the same request or Durable Object invocation (`waitUntil`). node-postgres
 * runs it from an in-process interval.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import type { ActivityLedgerPageInput } from "../deploy-control/store.ts";
import {
  type NotificationDeliveryRecord,
  type NotificationDeliverySettlement,
  type NotificationDispatchPusher,
  type NotificationDispatchStore,
  notificationDeliveryId,
} from "./dispatch_store.ts";
import {
  type OwnNotificationPlan,
  type OwnNotificationRecipient,
  ownNotificationLanguage,
  planOwnNotification,
  renderOwnNotification,
} from "./own_notifications.ts";
import { base64UrlDecode } from "./web_push/bytes.ts";
import {
  deliverWebPushToPusher,
  webPushRetrySchedule,
  type WebPushPusherHealthPort,
} from "./web_push/delivery.ts";
import { buildDeclarativeWebPushMessage } from "./web_push/payload.ts";
import { computeWebPushTopic } from "./web_push/topic.ts";
import type { VapidKeyPair } from "./web_push/vapid.ts";

/** Events this recent are read again on every run; the cursor trails by this much. */
export const NOTIFICATION_REREAD_WINDOW_MS = 10 * 60_000;
/** An event whose recipients cannot be read is given up once it is this old. */
const STUCK_EVENT_SKIP_AFTER_MS = 6 * 60 * 60_000;
const EVENT_PAGE_LIMIT = 90;
const DEFAULT_MAX_EVENT_PAGES = 5;
const DEFAULT_MAX_DELIVERIES = 50;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const DELIVERY_LEASE_MS = 2 * 60_000;
const SEND_CONCURRENCY = 8;
/** Settled rows stay this long past their expiry so a re-read cannot resend. */
const PRUNE_AFTER_EXPIRY_MS = 24 * 60 * 60_000;
const PRUNE_LIMIT = 200;

export interface NotificationEventSource {
  listAfter(input: ActivityLedgerPageInput): Promise<readonly ActivityEvent[]>;
}

/**
 * Who an event concerns. Each method returns undefined for something that no
 * longer exists and throws only for an unexpected failure (the event is then
 * retried on the next run).
 */
export interface NotificationRecipientDirectory {
  appOwner(capsuleId: string): Promise<string | undefined>;
  runStartedBy(runId: string): Promise<string | undefined>;
  appName(capsuleId: string): Promise<string | undefined>;
}

export interface OwnNotificationDispatcherDependencies {
  readonly events: NotificationEventSource;
  readonly directory: NotificationRecipientDirectory;
  readonly store: NotificationDispatchStore;
  /** Null when the instance has no secret-store passphrase: nothing is sent. */
  readonly vapid: () => Promise<VapidKeyPair | null>;
  readonly topicKey: () => Promise<CryptoKey | null>;
  /** The instance's public https origin: dashboard links and the VAPID `sub`. */
  readonly instanceOrigin: string;
  /** The relay allowlist as configured now, checked again before each send. */
  readonly relayOrigins: readonly string[];
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface OwnNotificationDispatchRunOptions {
  readonly maxEventPages?: number;
  readonly maxDeliveries?: number;
  readonly timeBudgetMs?: number;
}

export interface OwnNotificationDispatchResult {
  readonly enabled: boolean;
  /** No account has a pusher: the run only moved the cursor. */
  readonly idle: boolean;
  /** Ledger rows read this run, re-reads included. */
  readonly events: number;
  /** New delivery rows (re-read events add none). */
  readonly enqueued: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  readonly removedPushers: number;
  readonly skippedEvents: number;
}

export class OwnNotificationDispatcher {
  readonly #deps: OwnNotificationDispatcherDependencies;
  readonly #now: () => number;

  constructor(deps: OwnNotificationDispatcherDependencies) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  async run(
    options: OwnNotificationDispatchRunOptions = {},
  ): Promise<OwnNotificationDispatchResult> {
    const startedAt = this.#now();
    const deadline = startedAt + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
    const result = {
      enabled: true,
      idle: false,
      events: 0,
      enqueued: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      removedPushers: 0,
      skippedEvents: 0,
    };
    const vapid = await this.#deps.vapid();
    if (!vapid) return { ...result, enabled: false };
    const store = this.#deps.store;
    if (!(await store.hasAnyNotificationPusher())) {
      await this.#moveCursorToPresent();
      return { ...result, idle: true };
    }
    await this.#enqueue(result, options.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES, deadline);
    if (this.#now() < deadline) {
      await this.#deliver(result, vapid, options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES, deadline);
    }
    await store.pruneNotificationDeliveries({
      expiredBefore: this.#now() - PRUNE_AFTER_EXPIRY_MS,
      limit: PRUNE_LIMIT,
    });
    return result;
  }

  /** Nobody can receive anything: skip the ledger up to now. */
  async #moveCursorToPresent(): Promise<void> {
    const store = this.#deps.store;
    const present = new Date(this.#now()).toISOString();
    const cursor = await store.getNotificationDispatchCursor();
    if (cursor && cursor.createdAt >= present) return;
    await store.compareAndSetNotificationDispatchCursor({
      expectedGeneration: cursor?.generation,
      createdAt: present,
      id: "",
    });
  }

  async #enqueue(
    result: { events: number; enqueued: number; skippedEvents: number },
    maxPages: number,
    deadline: number,
  ): Promise<void> {
    const store = this.#deps.store;
    const cursor = await store.getNotificationDispatchCursor();
    const now = this.#now();
    const present = new Date(now).toISOString();
    if (!cursor) {
      // Start at the present; the ledger's history is never notified.
      await store.compareAndSetNotificationDispatchCursor({
        expectedGeneration: undefined,
        createdAt: present,
        id: "",
      });
      return;
    }
    const settledBefore = new Date(now - NOTIFICATION_REREAD_WINDOW_MS).toISOString();
    const pushersBySubject = new Map<string, Promise<readonly NotificationDispatchPusher[]>>();
    const names = new Map<string, Promise<string | undefined>>();
    let readAfter = { createdAt: cursor.createdAt, id: cursor.id };
    let advanceTo: { readonly createdAt: string; readonly id: string } | undefined;
    let blocked = false;
    for (let page = 0; page < maxPages && this.#now() < deadline; page += 1) {
      const events = await this.#deps.events.listAfter({
        after: readAfter,
        untilCreatedAt: present,
        limit: EVENT_PAGE_LIMIT,
      });
      if (events.length === 0) break;
      const rows: NotificationDeliveryRecord[] = [];
      for (const event of events) {
        result.events += 1;
        try {
          rows.push(...(await this.#rowsFor(event, now, pushersBySubject, names)));
        } catch (error) {
          const fields = {
            eventId: event.id,
            action: event.action,
            errorName: error instanceof Error ? error.name : "unknown",
          };
          if (Date.parse(event.createdAt) > now - STUCK_EVENT_SKIP_AFTER_MS) {
            // Keep the cursor behind this event; later events still go out.
            blocked = true;
            this.#log("own_notification_event_deferred", fields);
          } else {
            result.skippedEvents += 1;
            this.#log("own_notification_event_skipped", fields);
          }
        }
        if (!blocked && event.createdAt <= settledBefore) {
          advanceTo = { createdAt: event.createdAt, id: event.id };
        }
      }
      if (rows.length > 0) {
        result.enqueued += await store.enqueueNotificationDeliveries(rows);
      }
      const last = events.at(-1)!;
      readAfter = { createdAt: last.createdAt, id: last.id };
      if (events.length < EVENT_PAGE_LIMIT) break;
    }
    if (advanceTo) {
      // A lost compare-and-set means another run moved the cursor; both
      // enqueue the same rows idempotently.
      await store.compareAndSetNotificationDispatchCursor({
        expectedGeneration: cursor.generation,
        createdAt: advanceTo.createdAt,
        id: advanceTo.id,
      });
    }
  }

  async #rowsFor(
    event: ActivityEvent,
    now: number,
    pushersBySubject: Map<string, Promise<readonly NotificationDispatchPusher[]>>,
    names: Map<string, Promise<string | undefined>>,
  ): Promise<NotificationDeliveryRecord[]> {
    const plan = planOwnNotification(event);
    if (!plan) return [];
    const expiresAt = plan.occurredAt + plan.ttlSeconds * 1000;
    if (expiresAt <= now) return [];
    const subjects = await this.#recipients(plan.recipients);
    if (subjects.length === 0) return [];
    const appName = (capsuleId: string | undefined) => {
      if (!capsuleId) return Promise.resolve(undefined);
      let name = names.get(capsuleId);
      if (!name) {
        name = this.#deps.directory.appName(capsuleId);
        names.set(capsuleId, name);
      }
      return name;
    };
    const [app, consumerApp] = await Promise.all([
      appName(plan.capsuleId),
      appName(plan.consumerCapsuleId),
    ]);
    const topicKey = await this.#deps.topicKey();
    const rows: NotificationDeliveryRecord[] = [];
    for (const subject of subjects) {
      let pushers = pushersBySubject.get(subject);
      if (!pushers) {
        pushers = this.#deps.store.listNotificationPushersForSubject(subject);
        pushersBySubject.set(subject, pushers);
      }
      for (const pusher of await pushers) {
        rows.push(await this.#row({
          plan,
          pusher,
          names: {
            ...(app !== undefined ? { app } : {}),
            ...(consumerApp !== undefined ? { consumerApp } : {}),
          },
          topicKey,
          now,
          expiresAt,
        }));
      }
    }
    return rows;
  }

  async #recipients(
    recipients: readonly OwnNotificationRecipient[],
  ): Promise<readonly string[]> {
    const directory = this.#deps.directory;
    const resolved = await Promise.all(recipients.map((recipient) => {
      switch (recipient.kind) {
        case "app_owner":
          return directory.appOwner(recipient.capsuleId);
        case "run_starter":
          return directory.runStartedBy(recipient.runId);
        case "account":
          return Promise.resolve(recipient.accountId);
      }
    }));
    // Only Takosumi account subjects; `system:*` actors receive nothing.
    return [...new Set(resolved.filter((subject): subject is string =>
      typeof subject === "string" && /^tsub_[A-Za-z0-9_-]+$/.test(subject)
    ))];
  }

  async #row(input: {
    readonly plan: OwnNotificationPlan;
    readonly pusher: NotificationDispatchPusher;
    readonly names: { readonly app?: string; readonly consumerApp?: string };
    readonly topicKey: CryptoKey | null;
    readonly now: number;
    readonly expiresAt: number;
  }): Promise<NotificationDeliveryRecord> {
    const { plan, pusher } = input;
    const language = ownNotificationLanguage(pusher.lang);
    const text = renderOwnNotification(plan, input.names, language);
    const { json } = buildDeclarativeWebPushMessage({
      origin: this.#deps.instanceOrigin,
      title: text.title,
      body: text.body,
      navigate: plan.navigatePath,
      lang: language === "ja" ? pusher.lang : "en",
      tag: plan.group,
    });
    const topic = input.topicKey
      ? await computeWebPushTopic(input.topicKey, pusher.pusherId, plan.group)
      : undefined;
    return {
      deliveryId: await notificationDeliveryId(plan.eventId, pusher.pusherId),
      eventId: plan.eventId,
      pusherId: pusher.pusherId,
      subject: pusher.subject,
      payload: json,
      urgency: plan.urgency,
      ...(topic ? { topic } : {}),
      enqueuedAt: input.now,
      expiresAt: input.expiresAt,
      attempts: 0,
      nextAttemptAt: input.now,
      state: "pending",
    };
  }

  async #deliver(
    result: { delivered: number; retried: number; failed: number; removedPushers: number },
    vapid: VapidKeyPair,
    maxDeliveries: number,
    deadline: number,
  ): Promise<void> {
    const store = this.#deps.store;
    const now = this.#now();
    const leaseToken = crypto.randomUUID();
    const claimed = await store.claimNotificationDeliveries({
      now,
      limit: maxDeliveries,
      leaseToken,
      leaseExpiresAt: now + DELIVERY_LEASE_MS,
    });
    const health: WebPushPusherHealthPort = {
      removePusher: (pusher) => store.removeNotificationPusher(pusher),
      recordPusherDelivered: (pusher, at) =>
        store.recordNotificationPusherOutcome({ ...pusher, at, outcome: "delivered" }),
      recordPusherFailed: (pusher, at, status) =>
        store.recordNotificationPusherOutcome({
          ...pusher,
          at,
          outcome: "failed",
          ...(status !== null ? { status } : {}),
        }),
    };
    const schedule = webPushRetrySchedule(this.#deps.random);
    let next = 0;
    const worker = async () => {
      while (next < claimed.length && this.#now() < deadline) {
        const row = claimed[next]!;
        next += 1;
        const settlement = await this.#attempt(row, vapid, health, schedule);
        if (settlement.kind === "retry") result.retried += 1;
        else if (settlement.outcome === "delivered") result.delivered += 1;
        else if (settlement.outcome === "pusher_removed") result.removedPushers += 1;
        else result.failed += 1;
        await store.settleNotificationDelivery({
          deliveryId: row.deliveryId,
          leaseToken,
          at: this.#now(),
          settlement,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, worker),
    );
  }

  async #attempt(
    row: NotificationDeliveryRecord,
    vapid: VapidKeyPair,
    health: WebPushPusherHealthPort,
    schedule: ReturnType<typeof webPushRetrySchedule>,
  ): Promise<NotificationDeliverySettlement> {
    const now = this.#now();
    if (row.expiresAt <= now) {
      return { kind: "settled", attempts: row.attempts, outcome: "expired" };
    }
    const pusher = await this.#deps.store.findNotificationPusher(row.pusherId);
    const p256dh = pusher ? base64UrlDecode(pusher.pushkey) : null;
    const auth = pusher ? base64UrlDecode(pusher.auth) : null;
    if (!pusher || !p256dh || !auth) {
      return { kind: "settled", attempts: row.attempts, outcome: "pusher_removed" };
    }
    const decision = await deliverWebPushToPusher({
      target: { pusherId: pusher.pusherId, endpoint: pusher.endpoint, pushkey: pusher.pushkey, p256dh, auth },
      message: {
        payload: row.payload,
        // Never ask the relay to keep a message past the event's TTL.
        ttlSeconds: Math.max(0, Math.floor((row.expiresAt - now) / 1000)),
        urgency: row.urgency,
        ...(row.topic ? { topic: row.topic } : {}),
      },
      context: {
        vapid,
        subject: this.#deps.instanceOrigin,
        ...(this.#deps.fetch ? { fetch: this.#deps.fetch } : {}),
        now: this.#now,
      },
      pushers: health,
      retry: { attempts: row.attempts, expiresAt: row.expiresAt },
      allowedOrigins: this.#deps.relayOrigins,
      schedule,
    });
    const lastStatus = "status" in decision && decision.status !== null
      ? { lastStatus: decision.status }
      : {};
    switch (decision.kind) {
      case "retry":
        return { kind: "retry", attempts: decision.attemptsMade, nextAttemptAt: decision.at, ...lastStatus };
      case "delivered":
        return { kind: "settled", attempts: row.attempts + 1, outcome: "delivered", ...lastStatus };
      case "pusher_removed":
        return { kind: "settled", attempts: row.attempts + 1, outcome: "pusher_removed", ...lastStatus };
      case "failed":
        return { kind: "settled", attempts: row.attempts + 1, outcome: "failed", ...lastStatus };
      case "expired":
        return { kind: "settled", attempts: row.attempts + 1, outcome: "expired", ...lastStatus };
    }
  }

  #log(event: string, fields: Record<string, unknown>): void {
    this.#deps.log?.(event, fields);
  }
}
