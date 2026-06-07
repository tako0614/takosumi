export const REDACTED_VALUE = "[REDACTED]";

const SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?id|authorization|auth)([_-]|$)/i;
const SECRET_KEY_SUBSTRINGS =
  /(secret|token|passwd|pwd|password|passphrase|credential|apikey|accesskey|privatekey|sessionid|sessiontoken|authtoken|bearertoken|authorization|connectionstring|connstring|databaseurl|dsn)/;
const BEARER_TOKEN_PATTERN =
  /\b(Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+/g;
const AUTH_HEADER_PATTERN =
  /\b(Authorization\s*:\s*(?:Bearer|Basic|Digest|Token)?\s*)[^\s,;]+/gi;
const URL_CREDENTIAL_PATTERN =
  /\b([a-z][a-z0-9+.\-]*:\/\/[^:/?#\s@]+:)([^@/?#\s]+)@/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b((?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)|(?:[A-Za-z_][A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)[A-Za-z0-9_.-]*))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,&]+)/gi;

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

export function redactString(value: string): string {
  return value
    .replace(
      URL_CREDENTIAL_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED_VALUE}@`,
    )
    .replace(
      AUTH_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${REDACTED_VALUE}`,
    )
    .replace(
      BEARER_TOKEN_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`,
    )
    .replace(
      ASSIGNMENT_SECRET_PATTERN,
      (_match, key: string, sep: string) => `${key}${sep}${REDACTED_VALUE}`,
    );
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key) ||
    SECRET_KEY_SUBSTRINGS.test(key.toLowerCase().replace(/[_\-\s]+/g, ""));
}
