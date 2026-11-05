// takos-secret-scan: synthetic — this test exists to prove key material is redacted, so it must contain some.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { containsSecretLikeString, redactJsonObject, redactString } from "takosumi-contract/redaction";
import { redactUnknown } from "../../../../core/shared/redaction.ts";
import { errorMessage } from "../../../../core/shared/errors.ts";
import { errorDiagnostic, redactRunDiagnostics } from "../../../../core/domains/deploy-control/projection.ts";

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
    "Authorization: [REDACTED]",
  );
});

for (const scheme of ["bearer", "bEaReR", "basic", "bAsIc", "digest", "dIgEsT"]) {
  test(`redaction masks token-like auth fragments after case-insensitive ${scheme}`, () => {
    const input = `provider rejected ${scheme} opaque-fixture-value`;
    const expected = `provider rejected ${scheme} [REDACTED]`;
    assert.equal(redactString(input), expected);
    assert.equal(containsSecretLikeString(input), true);
    assert.deepEqual(redactJsonObject({ message: input }), { message: expected });
    assert.equal(redactString(expected), expected);
  });
}

test("Run error and diagnostic projection masks mixed-case token-like auth fragments", () => {
  assert.deepEqual(errorDiagnostic(new Error("provider rejected bEaReR opaque-fixture-value")), {
    severity: "error",
    message: "provider rejected bEaReR [REDACTED]",
  });
  assert.deepEqual(redactRunDiagnostics([{
    severity: "warning",
    message: "upstream rejected basic opaque-fixture-value",
    detail: "retry used dIgEsT opaque-fixture-value",
  }]), [{
    severity: "warning",
    message: "upstream rejected basic [REDACTED]",
    detail: "retry used dIgEsT [REDACTED]",
  }]);
});

