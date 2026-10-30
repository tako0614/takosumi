/**
 * Dispatcher for the instance's own notifications to Takosumi Mobile.
 *
 * Each run does two bounded steps:
 *
 * 1. Enqueue. Read the Activity ledger (`audit_events`, every Workspace) in
 *    `(createdAt, id)` order after the cursor. Some writers record Activity
 *    straight into the ledger without ActivityService (app ownership), so the
 *    ledger, not the service, is the source. Events younger than a settle
 *    window are left for the next run, because `createdAt` is minted before
 *    the row commits and isolates can commit slightly out of order. For each
 *    notified event, resolve the recipients from the app owner and the
 *    accounts the event names, and add one row per (event, pusher). The row
 *    id is derived from that pair, so a replayed page adds nothing twice.
 *    The first run starts at the present: history is never sent.
 * 2. Deliver. Lease the rows that are due and send each once with the
 *    answer rules of `web_push/delivery.ts`; retries come back on a later run.
 *
 * On Cloudflare the scheduled handler runs this under `waitUntil`, so a new
 * event is sent in the same run that enqueues it and the remaining retries on
 * later cron runs. node-postgres runs it from an in-process interval.
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

/** How long an event must be old before the cursor passes it. */
export const NOTIFICATION_SETTLE_WINDOW_MS = 60_000;
/** An event that keeps failing to resolve is skipped once it is this old. */
const STUCK_EVENT_SKIP_AFTER_MS = 15 * 60_000;
const EVENT_PAGE_LIMIT = 90;
const DEFAULT_MAX_EVENT_PAGES = 5;
const DEFAULT_MAX_DELIVERIES = 50;
const DEFAULT_TIME_BUDGET_MS = 20_000;
const DELIVERY_LEASE_MS = 2 * 60_000;
const SEND_CONCURRENCY = 8;
/** Settled rows stay this long past their expiry so a replay cannot resend. */
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
  connectionOwner(connectionId: string): Promise<string | undefined>;
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
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface OwnNotificationDispatchResult {
  readonly enabled: boolean;
  readonly events: number;
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

  async run(options: {
    readonly maxEventPages?: number;
    readonly maxDeliveries?: number;
    readonly timeBudgetMs?: number;
  } = {}): Promise<OwnNotificationDispatchResult> {
    const startedAt = this.#now();
    const deadline = startedAt + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);
    const result = {
      enabled: true,
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
    await this.#enqueue(result, options.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES, deadline);
    if (this.#now() < deadline) {
      await this.#deliver(result, vapid, options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES, deadline);
    }
    await this.#deps.store.pruneNotificationDeliveries({
      expiredBefore: this.#now() - PRUNE_AFTER_EXPIRY_MS,
      limit: PRUNE_LIMIT,
    });
    return result;
  }

  async #enqueue(
    result: { events: number; enqueued: number; skippedEvents: number },
    maxPages: number,
    deadline: number,
  ): Promise<void> {
    const store = this.#deps.store;
    let cursor = await store.getNotificationDispatchCursor();
    const now = this.#now();
    const untilCreatedAt = new Date(now - NOTIFICATION_SETTLE_WINDOW_MS).toISOString();
    if (!cursor) {
      // Start at the present; the ledger's history is never notified.
      await store.compareAndSetNotificationDispatchCursor({
        expectedGeneration: undefined,
        createdAt: untilCreatedAt,
        id: "",
      });
      return;
    }
    const pushersBySubject = new Map<string, Promise<readonly NotificationDispatchPusher[]>>();
    const names = new Map<string, Promise<string | undefined>>();
    for (let page = 0; page < maxPages && this.#now() < deadline; page += 1) {
      const events = await this.#deps.events.listAfter({
        after: { createdAt: cursor.createdAt, id: cursor.id },
        untilCreatedAt,
        limit: EVENT_PAGE_LIMIT,
      });
      if (events.length === 0) return;
      const rows: NotificationDeliveryRecord[] = [];
      let last: ActivityEvent | undefined;
      for (const event of events) {
        try {
          rows.push(...(await this.#rowsFor(event, now, pushersBySubject, names)));
        } catch (error) {
          if (Date.parse(event.createdAt) > now - STUCK_EVENT_SKIP_AFTER_MS) {
            this.#log("own_notification_event_deferred", {
              eventId: event.id,
              action: event.action,
              errorName: error instanceof Error ? error.name : "unknown",
            });
            break;
          }
          result.skippedEvents += 1;
          this.#log("own_notification_event_skipped", {
            eventId: event.id,
            action: event.action,
            errorName: error instanceof Error ? error.name : "unknown",
          });
        }
        last = event;
        result.events += 1;
      }
      if (rows.length > 0) {
        await store.enqueueNotificationDeliveries(rows);
        result.enqueued += rows.length;
      }
      if (!last) return;
      const advanced = await store.compareAndSetNotificationDispatchCursor({
        expectedGeneration: cursor.generation,
        createdAt: last.createdAt,
        id: last.id,
      });
      // Another run moved the cursor; its enqueue covers the same rows.
      if (!advanced) return;
      cursor = { generation: cursor.generation + 1, createdAt: last.createdAt, id: last.id };
      if (last !== events.at(-1) || events.length < EVENT_PAGE_LIMIT) return;
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
        case "connection_owner":
          return directory.connectionOwner(recipient.connectionId);
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
      removePusher: (pusherId) => store.removeNotificationPusher(pusherId),
      recordPusherDelivered: (pusherId, at) =>
        store.recordNotificationPusherOutcome({ pusherId, at, outcome: "delivered" }),
      recordPusherFailed: (pusherId, at, status) =>
        store.recordNotificationPusherOutcome({
          pusherId,
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
      target: { pusherId: pusher.pusherId, endpoint: pusher.endpoint, p256dh, auth },
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
