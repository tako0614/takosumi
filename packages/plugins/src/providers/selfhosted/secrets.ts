import type { kms, secretStore } from "takosumi-contract";
import {
  bytesFromBody,
  decodeBase64Url,
  encodeBase64Url,
  freezeClone,
  toArrayBuffer,
} from "./common.ts";

export interface SelfHostedSecretClient {
  putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata: Record<string, unknown>;
  }): Promise<{ readonly version: string; readonly createdAt?: string }>;
  getSecret(input: {
    readonly name: string;
    readonly version: string;
  }): Promise<string | undefined>;
  latestSecret(
    name: string,
  ): Promise<secretStore.SecretRecord | undefined>;
  listSecrets(): Promise<readonly secretStore.SecretRecord[]>;
  deleteSecret(input: {
    readonly name: string;
    readonly version: string;
  }): Promise<boolean>;
}

export interface SelfHostedSecretStoreAdapterOptions {
  readonly client: SelfHostedSecretClient;
  readonly clock?: () => Date;
}

export class SelfHostedSecretStoreAdapter
  implements secretStore.SecretStorePort {
  readonly #client: SelfHostedSecretClient;
  readonly #clock: () => Date;

  constructor(options: SelfHostedSecretStoreAdapterOptions) {
    this.#client = options.client;
    this.#clock = options.clock ?? (() => new Date());
  }

  async putSecret(input: {
    readonly name: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord> {
    const result = await this.#client.putSecret({
      name: input.name,
      value: input.value,
      metadata: { ...(input.metadata ?? {}) },
    });
    return freezeClone({
      name: input.name,
      version: result.version,
      createdAt: result.createdAt ?? this.#clock().toISOString(),
      metadata: { ...(input.metadata ?? {}) },
    });
  }

  getSecret(ref: secretStore.SecretVersionRef): Promise<string | undefined> {
    return this.#client.getSecret(ref);
  }

  async getSecretRecord(
    ref: secretStore.SecretVersionRef,
  ): Promise<secretStore.SecretRecord | undefined> {
    return (await this.listSecrets()).find((record) =>
      record.name === ref.name && record.version === ref.version
    );
  }

  latestSecret(
    name: string,
  ): Promise<secretStore.SecretRecord | undefined> {
    return this.#client.latestSecret(name);
  }

  listSecrets(): Promise<readonly secretStore.SecretRecord[]> {
    return this.#client.listSecrets();
  }

  deleteSecret(ref: secretStore.SecretVersionRef): Promise<boolean> {
    return this.#client.deleteSecret(ref);
  }
}

export interface SelfHostedKmsClient {
  activeKeyRef(): Promise<kms.KmsKeyRefDto>;
  encrypt(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto>;
  decrypt(input: kms.KmsDecryptInput): Promise<Uint8Array>;
  rotate?(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto>;
}

export class SelfHostedKmsAdapter implements kms.KmsPort {
  constructor(private readonly client: SelfHostedKmsClient) {}

  activeKeyRef(): Promise<kms.KmsKeyRefDto> {
    return this.client.activeKeyRef();
  }

  encrypt(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto> {
    return this.client.encrypt(input);
  }

  decrypt(input: kms.KmsDecryptInput): Promise<Uint8Array> {
    return this.client.decrypt(input);
  }

  async rotate(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto> {
    if (this.client.rotate) return await this.client.rotate(input);
    const plaintext = await this.client.decrypt({ envelope: input.envelope });
    return await this.client.encrypt({
      plaintext,
      keyRef: input.targetKeyRef,
      rotation: {
        rotationId: crypto.randomUUID(),
        rotatedFrom: input.envelope.keyRef,
        rotatedAt: new Date().toISOString(),
        reason: input.reason,
      },
    });
  }
}

export interface SelfHostedLocalAesGcmKmsOptions {
  readonly keyId?: string;
  readonly keyVersion?: string;
  readonly passphrase: string;
  readonly clock?: () => Date;
}

export class SelfHostedLocalAesGcmKmsClient implements SelfHostedKmsClient {
  readonly #keyRef: kms.KmsKeyRefDto;
  readonly #keyPromise: Promise<CryptoKey>;
  readonly #clock: () => Date;

  constructor(options: SelfHostedLocalAesGcmKmsOptions) {
    this.#keyRef = {
      provider: "local-webcrypto",
      keyId: options.keyId ?? "selfhosted-local",
      keyVersion: options.keyVersion ?? "v1",
    };
    this.#keyPromise = deriveAesKey(options.passphrase);
    this.#clock = options.clock ?? (() => new Date());
  }

  activeKeyRef(): Promise<kms.KmsKeyRefDto> {
    return Promise.resolve(freezeClone(this.#keyRef));
  }

  async encrypt(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        await this.#keyPromise,
        toArrayBuffer(bytesFromBody(input.plaintext)),
      ),
    );
    return freezeClone({
      version: "takos.kms.envelope.v1",
      algorithm: "AES-256-GCM",
      keyRef: input.keyRef ?? this.#keyRef,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext),
      createdAt: this.#clock().toISOString(),
      rotation: input.rotation,
    });
  }

  async decrypt(input: kms.KmsDecryptInput): Promise<Uint8Array> {
    if (input.envelope.algorithm !== "AES-256-GCM") {
      throw new Error(
        `unsupported selfhosted KMS envelope algorithm: ${input.envelope.algorithm}`,
      );
    }
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(decodeBase64Url(input.envelope.iv)),
        },
        await this.#keyPromise,
        toArrayBuffer(decodeBase64Url(input.envelope.ciphertext)),
      ),
    );
  }
}

async function deriveAesKey(passphrase: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(passphrase),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
