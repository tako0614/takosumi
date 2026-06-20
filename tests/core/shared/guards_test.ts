import { expect, test } from "bun:test";

import { asRecord, isRecord } from "../../../core/shared/guards.ts";

test("isRecord accepts plain objects", () => {
  expect(isRecord({})).toBeTruthy();
  expect(isRecord({ a: 1 })).toBeTruthy();
});

test("isRecord rejects arrays (the canonical, non-array guard)", () => {
  // A JSON array is `typeof "object"` but must NOT pass as a record: this is
  // the divergence the single-source guard closes.
  expect(isRecord([])).toBeFalsy();
  expect(isRecord([1, 2, 3])).toBeFalsy();
});

test("isRecord rejects null and non-objects", () => {
  expect(isRecord(null)).toBeFalsy();
  expect(isRecord(undefined)).toBeFalsy();
  expect(isRecord("x")).toBeFalsy();
  expect(isRecord(1)).toBeFalsy();
  expect(isRecord(true)).toBeFalsy();
});

test("asRecord returns the value for records and undefined otherwise", () => {
  const obj = { a: 1 };
  expect(asRecord(obj)).toBe(obj);
  expect(asRecord([])).toBeUndefined();
  expect(asRecord(null)).toBeUndefined();
  expect(asRecord("x")).toBeUndefined();
});
