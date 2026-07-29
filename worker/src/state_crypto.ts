// At-rest encryption for OpenTofu state + plan artifacts (spec §11, invariant
// #13: "state / plan / raw output は暗号化して保存する").
//
// New artifacts use byte-native AES-GCM. Historical artifacts used the
// string-only secret-store boundary and therefore encrypted
// `base64(plaintextBytes)`. `open` retains that reader as a compatibility path,
// while every new `seal` writes the v2 byte-native wire format:
//   magic || iv || AES-GCM(plaintextBytes, partition="global")
// The v2 key derivation and AAD stay byte-identical to the existing
// PartitionedSecretBoundaryCrypto global partition, so key rotation and
// operator configuration remain one boundary.
//
// Digests recorded over content are over the PLAINTEXT bytes (spec digests are
// content digests). On restore we decrypt first, then verify the recorded
// plaintext digest — a tamper of the ciphertext (or wrong key) fails the
// AES-GCM auth tag; a tamper that somehow survived decryption fails the digest
// check. Either way restore fails closed.

import {
  SECRET_STORE_KEY_ENV_KEYS,
  SECRET_STORE_PARTITION_KEYS_ENV,
  type SecretBoundaryCrypto,
  selectSecretBoundaryCrypto,
  type SecretCryptoEnvLike,
} from "../../core/adapters/secret-store/memory.ts";

// State/plan artifacts are operator-managed and not cloud-partition-scoped; use
// the `global` partition (whose key is the bare TAKOSUMI_SECRET_STORE_PASSPHRASE
// / TAKOSUMI_SECRET_STORE_KEY) so encrypt/decrypt are symmetric regardless of
// which provider the deployment targets.
const STATE_PARTITION = "global" as const;
const STATE_ARTIFACT_FORMAT = "aes-gcm-bytes-v2" as const;
const STATE_ARTIFACT_V2_MAGIC = new Uint8Array([
  0x54, // T
  0x4b, // K
  0x53, // S
  0x41, // A
  0x02, // wire version
]);
const LEGACY_PLACEHOLDER_PREFIX = new TextEncoder().encode(
  "takos-secret-placeholder-v1:",
);
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const DEV_ARTIFACT_PASSPHRASE =
  "takosumi-state-artifact-explicit-dev-placeholder-v2";

export interface SealedArtifact {
  /** Versioned AES-GCM ciphertext bytes to persist at rest. */
  readonly ciphertext: Uint8Array;
  /** `sha256:<hex>` over the PLAINTEXT bytes (content digest). */
  readonly contentDigest: string;
  /** Length of `ciphertext` in bytes (recorded alongside contentDigest). */
  readonly ciphertextLength: number;
  /** Stable wire-format marker stored as object metadata for operations. */
  readonly format: typeof STATE_ARTIFACT_FORMAT;
}

/**
 * Thin at-rest crypto for state + plan artifacts. Wraps a
 * {@link SecretBoundaryCrypto} so binary artifacts can be sealed/opened with the
 * existing AES-GCM primitive and a content digest is carried for tamper checks.
 */
export class StateArtifactCrypto {
  readonly #legacyCrypto: SecretBoundaryCrypto;
  readonly #key: Promise<CryptoKey>;

  private constructor(
    legacyCrypto: SecretBoundaryCrypto,
    key: Promise<CryptoKey>,
  ) {
    this.#legacyCrypto = legacyCrypto;
    this.#key = key;
  }

  /**
   * Selects the at-rest crypto from the worker env, reusing
   * {@link selectSecretBoundaryCrypto} (fails closed in production/staging when
   * no passphrase is configured; requires TAKOSUMI_DEV_MODE=1 for the dev
   * placeholder).
   */
  static fromEnv(env: SecretCryptoEnvLike): StateArtifactCrypto {
    // Selection performs the canonical production/staging fail-closed and
    // passphrase-strength validation before this module derives the identical
    // global-partition key for byte-native payloads.
    const legacyCrypto = selectSecretBoundaryCrypto({ env });
    return new StateArtifactCrypto(
      legacyCrypto,
      deriveAesKey(stateArtifactPassphrase(env)),
    );
  }

