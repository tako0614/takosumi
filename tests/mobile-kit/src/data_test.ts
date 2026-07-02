import { expect, test } from "bun:test";
import { mobileNumber, mobileRecord } from "../../../mobile-kit/src/index.ts";

test("mobileRecord accepts plain response records only", () => {
  expect(mobileRecord({ id: "one" })).toEqual({ id: "one" });
  expect(mobileRecord(["one"])).toBeUndefined();
  expect(mobileRecord(null)).toBeUndefined();
});

test("mobileNumber normalizes response numbers with explicit string support", () => {
  expect(mobileNumber(3.5)).toBe(3.5);
  expect(mobileNumber("3")).toBeUndefined();
  expect(mobileNumber("3", { acceptString: true })).toBe(3);
  expect(mobileNumber("3.9", { acceptString: true, integer: true })).toBe(3);
  expect(mobileNumber(-1, { min: 0 })).toBeUndefined();
});
