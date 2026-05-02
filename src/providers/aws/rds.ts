import {
  type AwsRetryConfig,
  classifyAwsError,
  detectDrift,
  type DriftField,
  withRetry,
} from "./support.ts";

/**
 * `provider.aws.rds@v1` — RDS (Aurora / Postgres / MySQL) instance lifecycle.
 *
 * Operator-injected client owns the actual SDK calls. The kernel only consumes
 * declarative descriptors:
 *   - {@link AwsRdsCreateInput}: create instance
 *   - {@link AwsRdsDescribeInput}: read endpoint / status
 *   - {@link AwsRdsDeleteInput}: delete (with snapshot)
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx (`AwsRetryConfig`)
 *  - timeout per call (default 30s)
 *  - `not-found` is mapped to `undefined` for `describeInstance` rather than
 *    throwing, matching kernel idempotency semantics
 *  - drift detection comparing desired and observed instance descriptors
 */
export type AwsRdsEngine =
  | "aurora-postgresql"
  | "aurora-mysql"
  | "postgres"
  | "mysql"
  | "mariadb";

export type AwsRdsInstanceStatus =
  | "creating"
  | "available"
  | "modifying"
  | "deleting"
  | "failed"
  | "stopped";

export interface AwsRdsCreateInput {
  readonly instanceIdentifier: string;
  readonly engine: AwsRdsEngine;
  readonly engineVersion?: string;
  readonly instanceClass: string;
  readonly allocatedStorageGb?: number;
  readonly databaseName?: string;
  readonly masterUsername: string;
  readonly masterPasswordSecretArn?: string;
  readonly masterPassword?: string;
  readonly subnetGroupName?: string;
  readonly vpcSecurityGroupIds?: readonly string[];
  readonly publiclyAccessible?: boolean;
  readonly multiAz?: boolean;
  readonly backupRetentionDays?: number;
  readonly storageEncrypted?: boolean;
  readonly kmsKeyArn?: string;
  readonly tags?: Record<string, string>;
}

export interface AwsRdsInstanceDescriptor {
  readonly instanceIdentifier: string;
  readonly arn?: string;
  readonly endpoint?: string;
  readonly port?: number;
  readonly engine?: AwsRdsEngine;
  readonly engineVersion?: string;
  readonly status: AwsRdsInstanceStatus;
  readonly multiAz?: boolean;
  readonly availabilityZone?: string;
  readonly databaseName?: string;
  readonly masterUsername?: string;
  readonly tags?: Record<string, string>;
}

export interface AwsRdsDescribeInput {
  readonly instanceIdentifier: string;
}

export interface AwsRdsDeleteInput {
  readonly instanceIdentifier: string;
  readonly skipFinalSnapshot?: boolean;
  readonly finalSnapshotIdentifier?: string;
  readonly deleteAutomatedBackups?: boolean;
}

export interface AwsRdsClient {
  createInstance(input: AwsRdsCreateInput): Promise<AwsRdsInstanceDescriptor>;
  describeInstance(
    input: AwsRdsDescribeInput,
  ): Promise<AwsRdsInstanceDescriptor | undefined>;
  deleteInstance(input: AwsRdsDeleteInput): Promise<boolean>;
  waitForAvailable?(
    input: AwsRdsDescribeInput,
    timeoutMs?: number,
  ): Promise<AwsRdsInstanceDescriptor>;
  listInstances?(
    input: { readonly nextToken?: string; readonly limit?: number },
  ): Promise<{
    readonly items: readonly AwsRdsInstanceDescriptor[];
    readonly nextToken?: string;
  }>;
}

export interface AwsRdsProviderOptions {
  readonly client: AwsRdsClient;
  readonly retry?: Partial<AwsRetryConfig>;
}

/**
 * Thin wrapper around an operator-injected {@link AwsRdsClient}. This is not
 * a `ProviderMaterializer` because RDS instances are managed as declarative
 * resources (descriptor `provider.aws.rds@v1`) by the kernel resource
 * subsystem, not as runtime workloads.
 */
