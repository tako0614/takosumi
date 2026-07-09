import { redactString } from "takosumi-contract/redaction";

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
  return parts.join(" <- caused by: ");
}

export function consoleErrorRedacted(event: string, error: unknown): void {
  console.error(event, redactedErrorText(error));
}
