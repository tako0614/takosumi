import type { kms } from "takosumi-contract";
import type { AwsKmsClient } from "./clients.ts";
import {
  type AwsRetryConfig,
  classifyAwsError,
  detectDrift,
  type DriftField,
  withRetry,
} from "./support.ts";

/**
 * `provider.aws.kms@v1` — KMS key lifecycle (create/describe/disable) plus
 * envelope encrypt / decrypt / rotate forwarding to an operator-injected
 * {@link AwsKmsClient}.
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx
 *  - `not-found` is mapped to `undefined` for `describeKey`
 *  - `listKeys` paginated
 *  - drift detection over (state, keyUsage, multiRegion)
 */
export type AwsKmsKeyState =
  | "Enabled"
  | "Disabled"
  | "PendingDeletion"
  | "PendingImport"
  | "Unavailable";

export type AwsKmsKeyUsage =
  | "ENCRYPT_DECRYPT"
  | "SIGN_VERIFY"
  | "GENERATE_VERIFY_MAC";

export interface AwsKmsKeyDescriptor {
  readonly keyId: string;
  readonly arn: string;
  readonly aliasName?: string;
  readonly state: AwsKmsKeyState;
  readonly keyUsage?: AwsKmsKeyUsage;
  readonly keySpec?: string;
  readonly multiRegion?: boolean;
  readonly description?: string;
  readonly tags?: Record<string, string>;
}

export interface AwsKmsCreateKeyInput {
  readonly aliasName?: string;
  readonly description?: string;
  readonly keyUsage?: AwsKmsKeyUsage;
  readonly keySpec?: string;
  readonly multiRegion?: boolean;
  readonly tags?: Record<string, string>;
  readonly policy?: string;
}

export interface AwsKmsDescribeKeyInput {
  readonly keyId: string;
}

export interface AwsKmsScheduleDeletionInput {
  readonly keyId: string;
  readonly pendingWindowDays?: number;
}

export interface AwsKmsListKeysInput {
  readonly nextToken?: string;
  readonly limit?: number;
}

export interface AwsKmsListKeysPage {
  readonly items: readonly AwsKmsKeyDescriptor[];
  readonly nextToken?: string;
}

export interface AwsKmsLifecycleClient {
  createKey(input: AwsKmsCreateKeyInput): Promise<AwsKmsKeyDescriptor>;
  describeKey(
    input: AwsKmsDescribeKeyInput,
  ): Promise<AwsKmsKeyDescriptor | undefined>;
  enableKey?(input: AwsKmsDescribeKeyInput): Promise<AwsKmsKeyDescriptor>;
  disableKey?(input: AwsKmsDescribeKeyInput): Promise<AwsKmsKeyDescriptor>;
  scheduleDeletion?(
    input: AwsKmsScheduleDeletionInput,
  ): Promise<AwsKmsKeyDescriptor>;
  listKeys?(input: AwsKmsListKeysInput): Promise<AwsKmsListKeysPage>;
}

export interface AwsKmsProviderOptions {
  readonly lifecycle: AwsKmsLifecycleClient;
  readonly envelope?: AwsKmsClient;
  readonly retry?: Partial<AwsRetryConfig>;
}

