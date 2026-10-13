/**
 * In-process cadence for the two-stage uninstall finalizer on the Bun +
 * PostgreSQL distribution, which has no platform cron. The Cloudflare host
 * runs the same bounded finalizer from its hourly scheduled handler.
 *
 * Ticks never overlap within a process. Several processes may tick against
 * the same database: every finalizer step is a compare-and-set on the
 * Capsule's uninstall revision, so a losing tick changes nothing.
 */

import type { buildComposedApp } from "./composed-app.ts";

type FinalizerOperations = Pick<
  Awaited<ReturnType<typeof buildComposedApp>>["operations"],
  "finalizeDueCapsuleUninstalls"
>;

/** Default cadence; a scheduled destroy runs at most this long after it is due. */
export const CAPSULE_UNINSTALL_FINALIZE_INTERVAL_MS = 15 * 60 * 1000;

/** First tick after boot, so start-up is not delayed by finalizer work. */
export const CAPSULE_UNINSTALL_FINALIZE_INITIAL_DELAY_MS = 60 * 1000;

const CAPSULE_UNINSTALL_FINALIZE_LIMIT = 10;

export interface CapsuleUninstallFinalizerLoop {
  /** Runs one tick now unless one is already running. */
  tick(): Promise<void>;
  stop(): void;
}

export function startCapsuleUninstallFinalizer(input: {
  readonly operations: FinalizerOperations;
  readonly log: (
    level: "info" | "error",
    message: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
}): CapsuleUninstallFinalizerLoop {
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const result = await input.operations.finalizeDueCapsuleUninstalls({
          limit: CAPSULE_UNINSTALL_FINALIZE_LIMIT,
        });
        if (result.scanned > 0 || result.failures > 0) {
          input.log("info", "capsule uninstall finalize", {
            event: "capsule_uninstall_finalize",
            ...result,
          });
        }
      } catch (error) {
        input.log("error", "capsule uninstall finalize failed", {
          event: "capsule_uninstall_finalize_failed",
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
    input.initialDelayMs ?? CAPSULE_UNINSTALL_FINALIZE_INITIAL_DELAY_MS,
  );
  const interval = setInterval(
    () => void tick(),
    input.intervalMs ?? CAPSULE_UNINSTALL_FINALIZE_INTERVAL_MS,
  );
  // The server's listener keeps the process alive, not this cadence.
  (first as { unref?: () => void }).unref?.();
  (interval as { unref?: () => void }).unref?.();
  return {
    tick,
    stop() {
      stopped = true;
      clearTimeout(first);
      clearInterval(interval);
    },
  };
}
