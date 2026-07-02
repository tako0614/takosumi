import { expect, test } from "bun:test";
import {
  isMobileAbortError,
  mobileErrorMessage,
} from "../../../mobile-kit/src/index.ts";

test("mobileErrorMessage prefers real Error messages", () => {
  expect(mobileErrorMessage(new Error("Network failed"), "Fallback")).toBe(
    "Network failed",
  );
  expect(mobileErrorMessage("nope", "Fallback")).toBe("Fallback");
  expect(mobileErrorMessage(new Error(""), "Fallback")).toBe("Fallback");
});

test("isMobileAbortError detects abort-like errors without product code", () => {
  expect(isMobileAbortError(new DOMException("Aborted", "AbortError"))).toBe(
    true,
  );
  expect(isMobileAbortError({ name: "AbortError" })).toBe(true);
  expect(isMobileAbortError(new Error("Other"))).toBe(false);
});
