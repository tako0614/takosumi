// Shared primitives for the Takosumi internal signed channels.
//
// Both the request RPC envelope (`internal-rpc.ts`) and the response signing
// envelope (`internal-api.ts`) are distinct protocols, but they share the same
// transport header names and the same low-level crypto helpers (HMAC-SHA256,
// hex encoding, constant-time hex compare, timestamp skew check, and header
// reading). These are security-sensitive primitives, so they live here once
// and are imported by both envelopes to keep a single source of truth and
// avoid one copy silently diverging from the other.

const textEncoder = new TextEncoder();

export const TAKOSUMI_INTERNAL_SIGNATURE_HEADER =
  "x-takosumi-internal-signature";
export const TAKOSUMI_INTERNAL_TIMESTAMP_HEADER =
  "x-takosumi-internal-timestamp";
export const TAKOSUMI_INTERNAL_REQUEST_ID_HEADER = "x-takosumi-request-id";
export const TAKOSUMI_INTERNAL_ACTOR_HEADER = "x-takosumi-actor-context";
export const TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    textEncoder.encode(message),
  );
  return toHex(signature);
}

export function readHeader(
  headers: Headers | Record<string, string>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Asserts that none of the supplied fields contain a CR or LF before they are
 * joined with `\n` into an HMAC canonical string.
 *
 * The internal canonical strings (request and response) are newline-delimited
 * with no escaping or length-prefixing, so a field value carrying a `\n` could
 * shift the field boundaries and let two distinct field tuples canonicalize to
 * the same byte string. In the current transport every signed field travels in
 * its own HTTP header (which cannot carry a raw CR/LF), so this never happens
 * in practice — but that invariant is implicit. This guard makes it explicit
 * and fail-closed: it throws at sign/verify time if any delimited field gains
 * a newline (e.g. from a future transport that moves a field to a JSON body or
 * query string), instead of silently producing an ambiguous canonical string.
 */
export function assertNoCanonicalDelimiter(
  fields: Readonly<Record<string, string>>,
): void {
  for (const [name, value] of Object.entries(fields)) {
    if (value.includes("\n") || value.includes("\r")) {
      throw new TypeError(
        `Takosumi internal canonical field "${name}" must not contain a newline`,
      );
    }
  }
}

/**
 * Constant-time equality over two hex strings. The length difference is folded
 * into the accumulator and the loop runs over the longer operand, so the
 * comparison time does not vary with where the first differing character is nor
 * with whether the lengths match.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i += 1) {
    diff |= (i < a.length ? a.charCodeAt(i) : 0) ^
      (i < b.length ? b.charCodeAt(i) : 0);
  }
  return diff === 0;
}

/**
 * Constant-time equality over two UTF-8 strings. Operands are encoded as bytes
 * so multi-byte characters in operator/internal secrets and tokens are compared
 * end-to-end. This is the single length-safe source of truth for the worker's
 * bearer / token / signature / secret checks; do not re-declare a copy that
 * short-circuits on a length mismatch (which leaks the secret length via
 * timing).
 */
export function constantTimeEqualsString(left: string, right: string): boolean {
  return constantTimeEqualsBytes(
    textEncoder.encode(left),
    textEncoder.encode(right),
  );
}

/**
 * Constant-time equality over two byte arrays. The length difference is folded
 * into the accumulator and the loop runs over the longer operand.
 */
export function constantTimeEqualsBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export function timestampWithinSkew(
  timestamp: string,
  input: {
    readonly now?: () => Date;
    readonly maxClockSkewMs?: number;
  },
): boolean {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return false;
  const maxClockSkewMs = input.maxClockSkewMs ??
    TAKOSUMI_INTERNAL_SIGNATURE_MAX_SKEW_MS;
  if (!Number.isFinite(maxClockSkewMs)) return true;
  const now = (input.now?.() ?? new Date()).getTime();
  return Math.abs(now - parsed) <= maxClockSkewMs;
}
