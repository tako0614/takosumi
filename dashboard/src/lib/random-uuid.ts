/**
 * RFC 4122 v4 UUID for idempotency keys and other client-minted ids.
 *
 * `crypto.randomUUID` exists only in secure contexts (HTTPS or localhost). A
 * self-hosted dashboard served over plain HTTP from a LAN address is a
 * supported setup (Accounts drops the Secure cookie flag for an http issuer),
 * and there every add / update / revision request threw before it was sent.
 * `crypto.getRandomValues` is available in every context.
 */
export function randomUuid(): string {
  const webCrypto = globalThis.crypto;
  if (typeof webCrypto.randomUUID === "function") return webCrypto.randomUUID();
  const bytes = webCrypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}
