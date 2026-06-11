// SECURITY DRY: the secret regex set (SECRET_KEY_PATTERN / SECRET_KEY_SUBSTRINGS
// / BEARER_TOKEN_PATTERN / AUTH_HEADER_PATTERN / URL_CREDENTIAL_PATTERN /
// ASSIGNMENT_SECRET_PATTERN) and the redactString / isSecretKey primitives live
// in the observability redaction module, which is the canonical (superset)
// implementation. This module re-exports those primitives and only adds the
// `unknown`-typed walkers (`redactUnknown` / `redactRecord`) that handle Error
// instances, so a fix to any pattern is applied in exactly one place.
import {
  isSecretKey,
  redactString,
  REDACTED_VALUE,
} from "../services/observability/redaction.ts";

export { REDACTED_VALUE, redactString };

export function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactUnknown(item));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = isSecretKey(key) ? REDACTED_VALUE : redactUnknown(child);
    }
    return out;
  }
  return value;
}

export function redactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return redactUnknown(value) as Record<string, unknown>;
}
