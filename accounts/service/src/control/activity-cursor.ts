/**
 * Sealed Activity cursors (TASK-0118 Phase 9.1).
 *
 * The Workspace-free Activity reads page on the store's `(createdAt, id)`
 * keyset, and the next page starts after the last row the request EXAMINED,
 * which may be a row the caller is not allowed to see. The keyset therefore
 * leaves the server only sealed: AES-256-GCM over the keyset, under a key
 * derived with HKDF-SHA256 (IKM = the secret-store passphrase, salt = empty,
 * info = {@link ACTIVITY_CURSOR_LABEL}) from the passphrase the operator
 * already holds (`TAKOSUMI_SECRET_STORE_PASSPHRASE`, or
 * `TAKOSUMI_SECRET_STORE_KEY`, the same precedence as the secret store).
 *
 * The additional authenticated data is the label, the route and the
 * caller's subject ({@link ActivityCursorContext}), so a cursor opens only
 * on the read and for the account it was issued to, and a token sealed for
 * another purpose under the same passphrase does not open here. The keyset is
 * padded to a fixed block before sealing, so the token length does not reveal
 * the length of the event id.
 *
 * Token: `ac1.` + base64url(12-byte IV || ciphertext || 16-byte tag). The
 * client cannot read the keyset or forge one, and only sealed cursors are
 * accepted: a chosen position would let a caller probe where hidden rows
 * lie. A changed passphrase or label version invalidates outstanding cursors
 * (the client starts again from the newest page).
 */
import type { PageCursor } from "takosumi-contract/pagination";
import {
  MIN_SECRET_STORE_PASSPHRASE_BYTES,
  SECRET_STORE_KEY_ENV_KEYS,
} from "../../../../core/adapters/secret-store/memory.ts";

export const ACTIVITY_CURSOR_LABEL = "takosumi/activity-cursor/v1";
/** Version prefix of a sealed Activity cursor. */
export const SEALED_ACTIVITY_CURSOR_PREFIX = "ac1.";

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The sealed plaintext is padded to a multiple of this many bytes. */
const PLAINTEXT_BLOCK_BYTES = 512;
/** Bytes of the big-endian length prefix inside the padded plaintext. */
const LENGTH_PREFIX_BYTES = 2;
/** Upper bound on a sealed token, far above any real keyset. */
const MAX_SEALED_CURSOR_LENGTH = 4096;

/** Where a cursor may be used: the read it came from and the caller. */
export interface ActivityCursorContext {
  /** The Activity read, e.g. `activity` or `capsules/<id>/activity`. */
  readonly route: string;
  /** The authenticated account subject. */
  readonly subject: string;
}

export interface ActivityCursorSealer {
  seal(position: PageCursor, context: ActivityCursorContext): Promise<string>;
  /**
   * The keyset of a token this sealer issued for the same context; undefined
   * for anything else.
   */
  open(token: string, context: ActivityCursorContext): Promise<PageCursor | undefined>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

async function deriveCursorKey(secret: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey("raw", toArrayBuffer(secret), "HKDF", false, ["deriveKey"]);
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new ArrayBuffer(0),
      info: toArrayBuffer(encoder.encode(ACTIVITY_CURSOR_LABEL)),
    },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * A sealer keyed from `secret` (at least
 * {@link MIN_SECRET_STORE_PASSPHRASE_BYTES} bytes). The key is derived on
 * first use.
 */
export function createActivityCursorSealer(secret: string | Uint8Array): ActivityCursorSealer {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  if (bytes.byteLength < MIN_SECRET_STORE_PASSPHRASE_BYTES) {
    throw new RangeError(
      `Activity cursor secret must be at least ${MIN_SECRET_STORE_PASSPHRASE_BYTES} bytes`,
    );
  }
  let key: Promise<CryptoKey> | undefined;
  const cursorKey = (): Promise<CryptoKey> => (key ??= deriveCursorKey(bytes));
  const aad = (context: ActivityCursorContext): ArrayBuffer =>
    toArrayBuffer(encoder.encode(JSON.stringify([ACTIVITY_CURSOR_LABEL, context.route, context.subject])));
  return {
    async seal(position, context) {
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: aad(context) },
          await cursorKey(),
          toArrayBuffer(padPlaintext(position)),
        ),
      );
      const token = new Uint8Array(IV_BYTES + sealed.byteLength);
      token.set(iv, 0);
      token.set(sealed, IV_BYTES);
      return `${SEALED_ACTIVITY_CURSOR_PREFIX}${base64UrlEncode(token)}`;
    },
    async open(token, context) {
      if (!token.startsWith(SEALED_ACTIVITY_CURSOR_PREFIX) || token.length > MAX_SEALED_CURSOR_LENGTH) {
        return undefined;
      }
      const bytes = base64UrlDecode(token.slice(SEALED_ACTIVITY_CURSOR_PREFIX.length));
      if (!bytes || bytes.byteLength <= IV_BYTES + TAG_BYTES) return undefined;
      let plaintext: Uint8Array;
      try {
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: toArrayBuffer(bytes.subarray(0, IV_BYTES)), additionalData: aad(context) },
            await cursorKey(),
            toArrayBuffer(bytes.subarray(IV_BYTES)),
          ),
        );
      } catch {
        return undefined;
      }
      return unpadPlaintext(plaintext);
    },
  };
}

