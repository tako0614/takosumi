import type { JsonObject, JsonValue } from "./types.ts";

export const REDACTED_VALUE = "[REDACTED]";

const DEFAULT_SECRET_KEY_PATTERN =
  /(^|[_-])(secret|token|password|passwd|pwd|credential|credentials|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|session[_-]?id|authorization|auth)([_-]|$)/i;

// SECURITY: the anchored DEFAULT_SECRET_KEY_PATTERN only matches snake_case /
// kebab-case / exact keys, so camelCase compound credential names slipped
// through (awsSecretAccessKey, accessKeyId, connectionString, databaseUrl, dsn,
// sessionToken, authToken, bearerToken, paymentProviderSecret, …). We additionally
// match against the key with separators stripped and lowercased, so camelCase
// keys are covered. Over-matching a non-secret key is the safe failure here.
const SECRET_KEY_SUBSTRINGS =
  /(secret|token|passwd|pwd|password|passphrase|credential|apikey|accesskey|privatekey|sessionid|sessiontoken|authtoken|bearertoken|authorization|connectionstring|connstring|databaseurl|dsn)/;

function normalizeSecretKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]+/g, "");
}

// HTTP authentication scheme names are case-insensitive (RFC 9110 section 11.1).
// This pattern handles token-like fragments, not parameterized Digest fields.
// Keep the historical Token marker separate: matching ordinary lowercase
// "token value" would reject the public prose accepted by manifest admission.
const HTTP_AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic|Digest)\s+[-._~+/=a-zA-Z0-9]+/gi;
const TOKEN_SCHEME_PATTERN = /\b(Token)\s+[-._~+/=a-zA-Z0-9]+/g;
// Digest credentials are a comma-separated parameter list. Mask the whole
// logical field before atom-based patterns can leave later parameters behind.
// A bare Digest fragment is admitted only when a named parameter starts
// immediately after the scheme.
// An explicit Authorization field makes the entire logical field value a
// credential, regardless of the authentication scheme or parameter names.
const AUTHORIZATION_FIELD_PATTERN =
  /\b(Authorization[ \t]*:[ \t]*)(?=[^\r\n]|\r?\n[ \t]+)/gi;
