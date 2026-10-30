/**
 * Durable state of the dispatcher that turns Activity events into Web Push to
 * Takosumi Mobile: the Activity cursor and one delivery row per (event,
 * pusher). The Accounts store implements it next to the pushers themselves
 * (memory, Postgres, D1), so the Control ledger gains no table.
 */

import { base64UrlEncode } from "./web_push/bytes.ts";
import type { WebPushPusherIdentity } from "./web_push/delivery.ts";

/**
 * The dispatcher's position in the Activity ledger, ordered by
 * `(createdAt, id)` like `takosumi_scheduled_sweep_cursors`. `generation`
 * makes every advance a compare-and-set.
 */
export interface NotificationDispatchCursor {
  readonly generation: number;
  readonly createdAt: string;
  readonly id: string;
  /**
   * Events behind the cursor whose recipients could not be read yet; they are
   * read again by id on later runs so they do not hold the cursor back.
   */
  readonly parked?: readonly NotificationParkedEvent[];
}

export interface NotificationParkedEvent {
  readonly eventId: string;
  readonly createdAt: string;
  readonly attempts: number;
}

export type NotificationDeliveryOutcome =
  | "delivered"
  | "pusher_removed"
  | "failed"
  | "expired";

export interface NotificationDeliveryRecord {
  /** Derived from (eventId, pusherId): enqueueing the same pair twice is a no-op. */
  readonly deliveryId: string;
  readonly eventId: string;
  readonly pusherId: string;
  readonly subject: string;
  /** Declarative Web Push JSON, at most 2,048 bytes. No secret or token. */
  readonly payload: string;
  readonly urgency: "high" | "normal";
  readonly topic?: string;
  readonly enqueuedAt: number;
  /** The event's time plus its TTL: never sent, and never retried, after this. */
  readonly expiresAt: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly state: "pending" | "settled";
  readonly leaseToken?: string;
  readonly leaseExpiresAt?: number;
  readonly outcome?: NotificationDeliveryOutcome;
  readonly lastStatus?: number;
  readonly settledAt?: number;
}

export type NotificationDeliverySettlement =
  | {
      readonly kind: "retry";
      readonly attempts: number;
      readonly nextAttemptAt: number;
      readonly lastStatus?: number;
    }
  | {
      readonly kind: "settled";
      readonly attempts: number;
      readonly outcome: NotificationDeliveryOutcome;
      readonly lastStatus?: number;
    };

/** Pushers as the dispatcher needs them (a subset of the Accounts record). */
export interface NotificationDispatchPusher {
  readonly pusherId: string;
  readonly subject: string;
  readonly endpoint: string;
  /** base64url `p256dh`. */
  readonly pushkey: string;
  /** base64url `auth`. */
  readonly auth: string;
  readonly lang: string;
}

export interface NotificationDispatchStore {
  getNotificationDispatchCursor(): Promise<NotificationDispatchCursor | undefined>;
  /**
   * Move the cursor if its generation is still `expectedGeneration`
   * (`undefined`: create it only if absent). Returns whether this call won.
   */
  compareAndSetNotificationDispatchCursor(input: {
    readonly expectedGeneration: number | undefined;
    readonly createdAt: string;
    readonly id: string;
    readonly parked?: readonly NotificationParkedEvent[];
  }): Promise<boolean>;
  /**
   * Insert rows whose delivery id is new; existing ids are left unchanged.
   * Returns how many rows were new.
   */
  enqueueNotificationDeliveries(
    records: readonly NotificationDeliveryRecord[],
  ): Promise<number>;
  /**
   * Lease up to `limit` pending rows due at `now` whose lease is free or
   * expired, oldest due first, and return them as leased. `deliveryIds`
   * (at most 50) restricts the claim to those rows (the immediate path).
   */
  claimNotificationDeliveries(input: {
    readonly now: number;
    readonly limit: number;
    readonly leaseToken: string;
    readonly leaseExpiresAt: number;
    readonly deliveryIds?: readonly string[];
  }): Promise<readonly NotificationDeliveryRecord[]>;
  /** Apply the result of one attempt if the row still carries `leaseToken`. */
  settleNotificationDelivery(input: {
    readonly deliveryId: string;
    readonly leaseToken: string;
    readonly at: number;
    readonly settlement: NotificationDeliverySettlement;
  }): Promise<boolean>;
  /** Delete rows (pending or settled) that expired before `expiredBefore`. */
  pruneNotificationDeliveries(input: {
    readonly expiredBefore: number;
    readonly limit: number;
  }): Promise<number>;
  /** Whether any account has a pusher; the dispatcher idles when none does. */
  hasAnyNotificationPusher(): Promise<boolean>;
  listNotificationPushersForSubject(
    subject: string,
  ): Promise<readonly NotificationDispatchPusher[]>;
  findNotificationPusher(
    pusherId: string,
  ): Promise<NotificationDispatchPusher | undefined>;
  /** Only while the pusher still has the endpoint and key that were sent to. */
  removeNotificationPusher(pusher: WebPushPusherIdentity): Promise<void>;
  /** Only while the pusher still has the endpoint and key that were sent to. */
  recordNotificationPusherOutcome(input: WebPushPusherIdentity & {
    readonly at: number;
    readonly outcome: "delivered" | "failed";
    readonly status?: number;
  }): Promise<void>;
}

/** `ndlv_` + 32 base64url characters of SHA-256 over (event, pusher). */
export async function notificationDeliveryId(
  eventId: string,
  pusherId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify(["takosumi.notification-delivery@v1", eventId, pusherId]),
      ),
    ),
  );
  return `ndlv_${base64UrlEncode(digest.subarray(0, 24))}`;
}
