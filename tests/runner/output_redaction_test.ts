// takos-secret-scan: synthetic — these canaries are deliberately not credentials.
import { expect, test } from "bun:test";
import { redactRunnerOutput } from "../../runner/entrypoint.ts";

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
