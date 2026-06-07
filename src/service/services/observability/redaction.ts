import type { JsonObject, JsonValue } from "takosumi-contract/reference/compat";

export const REDACTED_VALUE = "[REDACTED]";

const DEFAULT_SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?id|authorization|auth)([_-]|$)/i;

// SECURITY: the anchored DEFAULT_SECRET_KEY_PATTERN only matches snake_case /
// kebab-case / exact keys, so camelCase compound credential names slipped
// through (awsSecretAccessKey, accessKeyId, connectionString, databaseUrl, dsn,
// sessionToken, authToken, bearerToken, stripeSecretKey, …). We additionally
// match against the key with separators stripped and lowercased, so camelCase
// keys are covered. Over-matching a non-secret key is the safe failure here.
const SECRET_KEY_SUBSTRINGS =
  /(secret|token|passwd|pwd|password|passphrase|credential|apikey|accesskey|privatekey|sessionid|sessiontoken|authtoken|bearertoken|authorization|connectionstring|connstring|databaseurl|dsn)/;

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]+/g, "");
}

const BEARER_TOKEN_PATTERN =
  /\b(Bearer|Basic|Digest|Token)\s+[-._~+/=a-zA-Z0-9]+/g;
const AUTH_HEADER_PATTERN =
  /\b(Authorization\s*:\s*(?:Bearer|Basic|Digest|Token)?\s*)[^\s,;]+/gi;
// scheme://user:password@host — mask only the password segment of a DSN/URI.
const URL_CREDENTIAL_PATTERN =
  /\b([a-z][a-z0-9+.\-]*:\/\/[^:/?#\s@]+:)([^@/?#\s]+)@/gi;
const ASSIGNMENT_SECRET_PATTERN =
  /\b((?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)|(?:[A-Za-z_][A-Za-z0-9_.-]*(?:secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?token|auth[_-]?token|bearer[_-]?token|connection[_-]?string|database[_-]?url|dsn)[A-Za-z0-9_.-]*))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,&]+)/gi;

export interface RedactionOptions {
  readonly redactedValue?: string;
  readonly secretKeyPattern?: RegExp;
  readonly redactStringValues?: boolean;
}

export function isSecretKey(
  key: string,
  options: RedactionOptions = {},
): boolean {
  if (options.secretKeyPattern) return options.secretKeyPattern.test(key);
  return DEFAULT_SECRET_KEY_PATTERN.test(key) ||
    SECRET_KEY_SUBSTRINGS.test(normalizeSecretKey(key));
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
    // Mask the password in scheme://user:password@host DSNs/URIs (Postgres,
    // AMQP, Redis, SMTP, …) which OpenTofu/provider errors routinely echo.
    .replace(
      URL_CREDENTIAL_PATTERN,
      (_match, prefix: string) => `${prefix}${replacement}@`,
    )
    // Mask Authorization headers before assignment matching so the scheme word
    // (Bearer/Basic/...) is preserved and not treated as a generic value.
    .replace(
      AUTH_HEADER_PATTERN,
      (_match, prefix: string) => `${prefix}${replacement}`,
    )
    // Mask Authorization scheme tokens (Bearer / Basic / Digest / Token).
    .replace(
      BEARER_TOKEN_PATTERN,
      (_match, scheme: string) => `${scheme} ${replacement}`,
    )
    // Mask key=value / key: value / key="value" credential assignments, keeping
    // the original separator and spacing.
    .replace(
      ASSIGNMENT_SECRET_PATTERN,
      (_match, key: string, sep: string) => `${key}${sep}${replacement}`,
    );
}

function redacted(options: RedactionOptions): string {
  return options.redactedValue ?? REDACTED_VALUE;
}
