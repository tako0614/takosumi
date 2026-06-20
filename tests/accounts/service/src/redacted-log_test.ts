import { expect, test } from "bun:test";
import { redactedErrorText } from "../../../../accounts/service/src/redacted-log.ts";

test("redactedErrorText masks credential-shaped error details", () => {
  const error = new Error(
    "Authorization: Bearer raw-token DATABASE_URL=postgres://user:pass@db.example/takos apiToken=abc123",
  );
  const text = redactedErrorText(error);

  expect(text).not.toContain("raw-token");
  expect(text).not.toContain("pass@db.example");
  expect(text).not.toContain("abc123");
  expect(text).toContain("[REDACTED]");
  expect(text.startsWith("Error:")).toEqual(true);
  expect(text).not.toContain("redacted-log_test");
});
