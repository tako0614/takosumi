/**
 * Cloudflare composition of the own-notification dispatcher (Web Push to
 * Takosumi Mobile, TASK-0119).
 *
 * - Immediate: the ActivityService hook receives each event it just stored.
 *   For a notified event it enqueues that event's delivery rows directly and
 *   sends only those rows, under the `waitUntil` of the invocation that is
 *   recording it, within a hard 20-second limit. It never waits inside the
 *   invocation (a Durable Object's fetch or alarm returns at once) and keeps
 *   no state between invocations: no registry, no in-flight flag.
 * - Catch-up: every scheduled tick runs one bounded dispatcher pass that
 *   enqueues what the immediate path missed and retries leased leftovers.
 *
 * The per-invocation `waitUntil` is the runtime's own: `waitUntil` from
 * `cloudflare:workers` attaches work to whichever request or Durable Object
 * invocation is executing the caller, exactly like that invocation's
 * `ctx.waitUntil`. The platform entry passes it in once at startup, because
 * modules that Bun tests import cannot import `cloudflare:workers` themselves.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import type { RecordActivityContext } from "../../core/domains/activity/mod.ts";
import {
  createOwnNotificationDispatcher,
  deliverOwnNotificationNow,
  type OwnNotificationOperations,
} from "../../core/domains/notifications/compose.ts";
import type { NotificationDispatchStore } from "../../core/domains/notifications/dispatch_store.ts";
import type { OwnNotificationDispatchRunOptions } from "../../core/domains/notifications/dispatcher.ts";
import { planOwnNotification } from "../../core/domains/notifications/own_notifications.ts";

export interface OwnNotificationDispatchTarget {
  readonly operations: OwnNotificationOperations;
  readonly store: Partial<NotificationDispatchStore>;
  readonly env: Readonly<Record<string, unknown>>;
  /** The instance's public origin (Accounts issuer). */
  readonly issuer: string | undefined;
  /** Test hook; the Worker's global fetch otherwise. */
  readonly fetch?: typeof fetch;
}

/** Attaches a promise to the invocation that is executing the caller. */
export type InvocationWaitUntil = (task: Promise<unknown>) => void;

let invocationWaitUntil: InvocationWaitUntil | undefined;

/**
 * Called once by the platform entry with `waitUntil` from
 * `cloudflare:workers`. The function holds no per-invocation state; each call
 * resolves the invocation that is running at that moment.
 */
export function useInvocationWaitUntil(waitUntil: InvocationWaitUntil): void {
  invocationWaitUntil = waitUntil;
}

/** One bounded catch-up pass with value-free logging; never throws. */
export async function runOwnNotificationDispatch(
  target: OwnNotificationDispatchTarget,
  options: OwnNotificationDispatchRunOptions = {},
): Promise<void> {
  try {
    const dispatcher = createOwnNotificationDispatcher({ ...target, log });
    if (!dispatcher) return;
    const result = await dispatcher.run(options);
    if (
      result.enqueued > 0 || result.delivered > 0 || result.retried > 0 ||
      result.failed > 0 || result.removedPushers > 0 || result.skippedEvents > 0 ||
      result.parkedEvents > 0 || result.expiredEvents > 0
    ) {
      console.log(JSON.stringify({ event: "own_notification_dispatch", ...result }));
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: "own_notification_dispatch_failed",
      errorName: error instanceof Error ? error.name : "unknown",
    }));
  }
}

/**
 * ActivityService hook. A notified event starts its own immediate delivery
 * under the recording invocation's `waitUntil`; when no invocation can take
 * it (outside a request, or before the entry passed `waitUntil`), the
 * catch-up pass sends it instead.
 */
export function ownNotificationActivityObserver(
  target: () => OwnNotificationDispatchTarget | undefined,
  options: {
    /** Test hooks; production uses the entry's `waitUntil` and the real delivery. */
    readonly waitUntil?: InvocationWaitUntil;
    readonly deliver?: (
      target: OwnNotificationDispatchTarget,
      event: ActivityEvent,
      context: RecordActivityContext | undefined,
    ) => Promise<void>;
  } = {},
): (event: ActivityEvent, context?: RecordActivityContext) => void {
  return (event, context) => {
    if (!planOwnNotification(event, context)) return;
    const waitUntil = options.waitUntil ?? invocationWaitUntil;
    if (!waitUntil) return;
    const resolved = target();
    if (!resolved) return;
    const deliver = options.deliver ?? deliverNow;
    // Start the work only once an invocation has taken it.
    let start: () => void = () => {};
    const taken = new Promise<void>((resolve) => {
      start = resolve;
    });
    const task = taken.then(() => deliver(resolved, event, context));
    try {
      waitUntil(task);
    } catch {
      // No live invocation to attach to: the catch-up pass sends it.
      return;
    }
    start();
  };
}

async function deliverNow(
  target: OwnNotificationDispatchTarget,
  event: ActivityEvent,
  context: RecordActivityContext | undefined,
): Promise<void> {
  const dispatcher = createOwnNotificationDispatcher({ ...target, log });
  if (!dispatcher) return;
  await deliverOwnNotificationNow({
    dispatcher,
    event,
    ...(context ? { context } : {}),
    log,
  });
}

function log(event: string, fields: Record<string, unknown>): void {
  console.warn(JSON.stringify({ event, ...fields }));
}
