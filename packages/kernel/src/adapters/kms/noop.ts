import type {
  KmsDecryptInput,
  KmsEncryptInput,
  KmsEnvelopeDto,
  KmsKeyRefDto,
  KmsPort,
  KmsRotateInput,
} from "./types.ts";

export interface NoopTestKmsOptions {
  readonly keyId?: string;
  readonly keyVersion?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class NoopTestKms implements KmsPort {
  readonly #activeKeyRef: KmsKeyRefDto;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: NoopTestKmsOptions = {}) {
    this.#activeKeyRef = Object.freeze({
      provider: "test-noop",
      keyId: options.keyId ?? "test",
      keyVersion: options.keyVersion ?? "v1",
    });
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  activeKeyRef(): Promise<KmsKeyRefDto> {
    return Promise.resolve(Object.freeze(structuredClone(this.#activeKeyRef)));
  }

  encrypt(input: KmsEncryptInput): Promise<KmsEnvelopeDto> {
    const keyRef = input.keyRef ?? this.#activeKeyRef;
    return Promise.resolve(Object.freeze({
      version: "takosumi.kms.envelope.v1",
      algorithm: "TEST-NOOP",
      keyRef: Object.freeze(structuredClone(keyRef)),
      iv: "",
      ciphertext: encodeBase64Url(toBytes(input.plaintext)),
      createdAt: this.#clock().toISOString(),
      rotation: input.rotation ? structuredClone(input.rotation) : undefined,
    }));
  }

  decrypt(input: KmsDecryptInput): Promise<Uint8Array> {
    if (input.envelope.version !== "takosumi.kms.envelope.v1") {
      throw new Error(
        `unsupported KMS envelope version: ${input.envelope.version}`,
      );
    }
    if (input.envelope.algorithm !== "TEST-NOOP") {
      throw new Error(
        `unsupported KMS envelope algorithm: ${input.envelope.algorithm}`,
      );
    }
    return Promise.resolve(decodeBase64Url(input.envelope.ciphertext));
  }

  async rotate(input: KmsRotateInput): Promise<KmsEnvelopeDto> {
    const plaintext = await this.decrypt({ envelope: input.envelope });
    return await this.encrypt({
      plaintext,
      keyRef: input.targetKeyRef ?? this.#activeKeyRef,
      rotation: {
        rotationId: `kms_rotation_${this.#idGenerator()}`,
        rotatedFrom: input.envelope.keyRef,
        rotatedAt: this.#clock().toISOString(),
        reason: input.reason,
      },
    });
  }
}

function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
