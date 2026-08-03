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

test("redactedErrorText escapes control characters so a log record cannot be forged", () => {
  const error = new TypeError(
    "passkey attestation format mismatch: expected none, got none\r\n2026-08-02T00:00:00Z INFO privacy_request_completed subject=tsub_victim",
  );
  const text = redactedErrorText(error);

  expect(text).not.toContain("\n");
  expect(text).not.toContain("\r");
  expect(text).toContain("\\r\\n2026-08-02T00:00:00Z INFO");
});
