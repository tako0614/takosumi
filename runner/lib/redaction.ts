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
  redactString,
  traceRedactString,
  type OriginalSpanTrace,
  type OriginalRedactionSpan,
  type RedactionEdit,
} from "../../contract/redaction.ts";
import {
  RUNNER_REDACTED_VALUE,
  RUNNER_TF_VAR_ASSIGNMENT_PATTERN,
} from "./constants.ts";
export function redactRunnerOutput(
  text: string,
  exactValues: readonly string[] = [],
): string {
  const knownValues = normalizedRedactionValues(exactValues);
  if (knownValues.length > 0) {
    return redactRunnerOriginalSpans(text, knownValues);
  }
  // Preserve field names until structural redaction has consumed their values.
  // An exact credential can itself equal a key such as "password".
  let redacted = redactString(text, { redactedValue: RUNNER_REDACTED_VALUE })
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

function redactRunnerOriginalSpans(text: string, knownValues: readonly string[]): string {
  const trace = traceRedactString(text, { redactedValue: RUNNER_REDACTED_VALUE });
  applyRunnerAssignmentPattern(trace, RUNNER_TF_VAR_ASSIGNMENT_PATTERN);
  for (const name of ["GIT_HTTPS_TOKEN", "GIT_SSH_PRIVATE_KEY"]) {
    const pattern = new RegExp(
      `\\b(${escapeRegExp(name)}\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,&;]+)`,
      "g",
    );
    applyRunnerAssignmentPattern(trace, pattern);
  }
  const spans: OriginalRedactionSpan[] = [...trace.spans];
  for (const value of knownValues) appendExactMatchSpans(text, value, spans);
  if (spans.length === 0) return text;
  spans.sort((left, right) => left.start - right.start || left.end - right.end);
  const chunks: string[] = [];
  let cursor = 0;
  let start = spans[0].start;
  let end = spans[0].end;
  for (let index = 1; index < spans.length; index += 1) {
    const span = spans[index];
    if (span.start <= end) {
      end = Math.max(end, span.end);
    } else {
      chunks.push(text.slice(cursor, start), RUNNER_REDACTED_VALUE);
      cursor = end;
      start = span.start;
      end = span.end;
    }
  }
  chunks.push(text.slice(cursor, start), RUNNER_REDACTED_VALUE, text.slice(end));
  return chunks.join("");
}

function applyRunnerAssignmentPattern(trace: OriginalSpanTrace, pattern: RegExp): void {
  if (trace.failed) return;
  pattern.lastIndex = 0;
  const edits: RedactionEdit[] = [];
  const next = trace.value.replace(
    pattern,
    (match: string, prefix: string, _credential: string, offset: number) => {
      edits.push({
        start: offset + prefix.length,
        end: offset + match.length,
        replacement: RUNNER_REDACTED_VALUE,
      });
      return `${prefix}${RUNNER_REDACTED_VALUE}`;
    },
  );
  trace.apply(next, edits);
}

// KMP finds overlapping original occurrences in O(text + value) time per
// known value, including cases where a structural pass would split the value.
function appendExactMatchSpans(
  text: string,
  value: string,
  spans: OriginalRedactionSpan[],
): void {
  const prefix = new Uint32Array(value.length);
  for (let index = 1, matched = 0; index < value.length; index += 1) {
    while (matched > 0 && value[index] !== value[matched]) {
      matched = prefix[matched - 1];
    }
    if (value[index] === value[matched]) matched += 1;
    prefix[index] = matched;
  }
  let runStart = -1;
  let runEnd = -1;
  for (let index = 0, matched = 0; index < text.length; index += 1) {
    while (matched > 0 && text[index] !== value[matched]) {
      matched = prefix[matched - 1];
    }
    if (text[index] === value[matched]) matched += 1;
    if (matched === value.length) {
      const start = index + 1 - matched;
      const end = index + 1;
      if (runStart >= 0 && start > runEnd) {
        spans.push({ start: runStart, end: runEnd });
        runStart = -1;
      }
      if (runStart < 0) runStart = start;
      runEnd = end;
      matched = prefix[matched - 1];
    }
  }
  if (runStart >= 0) spans.push({ start: runStart, end: runEnd });
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

/**
 * Redaction floor. A shorter literal is too collision-prone to blanket-replace
 * in command output, so it is never redacted — which is why every lane that
 * mints a value the runner must be able to redact rejects anything shorter.
 */
export const RUNNER_REDACTION_MIN_VALUE_LENGTH = 8;

export function normalizedRedactionValues(values: readonly string[]): string[] {
  return [
    ...new Set(
      values.filter(
        (value) => value.length >= RUNNER_REDACTION_MIN_VALUE_LENGTH,
      ),
    ),
  ].sort((left, right) => right.length - left.length);
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
