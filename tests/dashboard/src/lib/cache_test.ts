import { describe, expect, test } from "bun:test";
import { isFreshCacheEntry } from "../../../../dashboard/src/lib/cache.ts";

describe("dashboard cache freshness", () => {
  test("preserves strict TTL and clock-skew behavior", () => {
    const entry = { cachedAt: 100 };

    expect(isFreshCacheEntry(undefined, 100, 199)).toBeFalse();
    expect(isFreshCacheEntry(entry, 100, 199)).toBeTrue();
    expect(isFreshCacheEntry(entry, 100, 200)).toBeFalse();
    expect(isFreshCacheEntry(entry, 100, 50)).toBeTrue();
  });
});
