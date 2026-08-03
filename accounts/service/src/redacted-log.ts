import { redactString } from "takosumi-contract/redaction";

const CONTROL_CHARACTER_ESCAPES: Record<string, string> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Escape control characters so untrusted text that reached an error message
 * cannot forge records in a line-oriented log sink. Error messages routinely
 * carry client-supplied bytes (e.g. a WebAuthn attestation `fmt`), and a bare
 * CR/LF would otherwise end the record and start an attacker-authored one.
 */
function escapeControlCharacters(text: string): string {
  return text.replace(
    /\p{Cc}/gu,
    (character) =>
      CONTROL_CHARACTER_ESCAPES[character] ??
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function redactedErrorText(error: unknown): string {
  // Walk the cause chain: driver errors (e.g. Postgres) put the actionable
  // message on `.cause`, and a top-level "Failed query" alone is undiagnosable.
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 4) {
    parts.push(
      current instanceof Error
        ? `${current.name}: ${redactString(current.message)}`
        : redactString(String(current)),
    );
    current = current instanceof Error ? current.cause : undefined;
    depth += 1;
  }
  return escapeControlCharacters(parts.join(" <- caused by: "));
}

export function consoleErrorRedacted(event: string, error: unknown): void {
  console.error(event, redactedErrorText(error));
}
