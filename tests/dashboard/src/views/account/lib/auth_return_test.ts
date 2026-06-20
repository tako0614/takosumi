import { expect, test } from "bun:test";
import { safeOAuthReturnTo } from "../../../../../../dashboard/src/views/account/lib/auth.ts";

test("safeOAuthReturnTo keeps same-origin paths", () => {
  expect(safeOAuthReturnTo("/")).toBe("/");
  expect(safeOAuthReturnTo("/installations?tab=apps#latest")).toBe(
    "/installations?tab=apps#latest",
  );
  expect(safeOAuthReturnTo("  /spaces/space_1  ")).toBe("/spaces/space_1");
});

test("safeOAuthReturnTo rejects open-redirect values", () => {
  for (const value of [
    undefined,
    null,
    "",
    "https://evil.example/",
    "javascript:alert(1)",
    "//evil.example/path",
    " ///evil.example/path",
    "/ok\nLocation: https://evil.example",
  ]) {
    expect(safeOAuthReturnTo(value)).toBe("/");
  }
});
