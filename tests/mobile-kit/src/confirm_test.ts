import { expect, test } from "bun:test";
import { confirmMobileAction } from "../../../mobile-kit/src/index.ts";

test("confirmMobileAction uses an injected confirmation function", () => {
  const messages: string[] = [];
  expect(
    confirmMobileAction({
      message: "Remove item?",
      confirm(message) {
        messages.push(message);
        return false;
      },
    }),
  ).toBe(false);
  expect(messages).toEqual(["Remove item?"]);
});

test("confirmMobileAction falls back when no native confirm is available", () => {
  expect(confirmMobileAction({ message: "Delete?", fallback: false })).toBe(
    false,
  );
  expect(confirmMobileAction({ message: "Delete?" })).toBe(true);
});
