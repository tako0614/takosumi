// runner/lib/redaction.ts
//
// Secret-redaction families for runner output / diagnostics.
//
// Pure code-motion out of runner/entrypoint.ts (P3 god-file split). No
// behavior change; see runner/entrypoint.ts for the re-exported public surface.
import type {
  CommandContext,
} from "./types.ts";
import {
  RUNNER_REDACTED_VALUE,
  RUNNER_AUTH_HEADER_PATTERN,
  RUNNER_AUTH_SCHEME_PATTERN,
  RUNNER_URL_CREDENTIAL_PATTERN,
  RUNNER_SECRET_ASSIGNMENT_PATTERN,
  RUNNER_TF_VAR_ASSIGNMENT_PATTERN,
} from "./constants.ts";
export function redactRunnerOutput(
  text: string,
  exactValues: readonly string[] = [],
): string {
  let redacted = redactExactCredentialValues(text, exactValues)
    .replace(
      RUNNER_URL_CREDENTIAL_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}@`,
    )
    .replace(
      RUNNER_AUTH_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_AUTH_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_SECRET_ASSIGNMENT_PATTERN,
      (_match, key: string, _bareKey: string, sep: string) =>
        `${key}${sep}${RUNNER_REDACTED_VALUE}`,
    )
    .replace(
      RUNNER_TF_VAR_ASSIGNMENT_PATTERN,
      (_match, prefix: string) => `${prefix}${RUNNER_REDACTED_VALUE}`,
    );
  for (const name of [
    "GIT_HTTPS_TOKEN",
    "GIT_SSH_PRIVATE_KEY",
  ]) {
    redacted = redacted.replaceAll(
      new RegExp(
        `\\b(${escapeRegExp(name)}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,&;]+)`,
        "g",
      ),
      `$1${RUNNER_REDACTED_VALUE}`,
    );
  }
  return redactExactCredentialValues(redacted, exactValues);
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactExactCredentialValues(
  text: string,
  values: readonly string[],
): string {
  let redacted = text;
  for (const value of normalizedRedactionValues(values)) {
    redacted = redacted.replaceAll(value, RUNNER_REDACTED_VALUE);
  }
  return redacted;
}

export function normalizedRedactionValues(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length >= 8))].sort(
    (left, right) => right.length - left.length,
  );
}
export function redactBuildOutput(text: string): string {
  // Build commands run credential-free, but redact any value that LOOKS like a
  // known credential env assignment as defense-in-depth before it reaches the
  // run record / diagnostics.
  return redactRunnerOutput(text);
}


// Redact any minted git credential env value that might appear in command
// output. Git never receives the secret in the URL, but ls-remote/fetch errors
// can echo the URL or env; this strips known credential env assignments and the
// literal token value if it is known.
export function redactCredentialOutput(text: string, context: CommandContext): string {
  return redactRunnerOutput(text, context.redactionValues);
}