// RFC 9110 auth-param names use full HTTP token syntax; RFC 7616 includes
// username*. A named parameter is an unambiguous credential fragment even
// when the first token character is punctuation.
const DIGEST_PARAMETERS_PATTERN =
  /\b(Digest[ \t]+)(?=[!#$%&'*+.^_`|~A-Za-z0-9-]+[ \t]*=)/gi;
const DIGEST_KNOWN_PARAMETER_NAMES = new Set([
  "username", "username*", "realm", "uri", "nonce", "response", "cnonce",
  "opaque", "algorithm", "qop", "nc", "userhash",
]);
const MAX_CREDENTIAL_FIELD_CODE_UNITS = 1_048_576;
const ASSIGNMENT_SEPARATOR_PATTERN = /[=:]/g;
// Quoted JSON keys are scanned once from the opening quote. JSON.parse decodes
// valid \u escapes before applying the same secret-key policy as object values.
// JavaScript string indexing uses UTF-16 code units, not UTF-8 bytes.
const MAX_STRUCTURED_SECRET_CODE_UNITS = 1_048_576;
const SECRET_VALUE_PATTERNS = [
  /\b(?:postgres(?:ql)?|mysql|mariadb|redis|mongo|mongodb|libsql):\/\//i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[opsru]_[A-Za-z0-9_]{8,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
] as const;
const SECRET_VALUE_REPLACEMENTS = SECRET_VALUE_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags}g`),
);

export interface RedactionOptions {
  readonly redactedValue?: string;
  readonly secretKeyPattern?: RegExp;
  readonly redactStringValues?: boolean;
}

export interface OriginalRedactionSpan {
  readonly start: number;
  readonly end: number;
}

export interface RedactionEdit extends OriginalRedactionSpan {
  readonly replacement: string;
  readonly maskStart?: number;
  readonly maskEnd?: number;
}

// Only the Runner exact-value path allocates this map. Each surviving UTF-16
// code unit retains its original index; replacement text has no source index.
// This lets later structural passes report original spans even after an earlier
// pass has changed the string, without guessing alignment from repeated text.
export class OriginalSpanTrace {
  value: string;
  readonly spans: OriginalRedactionSpan[] = [];
  failed = false;
  private indices: Int32Array;
  private readonly originalLength: number;

  constructor(value: string) {
    this.value = value;
    this.originalLength = value.length;
    this.indices = new Int32Array(value.length);
    for (let index = 0; index < value.length; index += 1) this.indices[index] = index;
  }

  apply(next: string, edits: readonly RedactionEdit[]): void {
    if (this.failed) return;
    if (edits.length === 0) {
      if (next !== this.value) this.failClosed();
      return;
    }
    let expectedLength = this.value.length;
    let previousEnd = 0;
    for (const edit of edits) {
      if (edit.start < previousEnd || edit.end < edit.start ||
        edit.end > this.value.length ||
        (edit.maskStart !== undefined &&
          (edit.maskStart < edit.start || edit.maskStart > edit.end)) ||
        (edit.maskEnd !== undefined &&
          (edit.maskEnd < (edit.maskStart ?? edit.start) ||
            edit.maskEnd > edit.end))) {
        this.failClosed();
        return;
      }
      expectedLength += edit.replacement.length - (edit.end - edit.start);
      previousEnd = edit.end;
    }
    if (expectedLength !== next.length) {
      this.failClosed();
      return;
    }
    const nextIndices = new Int32Array(next.length);
    const chunks: string[] = [];
    let source = 0;
    let target = 0;
    for (const edit of edits) {
      chunks.push(this.value.slice(source, edit.start), edit.replacement);
      nextIndices.set(this.indices.subarray(source, edit.start), target);
      target += edit.start - source;
      nextIndices.fill(-1, target, target + edit.replacement.length);
      target += edit.replacement.length;
      this.record(edit.maskStart ?? edit.start, edit.maskEnd ?? edit.end);
      source = edit.end;
    }
    chunks.push(this.value.slice(source));
    nextIndices.set(this.indices.subarray(source), target);
    if (chunks.join("") !== next) {
      this.failClosed();
      return;
    }
    this.value = next;
    this.indices = nextIndices;
  }

  private record(start: number, end: number): void {
    let runStart = -1;
    let previous = -1;
    for (let index = start; index < end; index += 1) {
      const original = this.indices[index];
      if (original < 0) continue;
      if (runStart >= 0 && original !== previous + 1) {
        this.spans.push({ start: runStart, end: previous + 1 });
        runStart = -1;
      }
      if (runStart < 0) runStart = original;
      previous = original;
    }
    if (runStart >= 0) this.spans.push({ start: runStart, end: previous + 1 });
  }

  private failClosed(): void {
    this.failed = true;
    this.spans.length = 0;
    this.spans.push({ start: 0, end: this.originalLength });
  }
}

export function isSecretKey(
  key: string,
  options: RedactionOptions = {},
): boolean {
  if (options.secretKeyPattern) return options.secretKeyPattern.test(key);
  return DEFAULT_SECRET_KEY_PATTERN.test(key) ||
    SECRET_KEY_SUBSTRINGS.test(normalizeSecretKey(key));
}

export function containsSecretLikeString(value: string): boolean {
  return (
    SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value)) ||
    redactString(value) !== value
  );
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
  let redactedValue = redactUrlCredentials(redactCredentialFields(
    redactCredentialFields(
      redactSecretAssignments(
        redactPrivateKeyBlocks(value, replacement),
        replacement,
        true,
      ),
      AUTHORIZATION_FIELD_PATTERN,
      replacement,
    ),
    DIGEST_PARAMETERS_PATTERN,
    replacement,
  ), replacement)
    // Mask scheme-prefixed token-like fragments without depending on casing.
    .replace(
      HTTP_AUTH_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${replacement}`,
    )
    // Preserve the existing capitalized Token marker and lowercase prose boundary.
    .replace(
      TOKEN_SCHEME_PATTERN,
      (_match, scheme: string) => `${scheme} ${replacement}`,
    );
  // Scalar assignments run after scheme masking so e.g. password=Bearer value
  // cannot leave the second atom visible. The structured/quoted pass above
  // runs first to keep the entire nested span away from later pattern passes.
  redactedValue = redactSecretAssignments(redactedValue, replacement, false);
  for (const pattern of SECRET_VALUE_REPLACEMENTS) {
    redactedValue = redactedValue.replace(pattern, replacement);
  }
  return redactedValue;
}

