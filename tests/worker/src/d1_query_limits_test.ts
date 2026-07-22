import { expect, test } from "bun:test";

import {
  chunkD1InQueryValues,
  D1_SAFE_IN_QUERY_VALUE_LIMIT,
} from "../../../worker/src/d1_query_limits.ts";

test("D1 IN query chunks retain safety headroom at every boundary", () => {
  expect(D1_SAFE_IN_QUERY_VALUE_LIMIT).toBe(90);
  expect(chunkD1InQueryValues([])).toEqual([]);
  expect(chunkD1InQueryValues(Array.from({ length: 90 }))).toHaveLength(1);
  expect(
    chunkD1InQueryValues(Array.from({ length: 91 })).map(
      (chunk) => chunk.length,
    ),
  ).toEqual([90, 1]);
  expect(
    chunkD1InQueryValues(Array.from({ length: 101 })).map(
      (chunk) => chunk.length,
    ),
  ).toEqual([90, 11]);
  expect(
    chunkD1InQueryValues(Array.from({ length: 205 })).map(
      (chunk) => chunk.length,
    ),
  ).toEqual([90, 90, 25]);
});
