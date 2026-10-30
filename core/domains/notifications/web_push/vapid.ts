/**
 * VAPID (RFC 8292) for the instance's own Web Push to Takosumi Mobile.
 *
 * The key pair is never stored. It is derived from the secret-store
 * passphrase the operator already holds and does not routinely rotate
 * (`TAKOSUMI_SECRET_STORE_PASSPHRASE`, or `TAKOSUMI_SECRET_STORE_KEY`, the
 * same precedence as the secret store) with HKDF-SHA256 under a fixed,
 * versioned label, so it survives restarts and deploys and needs no new secret
 * slot. Changing the label version, or rotating the passphrase, changes the
 * public key; Takosumi Mobile compares `web_push_public_key` on launch and
 * subscribes again.
 */

import {
  MIN_SECRET_STORE_PASSPHRASE_BYTES,
  SECRET_STORE_KEY_ENV_KEYS,
} from "../../../adapters/secret-store/memory.ts";
import {
  base64UrlEncode,
  bytesToBigInt,
  concatBytes,
  toArrayBuffer,
  utf8,
} from "./bytes.ts";
import { P256_ORDER, p256KeyMaterialFromScalar } from "./p256.ts";

export const TAKOSUMI_WEB_PUSH_VAPID_LABEL = "takosumi/web-push/vapid/v1";

/** RFC 8292 caps `exp` at 24 hours; the design keeps it within 12. */
export const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;
/** A cached JWT is reused only while it still has at least this long left. */
const VAPID_JWT_REUSE_MARGIN_SECONDS = 60 * 60;

const MAX_DERIVATION_ATTEMPTS = 256;
const MAX_CACHED_JWTS = 64;

export interface VapidKeyPair {
  /** ECDSA P-256 signing key, not extractable. */
  readonly privateKey: CryptoKey;
  /** Uncompressed SEC1 point, 65 bytes. */
  readonly publicKey: Uint8Array;
  /** base64url of `publicKey`: `web_push_public_key` and the VAPID `k`. */
  readonly publicKeyBase64Url: string;
}

/**
 * HKDF-SHA256(IKM = secret, salt = empty, info = label || 0x00 || counter)
 * → 32 bytes, retried with the next counter until 1 <= d < n (rejection
 * sampling; a retry happens with probability about 2^-32).
 */
export async function deriveVapidPrivateScalar(
  secret: Uint8Array,
  label: string = TAKOSUMI_WEB_PUSH_VAPID_LABEL,
): Promise<Uint8Array> {
  if (secret.byteLength < MIN_SECRET_STORE_PASSPHRASE_BYTES) {
    throw new RangeError(
      `VAPID derivation secret must be at least ${MIN_SECRET_STORE_PASSPHRASE_BYTES} bytes`,
    );
  }
  const ikm = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  for (let counter = 0; counter < MAX_DERIVATION_ATTEMPTS; counter += 1) {
    const info = concatBytes(utf8(label), Uint8Array.of(0x00, counter));
    const candidate = new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new ArrayBuffer(0),
          info: toArrayBuffer(info),
        },
        ikm,
        256,
      ),
    );
    const scalar = bytesToBigInt(candidate);
    if (scalar > 0n && scalar < P256_ORDER) return candidate;
  }
  throw new Error("VAPID key derivation did not produce a valid scalar");
}

/** Import a known P-256 private scalar (32 bytes) as a VAPID signing pair. */
export async function importVapidKeyPair(
  privateScalar: Uint8Array,
): Promise<VapidKeyPair> {
  const material = await p256KeyMaterialFromScalar(privateScalar);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { ...material.jwk, ext: false },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return {
    privateKey,
    publicKey: material.publicKey,
    publicKeyBase64Url: base64UrlEncode(material.publicKey),
  };
}

export async function deriveVapidKeyPair(
  secret: Uint8Array,
  label: string = TAKOSUMI_WEB_PUSH_VAPID_LABEL,
): Promise<VapidKeyPair> {
  return await importVapidKeyPair(await deriveVapidPrivateScalar(secret, label));
}

export type VapidSecretEnv = Readonly<Record<string, unknown>>;