/** Structural replacement spans in the original input, for combining with
 * Runner's literal credential matches. The ordinary redactString path remains
 * allocation-free with respect to the source-index map. */
export function traceRedactString(
  value: string,
  options: RedactionOptions = {},
): OriginalSpanTrace {
  const replacement = redacted(options);
  const trace = new OriginalSpanTrace(value);
  const step = (transform: (text: string, edits: RedactionEdit[]) => string) => {
    if (trace.failed) return;
    const edits: RedactionEdit[] = [];
    trace.apply(transform(trace.value, edits), edits);
  };
  step((text, edits) => redactPrivateKeyBlocks(text, replacement, edits));
  step((text, edits) => redactQuotedSecretAssignments(text, replacement, true, edits));
  step((text, edits) => redactUnquotedSecretAssignments(text, replacement, true, edits));
  step((text, edits) =>
    redactCredentialFields(text, AUTHORIZATION_FIELD_PATTERN, replacement, edits));
  step((text, edits) =>
    redactCredentialFields(text, DIGEST_PARAMETERS_PATTERN, replacement, edits));
  step((text, edits) => redactUrlCredentials(text, replacement, edits));
  for (const pattern of [HTTP_AUTH_SCHEME_PATTERN, TOKEN_SCHEME_PATTERN]) {
    step((text, edits) => {
      pattern.lastIndex = 0;
      return text.replace(pattern, (match: string, scheme: string, offset: number) => {
        const start = offset + scheme.length;
        let maskStart = start;
        while (maskStart < offset + match.length && isWhitespace(text[maskStart])) {
          maskStart += 1;
        }
        edits.push({
          start,
          end: offset + match.length,
          replacement: ` ${replacement}`,
          maskStart,
        });
        return `${scheme} ${replacement}`;
      });
    });
  }
  step((text, edits) => redactQuotedSecretAssignments(text, replacement, false, edits));
  step((text, edits) => redactUnquotedSecretAssignments(text, replacement, false, edits));
  for (const pattern of SECRET_VALUE_REPLACEMENTS) {
    step((text, edits) => {
      pattern.lastIndex = 0;
      return text.replace(pattern, (match: string, offset: number) => {
        edits.push({ start: offset, end: offset + match.length, replacement });
        return replacement;
      });
    });
  }
  return trace;
}

