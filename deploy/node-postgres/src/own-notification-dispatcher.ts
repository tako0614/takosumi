/**
 * In-process cadence for the own-notification dispatcher (Web Push to
 * Takosumi Mobile) on the Bun + PostgreSQL distribution, which has no
 * platform cron. The Cloudflare host runs the same dispatcher from its
 * scheduled handler.
 *
 * The server also delivers each notified Activity event right after it is
 * stored (`deliverNow`); the interval only catches up. Ticks never overlap
 * within a process. Several processes may tick against the
 * same database: the Activity cursor moves by compare-and-set, delivery rows
 * are keyed by (event, pusher), and sends are leased with FOR UPDATE SKIP
 * LOCKED, so a second process neither enqueues nor sends twice.
 */

import type { NotificationDispatchStore } from "../../../core/domains/notifications/dispatch_store.ts";
import type { ActivityEvent } from "takosumi-contract/activity";
import type { RecordActivityContext } from "../../../core/domains/activity/mod.ts";
import {
  createOwnNotificationDispatcher,
  deliverOwnNotificationNow,
} from "../../../core/domains/notifications/compose.ts";
import type { buildComposedApp } from "./composed-app.ts";

type DispatcherOperations = Pick<
  Awaited<ReturnType<typeof buildComposedApp>>["operations"],
  "activity" | "appOwnership" | "controller" | "capsules"
>;

/** Catch-up cadence: what the immediate path missed is sent within about this long. */
export const OWN_NOTIFICATION_DISPATCH_INTERVAL_MS = 30 * 1000;
const OWN_NOTIFICATION_DISPATCH_INITIAL_DELAY_MS = 15 * 1000;

export interface OwnNotificationDispatcherLoop {
  /** Runs one catch-up tick now unless one is already running. */
  tick(): Promise<void>;
  /**
   * The immediate path for an event the service just stored: enqueue and
   * send its rows (bounded, never throws). Leftovers go to the next tick.
   */
  deliverNow(event: ActivityEvent, context?: RecordActivityContext): Promise<void>;
  stop(): void;
}

export function startOwnNotificationDispatcher(input: {
  readonly operations: DispatcherOperations;
  readonly store: Partial<NotificationDispatchStore>;
  readonly env: Readonly<Record<string, unknown>>;
  readonly issuer: string;
  readonly log: (
    level: "info" | "error",
    message: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
}): OwnNotificationDispatcherLoop | undefined {
  const dispatcher = createOwnNotificationDispatcher({
    operations: input.operations,
    store: input.store,
    env: input.env,
    issuer: input.issuer,
    log: (event, fields) => input.log("info", "own notification dispatch", { event, ...fields }),
  });
  if (!dispatcher) return undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const result = await dispatcher.run();
        if (result.enqueued > 0 || result.delivered > 0 || result.retried > 0 ||
          result.failed > 0 || result.removedPushers > 0 || result.skippedEvents > 0 ||
          result.parkedEvents > 0 || result.expiredEvents > 0) {
          input.log("info", "own notification dispatch", {
            event: "own_notification_dispatch",
            ...result,
          });
        }
      } catch (error) {
        input.log("error", "own notification dispatch failed", {
          event: "own_notification_dispatch_failed",
          errorName: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        running = undefined;
      }
    })();
    return running;
  };
  const first = setTimeout(
    () => void tick(),
    input.initialDelayMs ?? OWN_NOTIFICATION_DISPATCH_INITIAL_DELAY_MS,
  );
  const interval = setInterval(
    () => void tick(),
    input.intervalMs ?? OWN_NOTIFICATION_DISPATCH_INTERVAL_MS,
  );
  // The server's listener keeps the process alive, not this cadence.
  (first as { unref?: () => void }).unref?.();
  (interval as { unref?: () => void }).unref?.();
  return {
    tick,
    deliverNow: (event, context) =>
      deliverOwnNotificationNow({
        dispatcher,
        event,
        ...(context ? { context } : {}),
        log: (name, fields) => input.log("info", "own notification immediate", { event: name, ...fields }),
      }),
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