/**
 * The secret-store passphrase the Web Push keys are derived from, or undefined
 * when none of at least 32 bytes is configured.
 */
export function webPushDerivationSecret(env: VapidSecretEnv): string | undefined {
  for (const key of SECRET_STORE_KEY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      return utf8(value).byteLength >= MIN_SECRET_STORE_PASSPHRASE_BYTES
        ? value
        : undefined;
    }
  }
  return undefined;
}

let cachedInstanceKeys:
  | { readonly secret: string; readonly promise: Promise<VapidKeyPair> }
  | undefined;

/**
 * The instance's VAPID pair, cached for the isolate or process. Null when no
 * secret-store passphrase of at least 32 bytes is configured (local dev
 * mode): Web Push is then unavailable and `web_push_public_key` is null.
 */
export async function instanceVapidKeyPair(
  env: VapidSecretEnv,
): Promise<VapidKeyPair | null> {
  const secret = webPushDerivationSecret(env);
  if (secret === undefined) return null;
  if (cachedInstanceKeys?.secret !== secret) {
    const promise = deriveVapidKeyPair(utf8(secret));
    cachedInstanceKeys = { secret, promise };
    // A failed derivation must not stay cached.
    promise.catch(() => {
      if (cachedInstanceKeys?.promise === promise) cachedInstanceKeys = undefined;
    });
  }
  return await cachedInstanceKeys.promise;
}

interface VapidClaims {
  /** Origin of the push resource, i.e. of the relay. */
  readonly aud: string;
  /** Expiry, seconds since the epoch. */
  readonly exp: number;
  /** Contact: the instance's https origin. */
  readonly sub: string;
}

export async function signVapidJwt(
  keys: VapidKeyPair,
  claims: VapidClaims,
): Promise<string> {
  const header = base64UrlEncode(
    utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const payload = base64UrlEncode(
    utf8(JSON.stringify({ aud: claims.aud, exp: claims.exp, sub: claims.sub })),
  );
  const signingInput = `${header}.${payload}`;
  // WebCrypto ECDSA returns IEEE P1363 r||s (64 bytes), which is exactly the
  // JWS ES256 signature encoding.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keys.privateKey,
      toArrayBuffer(utf8(signingInput)),
    ),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

const jwtCache = new Map<string, { readonly jwt: string; readonly exp: number }>();

/**
 * `Authorization: vapid t=<jwt>, k=<public key>` for one push resource. The
 * JWT is reused while it has more than an hour of validity left.
 */
export async function vapidAuthorization(
  keys: VapidKeyPair,
  input: { readonly endpoint: string; readonly subject: string },
  nowMs: number = Date.now(),
): Promise<string> {
  const aud = new URL(input.endpoint).origin;
  const sub = normalizeVapidSubject(input.subject);
  const nowSeconds = Math.floor(nowMs / 1000);
  const cacheKey = `${keys.publicKeyBase64Url}\n${aud}\n${sub}`;
  const cached = jwtCache.get(cacheKey);
  let jwt: string;
  if (cached && cached.exp - nowSeconds > VAPID_JWT_REUSE_MARGIN_SECONDS) {
    jwt = cached.jwt;
  } else {
    const exp = nowSeconds + VAPID_JWT_LIFETIME_SECONDS;
    jwt = await signVapidJwt(keys, { aud, exp, sub });
    jwtCache.delete(cacheKey);
    jwtCache.set(cacheKey, { jwt, exp });
    while (jwtCache.size > MAX_CACHED_JWTS) {
      const oldest = jwtCache.keys().next().value;
      if (oldest === undefined) break;
      jwtCache.delete(oldest);
    }
  }
  return `vapid t=${jwt}, k=${keys.publicKeyBase64Url}`;
}

/** Test hook: forget reused JWTs. */
export function clearVapidJwtCache(): void {
  jwtCache.clear();
}

/**
 * The VAPID `sub`: the instance's https origin. Plain http is accepted only
 * for loopback development issuers.
 */
export function normalizeVapidSubject(value: string): string {
  const url = new URL(value);
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  ) {
    return url.origin;
  }
  throw new Error("VAPID subject must be the instance's https origin");
}