  /**
   * Seals plaintext bytes for at-rest storage and records the plaintext content
   * digest. Returns the ciphertext to persist plus the digest/length metadata.
   */
  async seal(plaintext: Uint8Array): Promise<SealedArtifact> {
    const contentDigest = await digestBytes(plaintext);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const payload = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: toArrayBuffer(stateArtifactAdditionalData()),
        },
        await this.#key,
        toArrayBuffer(plaintext),
      ),
    );
    const ciphertext = new Uint8Array(
      STATE_ARTIFACT_V2_MAGIC.byteLength + iv.byteLength + payload.byteLength,
    );
    ciphertext.set(STATE_ARTIFACT_V2_MAGIC);
    ciphertext.set(iv, STATE_ARTIFACT_V2_MAGIC.byteLength);
    ciphertext.set(payload, STATE_ARTIFACT_V2_MAGIC.byteLength + iv.byteLength);
    return {
      ciphertext,
      contentDigest,
      ciphertextLength: ciphertext.byteLength,
      format: STATE_ARTIFACT_FORMAT,
    };
  }

  /**
   * Opens at-rest ciphertext and returns the plaintext bytes. When
   * `expectedDigest` is supplied, the recovered plaintext digest is verified and
   * a mismatch throws (tamper / wrong-content fails closed). The AES-GCM auth tag
   * already rejects a ciphertext bit-flip or a wrong key before this point.
   */
  async open(
    ciphertext: Uint8Array,
    expectedDigest?: string,
  ): Promise<Uint8Array> {
    let plaintext: Uint8Array;
    if (isV2Ciphertext(ciphertext)) {
      try {
        plaintext = await this.#openV2(ciphertext);
      } catch (v2Error) {
        // A legacy IV is random and can theoretically begin with the v2 magic.
        // Retry the authenticated legacy decoder before declaring the object
        // unreadable. A tampered v2 object still fails both authenticated paths.
        try {
          plaintext = await this.#openLegacy(ciphertext);
        } catch {
          throw v2Error;
        }
      }
    } else {
      plaintext = await this.#openLegacy(ciphertext);
    }
    if (expectedDigest !== undefined) {
      const digest = await digestBytes(plaintext);
      if (digest !== expectedDigest) {
        throw new Error(
          `state artifact content digest mismatch after decrypt: ${digest}`,
        );
      }
    }
    return plaintext;
  }

  async #openV2(ciphertext: Uint8Array): Promise<Uint8Array> {
    const minimumLength =
      STATE_ARTIFACT_V2_MAGIC.byteLength +
      AES_GCM_IV_BYTES +
      AES_GCM_TAG_BYTES;
    if (ciphertext.byteLength < minimumLength) {
      throw new Error("state artifact v2 ciphertext is truncated");
    }
    const ivOffset = STATE_ARTIFACT_V2_MAGIC.byteLength;
    const payloadOffset = ivOffset + AES_GCM_IV_BYTES;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(ciphertext.subarray(ivOffset, payloadOffset)),
        additionalData: toArrayBuffer(stateArtifactAdditionalData()),
      },
      await this.#key,
      toArrayBuffer(ciphertext.subarray(payloadOffset)),
    );
    return new Uint8Array(plaintext);
  }

  async #openLegacy(ciphertext: Uint8Array): Promise<Uint8Array> {
    // Explicit-dev placeholder objects predate the v2 wire format. They are
    // recognizable without decrypting; production/staging never write them.
    if (startsWithBytes(ciphertext, LEGACY_PLACEHOLDER_PREFIX)) {
      const base64 = await this.#legacyCrypto.open(
        ciphertext,
        STATE_PARTITION,
      );
      return decodeLegacyBase64String(base64);
    }
    if (ciphertext.byteLength < AES_GCM_IV_BYTES + AES_GCM_TAG_BYTES) {
      throw new Error("legacy state artifact ciphertext is truncated");
    }
    // Production legacy objects are decrypted as BYTES using the same key/AAD.
    // Decode the resulting ASCII base64 directly into the destination array;
    // do not create the former TextDecoder string + atob binary-string copies.
    const base64Bytes = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(ciphertext.subarray(0, AES_GCM_IV_BYTES)),
          additionalData: toArrayBuffer(stateArtifactAdditionalData()),
        },
        await this.#key,
        toArrayBuffer(ciphertext.subarray(AES_GCM_IV_BYTES)),
      ),
    );
    return decodeLegacyBase64Bytes(base64Bytes);
  }
}

/**
 * Maximum ciphertext length accepted for an artifact with the supplied
 * plaintext cap. The larger legacy bound keeps pre-v2 base64-wrapped objects
 * readable while preventing an unbounded R2 allocation.
 */
export function maxStateArtifactCiphertextBytes(
  maxPlaintextBytes: number,
): number {
  if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 0) {
    throw new TypeError("maxPlaintextBytes must be a non-negative safe integer");
  }
  const nativeBytes =
    STATE_ARTIFACT_V2_MAGIC.byteLength +
    AES_GCM_IV_BYTES +
    maxPlaintextBytes +
    AES_GCM_TAG_BYTES;
  const legacyBase64Bytes = Math.ceil(maxPlaintextBytes / 3) * 4;
  const legacyBytes = AES_GCM_IV_BYTES + legacyBase64Bytes + AES_GCM_TAG_BYTES;
  const legacyPlaceholderPrefixBytes = LEGACY_PLACEHOLDER_PREFIX.byteLength;
  const legacyPlaceholderPayloadBytes =
    new TextEncoder().encode(`${STATE_PARTITION}|-|`).byteLength +
    legacyBase64Bytes;
  const legacyPlaceholderBytes =
    legacyPlaceholderPrefixBytes +
    Math.ceil(legacyPlaceholderPayloadBytes / 3) * 4;
  return Math.max(nativeBytes, legacyBytes, legacyPlaceholderBytes);
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

