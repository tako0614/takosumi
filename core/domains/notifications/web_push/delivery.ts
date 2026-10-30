/**
 * What the instance does with one push service answer for one pusher.
 *
 * - 2xx: delivered; the pusher's last success is recorded.
 * - 404 / 410: the subscription is gone; the pusher is deleted.
 * - timeout, network error, 408, 429 (honouring `Retry-After`), 5xx: sent
 *   again on a {@link RetrySchedule} from 30 seconds growing to 1 hour, until
 *   the message's TTL has passed. Then it is given up and recorded as a
 *   failure of the pusher.
 * - 3xx and every other 4xx (403 and 413 included): recorded as a failure of
 *   the pusher, never retried and never deleted, so a fault in the instance's
 *   own signing cannot erase every device at once.
 * - An endpoint whose relay origin is no longer allowed is not sent to and is
 *   recorded as a failure.
 */

import { RetrySchedule } from "../../../shared/lifecycle/schedule.ts";
import { checkPusherEndpoint } from "../pusher_endpoint.ts";
import {
  sendWebPush,
  type WebPushMessage,
  type WebPushOutcome,
  type WebPushSendContext,
  type WebPushTarget,
} from "./send.ts";

const WEB_PUSH_RETRY_MIN_DELAY_MS = 30_000;
const WEB_PUSH_RETRY_MAX_DELAY_MS = 60 * 60 * 1000;
/**
 * The TTL ends retries first: 72 hours at the 1-hour ceiling is well under
 * this many attempts. The cap only keeps a corrupt counter from looping.
 */
const WEB_PUSH_RETRY_MAX_ATTEMPTS = 200;

export function webPushRetrySchedule(random?: () => number): RetrySchedule {
  return new RetrySchedule(
    {
      minDelayMs: WEB_PUSH_RETRY_MIN_DELAY_MS,
      maxDelayMs: WEB_PUSH_RETRY_MAX_DELAY_MS,
      jitter: "equal",
      maxAttempts: WEB_PUSH_RETRY_MAX_ATTEMPTS,
    },
    random ? { random } : {},
  );
}

export type WebPushDeliveryDecision =
  | { readonly kind: "delivered"; readonly status: number }
  | { readonly kind: "pusher_removed"; readonly status: number }
  | {
      readonly kind: "retry";
      /** Attempts made so far, including the one that just failed. */
      readonly attemptsMade: number;
      readonly at: number;
      readonly status: number | null;
      readonly reason: string;
    }
  | {
      readonly kind: "failed";
      readonly status: number | null;
      readonly reason: string;
    }
  | {
      /** A retryable answer arrived, but the message's TTL is over. */
      readonly kind: "expired";
      readonly status: number | null;
      readonly reason: string;
    };

export interface WebPushRetryState {
  /** Attempts already made before the one whose outcome is being decided. */
  readonly attempts: number;
  readonly now: number;
  /** When the message stops being worth delivering: first enqueue + TTL. */
  readonly expiresAt: number;
}

export function decideWebPushDelivery(
  outcome: WebPushOutcome,
  state: WebPushRetryState,
  schedule: RetrySchedule = webPushRetrySchedule(),
): WebPushDeliveryDecision {
  switch (outcome.kind) {
    case "delivered":
      return { kind: "delivered", status: outcome.status };
    case "gone":
      return { kind: "pusher_removed", status: outcome.status };
    case "failed":
      return { kind: "failed", status: outcome.status, reason: outcome.error };
    case "retry": {
      const next = schedule.next({
        attempts: state.attempts,
        now: state.now,
        reason: outcome.error,
      });
      if (next.kind === "exhausted") {
        return { kind: "expired", status: outcome.status, reason: outcome.error };
      }
      const at = Math.max(
        next.at,
        state.now + outcome.retryAfterSeconds * 1000,
      );
      if (at >= state.expiresAt) {
        return { kind: "expired", status: outcome.status, reason: outcome.error };
      }
      return {
        kind: "retry",
        attemptsMade: next.attempt,
        at,
        status: outcome.status,
        reason: outcome.error,
      };
    }
  }
}

/**
 * The pusher exactly as it was sent to. Effects apply only while the stored
 * pusher still has this endpoint and key, so an answer about an old
 * subscription never touches a pusher the device has since re-registered.
 */
export interface WebPushPusherIdentity {
  readonly pusherId: string;
  readonly endpoint: string;
  /** base64url `p256dh`. */
  readonly pushkey: string;
}

/** Where the effect of a decision on the pusher itself is written. */
export interface WebPushPusherHealthPort {
  /** The subscription is gone (404 / 410). */
  removePusher(pusher: WebPushPusherIdentity): Promise<void>;
  recordPusherDelivered(pusher: WebPushPusherIdentity, at: number): Promise<void>;
  /** A permanent failure, or retries that ran out with the TTL. */
  recordPusherFailed(
    pusher: WebPushPusherIdentity,
    at: number,
    status: number | null,
  ): Promise<void>;
}

export interface WebPushPusherTarget extends WebPushTarget, WebPushPusherIdentity {}

/**
 * Send one message to one pusher, apply the result to the pusher, and return
 * the decision so the caller can keep (or drop) its own delivery record.
 *
 * `allowedOrigins` is the relay allowlist as configured now: a pusher whose
 * endpoint is no longer on it is not sent to and is recorded as failing, so an
 * origin the operator removed stops receiving immediately.
 */
export async function deliverWebPushToPusher(input: {
  readonly target: WebPushPusherTarget;
  readonly message: WebPushMessage;
  readonly context: WebPushSendContext;
  readonly pushers: WebPushPusherHealthPort;
  readonly retry: Omit<WebPushRetryState, "now">;
  readonly allowedOrigins: readonly string[];
  readonly schedule?: RetrySchedule;
}): Promise<WebPushDeliveryDecision> {
  const identity: WebPushPusherIdentity = {
    pusherId: input.target.pusherId,
    endpoint: input.target.endpoint,
    pushkey: input.target.pushkey,
  };
  const now = () => (input.context.now ?? Date.now)();
  if (!checkPusherEndpoint(input.target.endpoint, input.allowedOrigins).ok) {
    const decision: WebPushDeliveryDecision = {
      kind: "failed",
      status: null,
      reason: "endpoint_origin_not_allowed",
    };
    await input.pushers.recordPusherFailed(identity, now(), null);
    return decision;
  }
  const outcome = await sendWebPush(input.target, input.message, input.context);
  const at = now();
  const decision = decideWebPushDelivery(
    outcome,
    { ...input.retry, now: at },
    input.schedule,
  );
  switch (decision.kind) {
    case "delivered":
      await input.pushers.recordPusherDelivered(identity, at);
      break;
    case "pusher_removed":
      await input.pushers.removePusher(identity);
      break;
    case "failed":
    case "expired":
      await input.pushers.recordPusherFailed(identity, at, decision.status);
      break;
    case "retry":
      break;
  }
  return decision;
}