export class AwsRdsProvider {
  readonly #client: AwsRdsClient;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsRdsProviderOptions) {
    this.#client = options.client;
    this.#retry = options.retry;
  }

  createInstance(
    input: AwsRdsCreateInput,
  ): Promise<AwsRdsInstanceDescriptor> {
    return withRetry(
      "aws-rds-create",
      () => this.#client.createInstance(input),
      this.#retry,
    );
  }

  /**
   * Returns the descriptor or `undefined` for `not-found`. Other error
   * categories propagate after retry.
   */
  async describeInstance(
    input: AwsRdsDescribeInput,
  ): Promise<AwsRdsInstanceDescriptor | undefined> {
    try {
      return await withRetry(
        "aws-rds-describe",
        () => this.#client.describeInstance(input),
        this.#retry,
      );
    } catch (error) {
      if (classifyAwsError(error) === "not-found") return undefined;
      throw error;
    }
  }

  deleteInstance(input: AwsRdsDeleteInput): Promise<boolean> {
    return withRetry(
      "aws-rds-delete",
      () => this.#client.deleteInstance(input),
      this.#retry,
    );
  }

  async resolveEndpoint(
    instanceIdentifier: string,
  ): Promise<{ readonly endpoint: string; readonly port: number }> {
    const descriptor = await this.describeInstance({ instanceIdentifier });
    if (!descriptor) {
      throw new Error(`aws rds instance "${instanceIdentifier}" not found`);
    }
    if (!descriptor.endpoint || descriptor.port === undefined) {
      throw new Error(
        `aws rds instance "${instanceIdentifier}" is in status ${descriptor.status} and has no endpoint yet`,
      );
    }
    return { endpoint: descriptor.endpoint, port: descriptor.port };
  }

  async waitForAvailable(
    instanceIdentifier: string,
    timeoutMs?: number,
  ): Promise<AwsRdsInstanceDescriptor> {
    if (this.#client.waitForAvailable) {
      return await this.#client.waitForAvailable(
        { instanceIdentifier },
        timeoutMs,
      );
    }
    const descriptor = await this.describeInstance({ instanceIdentifier });
    if (!descriptor) {
      throw new Error(`aws rds instance "${instanceIdentifier}" not found`);
    }
    if (descriptor.status !== "available") {
      throw new Error(
        `aws rds instance "${instanceIdentifier}" is not available (status=${descriptor.status}); inject AwsRdsClient.waitForAvailable to poll`,
      );
    }
    return descriptor;
  }

  /**
   * Lists all instances using paginated `listInstances`. Returns the
   * collected array. Each page is wrapped in retry / timeout.
   */
  async listInstances(): Promise<readonly AwsRdsInstanceDescriptor[]> {
    if (!this.#client.listInstances) {
      throw new Error(
        "AwsRdsClient does not implement listInstances; cannot enumerate",
      );
    }
    const out: AwsRdsInstanceDescriptor[] = [];
    let token: string | undefined;
    do {
      const page = await withRetry(
        "aws-rds-list",
        () => this.#client.listInstances!({ nextToken: token }),
        this.#retry,
      );
      for (const item of page.items) out.push(item);
      token = page.nextToken;
    } while (token !== undefined);
    return out;
  }

  /**
   * Drift detection — compares desired RDS create input to observed
   * descriptor. Returns the list of fields that differ. `not-found` is
   * surfaced as a single drift entry with path `$` (so the caller can decide
   * to recreate).
   */
  async detectDrift(
    desired: AwsRdsCreateInput,
  ): Promise<readonly DriftField[]> {
    const observed = await this.describeInstance({
      instanceIdentifier: desired.instanceIdentifier,
    });
    if (!observed) {
      return [{ path: "$", desired, observed: undefined }];
    }
    const desiredSubset = {
      instanceIdentifier: desired.instanceIdentifier,
      engine: desired.engine,
      engineVersion: desired.engineVersion,
      databaseName: desired.databaseName,
      masterUsername: desired.masterUsername,
      multiAz: desired.multiAz,
    };
    const observedSubset = {
      instanceIdentifier: observed.instanceIdentifier,
      engine: observed.engine,
      engineVersion: observed.engineVersion,
      databaseName: observed.databaseName,
      masterUsername: observed.masterUsername,
      multiAz: observed.multiAz,
    };
    return detectDrift(desiredSubset, observedSubset);
  }
}
