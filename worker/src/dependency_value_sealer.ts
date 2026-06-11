// At-rest sealing for the SENSITIVE pinned values of a DependencySnapshot entry
// (spec §11 / §18 invariant: secret outputs are never stored as cleartext ledger
// values).
//
// A cross-Space `published_output` edge may inline a producer's *sensitive*
// output value into the consumer's pinned inputs. That value MUST NOT sit in
// cleartext in the `dependency_snapshots` ledger row. This sealer reuses the
// EXISTING AES-GCM at-rest envelope ({@link StateArtifactCrypto}, the same
// secret-boundary crypto that protects state / plan / raw-output artifacts) —
// no new key management is introduced. The plaintext sealed/opened here is the
// JSON of the edge's `{ name: value }` sensitive value map.

import type { JsonValue } from "takosumi-contract";
import type { SealedDependencyValues } from "takosumi-contract/dependencies";
import type { DependencyValueSealer } from "../../core/domains/deploy-control/mod.ts";
import type { SecretCryptoEnvLike } from "../../core/adapters/secret-store/memory.ts";
import { StateArtifactCrypto } from "./state_crypto.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Seals/opens the sensitive value map of a DependencySnapshot entry with the
 * at-rest {@link StateArtifactCrypto} envelope. `seal` serializes the
 * `{ name: value }` map to JSON, seals the UTF-8 bytes, and base64-encodes the
 * ciphertext for JSON storage; `open` reverses it, verifying the recorded
 * plaintext content digest (a tamper / wrong key fails closed at the AES-GCM
 * auth tag, and a surviving tamper fails the digest check).
 */
export class StateCryptoDependencyValueSealer implements DependencyValueSealer {
  readonly #crypto: StateArtifactCrypto;

  constructor(crypto: StateArtifactCrypto) {
    this.#crypto = crypto;
  }

  async seal(
    values: Readonly<Record<string, JsonValue>>,
  ): Promise<SealedDependencyValues> {
    const plaintext = textEncoder.encode(JSON.stringify(values));
    const sealed = await this.#crypto.seal(plaintext);
    return {
      ciphertext: bytesToBase64(sealed.ciphertext),
      contentDigest: sealed.contentDigest,
      names: Object.keys(values),
    };
  }

  async open(
    sealed: SealedDependencyValues,
  ): Promise<Readonly<Record<string, JsonValue>>> {
    const ciphertext = base64ToBytes(sealed.ciphertext);
    const plaintext = await this.#crypto.open(ciphertext, sealed.contentDigest);
    const parsed = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("sealed dependency values must decode to a JSON object");
    }
    return parsed as Record<string, JsonValue>;
  }
}

/**
 * Builds the at-rest dependency value sealer from the worker env, reusing
 * {@link StateArtifactCrypto.fromEnv} (the same secret-boundary crypto / key as
 * state / plan / raw-output artifacts). Returns undefined only when the crypto
 * cannot be selected; callers leave the sealer unset so a sensitive edge fails
 * closed rather than persisting cleartext.
 */
export function dependencyValueSealerFromEnv(
  cryptoEnv: SecretCryptoEnvLike,
): DependencyValueSealer {
  return new StateCryptoDependencyValueSealer(
    StateArtifactCrypto.fromEnv(cryptoEnv),
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
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
