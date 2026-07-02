import { expect, test } from "bun:test";
import {
  canSubmitMobileText,
  isMobileTextPresent,
  mobileOptionalText,
  mobilePlainText,
  mobileTextRemaining,
} from "../../../mobile-kit/src/index.ts";

test("mobile text helpers normalize submit and remaining logic", () => {
  expect(mobileTextRemaining("hello", 10)).toBe(5);
  expect(isMobileTextPresent("  hello  ")).toBe(true);
  expect(isMobileTextPresent("   ")).toBe(false);
  expect(
    canSubmitMobileText({ value: "hello", disabled: false, maxLength: 10 }),
  ).toBe(true);
  expect(canSubmitMobileText({ value: "   " })).toBe(false);
  expect(canSubmitMobileText({ value: "hello", disabled: true })).toBe(false);
  expect(canSubmitMobileText({ value: "hello", maxLength: 4 })).toBe(false);
  expect(
    canSubmitMobileText({ value: "", requireContent: false, maxLength: 4 }),
  ).toBe(true);
});

test("mobile text helpers normalize optional and plain text", () => {
  expect(mobileOptionalText("  hello  ")).toBe("hello");
  expect(mobileOptionalText("   ")).toBeUndefined();
  expect(mobileOptionalText(42)).toBeUndefined();
  expect(mobilePlainText(" <b>Hello</b> world ", { maxLength: 5 })).toBe(
    "Hello",
  );
  expect(mobilePlainText("<p>   </p>")).toBeUndefined();
});
