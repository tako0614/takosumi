import { redactString } from "../../../core/domains/observability/redaction.ts";

export function redactedErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${redactString(error.message)}`;
  }
  return redactString(String(error));
}

export function consoleErrorRedacted(event: string, error: unknown): void {
  console.error(event, redactedErrorText(error));
}