function stateArtifactPassphrase(env: SecretCryptoEnvLike): string {
  let globalPassphrase: string | undefined;
  for (const name of SECRET_STORE_KEY_ENV_KEYS) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      globalPassphrase = value;
      break;
    }
  }
  if (!globalPassphrase) {
    // selectSecretBoundaryCrypto above permits this only with explicit dev mode.
    return `${DEV_ARTIFACT_PASSPHRASE}|takos.cloud.partition=${STATE_PARTITION}`;
  }
  const rawOverrides = env[SECRET_STORE_PARTITION_KEYS_ENV];
  if (typeof rawOverrides === "string" && rawOverrides.trim().length > 0) {
    // The canonical selector already validated this JSON and every passphrase.
    const parsed = JSON.parse(rawOverrides) as Record<string, unknown>;
    const override = parsed[STATE_PARTITION];
    if (typeof override === "string" && override.trim().length > 0) {
      return override;
    }
  }
  // Historical v1 derivation label; changing it would rotate the key.
  return `${globalPassphrase}|takos.cloud.partition=${STATE_PARTITION}`;
}

function stateArtifactAdditionalData(): Uint8Array {
  // Historical v1 AAD wire label; byte-identical to
  // PartitionedSecretBoundaryCrypto for the global partition.
  return new TextEncoder().encode(`takos.cloud:${STATE_PARTITION}`);
}

async function deriveAesKey(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(passphrase),
  );
  return await crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function isV2Ciphertext(ciphertext: Uint8Array): boolean {
  if (ciphertext.byteLength < STATE_ARTIFACT_V2_MAGIC.byteLength) return false;
  return STATE_ARTIFACT_V2_MAGIC.every(
    (byte, index) => ciphertext[index] === byte,
  );
}

function decodeLegacyBase64Bytes(base64: Uint8Array): Uint8Array {
  return decodeLegacyBase64(base64.byteLength, (index) => base64[index]!);
}

function decodeLegacyBase64String(base64: string): Uint8Array {
  return decodeLegacyBase64(base64.length, (index) =>
    base64.charCodeAt(index)
  );
}

function decodeLegacyBase64(
  length: number,
  charCodeAt: (index: number) => number,
): Uint8Array {
  if (length === 0) return new Uint8Array();
  if (length % 4 !== 0) {
    throw new Error("legacy state artifact base64 length is invalid");
  }
  const padding =
    charCodeAt(length - 1) === 0x3d
      ? charCodeAt(length - 2) === 0x3d
        ? 2
        : 1
      : 0;
  const out = new Uint8Array((length / 4) * 3 - padding);
  let outputOffset = 0;
  for (let inputOffset = 0; inputOffset < length; inputOffset += 4) {
    const last = inputOffset + 4 === length;
    const a = base64Value(charCodeAt(inputOffset));
    const b = base64Value(charCodeAt(inputOffset + 1));
    const cCode = charCodeAt(inputOffset + 2);
    const dCode = charCodeAt(inputOffset + 3);
    const c = cCode === 0x3d ? 0 : base64Value(cCode);
    const d = dCode === 0x3d ? 0 : base64Value(dCode);
    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      d < 0 ||
      (!last && (cCode === 0x3d || dCode === 0x3d)) ||
      (cCode === 0x3d && dCode !== 0x3d) ||
      (last && padding === 0 && (cCode === 0x3d || dCode === 0x3d)) ||
      (last && padding === 1 && (cCode === 0x3d || dCode !== 0x3d)) ||
      (last && padding === 2 && (cCode !== 0x3d || dCode !== 0x3d))
    ) {
      throw new Error("legacy state artifact base64 payload is invalid");
    }
    const combined = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputOffset < out.byteLength) {
      out[outputOffset++] = (combined >>> 16) & 0xff;
    }
    if (outputOffset < out.byteLength) {
      out[outputOffset++] = (combined >>> 8) & 0xff;
    }
    if (outputOffset < out.byteLength) out[outputOffset++] = combined & 0xff;
  }
  return out;
}

function base64Value(code: number): number {
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61 + 26;
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 52;
  if (code === 0x2b) return 62;
  if (code === 0x2f) return 63;
  return -1;
}

function startsWithBytes(
  value: Uint8Array,
  prefix: Uint8Array,
): boolean {
  if (value.byteLength < prefix.byteLength) return false;
  return prefix.every((byte, index) => value[index] === byte);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
