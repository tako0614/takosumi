import { expect, test } from "bun:test";
import {
  formatDateTime,
  formatEpochDateTime,
} from "../../../../dashboard/src/i18n/index.ts";

test("epoch timestamps format like ISO ones and never throw", () => {
  const ms = Date.UTC(2026, 9, 13, 12, 0, 0);
  expect(formatEpochDateTime(ms)).toBe(
    formatDateTime(new Date(ms).toISOString()),
  );
  // `new Date(x).toISOString()` throws a RangeError for these.
  for (const bad of [8.64e15 + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(formatEpochDateTime(bad)).toBe("—");
  }
  expect(formatEpochDateTime(undefined)).toBe("—");
});
