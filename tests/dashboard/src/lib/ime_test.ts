import { describe, expect, test } from "bun:test";
import { isImeComposing } from "../../../../dashboard/src/lib/ime.ts";

describe("isImeComposing", () => {
  test("treats a composing keydown as IME input", () => {
    expect(isImeComposing({ isComposing: true, keyCode: 13 })).toBe(true);
  });

  test("treats Safari's post-composition keyCode 229 as IME input", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 229 })).toBe(true);
  });

  test("lets an ordinary Enter or Escape through", () => {
    expect(isImeComposing({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeComposing({ isComposing: false, keyCode: 27 })).toBe(false);
  });
});
