import { expect, test } from "bun:test";

import { sanitizeUpstreamErrorPayload } from "../../../../accounts/service/src/installation-lifecycle-shared.ts";

test("sanitizeUpstreamErrorPayload redacts secret-like message and hint fields", () => {
  const sanitized = sanitizeUpstreamErrorPayload({
    error: {
      code: "upstream_failed",
      message:
        "Authorization: Bearer raw-token DATABASE_URL=postgres://user:pass@db/app",
      requestId: "req_1",
      hint: "retry with OPENAI_API_KEY=sk-live-token-123456789",
      stack: "do not echo",
    },
  });

  expect(sanitized).toEqual({
    code: "upstream_failed",
    message: "Authorization: Bearer [REDACTED] DATABASE_URL=[REDACTED]",
    requestId: "req_1",
    hint: "retry with OPENAI_API_KEY=[REDACTED]",
  });
});