/**
 * `uint16 length || JSON keyset || zero padding`, padded to a multiple of
 * {@link PLAINTEXT_BLOCK_BYTES} so every ordinary keyset seals to one size.
 */
function padPlaintext(position: PageCursor): Uint8Array {
  const json = encoder.encode(JSON.stringify({ c: position.createdAt, i: position.id }));
  if (json.byteLength > 0xffff) throw new RangeError("Activity cursor keyset is too long");
  const used = LENGTH_PREFIX_BYTES + json.byteLength;
  const size = Math.ceil(used / PLAINTEXT_BLOCK_BYTES) * PLAINTEXT_BLOCK_BYTES;
  const padded = new Uint8Array(size);
  padded[0] = json.byteLength >>> 8;
  padded[1] = json.byteLength & 0xff;
  padded.set(json, LENGTH_PREFIX_BYTES);
  return padded;
}

function unpadPlaintext(padded: Uint8Array): PageCursor | undefined {
  if (padded.byteLength < LENGTH_PREFIX_BYTES || padded.byteLength % PLAINTEXT_BLOCK_BYTES !== 0) return undefined;
  const length = (padded[0]! << 8) | padded[1]!;
  if (LENGTH_PREFIX_BYTES + length > padded.byteLength) return undefined;
  try {
    const parsed = JSON.parse(
      decoder.decode(padded.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length)),
    ) as { c?: unknown; i?: unknown };
    return typeof parsed.c === "string" && typeof parsed.i === "string"
      ? { createdAt: parsed.c, id: parsed.i }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Environment bindings; the secret-store passphrase keys are read from it. */
export type ActivityCursorSecretEnv = Readonly<Record<string, unknown>>;

let cachedEnvSealer: { readonly secret: string; readonly sealer: ActivityCursorSealer } | undefined;

/**
 * The sealer for the configured secret-store passphrase, cached per isolate
 * or process. Undefined when no passphrase of at least
 * {@link MIN_SECRET_STORE_PASSPHRASE_BYTES} bytes is configured; Activity
 * paging then fails closed instead of issuing readable cursors.
 */
export function activityCursorSealerFromEnv(
  env: ActivityCursorSecretEnv,
): ActivityCursorSealer | undefined {
  let secret: string | undefined;
  for (const key of SECRET_STORE_KEY_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim() !== "") {
      secret = value;
      break;
    }
  }
  if (secret === undefined || encoder.encode(secret).byteLength < MIN_SECRET_STORE_PASSPHRASE_BYTES) {
    return undefined;
  }
  if (cachedEnvSealer?.secret !== secret) {
    cachedEnvSealer = { secret, sealer: createActivityCursorSealer(secret) };
  }
  return cachedEnvSealer.sealer;
}
