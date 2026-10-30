/**
 * Dispatcher for the instance's own notifications to Takosumi Mobile.
 *
 * Two paths share one durable queue of delivery rows, one per (event,
 * pusher), whose id is derived from that pair so nothing is enqueued twice:
 *
 * - Immediate ({@link OwnNotificationDispatcher.deliverEvent}): the host's
 *   Activity hook hands over the event it just stored. Its rows are enqueued
 *   directly and only those rows are leased and sent, within a hard time
 *   limit. Anything left (a timeout, a retryable answer) stays leased and is
 *   picked up later by the catch-up run. It does not read or move the cursor.
 * - Catch-up ({@link OwnNotificationDispatcher.run}): read the Activity
 *   ledger (`audit_events`, every Workspace) in `(createdAt, id)` order after
 *   the cursor, up to now, and enqueue what the immediate path missed (events
 *   written without ActivityService, such as app ownership rows; hosts or
 *   moments without an invocation to attach to). The cursor trails the
 *   present by a re-read window because `createdAt` is minted before the row
 *   commits; re-reads add no rows. An event whose recipients cannot be read
 *   is parked on the cursor while the cursor moves on; after the ledger read,
 *   a few parked events are retried by id (given up after six hours, when
 *   gone, or past 50 parked). Events past their TTL are dropped, logged and
 *   counted. Then lease the due rows and send them. The first run starts at
 *   the present; while no account has a pusher a run only moves the cursor.
 *
 * A send starts only while its whole timeout fits before the run's deadline;
 * rows not reached stay due or leased, unattempted.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import type { ActivityLedgerPageInput } from "../deploy-control/store.ts";
import {
  type NotificationDeliveryRecord,
  type NotificationDeliverySettlement,
  type NotificationDispatchPusher,
  type NotificationDispatchStore,
  type NotificationParkedEvent,
  notificationDeliveryId,
} from "./dispatch_store.ts";
import {
  type OwnNotificationContext,
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

/** At most this many unreadable events wait on the cursor. */
const MAX_PARKED_EVENTS = 50;
/** Hard ceiling of one immediate delivery, send timeouts included. */
export const IMMEDIATE_DELIVERY_TIMEOUT_MS = 20_000;
const IMMEDIATE_SEND_TIMEOUT_MS = 8_000;
const IMMEDIATE_MAX_ROWS = 50;
/** A catch-up send gets the sender's full default timeout. */
const CATCH_UP_SEND_TIMEOUT_MS = 10_000;
/** Parked events retried per run, after the ledger read. */
const PARKED_RETRIES_PER_RUN = 10;

export interface NotificationEventSource {
  listAfter(input: ActivityLedgerPageInput): Promise<readonly ActivityEvent[]>;
  /** One event by id (parked events are read again by id). */
  get(id: string): Promise<ActivityEvent | undefined>;
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
  /** Unreadable events given up after six hours (or past the parking limit). */
  readonly skippedEvents: number;
  /** Events whose recipients could not be read this run, now parked. */
  readonly parkedEvents: number;
  /** Notified events read only after their TTL had passed. */
  readonly expiredEvents: number;
}

export interface OwnNotificationImmediateResult {
  readonly enqueued: number;
  readonly delivered: number;
  readonly retried: number;
  readonly failed: number;
  readonly removedPushers: number;
  /** Rows left leased for the catch-up run (time limit reached). */
  readonly leftOver: number;
}

