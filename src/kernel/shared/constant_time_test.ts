import { expect, test } from "bun:test";

import {
  constantTimeEqualsBytes,
  constantTimeEqualsString,
} from "./constant_time.ts";

test("constantTimeEqualsString matches equal strings and rejects differences", () => {
  expect(constantTimeEqualsString("bearer-token", "bearer-token")).toBeTruthy();
  expect(!constantTimeEqualsString("bearer-token", "bearer-tokem")).toBeTruthy();
  // Length mismatch must not be treated as equal (and is folded into the
  // accumulator rather than short-circuited).
  expect(!constantTimeEqualsString("short", "short-but-longer")).toBeTruthy();
  expect(!constantTimeEqualsString("", "x")).toBeTruthy();
  expect(constantTimeEqualsString("", "")).toBeTruthy();
});

test("constantTimeEqualsString compares multi-byte characters end-to-end", () => {
  expect(constantTimeEqualsString("トークン", "トークン")).toBeTruthy();
  expect(!constantTimeEqualsString("トークン", "トークソ")).toBeTruthy();
});

test("constantTimeEqualsBytes matches equal byte arrays and rejects differences", () => {
  expect(constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 3]),
    )).toBeTruthy();
  expect(!constantTimeEqualsBytes(
      new Uint8Array([1, 2, 3]),
      new Uint8Array([1, 2, 4]),
    )).toBeTruthy();
  expect(!constantTimeEqualsBytes(
      new Uint8Array([1, 2]),
      new Uint8Array([1, 2, 3]),
    )).toBeTruthy();
});
