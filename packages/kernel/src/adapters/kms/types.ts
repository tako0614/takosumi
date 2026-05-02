export type KmsKeyProvider = "local-webcrypto" | "test-noop" | string;

export interface KmsKeyRefDto {
  readonly provider: KmsKeyProvider;
  readonly keyId: string;
  readonly keyVersion: string;
}

export interface KmsRotationMetadataDto {
  readonly rotationId?: string;
  readonly rotatedFrom?: KmsKeyRefDto;
  readonly rotatedAt?: string;
  readonly nextRotationAt?: string;
  readonly reason?: string;
}

export interface KmsEnvelopeDto {
  readonly version: "takosumi.kms.envelope.v1";
  readonly algorithm: "AES-256-GCM" | "PROVIDER-KMS" | "TEST-NOOP";
  readonly keyRef: KmsKeyRefDto;
  readonly iv: string;
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly rotation?: KmsRotationMetadataDto;
}

export interface KmsEncryptInput {
  readonly plaintext: Uint8Array | string;
  readonly keyRef?: KmsKeyRefDto;
  readonly rotation?: KmsRotationMetadataDto;
}

export interface KmsDecryptInput {
  readonly envelope: KmsEnvelopeDto;
}

export interface KmsRotateInput {
  readonly envelope: KmsEnvelopeDto;
  readonly targetKeyRef?: KmsKeyRefDto;
  readonly reason?: string;
}

export interface KmsPort {
  activeKeyRef(): Promise<KmsKeyRefDto>;
  encrypt(input: KmsEncryptInput): Promise<KmsEnvelopeDto>;
  decrypt(input: KmsDecryptInput): Promise<Uint8Array>;
  rotate(input: KmsRotateInput): Promise<KmsEnvelopeDto>;
}
