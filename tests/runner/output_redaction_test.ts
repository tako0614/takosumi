// takos-secret-scan: synthetic — these canaries are deliberately not credentials.
import { expect, test } from "bun:test";
import { redactRunnerOutput } from "../../runner/entrypoint.ts";

test.each([
  ["contains an auth fragment", "Bearer abcdefgh!CANARY", "error: Bearer abcdefgh!CANARY", "error: [redacted]"],
  ["follows an auth scheme", "abcdefgh!CANARY", "error: Bearer abcdefgh!CANARY", "error: Bearer [redacted]"],
  ["contains an assignment", "password=alpha late-CANARY", "error: password=alpha late-CANARY", "error: [redacted]"],
  ["contains a variable assignment", 'TF_VAR_label="known-fragment" late-CANARY', 'error: TF_VAR_label="known-fragment" late-CANARY', "error: [redacted]"],
])("Runner exact value %s retains its original complete span", (_name, value, input, expected) => {
  expect(redactRunnerOutput(input, [value])).toBe(expected);
});

test("Runner exact values may overlap without exposing an auth suffix", () => {
  expect(redactRunnerOutput("error: Bearer prefixsuffix!CANARY", [
    "prefixsuffix!CANARY", "suffix!CANARY",
  ])).toBe("error: Bearer [redacted]");
});

test("Runner exact values preserve UTF-16 offsets and repeated matches", () => {
  const value = "A🔑Bearer abcdefgh!UNICODE_CANARY";
  expect(redactRunnerOutput(`prefix 🔍 ${value} repeated ${value} safe=retained`, [value]))
    .toBe("prefix 🔍 [redacted] repeated [redacted] safe=retained");
});

test("Runner exact values may span a logical field boundary", () => {
  const value = "Bearer first\r\nX-Safe: boundary-CANARY";
  expect(redactRunnerOutput(`error: ${value}\r\nSafe: retained`, [value]))
    .toBe("error: [redacted]\r\nSafe: retained");
});

test("Runner literal replacement text is preserved outside exact spans", () => {
  const value = "Bearer abcdefgh!CANARY";
  expect(redactRunnerOutput(`keep [redacted] visible; ${value} safe=retained`, [value]))
    .toBe("keep [redacted] visible; [redacted] safe=retained");
});

test("Runner specialized rules do not reinterpret an already masked credential body", () => {
  const input = `credentials={"nested":"TF_VAR_label='unterminated"} safe='visible'`;
  expect(redactRunnerOutput(input, ["unrelated-known-value"]))
    .toBe("credentials=[redacted] safe='visible'");
});

test("Runner original span mapping preserves large safe prefixes", () => {
  const prefix = "x".repeat(262_144);
  const output = redactRunnerOutput(`${prefix} Bearer abcdefgh!CANARY`, ["abcdefgh!CANARY"]);
  expect(output.length).toBe(prefix.length + " Bearer [redacted]".length);
  expect(output.startsWith(prefix)).toBe(true);
  expect(output.endsWith(" Bearer [redacted]")).toBe(true);
});

test("Runner exact values spanning a JSON key delimiter retain structural masking", () => {
  const output = redactRunnerOutput(
    '{"prefixpassword":"credential-canary","safe":"retained"}',
    ['prefixpassword":'],
  );
  expect(output).not.toContain("prefixpassword");
  expect(output).not.toContain("credential-canary");
  expect(output).toContain("retained");
});

test("Runner output masks complete canonical credential spans", () => {
  for (const input of [
    'Digest username="one", nonce="nonce-canary", response="response-canary"',
    'Authorization: Signature keyId="one", signature="signature-canary"',
    'auth=Negotiate negotiate-canary',
    'credentials={"nested":["json-canary",{"value":"other-canary"}]}',
    '-----BEGIN PRIVATE KEY-----\npem-canary\n-----END PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----\ntruncated-pem-canary',
  ]) {
    const output = redactRunnerOutput(input);
    expect(output).toContain("[redacted]");
    expect(output).not.toContain("canary");
    expect(redactRunnerOutput(output)).toBe(output);
  }
});

test("Runner structural masking precedes exact values that equal field names", () => {
  const output = redactRunnerOutput(
    'password=assignment-canary TF_VAR_label="variable-canary" GIT_HTTPS_TOKEN=git-canary',
    ["password", "TF_VAR_label", "GIT_HTTPS_TOKEN"],
  );
  expect(output).not.toContain("canary");
  expect(output).toContain("[redacted]");
});

test("Runner keeps its variable, Git and exact-value masking", () => {
  expect(redactRunnerOutput(
    'TF_VAR_label="private variable" GIT_SSH_PRIVATE_KEY=private-git bare-value-canary short-7',
    ["bare-value-canary", "short-7"],
  )).toBe(
    "TF_VAR_label=[redacted] GIT_SSH_PRIVATE_KEY=[redacted] [redacted] short-7",
  );
  expect(redactRunnerOutput("secret=assignment-canary;safe=true")).toBe(
    "secret=[redacted]",
  );
});

test("Runner retains lowercase token prose and URL password boundaries", () => {
  const prose = "Use a token value supplied by the operator.";
  expect(redactRunnerOutput(prose)).toBe(prose);
  expect(redactRunnerOutput(
    "fetch 1a.b://user:url-canary@host.invalid/path and https://host.invalid/public",
  )).toBe(
    "fetch 1a.b://user:[redacted]@host.invalid/path and https://host.invalid/public",
  );
});
