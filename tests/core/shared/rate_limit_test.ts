import { expect, test } from "bun:test";

import { InMemoryTokenBucketRateLimiter, rateLimitPerMinuteFromEnv } from "../../../core/shared/rate_limit.ts";

function limiterAt(startMs: number): {
  limiter: InMemoryTokenBucketRateLimiter;
  tick: (ms: number) => void;
} {
  let now = startMs;
  return {
    limiter: new InMemoryTokenBucketRateLimiter({ now: () => now }),
    tick: (ms) => {
      now += ms;
    },
  };
}

test("admits up to the per-minute budget, then refuses with a retry hint", async () => {
  const { limiter } = limiterAt(1_000_000);
  for (let i = 0; i < 3; i++) {
    expect(
      (await limiter.admit({ scope: "ws_a", limitPerMinute: 3 })).admitted,
    ).toBe(true);
  }
  const refused = await limiter.admit({ scope: "ws_a", limitPerMinute: 3 });
  expect(refused.admitted).toBe(false);
  // 3/min refills one token every 20s.
  expect(refused.retryAfterSeconds).toBe(20);
});

test("tokens refill continuously with elapsed time", async () => {
  const { limiter, tick } = limiterAt(2_000_000);
  for (let i = 0; i < 2; i++) {
    await limiter.admit({ scope: "ws_b", limitPerMinute: 2 });
  }
  expect(
    (await limiter.admit({ scope: "ws_b", limitPerMinute: 2 })).admitted,
  ).toBe(false);
  tick(30_001); // one token refilled (2/min = 1 per 30s)
  expect(
    (await limiter.admit({ scope: "ws_b", limitPerMinute: 2 })).admitted,
  ).toBe(true);
  expect(
    (await limiter.admit({ scope: "ws_b", limitPerMinute: 2 })).admitted,
  ).toBe(false);
});

test("scopes are independent", async () => {
  const { limiter } = limiterAt(3_000_000);
  await limiter.admit({ scope: "ws_c", limitPerMinute: 1 });
  expect(
    (await limiter.admit({ scope: "ws_c", limitPerMinute: 1 })).admitted,
  ).toBe(false);
  expect(
    (await limiter.admit({ scope: "ws_d", limitPerMinute: 1 })).admitted,
  ).toBe(true);
});

test("a non-positive limit disables the throttle", async () => {
  const { limiter } = limiterAt(4_000_000);
  for (let i = 0; i < 100; i++) {
    expect(
      (await limiter.admit({ scope: "ws_e", limitPerMinute: 0 })).admitted,
    ).toBe(true);
  }
});

test("rateLimitPerMinuteFromEnv parses, defaults, and honors 0", () => {
  expect(rateLimitPerMinuteFromEnv(undefined, 30)).toBe(30);
  expect(rateLimitPerMinuteFromEnv("", 30)).toBe(30);
  expect(rateLimitPerMinuteFromEnv("junk", 30)).toBe(30);
  expect(rateLimitPerMinuteFromEnv("-5", 30)).toBe(30);
  expect(rateLimitPerMinuteFromEnv("0", 30)).toBe(0);
  expect(rateLimitPerMinuteFromEnv("120", 30)).toBe(120);
});
