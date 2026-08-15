import type { Run } from "../../lib/control-api.ts";

const TERMINAL = new Set<Run["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);

/**
 * SSE is a latency optimization, not completion authority. A stream can open
 * successfully and still lose a later terminal frame, so every non-terminal
 * install Run keeps the bounded fallback read active.
 */
export function installRunNeedsFallbackRead(run: Run | undefined): boolean {
  return !run || !TERMINAL.has(run.status);
}