export class AwsKmsProvider {
  readonly #lifecycle: AwsKmsLifecycleClient;
  readonly #envelope?: AwsKmsClient;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsKmsProviderOptions) {
    this.#lifecycle = options.lifecycle;
    this.#envelope = options.envelope;
    this.#retry = options.retry;
  }

  createKey(input: AwsKmsCreateKeyInput): Promise<AwsKmsKeyDescriptor> {
    return withRetry(
      "aws-kms-create-key",
      () => this.#lifecycle.createKey(input),
      this.#retry,
    );
  }

  async describeKey(
    input: AwsKmsDescribeKeyInput,
  ): Promise<AwsKmsKeyDescriptor | undefined> {
    try {
      return await withRetry(
        "aws-kms-describe-key",
        () => this.#lifecycle.describeKey(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  async enableKey(input: AwsKmsDescribeKeyInput): Promise<AwsKmsKeyDescriptor> {
    if (!this.#lifecycle.enableKey) {
      throw new Error(
        "AwsKmsLifecycleClient does not implement enableKey; cannot enable",
      );
    }
    return await withRetry(
      "aws-kms-enable-key",
      () => this.#lifecycle.enableKey!(input),
      this.#retry,
    );
  }

  async disableKey(
    input: AwsKmsDescribeKeyInput,
  ): Promise<AwsKmsKeyDescriptor> {
    if (!this.#lifecycle.disableKey) {
      throw new Error(
        "AwsKmsLifecycleClient does not implement disableKey; cannot disable",
      );
    }
    return await withRetry(
      "aws-kms-disable-key",
      () => this.#lifecycle.disableKey!(input),
      this.#retry,
    );
  }

  async scheduleDeletion(
    input: AwsKmsScheduleDeletionInput,
  ): Promise<AwsKmsKeyDescriptor> {
    if (!this.#lifecycle.scheduleDeletion) {
      throw new Error(
        "AwsKmsLifecycleClient does not implement scheduleDeletion",
      );
    }
    return await withRetry(
      "aws-kms-schedule-deletion",
      () => this.#lifecycle.scheduleDeletion!(input),
      this.#retry,
    );
  }

  /**
   * Paginated key enumeration. Each page is retried independently.
   */
  async listAllKeys(): Promise<readonly AwsKmsKeyDescriptor[]> {
    if (!this.#lifecycle.listKeys) {
      throw new Error(
        "AwsKmsLifecycleClient does not implement listKeys; cannot enumerate",
      );
    }
    const out: AwsKmsKeyDescriptor[] = [];
    let token: string | undefined;
    do {
      const page = await withRetry(
        "aws-kms-list-keys",
        () => this.#lifecycle.listKeys!({ nextToken: token }),
        this.#retry,
      );
      for (const item of page.items) out.push(item);
      token = page.nextToken;
    } while (token !== undefined);
    return out;
  }

  /**
   * Drift detection — compares desired KMS create input to observed key.
   */
  async detectDrift(
    desired: AwsKmsCreateKeyInput & { readonly keyId: string },
  ): Promise<readonly DriftField[]> {
    const observed = await this.describeKey({ keyId: desired.keyId });
    if (!observed) {
      return [{ path: "$", desired, observed: undefined }];
    }
    return detectDrift(
      {
        keyUsage: desired.keyUsage,
        keySpec: desired.keySpec,
        multiRegion: desired.multiRegion,
        description: desired.description,
      },
      {
        keyUsage: observed.keyUsage,
        keySpec: observed.keySpec,
        multiRegion: observed.multiRegion,
        description: observed.description,
      },
    );
  }

  describeActiveEnvelopeKey(): Promise<kms.KmsKeyRefDto> {
    return withRetry(
      "aws-kms-describe-active",
      () => this.#requireEnvelope().describeActiveKey(),
      this.#retry,
    );
  }

  encryptEnvelope(input: kms.KmsEncryptInput): Promise<kms.KmsEnvelopeDto> {
    return withRetry(
      "aws-kms-encrypt-envelope",
      () => this.#requireEnvelope().encryptEnvelope(input),
      this.#retry,
    );
  }

  decryptEnvelope(input: kms.KmsDecryptInput): Promise<Uint8Array> {
    return withRetry(
      "aws-kms-decrypt-envelope",
      () => this.#requireEnvelope().decryptEnvelope(input),
      this.#retry,
    );
  }

  rotateEnvelope(input: kms.KmsRotateInput): Promise<kms.KmsEnvelopeDto> {
    return withRetry(
      "aws-kms-rotate-envelope",
      () => this.#requireEnvelope().rotateEnvelope(input),
      this.#retry,
    );
  }

  #requireEnvelope(): AwsKmsClient {
    if (!this.#envelope) {
      throw new Error(
        "AwsKmsProvider was not constructed with an envelope client; inject AwsKmsClient to wrap data keys",
      );
    }
    return this.#envelope;
  }
}
