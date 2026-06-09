// R2-backed {@link BackupArtifactStore} for control backups (spec §33 / §26
// R2_BACKUPS). Seals backup payloads with the at-rest
// secret-boundary crypto (the SAME StateArtifactCrypto the state / raw-output
// lanes use) and writes the sealed object to the R2_BACKUPS bucket under the
// service-supplied §26 key.
//
// The service hands us PLAINTEXT payload bytes; we seal them, persist the sealed
// bytes, and return the digest over the SEALED bytes + their length so the
// BackupRecord pointer matches the object actually stored at rest. No secret
// material is ever returned to the service — only the pointer metadata.

import type {
  BackupArtifactStore,
  BackupObjectReader,
} from "../../src/service/domains/backups/mod.ts";
import type { SecretCryptoEnvLike } from "../../src/service/adapters/secret-store/memory.ts";
import { digestBytes, StateArtifactCrypto } from "./state_crypto.ts";
import type { R2Bucket } from "./bindings.ts";

export class R2BackupArtifactStore implements BackupArtifactStore {
  readonly #bucket: R2Bucket;
  readonly #crypto: StateArtifactCrypto;

  constructor(bucket: R2Bucket, crypto: StateArtifactCrypto) {
    this.#bucket = bucket;
    this.#crypto = crypto;
  }

  async put(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    const sealed = await this.#crypto.seal(input.payload);
    const digest = await digestBytes(sealed.ciphertext);
    await this.#bucket.put(
      input.objectKey,
      toArrayBuffer(sealed.ciphertext),
      {
        httpMetadata: { contentType: input.contentType },
        customMetadata: {
          "takosumi-sealed": "1",
          "takosumi-plaintext-digest": sealed.contentDigest,
        },
      },
    );
    return { digest, sizeBytes: sealed.ciphertext.byteLength };
  }

  async putPlain(input: {
    readonly objectKey: string;
    readonly payload: Uint8Array;
    readonly contentType: string;
  }): Promise<{ readonly digest: string; readonly sizeBytes: number }> {
    const digest = await digestBytes(input.payload);
    await this.#bucket.put(input.objectKey, toArrayBuffer(input.payload), {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        "takosumi-public-backup-sidecar": "1",
      },
    });
    return { digest, sizeBytes: input.payload.byteLength };
  }
}

/**
 * Builds the {@link R2BackupArtifactStore} from a worker's R2_BACKUPS binding +
 * the crypto env. Returns undefined when the bucket is absent so the backups
 * service stays disabled (routes report not_implemented). The at-rest crypto
 * fails closed in production/staging without a configured passphrase, per
 * {@link StateArtifactCrypto.fromEnv}.
 */
export function backupArtifactStoreFromEnv(
  bucket: R2Bucket | undefined,
  cryptoEnv: SecretCryptoEnvLike,
): BackupArtifactStore | undefined {
  if (!bucket) return undefined;
  return new R2BackupArtifactStore(bucket, StateArtifactCrypto.fromEnv(cryptoEnv));
}

export function backupObjectReaderFromR2(
  bucket: R2Bucket | undefined,
): BackupObjectReader | undefined {
  if (!bucket) return undefined;
  return {
    get: async (objectKey: string): Promise<Uint8Array | undefined> => {
      const object = await bucket.get(objectKey);
      if (!object) return undefined;
      return new Uint8Array(await object.arrayBuffer());
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
