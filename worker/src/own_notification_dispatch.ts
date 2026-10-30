/**
 * Cloudflare composition of the own-notification dispatcher (Web Push to
 * Takosumi Mobile, TASK-0119).
 *
 * Every scheduled tick runs one bounded pass. In addition, when a notified
 * Activity event is recorded while a request or a Durable Object invocation
 * runs, one more bounded pass starts right away under a live invocation's
 * `waitUntil`, so the event is sent without waiting for the next cron (the
 * OSS template's cron is hourly). The pass is the same lease-protected run:
 * delivery rows are keyed by (event, pusher), sends are leased, and the
 * cursor moves by compare-and-set, so overlapping passes never send twice.
 */

import type { ActivityEvent } from "takosumi-contract/activity";
import {
  createOwnNotificationDispatcher,
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

interface InvocationScope {
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/**
 * The invocations of this isolate that are still running and accept
 * `waitUntil`. The Worker bundle has no `node:async_hooks`, so instead of an
 * async-local scope an immediate pass borrows the newest live invocation; any
 * live invocation keeps the isolate working until the pass settles, and the
 * one that recorded the event is live while it records.
 */
const liveInvocations: InvocationScope[] = [];

/** Run `fn` with `waitUntil` available to immediate notification passes. */
export async function runWithOwnNotificationScope<T>(
  waitUntil: ((task: Promise<unknown>) => void) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!waitUntil) return await fn();
  const scope: InvocationScope = { waitUntil };
  liveInvocations.push(scope);
  try {
    return await fn();
  } finally {
    const index = liveInvocations.lastIndexOf(scope);
    if (index >= 0) liveInvocations.splice(index, 1);
  }
}

/**
 * For a Durable Object invocation: run `fn`, then wait for the immediate
 * passes it started, so the object does not go idle before they finish.
 */
export async function withOwnNotificationsSettled<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const pending: Promise<unknown>[] = [];
  try {
    return await runWithOwnNotificationScope((task) => {
      pending.push(task);
    }, fn);
  } finally {
    await Promise.allSettled(pending);
  }
}

/** One bounded dispatcher pass with value-free logging; never throws. */
export async function runOwnNotificationDispatch(
  target: OwnNotificationDispatchTarget,
  options: OwnNotificationDispatchRunOptions = {},
  label = "own_notification_dispatch",
): Promise<void> {
  try {
    const dispatcher = createOwnNotificationDispatcher({
      ...target,
      log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
    });
    if (!dispatcher) return;
    const result = await dispatcher.run(options);
    if (
      result.enqueued > 0 || result.delivered > 0 || result.retried > 0 ||
      result.failed > 0 || result.removedPushers > 0 || result.skippedEvents > 0
    ) {
      console.log(JSON.stringify({ event: label, ...result }));
    }
  } catch (error) {
    console.warn(JSON.stringify({
      event: `${label}_failed`,
      errorName: error instanceof Error ? error.name : "unknown",
    }));
  }
}

const IMMEDIATE_PASS: OwnNotificationDispatchRunOptions = {
  maxEventPages: 1,
  maxDeliveries: 20,
  timeBudgetMs: 10_000,
};
/** Events recorded while a pass runs trigger at most this many more passes. */
const MAX_IMMEDIATE_PASSES = 3;

let inFlight: Promise<void> | undefined;
let requestedAgain = false;

function immediatePass(target: OwnNotificationDispatchTarget): Promise<void> {
  if (inFlight) {
    requestedAgain = true;
    return inFlight;
  }
  const run = (async () => {
    for (let pass = 0; pass < MAX_IMMEDIATE_PASSES; pass += 1) {
      requestedAgain = false;
      await runOwnNotificationDispatch(target, IMMEDIATE_PASS, "own_notification_immediate");
      if (!requestedAgain) break;
    }
  })().finally(() => {
    if (inFlight === run) inFlight = undefined;
  });
  inFlight = run;
  return run;
}

/**
 * ActivityService observer. A notified event recorded while an invocation
 * that provided `waitUntil` is live starts one bounded pass; events recorded
 * outside any invocation wait for the scheduled pass.
 */
export function ownNotificationActivityObserver(
  target: () => OwnNotificationDispatchTarget | undefined,
): (event: ActivityEvent) => void {
  return (event) => {
    if (!planOwnNotification(event)) return;
    const scope = liveInvocations.at(-1);
    if (!scope) return;
    const resolved = target();
    if (!resolved) return;
    scope.waitUntil(immediatePass(resolved));
  };
}
