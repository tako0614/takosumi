// At-rest encryption for OpenTofu state + plan artifacts (spec §11, invariant
// #13: "state / plan / raw output は暗号化して保存する").
//
// This module does NOT implement a new crypto primitive. It reuses the existing
// secret-store AES-GCM boundary crypto (selectSecretBoundaryCrypto /
// MultiCloudSecretBoundaryCrypto in
// src/service/adapters/secret-store/memory.ts), which derives an AES-GCM key
// from TAKOSUMI_SECRET_STORE_PASSPHRASE (an already-pushed production secret).
//
// The secret-store crypto's seal/open operate on UTF-8 STRINGS. tfstate is JSON
// text but plan.bin is arbitrary binary, so we base64-wrap the plaintext bytes
// before seal and decode after open. The ciphertext we persist therefore is:
//   AES-GCM( base64(plaintextBytes), partition="global" )
// with the partition label bound into the GCM AAD by the underlying crypto.
//
// Digests recorded over content are over the PLAINTEXT bytes (spec digests are
// content digests). On restore we decrypt first, then verify the recorded
// plaintext digest — a tamper of the ciphertext (or wrong key) fails the
// AES-GCM auth tag; a tamper that somehow survived decryption fails the digest
// check. Either way restore fails closed.

import {
  type SecretBoundaryCrypto,
  selectSecretBoundaryCrypto,
  type SecretCryptoEnvLike,
} from "../../src/service/adapters/secret-store/memory.ts";

// State/plan artifacts are operator-managed and not cloud-partition-scoped; use
// the `global` partition (whose key is the bare TAKOSUMI_SECRET_STORE_PASSPHRASE
// / TAKOSUMI_SECRET_STORE_KEY) so encrypt/decrypt are symmetric regardless of
// which provider the deployment targets.
const STATE_PARTITION = "global" as const;

export interface SealedArtifact {
  /** AES-GCM ciphertext bytes (iv || ciphertext+tag) to persist at rest. */
  readonly ciphertext: Uint8Array;
  /** `sha256:<hex>` over the PLAINTEXT bytes (content digest). */
  readonly contentDigest: string;
  /** Length of `ciphertext` in bytes (recorded alongside contentDigest). */
  readonly ciphertextLength: number;
}

/**
 * Thin at-rest crypto for state + plan artifacts. Wraps a
 * {@link SecretBoundaryCrypto} so binary artifacts can be sealed/opened with the
 * existing AES-GCM primitive and a content digest is carried for tamper checks.
 */
export class StateArtifactCrypto {
  readonly #crypto: SecretBoundaryCrypto;

  constructor(crypto: SecretBoundaryCrypto) {
    this.#crypto = crypto;
  }

  /**
   * Selects the at-rest crypto from the worker env, reusing
   * {@link selectSecretBoundaryCrypto} (fails closed in production/staging when
   * no passphrase is configured; requires TAKOSUMI_DEV_MODE=1 for the dev
   * placeholder).
   */
  static fromEnv(env: SecretCryptoEnvLike): StateArtifactCrypto {
    return new StateArtifactCrypto(selectSecretBoundaryCrypto({ env }));
  }

  /**
   * Seals plaintext bytes for at-rest storage and records the plaintext content
   * digest. Returns the ciphertext to persist plus the digest/length metadata.
   */
  async seal(plaintext: Uint8Array): Promise<SealedArtifact> {
    const contentDigest = await digestBytes(plaintext);
    const ciphertext = await this.#crypto.seal(
      bytesToBase64(plaintext),
      STATE_PARTITION,
    );
    return {
      ciphertext,
      contentDigest,
      ciphertextLength: ciphertext.byteLength,
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
    const base64 = await this.#crypto.open(ciphertext, STATE_PARTITION);
    const plaintext = base64ToBytes(base64);
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
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return `sha256:${
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  // Chunk to avoid blowing the argument list on large states.
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