// scheme://user:password@host — walk from the fixed :// delimiter rather than
// asking a regex to retry a long dotted scheme at every word boundary.
function redactUrlCredentials(
  value: string,
  replacement: string,
  edits?: RedactionEdit[],
): string {
  const chunks: string[] = [];
  let cursor = 0;
  let search = 0;
  while (search < value.length) {
    const delimiter = value.indexOf("://", search);
    if (delimiter < 0) break;
    search = delimiter + 3;
    let segmentStart = delimiter;
    while (segmentStart > cursor && isSchemeChar(value[segmentStart - 1])) {
      segmentStart -= 1;
    }
    // The old word-boundary regex could begin after a dot/plus/hyphen even if
    // an earlier letter in this run was preceded by a word character.
    let schemeStart = segmentStart;
    while (schemeStart < delimiter &&
      (!isAsciiLetter(value.charCodeAt(schemeStart)) ||
        (schemeStart > 0 && isWordChar(value[schemeStart - 1])))) {
      schemeStart += 1;
    }
    if (schemeStart === delimiter) continue;
    let index = delimiter + 3;
    const userStart = index;
    while (index < value.length && isUriUserChar(value[index])) index += 1;
    if (index === userStart || value[index] !== ":") continue;
    index += 1;
    const passwordStart = index;
    while (index < value.length && isUriPasswordChar(value[index])) index += 1;
    if (index === passwordStart || value[index] !== "@") continue;
    chunks.push(value.slice(cursor, passwordStart), replacement);
    edits?.push({ start: passwordStart, end: index, replacement });
    cursor = index;
    search = index + 1;
  }
  if (cursor === 0) return value;
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function isSchemeChar(character: string | undefined): boolean {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return isAsciiLetter(code) || (code >= 48 && code <= 57) ||
    character === "+" || character === "." || character === "-";
}

function isWordChar(character: string): boolean {
  const code = character.charCodeAt(0);
  return isAsciiLetter(code) || (code >= 48 && code <= 57) || character === "_";
}

function isUriUserChar(character: string | undefined): boolean {
  return character !== undefined && character !== ":" && character !== "/" &&
    character !== "?" && character !== "#" && character !== "@" &&
    !isWhitespace(character);
}

function isUriPasswordChar(character: string | undefined): boolean {
  return character !== undefined && character !== "/" && character !== "?" &&
    character !== "#" && character !== "@" && !isWhitespace(character);
}

function redactCredentialFields(
  value: string,
  pattern: RegExp,
  replacement: string,
  edits?: RedactionEdit[],
): string {
  pattern.lastIndex = 0;
  const chunks: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index < cursor) continue;
    const prefix = match[1];
    const start = match.index + match[0].length;
    const end = credentialFieldEnd(value, start);
    edits?.push({
      start,
      end,
      replacement: /[ \t]$/u.test(prefix) ? replacement : ` ${replacement}`,
    });
    chunks.push(
      value.slice(cursor, match.index),
      /[ \t]$/u.test(prefix) ? prefix : `${prefix} `,
      replacement,
    );
    cursor = end;
  }
  if (cursor === 0) return value;
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function credentialFieldEnd(value: string, start: number): number {
  const limit = Math.min(value.length, start + MAX_CREDENTIAL_FIELD_CODE_UNITS);
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let lastOutside: string | null = null;
  for (let index = start; index < limit; index += 1) {
    const character = value[index];
    if (character === "\n") {
      const boundary = value[index - 1] === "\r" ? index - 1 : index;
      const next = index + 1;
      if (next >= value.length || isClearHeaderLine(value, next)) return boundary;
      const folded = value[next] === " " || value[next] === "\t";
      const knownParameter = DIGEST_KNOWN_PARAMETER_NAMES.has(
        digestLineFirstToken(value, next),
      );
      if (!folded && quote === null && lastOutside !== "," && !knownParameter) {
        return boundary;
      }
      lastOutside = null;
      continue;
    }
    if (character === "\r" && value[index + 1] === "\n") continue;
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          if (index + 1 >= limit) return value.length;
          index += 1;
        } else {
          quote = null;
          lastOutside = character;
        }
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      lastOutside = character;
    } else if (character !== " " && character !== "\t") {
      lastOutside = character;
    }
  }
  // If the logical field exceeds the scan ceiling, no safe boundary is known.
  return value.length;
}

function isClearHeaderLine(value: string, start: number): boolean {
  const first = value.charCodeAt(start);
  if (!isAsciiLetter(first)) return false;
  let index = start + 1;
  while (index < value.length && index - start <= 128) {
    const code = value.charCodeAt(index);
    if (isAsciiLetter(code) || (code >= 48 && code <= 57) || code === 45) {
      index += 1;
    } else break;
  }
  return value[index] === ":";
}

