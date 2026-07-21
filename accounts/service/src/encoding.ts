export function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Constant-time string equality for the account plane's client-secret and
 * bearer checks. The implementation is the contract's single length-safe source
 * of truth (`contract/internal-crypto.ts`); this is a name-preserving
 * re-export, not a copy. A hand-rolled copy here is exactly the shape that
 * drifted before — some copies short-circuited on a length mismatch and leaked
 * the secret's length through timing.
 */
export { constantTimeEqualsString as constantTimeEqual } from "takosumi-contract/internal/crypto";

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return `sha256:${base64UrlEncodeBytes(new Uint8Array(digest))}`;
}
