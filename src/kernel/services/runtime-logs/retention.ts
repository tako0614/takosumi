import type { IsoTimestamp } from "../../shared/time.ts";
import type {
  RuntimeLogRetentionDecision,
  RuntimeLogRetentionPolicy,
} from "./types.ts";

export const DEFAULT_RUNTIME_LOG_RETENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

export function decideRuntimeLogRetention(input: {
  readonly now: IsoTimestamp;
  readonly policy?: Partial<RuntimeLogRetentionPolicy>;
  readonly oldestObservedAt?: IsoTimestamp;
}): RuntimeLogRetentionDecision {
  const windowMs = input.policy?.windowMs ??
    DEFAULT_RUNTIME_LOG_RETENTION_WINDOW_MS;
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError("runtime log retention windowMs must be non-negative");
  }

  const retainAfter = new Date(Date.parse(input.now) - windowMs).toISOString();
  return {
    now: input.now,
    windowMs,
    retainAfter,
    oldestObservedAt: input.oldestObservedAt,
    shouldPrune: input.oldestObservedAt !== undefined &&
      input.oldestObservedAt < retainAfter,
  };
}
