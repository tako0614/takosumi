import {
  isSecretKey,
  REDACTED_VALUE,
  redactString,
} from "takosumi-contract/redaction";

export function redactPublicValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactPublicValue(entry));
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      output[key] = isSecretKey(key) ? REDACTED_VALUE : redactPublicValue(child);
    }
    return output;
  }
  return value;
}

export function redactPublicRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return redactPublicValue(value) as Record<string, unknown>;
}

export function redactPublicString(value: string): string {
  return redactString(value);
}
