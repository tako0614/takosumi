/** Daily bounded retry for terminal app and orphan Source cleanup. */
import type { buildComposedApp } from "./composed-app.ts";

type SweepOperations = Pick<
  Awaited<ReturnType<typeof buildComposedApp>>["operations"],
  "sweepRetiredSources"
>;

export const SOURCE_RETIREMENT_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const SOURCE_RETIREMENT_SWEEP_INITIAL_DELAY_MS = 60 * 1000;

export function startSourceRetirementSweeper(input: {
  readonly operations: SweepOperations;
  readonly log: (
    level: "info" | "error",
    message: string,
    fields: Record<string, unknown>,
  ) => void;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
}): { readonly tick: () => Promise<void>; readonly stop: () => void } {
  let running: Promise<void> | undefined;
  let stopped = false;
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const result = await input.operations.sweepRetiredSources({ limit: 25 });
        if (result.attempted > 0 || result.failures > 0) {
          input.log("info", "source retirement sweep", {
            event: "source_retirement_sweep",
            ...result,
          });
        }
      } catch (error) {
        input.log("error", "source retirement sweep failed", {
          event: "source_retirement_sweep_failed",
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
    input.initialDelayMs ?? SOURCE_RETIREMENT_SWEEP_INITIAL_DELAY_MS,
  );
  const interval = setInterval(
    () => void tick(),
    input.intervalMs ?? SOURCE_RETIREMENT_SWEEP_INTERVAL_MS,
  );
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