function digestLineFirstToken(value: string, start: number): string {
  let index = start;
  while (index < value.length && index - start < 64 &&
    /[!#$%&'*+.^_`|~A-Za-z0-9-]/u.test(value[index])) index += 1;
  return value.slice(start, index).toLowerCase();
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function redactPrivateKeyBlocks(
  value: string,
  replacement: string,
  edits?: RedactionEdit[],
): string {
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const begin = value.indexOf("-----BEGIN ", cursor);
    if (begin < 0) break;
    // Bounded window avoids repeated scans to EOF for malformed BEGIN text.
    const delimiterOffset = value.slice(begin + 11, begin + 81).indexOf("-----");
    if (delimiterOffset < 0) {
      chunks.push(value.slice(cursor, begin + 11));
      cursor = begin + 11;
      continue;
    }
    const headerEnd = begin + 11 + delimiterOffset + 5;
    const header = value.slice(begin, headerEnd);
    if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----$/u.test(header)) {
      chunks.push(value.slice(cursor, begin + 1));
      cursor = begin + 1;
      continue;
    }
    const endHeader = header.replace("BEGIN", "END");
    const endStart = value.indexOf(endHeader, headerEnd);
    chunks.push(value.slice(cursor, begin), replacement);
    const end = endStart < 0 ? value.length : endStart + endHeader.length;
    edits?.push({ start: begin, end, replacement });
    cursor = end;
  }
  if (cursor === 0) return value;
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function redactSecretAssignments(
  value: string,
  replacement: string,
  structuredOnly: boolean,
): string {
  return redactUnquotedSecretAssignments(
    redactQuotedSecretAssignments(value, replacement, structuredOnly),
    replacement,
    structuredOnly,
  );
}

function redactQuotedSecretAssignments(
  value: string,
  replacement: string,
  structuredOnly: boolean,
  edits?: RedactionEdit[],
): string {
  const chunks: string[] = [];
  let cursor = 0;
  let index = 0;
  while (index < value.length) {
    const keyStart = value.indexOf('"', index);
    if (keyStart < 0) break;
    const keyEnd = doubleQuotedEnd(value, keyStart);
    if (keyEnd < 0) break;
    index = keyEnd;
    let separator = keyEnd;
    while (separator < value.length && isWhitespace(value[separator])) separator += 1;
    if (value[separator] !== ":" && value[separator] !== "=") continue;
    const rawKey = value.slice(keyStart, keyEnd);
    let key: string;
    try {
      key = JSON.parse(rawKey) as string;
    } catch {
      key = rawKey.slice(1, -1);
    }
    if (!isSecretKey(key)) continue;
    const start = separator + 1;
    let valueStart = start;
    while (valueStart < value.length && isWhitespace(value[valueStart])) {
      valueStart += 1;
    }
    if (valueStart >= value.length) continue;
    const opening = value[valueStart];
    if (isStructuredOpening(opening) !== structuredOnly) continue;
    const end = secretAssignmentValueEnd(value, valueStart);
    chunks.push(value.slice(cursor, valueStart), replacement);
    edits?.push({ start: valueStart, end, replacement });
    cursor = end;
    index = end;
  }
  if (cursor === 0) return value;
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function doubleQuotedEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) escaped = false;
    else if (character === "\\") escaped = true;
    else if (character === '"') return index + 1;
  }
  return -1;
}

