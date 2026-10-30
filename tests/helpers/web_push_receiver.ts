/**
 * The receiving side of Web Push, for tests: a user agent's key pair, RFC 8291
 * decryption, and RFC 8292 VAPID verification as a push relay does it.
 */

import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  toArrayBuffer,
  utf8,
} from "../../core/domains/notifications/web_push/bytes.ts";
import { p256KeyMaterialFromScalar } from "../../core/domains/notifications/web_push/p256.ts";

export interface TestUserAgent {
  readonly privateKey: CryptoKey;
  /** Subscription `p256dh` / pusher `pushkey`. */
  readonly p256dh: Uint8Array;
  /** Subscription `auth`. */
  readonly auth: Uint8Array;
}

export async function createTestUserAgent(): Promise<TestUserAgent> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  return {
    privateKey: pair.privateKey,
    p256dh: new Uint8Array(
      (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
    ),
    auth: crypto.getRandomValues(new Uint8Array(16)),
  };
}

/** Import a known P-256 private scalar as an ECDH key. */
export async function importEcdhPrivateScalar(
  scalar: Uint8Array,
): Promise<CryptoKey> {
  const material = await p256KeyMaterialFromScalar(scalar);
  return await crypto.subtle.importKey(
    "jwk",
    material.jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

export async function decryptWebPushBody(
  body: Uint8Array,
  agent: TestUserAgent,
): Promise<Uint8Array> {
  const salt = body.subarray(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const keyIdLength = body[20]!;
  if (recordSize < 18 || keyIdLength !== 65) throw new Error("bad header");
  const senderPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);
  const senderKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(senderPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdh = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderKey },
      agent.privateKey,
      256,
    ),
  );
  const ikm = await hkdf(
    ecdh,
    agent.auth,
    concatBytes(utf8("WebPush: info\0"), agent.p256dh, senderPublic),
    32,
  );
  const cek = await hkdf(ikm, salt, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(ikm, salt, utf8("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(cek),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce), tagLength: 128 },
      key,
      toArrayBuffer(ciphertext),
    ),
  );
  let end = record.byteLength - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  if (record[end] !== 0x02) throw new Error("not a final record");
  return record.subarray(0, end);
}

export interface VerifiedVapid {
  readonly claims: { readonly aud: string; readonly exp: number; readonly sub: string };
  readonly publicKey: string;
}

/** Verify `Authorization: vapid t=..., k=...` like a push relay. */
export async function verifyVapidAuthorization(
  header: string | null,
): Promise<VerifiedVapid> {
  const match = /^vapid t=([^,\s]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!match) throw new Error("not a vapid authorization header");
  const [, jwt, k] = match as unknown as [string, string, string];
  const point = base64UrlDecode(k);
  if (!point) throw new Error("bad k");
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(point),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const [header64, payload64, signature64] = jwt.split(".");
  const signature = base64UrlDecode(signature64 ?? "");
  if (!header64 || !payload64 || !signature) throw new Error("bad jwt");
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    toArrayBuffer(signature),
    toArrayBuffer(utf8(`${header64}.${payload64}`)),
  );
  if (!valid) throw new Error("bad signature");
  const jwtHeader = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(header64)!),
  ) as { alg?: string; typ?: string };
  if (jwtHeader.alg !== "ES256") throw new Error("bad alg");
  return {
    claims: JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payload64)!),
    ) as VerifiedVapid["claims"],
    publicKey: base64UrlEncode(point),
  };
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(ikm),
    "HKDF",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toArrayBuffer(salt),
        info: toArrayBuffer(info),
      },
      key,
      length * 8,
    ),
  );
}
