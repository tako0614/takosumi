// takos-secret-scan: synthetic — this test exists to prove key material is redacted, so it must contain some.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { containsSecretLikeString, redactJsonObject, redactString } from "takosumi-contract/redaction";
import { redactUnknown } from "../../../../core/shared/redaction.ts";
import { errorMessage } from "../../../../core/shared/errors.ts";

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

test("secret-like detection rejects private keys and credential-bearing service URLs", () => {
  assert.equal(
    containsSecretLikeString(
      "-----BEGIN PRIVATE KEY-----\nnot-real-key\n-----END PRIVATE KEY-----",
    ),
    true,
  );
  assert.equal(
    containsSecretLikeString("postgres://database.internal/workspace"),
    true,
  );
  assert.equal(
    containsSecretLikeString("https://service.example/workspace"),
    false,
  );
});

test("unknown redaction terminates on cycles, BigInt and hostile properties", () => {
  const cyclic: Record<string, unknown> = { count: 10n };
  cyclic.self = cyclic;
  const shared = { value: 1 };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();

  assert.deepEqual(redactUnknown(cyclic), {
    count: "10",
    self: "[Circular]",
  });
  assert.deepEqual(redactUnknown({ left: shared, right: shared }), {
    left: { value: 1 },
    right: { value: 1 },
  });
  assert.deepEqual(redactUnknown({
    get hostile() {
      throw new Error("accessor must not run");
    },
    revoked: revoked.proxy,
    okay: true,
  }), {
    hostile: "[Unreadable]",
    revoked: "[Unreadable]",
    okay: true,
  });
});

test("unknown redaction has a finite depth and breadth budget", () => {
  let deep: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 100; index += 1) deep = { next: deep };
  assert.match(JSON.stringify(redactUnknown(deep)), /\[Truncated\]/u);

  const wide = redactUnknown(Array.from({ length: 20_000 }, (_, index) => index));
  assert.ok(Array.isArray(wide));
  assert.ok(wide.length < 20_000);
  assert.equal(wide.at(-1), "[Truncated]");
});

test("object redaction bounds Proxy descriptor inspection", () => {
  const target = Object.fromEntries(
    Array.from({ length: 5_000 }, (_, index) => [`key${index}`, index]),
  );
  let descriptorReads = 0;
  const proxy = new Proxy(target, {
    getOwnPropertyDescriptor(object, key) {
      descriptorReads += 1;
      return Reflect.getOwnPropertyDescriptor(object, key);
    },
  });

  const result = redactUnknown(proxy) as Record<string, unknown>;
  assert.ok(descriptorReads <= 1_024);
  assert.ok(Object.keys(result).length <= 1_025);
  assert.equal(result["[Truncated]"], "[Truncated]");
});

test("unknown redaction does not execute arbitrary toJSON or expose URL credentials", () => {
  let calls = 0;
  const carrier = {
    note: "visible",
    toJSON() {
      calls += 1;
      return { value: "opaque-local-value" };
    },
  };
  assert.deepEqual(redactUnknown({
    carrier,
    url: new URL("https://only-user@example.invalid/path?authorization=opaque-local-value"),
    date: new Date("2026-10-25T00:00:00.000Z"),
  }), {
    carrier: { note: "visible", toJSON: "[Function]" },
    url: "[URL]",
    date: "2026-10-25T00:00:00.000Z",
  });
  assert.equal(calls, 0);
});

test("redacted objects and arrays cannot inherit a later toJSON override", () => {
  const redacted = redactUnknown({
    password: "opaque-local-value",
    items: [{ note: "visible" }],
  }) as Record<string, unknown>;
  Object.setPrototypeOf(redacted, {
    toJSON() {
      return { leak: "opaque-local-value" };
    },
  });
  Object.setPrototypeOf(redacted.items as unknown[], {
    toJSON() {
      return ["opaque-local-value"];
    },
  });

  const serialized = JSON.stringify(redacted);
  assert.match(serialized, /"password":"\[REDACTED\]"/u);
  assert.doesNotMatch(serialized, /opaque-local-value/u);
});

test("errorMessage survives unprintable throwables", () => {
  assert.equal(errorMessage(Object.create(null)), "[unprintable thrown value]");
  assert.equal(errorMessage({
    toString() {
      throw new Error("toString must not replace the original error");
    },
  }), "[unprintable thrown value]");
  assert.equal(errorMessage(new Error("ordinary")), "ordinary");
});
