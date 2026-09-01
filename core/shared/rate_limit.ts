/**
 * Token-bucket admission control for edge write lanes.
 *
 * The bucket is scoped by an opaque string (a workspace, a subject, a source)
 * and refills continuously at `limitPerMinute`. Admission never throws — a
 * refusal returns `admitted: false` with the seconds until one token refills,
 * which HTTP layers surface as 429 + `Retry-After`.
 *
 * The in-memory implementation is the AUTHORITY on single-process substrates
 * (the Bun + Postgres distribution). On Cloudflare Workers it bounds each
 * isolate independently — a coordination-backed limiter can be composed in
 * through the same seam when exact global counting matters.
 */

export interface RateAdmission {
  readonly admitted: boolean;
  /** Present on refusal: whole seconds until one token is available. */
  readonly retryAfterSeconds?: number;
}

export interface WriteRateLimiter {
  admit(input: {
    readonly scope: string;
    readonly limitPerMinute: number;
  }): Promise<RateAdmission>;
}

interface Bucket {
  tokens: number;
  updatedAtMs: number;
  /** The budget this bucket was last admitted under; pruning uses it. */
  limit: number;
}

/** Buckets at (or above) capacity carry no state worth keeping. */
const PRUNE_THRESHOLD = 4096;

export class InMemoryTokenBucketRateLimiter implements WriteRateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #now: () => number;

  constructor(deps: { readonly now?: () => number } = {}) {
    this.#now = deps.now ?? (() => Date.now());
  }

  admit(input: {
    readonly scope: string;
    readonly limitPerMinute: number;
  }): Promise<RateAdmission> {
    const limit = input.limitPerMinute;
    if (!Number.isFinite(limit) || limit <= 0) {
      // Non-positive limit disables the lane's throttle.
      return Promise.resolve({ admitted: true });
    }
    const now = this.#now();
    const refillPerMs = limit / 60_000;
    const bucket = this.#buckets.get(input.scope);
    const tokens = bucket
      ? Math.min(
          limit,
          bucket.tokens + Math.max(0, now - bucket.updatedAtMs) * refillPerMs,
        )
      : limit;
    if (tokens < 1) {
      this.#buckets.set(input.scope, { tokens, updatedAtMs: now, limit });
      return Promise.resolve({
        admitted: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((1 - tokens) / refillPerMs / 1000),
        ),
      });
    }
    this.#buckets.set(input.scope, {
      tokens: tokens - 1,
      updatedAtMs: now,
      limit,
    });
    this.#prune(now);
    return Promise.resolve({ admitted: true });
  }

  /**
   * Bounds the map: drop buckets that have refilled back to capacity.
   *
   * Each bucket is judged against ITS OWN limit. Using the calling lane's
   * limit meant one limiter shared across lanes with different budgets would
   * evict or retain the wrong buckets.
   */
  #prune(now: number): void {
    if (this.#buckets.size <= PRUNE_THRESHOLD) return;
    for (const [scope, bucket] of this.#buckets) {
      const refillPerMs = bucket.limit / 60_000;
      const tokens =
        bucket.tokens + Math.max(0, now - bucket.updatedAtMs) * refillPerMs;
      if (tokens >= bucket.limit) this.#buckets.delete(scope);
    }
  }
}

/**
 * Parses a per-minute rate-limit env value. Returns the default for
 * absent/malformed values; `0` (or any non-positive integer) disables the
 * throttle for that lane.
 */
export function rateLimitPerMinuteFromEnv(
  raw: string | undefined,
  defaultPerMinute: number,
): number {
  if (raw === undefined || raw.trim() === "") return defaultPerMinute;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return defaultPerMinute;
  return parsed;
}
