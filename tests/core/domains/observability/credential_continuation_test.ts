// takos-secret-scan: synthetic — deliberately malformed credential-shaped canaries.
import { expect, test } from "bun:test";
import { containsSecretLikeString, redactString, traceRedactString } from "../../../../contract/redaction.ts";
import { errorDiagnostic, redactRunDiagnostics } from "../../../../core/domains/deploy-control/projection.ts";
import { redactUnknown } from "../../../../core/shared/redaction.ts";
import { credentialProseFixtures, credentialSpanFixtures } from "../../../helpers/credential_span_fixtures.ts";

test.each(credentialSpanFixtures)("credential continuation reaches Core diagnostics: $name", ({ input, sensitive, suffix }) => {
  const canonical = redactString(input);
  const trace = traceRedactString(input);
  expect(trace.failed).toBe(false);
  expect(trace.value).toBe(canonical);
  expect(containsSecretLikeString(input)).toBe(true);
  const diagnostic = redactRunDiagnostics([{ severity: "warning", message: input, detail: input }])?.[0];
  const unknown = redactUnknown({ message: input }) as { message: string };
  for (const output of [canonical, errorDiagnostic(new Error(input)).message,
    diagnostic?.message, diagnostic?.detail, unknown.message]) {
    expect(typeof output).toBe("string");
    expect(output).toContain("[REDACTED]");
    for (const value of sensitive) expect(output).not.toContain(value);
    expect(output?.endsWith(suffix)).toBe(true);
  }
  expect(redactString(canonical)).toBe(canonical);
});

test.each(credentialProseFixtures)("public keys and format prose remain visible: %s", (input) => {
  expect(redactString(input)).toBe(input);
  expect(traceRedactString(input).value).toBe(input);
  expect(containsSecretLikeString(input)).toBe(false);
});

test("uncertain YAML and truncated private blocks fail closed", () => {
  for (const input of [
    "password: |0\n  TRUNCATED_CANARY",
    "password: | # comment\n\tTRUNCATED_CANARY",
    "password: |2\n TRUNCATED_CANARY",
    "error: password: |\n  TRUNCATED_CANARY\nsafe: visible",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\nTRUNCATED_CANARY",
    "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\nTRUNCATED_CANARY",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----\rTRUNCATED_CANARY",
    "---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ----\rTRUNCATED_CANARY",
    "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\nTRUNCATED_CANARY",
  ]) {
    const output = redactString(input);
    expect(output).not.toContain("TRUNCATED_CANARY");
    expect(traceRedactString(input).value).toBe(output);
  }
});

test("even shell backslashes and ordinary newlines preserve the next line", () => {
  for (const lineBreak of ["\n", "\r\n", "\r"]) {
    for (const ending of ["", "\\\\"]) {
      const nextLines = `${lineBreak}NEXT_LINE_VISIBLE${lineBreak}safe: visible`;
      const input = `PASSWORD=FIRST_CANARY${ending}${nextLines}`;
      const output = redactString(input);
      expect(output).not.toContain("FIRST_CANARY");
      expect(output.endsWith(nextLines)).toBe(true);
      expect(traceRedactString(input).value).toBe(output);
    }
  }
});

test("YAML scanning fails closed at its UTF-16 budget", () => {
  const input = `password: |\n  ${"x".repeat(1_048_576)}BUDGET_CANARY\nsafe: visible`;
  const output = redactString(input);
  expect(output.includes("BUDGET_CANARY")).toBe(false);
  expect(output.endsWith("[REDACTED]")).toBe(true);
  expect(traceRedactString(input).value === output).toBe(true);
}, 5_000);

test("many explanatory armor markers remain bounded and visible", () => {
  const input = "The ---- BEGIN SSH2 ENCRYPTED PRIVATE KEY ---- marker is documented.\n".repeat(4_096);
  expect(redactString(input) === input).toBe(true);
  expect(traceRedactString(input).value === input).toBe(true);
}, 5_000);
