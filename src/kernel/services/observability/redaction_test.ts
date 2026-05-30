import assert from "node:assert/strict";
import { redactJsonObject, redactString } from "./mod.ts";

Deno.test("redaction masks nested secret and token fields", () => {
  const redacted = redactJsonObject({
    ok: "visible",
    password: "p@ssw0rd",
    nested: {
      apiKey: "abc123",
      items: [{ refresh_token: "refresh" }, { value: "safe" }],
    },
  });

  assert.deepEqual(redacted, {
    ok: "visible",
    password: "[REDACTED]",
    nested: {
      apiKey: "[REDACTED]",
      items: [{ refresh_token: "[REDACTED]" }, { value: "safe" }],
    },
  });
});

Deno.test("redaction masks bearer and assignment secrets inside strings", () => {
  assert.equal(
    redactString("Authorization: Bearer abc.def token=xyz&safe=true"),
    "Authorization: Bearer [REDACTED] token=[REDACTED]&safe=true",
  );
});
