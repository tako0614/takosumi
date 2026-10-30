/**
 * The Web Push `Topic` header for Takosumi's own notifications.
 *
 * `Topic` reaches the relay unencrypted (and may become an APNs collapse id or
 * an FCM collapse key), so it must not be a value an outsider can compute or
 * link across devices. It is a keyed MAC over (pusher, group) with a key only
 * the instance holds: HKDF-SHA256(IKM = secret-store passphrase, salt = empty,
 * info = "takosumi/web-push/topic/v1") → HMAC-SHA256 key. The first 24 bytes
 * of the MAC give 32 base64url characters, the RFC 8030 maximum.
 */

import { base64UrlEncode, concatBytes, toArrayBuffer, utf8 } from "./bytes.ts";
import { type VapidSecretEnv, webPushDerivationSecret } from "./vapid.ts";

export const TAKOSUMI_WEB_PUSH_TOPIC_LABEL = "takosumi/web-push/topic/v1";
const TOPIC_BYTES = 24;

export async function deriveWebPushTopicKey(secret: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(0),
      info: toArrayBuffer(utf8(TAKOSUMI_WEB_PUSH_TOPIC_LABEL)),
    },
    ikm,
    256,
  );
  return await crypto.subtle.importKey(
    "raw",
    bits,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** HMAC(key, uint32 len(pusher) ‖ pusher ‖ group), truncated to 24 bytes. */
export async function computeWebPushTopic(
  key: CryptoKey,
  pusherId: string,
  group: string,
): Promise<string> {
  const pusher = utf8(pusherId);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, pusher.byteLength);
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      toArrayBuffer(concatBytes(length, pusher, utf8(group))),
    ),
  );
  return base64UrlEncode(mac.subarray(0, TOPIC_BYTES));
}

let cachedTopicKey:
  | { readonly secret: string; readonly promise: Promise<CryptoKey> }
  | undefined;

/** The instance's topic key, or null without a secret-store passphrase. */
export async function instanceWebPushTopicKey(
  env: VapidSecretEnv,
): Promise<CryptoKey | null> {
  const secret = webPushDerivationSecret(env);
  if (secret === undefined) return null;
  if (cachedTopicKey?.secret !== secret) {
    const promise = deriveWebPushTopicKey(utf8(secret));
    cachedTopicKey = { secret, promise };
    promise.catch(() => {
      if (cachedTopicKey?.promise === promise) cachedTopicKey = undefined;
    });
  }
  return await cachedTopicKey.promise;
}
