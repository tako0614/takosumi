import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../dashboard/src/components/ConfirmDialogRenderer.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("ConfirmDialogRenderer accessibility", () => {
  test("the message body is wired as the dialog's accessible description", () => {
    // aria-label carries the title; without aria-describedby the message —
    // the thing the user is actually confirming — was never announced.
    expect(source).toContain("aria-label={state().title}");
    expect(source).toContain('aria-describedby="tg-confirm-message"');
    expect(source).toContain('id="tg-confirm-message"');
  });
});
