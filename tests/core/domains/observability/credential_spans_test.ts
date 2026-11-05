// takos-secret-scan: synthetic — these canaries are deliberately not credentials.
import { expect, test } from "bun:test";
import { errorDiagnostic, redactRunDiagnostics } from "../../../../core/domains/deploy-control/projection.ts";
import { redactUnknown } from "../../../../core/shared/redaction.ts";
import { redactString, traceRedactString } from "takosumi-contract/redaction";

test("optional original-span tracing preserves canonical rendering", () => {
  for (const input of [
    'credentials={"nested":["json-canary",{"value":"other-canary"}]} safe=retained',
    'Authorization:Negotiate negotiate-canary\r\nSafe: retained',
    'Digest username="one", nonce="nonce-canary", response="response-canary"',
    'auth=Signature keyId=signature-canary\nSafe: retained',
    '-----BEGIN PRIVATE KEY-----\npem-canary\n-----END PRIVATE KEY-----',
    'fetch 1a.b://user:url-canary@host.invalid/path',
    'prefix 🔍 Bearer credential-canary and ghp_abcdefghijklmnopqrstuvwxyz',
    'Use a token value supplied by the operator.',
  ]) {
    const trace = traceRedactString(input);
    expect(trace.failed).toBe(false);
    expect(trace.value).toBe(redactString(input));
  }
});

test("Run diagnostics and unknown values mask complete credential spans", () => {
  for (const input of [
    'Digest username="one", nonce="nonce-canary", response="response-canary"',
    'Authorization: Negotiate negotiate-canary',
    'credentials={"nested":["json-canary",{"value":"other-canary"}]}',
    '-----BEGIN PRIVATE KEY-----\ntruncated-pem-canary',
  ]) {
    const projected = JSON.stringify({
      error: errorDiagnostic(new Error(input)),
      diagnostics: redactRunDiagnostics([{ severity: "error", message: input, detail: input }]),
      unknown: redactUnknown({ message: input, error: new Error(input) }),
    });
    expect(projected).not.toContain("canary");
    expect(projected).toContain("[REDACTED]");
  }
});
