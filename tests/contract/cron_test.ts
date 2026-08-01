import { expect, test } from "bun:test";
import {
  matchesPortableCron,
  nextPortableCronOccurrence,
  normalizePortableCron,
} from "../../contract/index.ts";

test("normalizes five fields and Sunday aliases", () => {
  expect(normalizePortableCron("  5  04  */10  01  7  ")).toBe(
    "5 4 */10 1 0",
  );
  expect(normalizePortableCron("0 0 * * 5-7")).toBe("0 0 * * 5,6,0");
  expect(normalizePortableCron("01,001 02-04/01 * 1-12 0,07")).toBe(
    "1 2-4 * 1-12 0",
  );
  expect(normalizePortableCron("0 0 */01 * 1")).toBe("0 0 */1 * 1");
});

test("rejects malformed fields and out-of-range values", () => {
  for (const expression of [
    "* * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "1--2 * * * *",
    "1, * * * *",
  ]) {
    expect(() => normalizePortableCron(expression)).toThrow(TypeError);
  }
});

test("matches numeric, list, range, and step syntax at UTC minute granularity", () => {
  const expression = "5,10-14/2 1-3 10-12 1-6 1-5";
  expect(
    matchesPortableCron(expression, new Date("2024-03-11T01:05:59.999Z")),
  ).toBe(true);
  expect(
    matchesPortableCron(expression, new Date("2024-03-11T01:06:00.000Z")),
  ).toBe(false);
  expect(
    matchesPortableCron(expression, new Date("2024-03-11T01:10:00.000Z")),
  ).toBe(true);
});

test("uses OR when both day fields are restricted and AND otherwise", () => {
  // 7 January 2024 is Sunday (0), but not day 1: DOW makes this match.
  expect(
    matchesPortableCron("0 0 1 * 0", new Date("2024-01-07T00:00:00Z")),
  ).toBe(true);
  expect(
    matchesPortableCron("0 0 1 * 0", new Date("2024-01-02T00:00:00Z")),
  ).toBe(false);
  // A wildcard DOM means the DOW predicate is still required.
  expect(
    matchesPortableCron("0 0 * * 1", new Date("2024-01-07T00:00:00Z")),
  ).toBe(false);
  expect(
    matchesPortableCron("0 0 * * 7", new Date("2024-01-07T00:00:00Z")),
  ).toBe(true);
});

test("next occurrence is strictly after the instant and returns a UTC minute", () => {
  const next = nextPortableCronOccurrence(
    "*/15 * * * *",
    new Date("2024-01-01T00:15:00.123Z"),
  );
  expect(next.toISOString()).toBe("2024-01-01T00:30:00.000Z");
  expect(next.getUTCSeconds()).toBe(0);
  expect(next.getUTCMilliseconds()).toBe(0);
});

test("bounded next-occurrence search fails for an impossible calendar date", () => {
  expect(() =>
    nextPortableCronOccurrence("0 0 31 2 *", new Date("2024-01-01T00:00:00Z")),
  ).toThrow(RangeError);
});
