import { test } from "bun:test";
import assert from "node:assert/strict";
import { containsSecretLikeString, redactJsonObject, redactString } from "../../../../core/domains/observability/mod.ts";

test("redaction masks nested secret and token fields", () => {
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

test("redaction masks bearer and assignment secrets inside strings", () => {
  assert.equal(
    redactString("Authorization: Bearer abc.def token=xyz&safe=true"),
    "Authorization: Bearer [REDACTED] token=[REDACTED]&safe=true",
  );
});

test("redaction masks prefixed env-style secret assignments and DSN passwords", () => {
  assert.equal(
    redactString(
      "AWS_SECRET_ACCESS_KEY=aws-secret CLOUDFLARE_API_TOKEN=cf-token " +
        "DATABASE_URL=postgres://user:db-pass@db.example/takos",
    ),
    "AWS_SECRET_ACCESS_KEY=[REDACTED] CLOUDFLARE_API_TOKEN=[REDACTED] " +
      "DATABASE_URL=[REDACTED]",
  );
});

test("redaction masks bare provider token value shapes", () => {
  assert.equal(containsSecretLikeString("sk-status-raw"), true);
  assert.equal(containsSecretLikeString("ghp_abcdefghijklmnopqrstuvwxyz"), true);
  assert.equal(
    redactString(
      "failed with sk-status-raw and ghp_abcdefghijklmnopqrstuvwxyz in stderr",
    ),
    "failed with [REDACTED] and [REDACTED] in stderr",
  );
});
