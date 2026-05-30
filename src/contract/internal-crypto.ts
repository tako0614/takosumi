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

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
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
