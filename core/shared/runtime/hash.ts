/**
 * Runtime-neutral SHA-256 helper used by service modules that must compile on
 * Cloudflare Workers, Node.js, and Bun. Web Crypto's `crypto.subtle`
 * is async-only (no sync API exists on Workers / V8 isolates), so call sites
 * that previously used `node:crypto`'s synchronous `createHash` must either
 * `await` this helper or hold a lazy-cached promise.
 *
 * The previous implementation imported `createHash` from `node:crypto`, which
 * forces a Workers build to embed Node-compat polyfills and blocks the
 * service from running on a bare V8 isolate. Web Crypto is available on every
 * runtime the service targets (Node 22+, Bun, Workers) and produces an
 * identical hex digest, so the hex output is API-compatible with the prior
 * `createHash("sha256").update(...).digest("hex")` call shape.
 */
export async function sha256HexAsync(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    view.buffer as ArrayBuffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Convenience wrapper for the common case of digesting a UTF-8 encoded
 * string. Equivalent to `sha256HexAsync(new TextEncoder().encode(input))`
 * but documented separately so service call sites can express intent.
 */
export async function sha256HexOfStringAsync(input: string): Promise<string> {
  return await sha256HexAsync(new TextEncoder().encode(input));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}