test("Token prose retains its existing metadata detection boundary", () => {
  assert.equal(containsSecretLikeString("Use a token value supplied by the operator."), false);
  assert.equal(redactString("Token opaque-fixture-value"), "Token [REDACTED]");
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

test("private-key PEM bodies and multiple blocks are fully masked", () => {
  const input = [
    "before-safe",
    "-----BEGIN RSA PRIVATE KEY-----",
    "pem-canary-alpha",
    "-----END RSA PRIVATE KEY-----",
    "between-safe",
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "pem-canary-beta",
    "-----END ENCRYPTED PRIVATE KEY-----",
    "after-safe",
  ].join("\n");
  assert.equal(redactString(input), [
    "before-safe", "[REDACTED]", "between-safe", "[REDACTED]", "after-safe",
  ].join("\n"));
  assert.equal(containsSecretLikeString(input), true);
});

test("incomplete or mismatched PEM end fails closed", () => {
  for (const tail of [
    "pem-canary-gamma\ntrailing-canary",
    "pem-canary-gamma\n-----END EC PRIVATE KEY-----\ntrailing-canary",
  ]) {
    assert.equal(redactString(`pre-safe\n-----BEGIN RSA PRIVATE KEY-----\n${tail}`),
      "pre-safe\n[REDACTED]");
  }
});

test("structured credential assignments mask nested mixed values and quoted escapes", () => {
  assert.equal(
    redactString('GOOGLE_CREDENTIALS={"outer":[{"v":"object-canary"},["array-canary",{"x":"leaf-canary"}]]} safe=visible'),
    "GOOGLE_CREDENTIALS=[REDACTED] safe=visible",
  );
  assert.equal(
    redactString(String.raw`CREDENTIALS='{"entry":"quote-\'canary","path":"slash-\\canary"}' safe=visible`),
    "CREDENTIALS=[REDACTED] safe=visible",
  );
});

test("malformed or oversized structured credentials fail closed", () => {
  assert.equal(redactString("CREDENTIALS={[}mismatch-tail-canary safe=visible"),
    "CREDENTIALS=[REDACTED]");
  assert.equal(redactString('CREDENTIALS="unterminated-canary\\" tail-canary'),
    "CREDENTIALS=[REDACTED]");
  assert.equal(redactString('CREDENTIALS={"x":["unterminated-canary"} tail-canary'),
    "CREDENTIALS=[REDACTED]");
  assert.equal(redactString(`CREDENTIALS={${"x".repeat(1_048_576)}over-budget-canary`),
    "CREDENTIALS=[REDACTED]");
});

test("Digest parameter lists hide later values while preserving next line", () => {
  const header = 'Authorization: dIgEsT username="u,\\"ser", nonce="nonce-canary", response="response-canary", cnonce="cnonce-canary", opaque="opaque-canary"\nNext: visible';
  assert.equal(redactString(header), "Authorization: [REDACTED]\nNext: visible");
  assert.equal(containsSecretLikeString(header), true);
  assert.equal(
    redactString('upstream dIgEsT username="u,ser", nonce="nonce-canary"\nNext: visible'),
    "upstream dIgEsT [REDACTED]\nNext: visible",
  );
  assert.equal(
    redactString("upstream Digest username*=UTF-8''user-canary, response=hash-canary\nNext: visible"),
    "upstream Digest [REDACTED]\nNext: visible",
  );
  assert.equal(containsSecretLikeString("Use a token value supplied by the operator."), false);
});

test("folded and malformed Digest fields mask continued parameters", () => {
  assert.equal(
    redactString('Authorization: dIgEsT username="u",\r\n nonce="NONCE_CANARY",\r\n\tresponse="RESPONSE_CANARY", cnonce="CNONCE_CANARY"\r\nSafe: retained'),
    "Authorization: [REDACTED]\r\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Digest\r\n username="USER_CANARY", nonce="NONCE_CANARY"\r\nSafe: retained'),
    "Authorization: [REDACTED]\r\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Digest username="u",\nnonce="NONCE_CANARY", response="RESPONSE_CANARY"\nSafe: retained'),
    "Authorization: [REDACTED]\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Digest username="unterminated-canary\nnonce="NONCE_CANARY"\nSafe: retained'),
    "Authorization: [REDACTED]\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Digest username="unterminated-canary\nloose-tail-canary'),
    "Authorization: [REDACTED]",
  );
});

test("SQL-style doubled single quotes remain inside a credential value", () => {
  assert.equal(redactString("CREDENTIALS='first''sensitive tail' safe=visible"),
    "CREDENTIALS=[REDACTED] safe=visible");
});

test("quoted JSON secret keys and adjacent credential fragments are masked", () => {
  assert.equal(
    redactString(String.raw`{"cred\u0065ntials":{"v":"JSON_CANARY with space"},"safe":"visible"}`),
    String.raw`{"cred\u0065ntials":[REDACTED],"safe":"visible"}`,
  );
  assert.equal(redactString('CREDENTIALS="first"\'CANARY tail\''),
    "CREDENTIALS=[REDACTED]");
  assert.equal(redactString('CREDENTIALS="first"CANARYtail'),
    "CREDENTIALS=[REDACTED]");
  assert.equal(redactString('CREDENTIALS="first" safe=visible'),
    "CREDENTIALS=[REDACTED] safe=visible");
});

test("standalone URL credentials retain the password-only masking", () => {
  assert.equal(
    redactString("fetch https://user:password-canary@host.invalid/path"),
    "fetch https://user:[REDACTED]@host.invalid/path",
  );
});

test("URL scheme word boundaries retain password masking", () => {
  assert.equal(redactString("1a.b://user:plain-canary@host.invalid"),
    "1a.b://user:[REDACTED]@host.invalid");
  assert.equal(redactString("_abc.def://user:other-canary@host.invalid"),
    "_abc.def://user:[REDACTED]@host.invalid");
});

test("scalar auth assignments mask values without changing Authorization headers", () => {
  assert.equal(redactString("auth=plain-canary"), "auth=[REDACTED]");
  assert.equal(redactString("authorization=other-canary"),
    "authorization=[REDACTED]");
  assert.equal(redactString("auth=plain-canary safe=visible"),
    "auth=[REDACTED]");
  assert.equal(redactString('auth=Bearer "quoted-canary with space" safe=visible'),
    "auth=[REDACTED]");
  assert.equal(redactString("auth=Negotiate plain-canary\nSafe: retained"),
    "auth=[REDACTED]\nSafe: retained");
  assert.equal(
    redactString("authorization=Signature keyId=plain-canary, signature=secret-canary\r\nSafe: retained"),
    "authorization=[REDACTED]\r\nSafe: retained",
  );
  assert.equal(redactString("auth=customscheme plain-canary\nSafe: retained"),
    "auth=[REDACTED]\nSafe: retained");
  assert.equal(
    redactString('auth=Bearer "quoted-canary with space", nonce="N_CANARY"\nSafe: retained'),
    "auth=[REDACTED]\nSafe: retained",
  );
  assert.equal(redactString("Authorization: Bearer abc.def token=xyz&safe=true"),
    "Authorization: [REDACTED]");
});

test("bare Digest recognizes RFC-valid punctuation-led auth parameters", () => {
  for (const initial of ["!", "#", "$", "%", "&", "'", "*", "^", "`", "|"]) {
    const input = `Digest ${initial}ext="x", nonce="N_CANARY", response="R_CANARY"\nSafe: retained`;
    assert.equal(redactString(input), "Digest [REDACTED]\nSafe: retained");
    assert.equal(containsSecretLikeString(input), true);
  }
  assert.equal(redactString("Digest !metadata=visible"), "Digest [REDACTED]");
  assert.equal(containsSecretLikeString("Use a token value supplied by the operator."), false);
});

test("Authorization masks complete Negotiate and Signature fields", () => {
  assert.equal(
    redactString("Authorization: Negotiate plain-canary\nSafe: retained"),
    "Authorization: [REDACTED]\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Signature keyId="one", signature="secret-canary"\r\nSafe: retained'),
    "Authorization: [REDACTED]\r\nSafe: retained",
  );
  assert.equal(
    redactString('aUtHoRiZaTiOn: Signature keyId="one",\r\n signature="secret-canary",\r\n\talgorithm="hmac"\r\nSafe: retained'),
    "aUtHoRiZaTiOn: [REDACTED]\r\nSafe: retained",
  );
});

test("Authorization masks malformed Basic and Bearer extra atoms", () => {
  assert.equal(
    redactString('Authorization: Bearer first-canary extra-canary\nSafe: retained'),
    "Authorization: [REDACTED]\nSafe: retained",
  );
  assert.equal(
    redactString('Authorization: Basic "quoted-canary with space"\nSafe: retained'),
    "Authorization: [REDACTED]\nSafe: retained",
  );
  assert.equal(redactString("Bearer bare-canary"), "Bearer [REDACTED]");
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
