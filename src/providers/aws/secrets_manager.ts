import type { secretStore } from "takosumi-contract";
import type { AwsSecretsClient } from "./clients.ts";
import {
  type AwsRetryConfig,
  classifyAwsError,
  detectDrift,
  type DriftField,
  withRetry,
} from "./support.ts";

/**
 * `provider.aws.secrets-manager@v1` — Secrets Manager secret lifecycle
 * (create / put-value / rotate / delete) on top of an operator-injected
 * {@link AwsSecretsClient}. The kernel only consumes declarative descriptors;
 * the AWS SDK never enters the kernel.
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx
 *  - `not-found` mapped to `undefined` for `describeSecret`
 *  - paginated `listAllSecrets`
 *  - drift detection over (kmsKeyArn, rotationEnabled, rotationIntervalDays)
 */
export interface AwsSecretDescriptor {
  readonly arn: string;
  readonly name: string;
  readonly description?: string;
  readonly kmsKeyArn?: string;
  readonly versionId?: string;
  readonly tags?: Record<string, string>;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly rotationEnabled?: boolean;
  readonly rotationLambdaArn?: string;
  readonly rotationIntervalDays?: number;
}

export interface AwsSecretCreateInput {
  readonly name: string;
  readonly description?: string;
  readonly kmsKeyArn?: string;
  readonly initialValue?: string;
  readonly tags?: Record<string, string>;
}

export interface AwsSecretDescribeInput {
  readonly name: string;
}

export interface AwsSecretDeleteInput {
  readonly name: string;
  readonly recoveryWindowDays?: number;
  readonly forceWithoutRecovery?: boolean;
}

export interface AwsSecretRotationConfig {
  readonly name: string;
  readonly rotationLambdaArn: string;
  readonly rotationIntervalDays: number;
  readonly rotateImmediately?: boolean;
}

export interface AwsSecretListInput {
  readonly nextToken?: string;
  readonly limit?: number;
}

export interface AwsSecretListPage {
  readonly items: readonly AwsSecretDescriptor[];
  readonly nextToken?: string;
}

export interface AwsSecretsLifecycleClient {
  createSecret(
    input: AwsSecretCreateInput,
  ): Promise<AwsSecretDescriptor>;
  describeSecret(
    input: AwsSecretDescribeInput,
  ): Promise<AwsSecretDescriptor | undefined>;
  deleteSecret(input: AwsSecretDeleteInput): Promise<boolean>;
  configureRotation?(
    input: AwsSecretRotationConfig,
  ): Promise<AwsSecretDescriptor>;
  listSecrets?(input: AwsSecretListInput): Promise<AwsSecretListPage>;
}

export interface AwsSecretsManagerProviderOptions {
  readonly lifecycle: AwsSecretsLifecycleClient;
  readonly secrets?: AwsSecretsClient;
  readonly retry?: Partial<AwsRetryConfig>;
}

export class AwsSecretsManagerProvider {
  readonly #lifecycle: AwsSecretsLifecycleClient;
  readonly #secrets?: AwsSecretsClient;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsSecretsManagerProviderOptions) {
    this.#lifecycle = options.lifecycle;
    this.#secrets = options.secrets;
    this.#retry = options.retry;
  }

  createSecret(
    input: AwsSecretCreateInput,
  ): Promise<AwsSecretDescriptor> {
    return withRetry(
      "aws-secrets-create",
      () => this.#lifecycle.createSecret(input),
      this.#retry,
    );
  }

  async describeSecret(
    input: AwsSecretDescribeInput,
  ): Promise<AwsSecretDescriptor | undefined> {
    try {
      return await withRetry(
        "aws-secrets-describe",
        () => this.#lifecycle.describeSecret(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  deleteSecret(input: AwsSecretDeleteInput): Promise<boolean> {
    return withRetry(
      "aws-secrets-delete",
      () => this.#lifecycle.deleteSecret(input),
      this.#retry,
    );
  }

  async configureRotation(
    input: AwsSecretRotationConfig,
  ): Promise<AwsSecretDescriptor> {
    if (!this.#lifecycle.configureRotation) {
      throw new Error(
        "AwsSecretsLifecycleClient does not implement configureRotation",
      );
    }
    return await withRetry(
      "aws-secrets-configure-rotation",
      () => this.#lifecycle.configureRotation!(input),
      this.#retry,
    );
  }

  /** Paginated secret enumeration. Each page is retried independently. */
  async listAllSecrets(): Promise<readonly AwsSecretDescriptor[]> {
    if (!this.#lifecycle.listSecrets) {
      throw new Error(
        "AwsSecretsLifecycleClient does not implement listSecrets; cannot enumerate",
      );
    }
    const out: AwsSecretDescriptor[] = [];
    let token: string | undefined;
    do {
      const page = await withRetry(
        "aws-secrets-list",
        () => this.#lifecycle.listSecrets!({ nextToken: token }),
        this.#retry,
      );
      for (const item of page.items) out.push(item);
      token = page.nextToken;
    } while (token !== undefined);
    return out;
  }

  /**
   * Drift detection — compares desired vs observed secret metadata.
   */
  async detectDrift(
    desired: {
      readonly name: string;
      readonly kmsKeyArn?: string;
      readonly rotationEnabled?: boolean;
      readonly rotationIntervalDays?: number;
    },
  ): Promise<readonly DriftField[]> {
    const observed = await this.describeSecret({ name: desired.name });
    if (!observed) {
      return [{ path: "$", desired, observed: undefined }];
    }
    return detectDrift(
      {
        kmsKeyArn: desired.kmsKeyArn,
        rotationEnabled: desired.rotationEnabled,
        rotationIntervalDays: desired.rotationIntervalDays,
      },
      {
        kmsKeyArn: observed.kmsKeyArn,
        rotationEnabled: observed.rotationEnabled,
        rotationIntervalDays: observed.rotationIntervalDays,
      },
    );
  }

  putSecretValue(input: {
    readonly secretName: string;
    readonly value: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<secretStore.SecretRecord> {
    return withRetry(
      "aws-secrets-put-value",
      () => this.#requireSecrets().putSecretValue(input),
      this.#retry,
    );
  }

  async getSecretValue(input: {
    readonly secretName: string;
    readonly versionId: string;
  }): Promise<string | undefined> {
    try {
      return await withRetry(
        "aws-secrets-get-value",
        () => this.#requireSecrets().getSecretValue(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  async getLatestSecret(
    secretName: string,
  ): Promise<secretStore.SecretRecord | undefined> {
    try {
      return await withRetry(
        "aws-secrets-get-latest",
        () => this.#requireSecrets().getLatestSecret(secretName),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  listSecretVersions(): Promise<readonly secretStore.SecretRecord[]> {
    return withRetry(
      "aws-secrets-list-versions",
      () => this.#requireSecrets().listSecretVersions(),
      this.#retry,
    );
  }

  deleteSecretVersion(input: {
    readonly secretName: string;
    readonly versionId: string;
  }): Promise<boolean> {
    return withRetry(
      "aws-secrets-delete-version",
      () => this.#requireSecrets().deleteSecretVersion(input),
      this.#retry,
    );
  }

  #requireSecrets(): AwsSecretsClient {
    if (!this.#secrets) {
      throw new Error(
        "AwsSecretsManagerProvider was not constructed with a secrets client; inject AwsSecretsClient to access secret values",
      );
    }
    return this.#secrets;
  }
}