type MutableResult = {
  -readonly [K in keyof OwnNotificationDispatchResult]: OwnNotificationDispatchResult[K];
};

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
    const result: MutableResult = {
      enabled: true,
      idle: false,
      events: 0,
      enqueued: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      removedPushers: 0,
      skippedEvents: 0,
      parkedEvents: 0,
      expiredEvents: 0,
    };
    const vapid = await this.#deps.vapid();
    if (!vapid) return { ...result, enabled: false };
    const store = this.#deps.store;
    if (!(await store.hasAnyNotificationPusher())) {
      await this.#moveCursorWhileIdle();
      return { ...result, idle: true };
    }
    await this.#enqueue(result, options.maxEventPages ?? DEFAULT_MAX_EVENT_PAGES, deadline);
    // Lease only when a whole send still fits; otherwise the rows stay due.
    if (deadline - this.#now() >= CATCH_UP_SEND_TIMEOUT_MS) {
      const leaseToken = crypto.randomUUID();
      const now = this.#now();
      const claimed = await store.claimNotificationDeliveries({
        now,
        limit: options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES,
        leaseToken,
        leaseExpiresAt: now + DELIVERY_LEASE_MS,
      });
      await this.#send(claimed, leaseToken, vapid, deadline, result, CATCH_UP_SEND_TIMEOUT_MS);
    }
    await store.pruneNotificationDeliveries({
      expiredBefore: this.#now() - PRUNE_AFTER_EXPIRY_MS,
      limit: PRUNE_LIMIT,
    });
    return result;
  }

  /**
   * The immediate path for one event the host just stored: enqueue its rows
   * and send only those, within {@link IMMEDIATE_DELIVERY_TIMEOUT_MS}. It
   * never reads or moves the cursor. Rows it could not finish stay leased and
   * become due again for the catch-up run.
   */
  async deliverEvent(
    event: ActivityEvent,
    context?: OwnNotificationContext,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<OwnNotificationImmediateResult> {
    const startedAt = this.#now();
    const deadline = startedAt + Math.min(
      options.timeoutMs ?? IMMEDIATE_DELIVERY_TIMEOUT_MS,
      IMMEDIATE_DELIVERY_TIMEOUT_MS,
    );
    const result = { enqueued: 0, delivered: 0, retried: 0, failed: 0, removedPushers: 0, leftOver: 0 };
    const store = this.#deps.store;
    // Nobody can receive anything: one indexed read, nothing else.
    if (!(await store.hasAnyNotificationPusher())) return result;
    const vapid = await this.#deps.vapid();
    if (!vapid) return result;
    const planned = await this.#rowsFor(event, startedAt, new Map(), new Map(), context);
    const rows = planned.rows.slice(0, IMMEDIATE_MAX_ROWS);
    if (rows.length === 0) return result;
    result.enqueued = await store.enqueueNotificationDeliveries(rows);
    if (deadline - this.#now() < IMMEDIATE_SEND_TIMEOUT_MS) {
      // Not even one whole send fits: leave the new rows due for catch-up.
      return { ...result, leftOver: result.enqueued };
    }
    const leaseToken = crypto.randomUUID();
    const now = this.#now();
    const claimed = await store.claimNotificationDeliveries({
      now,
      limit: rows.length,
      leaseToken,
      leaseExpiresAt: now + DELIVERY_LEASE_MS,
      deliveryIds: rows.map((row) => row.deliveryId),
    });
    const sent = { delivered: 0, retried: 0, failed: 0, removedPushers: 0 };
    const settled = await this.#send(claimed, leaseToken, vapid, deadline, sent, IMMEDIATE_SEND_TIMEOUT_MS);
    return { ...result, ...sent, leftOver: claimed.length - settled };
  }

  /**
   * Nobody can receive anything: skip the ledger, keeping the re-read window
   * so an event that commits late is still read once a device registers.
   */
  async #moveCursorWhileIdle(): Promise<void> {
    const store = this.#deps.store;
    const target = new Date(this.#now() - NOTIFICATION_REREAD_WINDOW_MS).toISOString();
    const cursor = await store.getNotificationDispatchCursor();
    if (cursor && cursor.createdAt >= target) return;
    await store.compareAndSetNotificationDispatchCursor({
      expectedGeneration: cursor?.generation,
      createdAt: target,
      id: "",
      parked: cursor?.parked ?? [],
    });
  }

  async #enqueue(result: MutableResult, maxPages: number, deadline: number): Promise<void> {
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
        parked: [],
      });
      return;
    }
    const settledBefore = new Date(now - NOTIFICATION_REREAD_WINDOW_MS).toISOString();
    const pushersBySubject = new Map<string, Promise<readonly NotificationDispatchPusher[]>>();
    const names = new Map<string, Promise<string | undefined>>();
    const parked = new Map((cursor.parked ?? []).map((entry) => [entry.eventId, entry]));
    let parkedChanged = false;
    const rows: NotificationDeliveryRecord[] = [];
    const tryEvent = async (event: ActivityEvent): Promise<boolean> => {
      try {
        const planned = await this.#rowsFor(event, now, pushersBySubject, names);
        if (planned.expired) {
          result.expiredEvents += 1;
          this.#log("own_notification_event_expired", { eventId: event.id, action: event.action });
        }
        rows.push(...planned.rows);
        return true;
      } catch (error) {
        this.#log("own_notification_event_unreadable", {
          eventId: event.id,
          action: event.action,
          errorName: error instanceof Error ? error.name : "unknown",
        });
        return false;
      }
    };
    const giveUp = (entry: NotificationParkedEvent, reason: string) => {
      parked.delete(entry.eventId);
      parkedChanged = true;
      result.skippedEvents += 1;
      this.#log("own_notification_event_skipped", { eventId: entry.eventId, reason });
    };

    // The ledger first, so a slow parked event never holds the cursor back.
    let readAfter = { createdAt: cursor.createdAt, id: cursor.id };
    let advanceTo: { readonly createdAt: string; readonly id: string } | undefined;
    const parkedNow = new Set<string>();
    for (let page = 0; page < maxPages && this.#now() < deadline; page += 1) {
      const events = await this.#deps.events.listAfter({
        after: readAfter,
        untilCreatedAt: present,
        limit: EVENT_PAGE_LIMIT,
      });
      if (events.length === 0) break;
      for (const event of events) {
        result.events += 1;
        // A parked event is retried below, by id, not here.
        if (!parked.has(event.id) && !(await tryEvent(event))) {
          if (Date.parse(event.createdAt) <= now - STUCK_EVENT_SKIP_AFTER_MS) {
            result.skippedEvents += 1;
            this.#log("own_notification_event_skipped", { eventId: event.id, reason: "recipients_unreadable" });
          } else {
            // Park it and move on: it must not hold back later notifications.
            parked.set(event.id, { eventId: event.id, createdAt: event.createdAt, attempts: 1 });
            parkedNow.add(event.id);
            parkedChanged = true;
            result.parkedEvents += 1;
          }
        }
        if (event.createdAt <= settledBefore) {
          advanceTo = { createdAt: event.createdAt, id: event.id };
        }
      }
      const last = events.at(-1)!;
      readAfter = { createdAt: last.createdAt, id: last.id };
      if (events.length < EVENT_PAGE_LIMIT) break;
    }

    // Then parked events, from an earlier run, on a small budget of their
    // own. Old ones are given up without a read; the rest are retried
    // fewest-attempts first, so none is starved.
    const retry: NotificationParkedEvent[] = [];
    for (const entry of parked.values()) {
      if (parkedNow.has(entry.eventId)) continue;
      if (Date.parse(entry.createdAt) <= now - STUCK_EVENT_SKIP_AFTER_MS) {
        giveUp(entry, "recipients_unreadable");
      } else {
        retry.push(entry);
      }
    }
    retry.sort((a, b) => a.attempts - b.attempts || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    // Keep a whole send's time for the delivery step that follows.
    const parkedDeadline = deadline - CATCH_UP_SEND_TIMEOUT_MS;
    for (const entry of retry.slice(0, PARKED_RETRIES_PER_RUN)) {
      if (this.#now() >= parkedDeadline) break;
      const event = await this.#deps.events.get(entry.eventId);
      if (!event) {
        giveUp(entry, "event_missing");
      } else if (await tryEvent(event)) {
        parked.delete(entry.eventId);
        parkedChanged = true;
      } else {
        parked.set(entry.eventId, { ...entry, attempts: entry.attempts + 1 });
        parkedChanged = true;
      }
    }
    // Bound the parking list; the oldest give way.
    const keep = [...parked.values()].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    while (keep.length > MAX_PARKED_EVENTS) giveUp(keep.shift()!, "parking_full");
    if (rows.length > 0) {
      result.enqueued += await store.enqueueNotificationDeliveries(rows);
    }
    if (advanceTo || parkedChanged) {
      // A lost compare-and-set means another run moved the cursor; both
      // enqueue the same rows idempotently and parked events stay readable.
      await store.compareAndSetNotificationDispatchCursor({
        expectedGeneration: cursor.generation,
        createdAt: advanceTo?.createdAt ?? cursor.createdAt,
        id: advanceTo?.id ?? cursor.id,
        parked: [...parked.values()],
      });
    }
  }

  async #rowsFor(
    event: ActivityEvent,
    now: number,
    pushersBySubject: Map<string, Promise<readonly NotificationDispatchPusher[]>>,
    names: Map<string, Promise<string | undefined>>,
    context?: OwnNotificationContext,
  ): Promise<{ readonly rows: NotificationDeliveryRecord[]; readonly expired: boolean }> {
    const plan = planOwnNotification(event, context);
    if (!plan) return { rows: [], expired: false };
    const expiresAt = plan.occurredAt + plan.ttlSeconds * 1000;
    if (expiresAt <= now) return { rows: [], expired: true };
    const subjects = await this.#recipients(plan.recipients);
    if (subjects.length === 0) return { rows: [], expired: false };
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
    return { rows, expired: false };
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

  /**
   * Send already leased rows, settling each. A send starts only while its
   * whole timeout still fits before `deadline`, so the deadline never cuts a
   * send short and counts it as a failed attempt. Returns how many were
   * settled; the rest keep their lease, unattempted, and become due again.
   */
  async #send(
    claimed: readonly NotificationDeliveryRecord[],
    leaseToken: string,
    vapid: VapidKeyPair,
    deadline: number,
    result: { delivered: number; retried: number; failed: number; removedPushers: number },
    sendTimeoutMs: number,
  ): Promise<number> {
    const store = this.#deps.store;
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
    let settled = 0;
    const worker = async () => {
      while (next < claimed.length) {
        if (deadline - this.#now() < sendTimeoutMs) return;
        const row = claimed[next]!;
        next += 1;
        const settlement = await this.#attempt(row, vapid, health, schedule, sendTimeoutMs);
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
        settled += 1;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SEND_CONCURRENCY, claimed.length) }, worker),
    );
    return settled;
  }

  async #attempt(
    row: NotificationDeliveryRecord,
    vapid: VapidKeyPair,
    health: WebPushPusherHealthPort,
    schedule: ReturnType<typeof webPushRetrySchedule>,
    timeoutMs: number,
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
        timeoutMs,
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
