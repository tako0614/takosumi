import { expect, test } from "bun:test";

import {
  constantTimeEqualsBytes,
  constantTimeEqualsString,
  timingSafeEqualHex,
} from "../../contract/internal-crypto.ts";

test("timingSafeEqualHex matches equal hex and folds length into the accumulator", () => {
  expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBeTruthy();
  expect(!timingSafeEqualHex("deadbeef", "deadbeee")).toBeTruthy();
  // A length mismatch must compare unequal without short-circuiting on the
  // length check (which would leak the operand length via timing).
  expect(!timingSafeEqualHex("dead", "deadbeef")).toBeTruthy();
  expect(!timingSafeEqualHex("", "00")).toBeTruthy();
  expect(timingSafeEqualHex("", "")).toBeTruthy();
});

test("constantTimeEqualsString matches equal strings and rejects differences", () => {
  expect(constantTimeEqualsString("bearer-token", "bearer-token")).toBeTruthy();
  expect(!constantTimeEqualsString("bearer-token", "bearer-tokem"))
    .toBeTruthy();
  // Length mismatch must be folded into the accumulator rather than
  // short-circuited (which would leak the secret length via timing).
  expect(!constantTimeEqualsString("short", "short-but-longer")).toBeTruthy();
  expect(!constantTimeEqualsString("", "x")).toBeTruthy();
  expect(constantTimeEqualsString("", "")).toBeTruthy();
});

test("constantTimeEqualsString compares multi-byte characters end-to-end", () => {
  expect(constantTimeEqualsString("トークン", "トークン")).toBeTruthy();
  expect(!constantTimeEqualsString("トークン", "トークソ")).toBeTruthy();
});

test("constantTimeEqualsBytes matches equal byte arrays and rejects differences", () => {
  expect(
    constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
    ),
  ).toBeTruthy();
  expect(
    !constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 4]),
    ),
  ).toBeTruthy();
  expect(
    !constantTimeEqualsBytes(
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3]),
    ),
  ).toBeTruthy();
});