function redactUnquotedSecretAssignments(
  value: string,
  replacement: string,
  structuredOnly: boolean,
  edits?: RedactionEdit[],
): string {
  ASSIGNMENT_SEPARATOR_PATTERN.lastIndex = 0;
  const chunks: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(ASSIGNMENT_SEPARATOR_PATTERN)) {
    const separator = match.index;
    if (separator < cursor) continue;
    let keyEnd = separator;
    while (keyEnd > cursor && isWhitespace(value[keyEnd - 1])) keyEnd -= 1;
    let keyStart = keyEnd;
    while (keyStart > cursor && isAssignmentKeyChar(value[keyStart - 1])) {
      keyStart -= 1;
    }
    if (keyStart === keyEnd) continue;
    const key = value.slice(keyStart, keyEnd);
    if (!isSecretKey(key)) continue;
    // The existing Authorization header matcher owns colon-delimited fields;
    // auth= and authorization= are persisted assignments and must be masked.
    const normalized = normalizeSecretKey(key);
    if (!structuredOnly && normalized === "authorization" && value[separator] === ":") {
      continue;
    }
    let start = separator + 1;
    while (start < value.length && isWhitespace(value[start])) start += 1;
    if (start >= value.length || isStructuredOpening(value[start]) !== structuredOnly) {
      continue;
    }
    const end = !structuredOnly &&
        (normalized === "auth" || normalized === "authorization")
      // A persisted auth value is a credential field even when its scheme is
      // unknown; same-line atoms and parameters are part of that field.
      ? credentialFieldEnd(value, start)
      : secretAssignmentValueEnd(value, start);
    chunks.push(value.slice(cursor, start), replacement);
    edits?.push({ start, end, replacement });
    cursor = end;
  }
  if (cursor === 0) return value;
  chunks.push(value.slice(cursor));
  return chunks.join("");
}

function secretAssignmentValueEnd(value: string, start: number): number {
  if (isStructuredOpening(value[start])) {
    const end = structuredValueEnd(value, start);
    if (end === value.length || isSafeValueBoundary(value[end])) return end;
    return value.length;
  }
  let index = start;
  let ambiguousQuote = false;
  while (index < value.length && !isWhitespace(value[index]) &&
    value[index] !== "," && value[index] !== "&") {
    if (value[index] === '"' || value[index] === "'") ambiguousQuote = true;
    index += 1;
  }
  return ambiguousQuote ? value.length : index;
}

function isStructuredOpening(character: string | undefined): boolean {
  return character === '"' || character === "'" || character === "{" || character === "[";
}

function isSafeValueBoundary(character: string | undefined): boolean {
  return character === undefined || isWhitespace(character) ||
    character === "," || character === "&" || character === ";" ||
    character === "}" || character === "]" || character === ")";
}

function isAssignmentKeyChar(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_.-]/u.test(character);
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character);
}

function structuredValueEnd(value: string, start: number): number {
  const opening = value[start];
  const limit = Math.min(value.length, start + MAX_STRUCTURED_SECRET_CODE_UNITS);
  if (opening === '"' || opening === "'") {
    let escaped = false;
    for (let index = start + 1; index < limit; index += 1) {
      const character = value[index];
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === opening) {
        if (opening === "'" && value[index + 1] === "'") {
          if (index + 1 >= limit) return value.length;
          index += 1;
        } else return index + 1;
      }
    }
    return value.length;
  }
  if (opening !== "{" && opening !== "[") return start;

  const expectedClosers = [opening === "{" ? "}" : "]"];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start + 1; index < limit; index += 1) {
    const character = value[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) {
        if (quote === "'" && value[index + 1] === "'") {
          if (index + 1 >= limit) return value.length;
          index += 1;
        } else quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "{" || character === "[") {
      expectedClosers.push(character === "{" ? "}" : "]");
    } else if (character === "}" || character === "]") {
      if (expectedClosers.pop() !== character) return value.length;
      if (expectedClosers.length === 0) return index + 1;
    }
  }
  // Malformed nesting, unclosed quotes/structures, and budget exhaustion all
  // fail closed through EOF rather than guessing where a safe suffix begins.
  return value.length;
}

function redacted(options: RedactionOptions): string {
  return options.redactedValue ?? REDACTED_VALUE;
}
