/**
 * P-256 helpers built only on WebCrypto.
 *
 * WebCrypto cannot import a bare private scalar as JWK without its public
 * point. It can import PKCS#8, and an RFC 5915 ECPrivateKey inside PKCS#8 may
 * leave out the optional public key: the implementation then computes the
 * point, and a JWK export returns it as `x`/`y`. workerd, Bun and Node all do
 * this (tests/core/domains/notifications/web_push_*_test.ts), so the sender
 * needs no curve arithmetic of its own.
 */

import { base64UrlDecode, concatBytes, toArrayBuffer } from "./bytes.ts";

/** Order of the P-256 base point. A valid private scalar d satisfies 1 <= d < N. */
export const P256_ORDER =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/**
 * PKCS#8 PrivateKeyInfo for id-ecPublicKey / prime256v1 wrapping
 * ECPrivateKey { version 1, privateKey OCTET STRING (32) } — no parameters
 * and no publicKey field. The 32-byte scalar follows this prefix.
 */
const PKCS8_P256_PREFIX = Uint8Array.from([
  0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48,
  0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
  0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
]);

export interface P256PrivateKeyMaterial {
  /** The JWK with `d`, `x` and `y`, for importing as ECDSA or ECDH. */
  readonly jwk: JsonWebKey;
  /** Uncompressed SEC1 public point (0x04 || X || Y), 65 bytes. */
  readonly publicKey: Uint8Array;
}

/** The full JWK and public point of a 32-byte big-endian private scalar. */
export async function p256KeyMaterialFromScalar(
  scalar: Uint8Array,
): Promise<P256PrivateKeyMaterial> {
  if (scalar.byteLength !== 32) {
    throw new RangeError("P-256 private key must be 32 bytes");
  }
  const key = await crypto.subtle.importKey(
    "pkcs8",
    toArrayBuffer(concatBytes(PKCS8_P256_PREFIX, scalar)),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const x = jwk.x ? base64UrlDecode(jwk.x) : null;
  const y = jwk.y ? base64UrlDecode(jwk.y) : null;
  if (!x || !y || x.byteLength !== 32 || y.byteLength !== 32) {
    throw new Error("WebCrypto did not return the P-256 public point");
  }
  return {
    jwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y },
    publicKey: concatBytes(Uint8Array.of(0x04), x, y),
  };
}

/**
 * True when `point` is an uncompressed SEC1 P-256 point on the curve.
 * WebCrypto refuses to import a raw point that is not on the curve.
 */
export async function isP256PublicPoint(point: Uint8Array): Promise<boolean> {
  if (point.byteLength !== 65 || point[0] !== 0x04) return false;
  try {
    await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(point),
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    return true;
  } catch {
    return false;
  }
}
