// takos-secret-scan: synthetic — these canaries are deliberately not credentials.
import { expect, test } from "bun:test";
import { errorDiagnostic, redactRunDiagnostics } from "../../../../core/domains/deploy-control/projection.ts";
import { redactUnknown } from "../../../../core/shared/redaction.ts";

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
