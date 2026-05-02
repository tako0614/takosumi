import type { JsonObject, JsonValue } from "takosumi-contract";

export const REDACTED_VALUE = "[REDACTED]";

const DEFAULT_SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?id|authorization|auth)([_-]|$)/i;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[-._~+/=a-zA-Z0-9]+/g;
const ASSIGNMENT_SECRET_PATTERN =
  /\b(secret|token|password|passwd|pwd|api[_-]?key|client[_-]?secret|refresh[_-]?token)=([^\s&]+)/gi;

export interface RedactionOptions {
  readonly redactedValue?: string;
  readonly secretKeyPattern?: RegExp;
  readonly redactStringValues?: boolean;
}

export function isSecretKey(
  key: string,
  options: RedactionOptions = {},
): boolean {
  return (options.secretKeyPattern ?? DEFAULT_SECRET_KEY_PATTERN).test(key);
}

export function redactJsonObject(
  value: JsonObject,
  options: RedactionOptions = {},
): JsonObject {
  return redactJsonValue(value, options) as JsonObject;
}

export function redactJsonValue(
  value: JsonValue,
  options: RedactionOptions = {},
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactJsonValue(item, options));
  }
  if (value !== null && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = isSecretKey(key, options)
        ? redacted(options)
        : redactJsonValue(child, options);
    }
    return result;
  }
  if (typeof value === "string" && options.redactStringValues !== false) {
    return redactString(value, options);
  }
  return value;
}

export function redactString(
  value: string,
  options: RedactionOptions = {},
): string {
  const replacement = redacted(options);
  return value
    .replace(BEARER_TOKEN_PATTERN, `Bearer ${replacement}`)
    .replace(
      ASSIGNMENT_SECRET_PATTERN,
      (_match, key: string) => `${key}=${replacement}`,
    );
}

function redacted(options: RedactionOptions): string {
  return options.redactedValue ?? REDACTED_VALUE;
}
