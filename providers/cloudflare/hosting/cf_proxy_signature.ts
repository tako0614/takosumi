/**
 * Stateless HMAC signature binding a managed cf-proxy request to the
 * control-plane-issued `(namespace, slug, expiry)`.
 *
 * The cf-proxy (`cf_proxy_worker.ts`) is reachable at the worker edge because the
 * OpenTofu runner's cloudflare provider dials it via the `base_url`. Without a
 * signature it would be an unauthenticated open relay to `api.cloudflare.com`
 * whose namespace+slug are caller-controlled in the path. The control plane
 * therefore signs the scope at run-dispatch time and embeds the signature as the
 * FIRST path segment of the `base_url`; the proxy verifies it (constant-time,
 * `crypto.subtle.verify`) before forwarding. Stateless: the expiry is carried in
 * the segment AND covered by the MAC, so the proxy needs no per-run storage.
 *
 * Segment format: `<expMs>.<base64url(HMAC-SHA256(secret, "ns\nslug\nexpMs"))>`.
 */

const ENCODER = new TextEncoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return undefined;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function scopePayload(
  namespace: string,
  slug: string,
  expMs: number,
): BufferSource {
  return ENCODER.encode(`${namespace}\n${slug}\n${expMs}`) as BufferSource;
}

export interface CfProxySignatureInput {
  readonly namespace: string;
  readonly slug: string;
  /** Absolute epoch-ms expiry; the proxy rejects requests after it. */
  readonly expMs: number;
}

/** Returns the `<expMs>.<mac>` path segment for the managed `base_url`. */
export async function signCfProxyScope(
  secret: string,
  input: CfProxySignatureInput,
): Promise<string> {
  const key = await hmacKey(secret);
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      scopePayload(input.namespace, input.slug, input.expMs),
    ),
  );
  return `${input.expMs}.${base64UrlEncode(mac)}`;
}

/**
 * Verifies that `signature` binds to `(namespace, slug)` and is unexpired at
 * `nowMs`. Returns false on any malformed / tampered / expired input.
 */
export async function verifyCfProxyScope(
  secret: string,
  signature: string,
  input: { readonly namespace: string; readonly slug: string; readonly nowMs: number },
): Promise<boolean> {
  const dot = signature.indexOf(".");
  if (dot <= 0) return false;
  const expStr = signature.slice(0, dot);
  const macStr = signature.slice(dot + 1);
  if (!/^[0-9]+$/.test(expStr)) return false;
  const expMs = Number(expStr);
  if (!Number.isSafeInteger(expMs) || expMs <= input.nowMs) return false;
  const mac = base64UrlDecode(macStr);
  if (!mac) return false;
  const key = await hmacKey(secret);
  return await crypto.subtle.verify(
    "HMAC",
    key,
    mac as BufferSource,
    scopePayload(input.namespace, input.slug, expMs),
  );
}
