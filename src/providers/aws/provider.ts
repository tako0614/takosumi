import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  type AwsEcsFargateClient,
  AwsEcsFargateProviderMaterializer,
  type AwsEcsFargateProviderOptions,
} from "./ecs_fargate.ts";
import { AwsKmsProvider, type AwsKmsProviderOptions } from "./kms.ts";
import { AwsRdsProvider, type AwsRdsProviderOptions } from "./rds.ts";
import { AwsS3Provider, type AwsS3ProviderOptions } from "./s3.ts";
import {
  AwsSecretsManagerProvider,
  type AwsSecretsManagerProviderOptions,
} from "./secrets_manager.ts";
import { AwsSqsProvider, type AwsSqsProviderOptions } from "./sqs.ts";

/**
 * Aggregates the AWS provider plugins behind a single entry point. The kernel
 * only consumes the {@link provider.ProviderMaterializer} surface; the rest of
 * the providers are read by the resource subsystem which already addresses
 * them via descriptor IDs (see `provider.aws.<service>@v1`).
 *
 * The kernel never imports the AWS SDK directly: every entry point is an
 * operator-injected client (or HTTP gateway client over JSON).
 */
export interface AwsProviderMaterializerOptions {
  readonly ecsFargate?: AwsEcsFargateProviderOptions;
  readonly s3?: AwsS3ProviderOptions;
  readonly sqs?: AwsSqsProviderOptions;
  readonly kms?: AwsKmsProviderOptions;
  readonly rds?: AwsRdsProviderOptions;
  readonly secretsManager?: AwsSecretsManagerProviderOptions;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

/**
 * `provider.aws@v1` materializer. Delegates runtime workload materialization
 * to the ECS Fargate sub-materializer when available, and otherwise emits a
 * fallback skipped operation so deployments degrade safely.
 */
export class AwsProviderMaterializer implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #ecsFargate?: AwsEcsFargateProviderMaterializer;
  readonly #s3?: AwsS3Provider;
  readonly #sqs?: AwsSqsProvider;
  readonly #kms?: AwsKmsProvider;
  readonly #rds?: AwsRdsProvider;
  readonly #secretsManager?: AwsSecretsManagerProvider;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: AwsProviderMaterializerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    if (options.ecsFargate) {
      this.#ecsFargate = new AwsEcsFargateProviderMaterializer({
        clock: this.#clock,
        idGenerator: this.#idGenerator,
        ...options.ecsFargate,
      });
    }
    if (options.s3) this.#s3 = new AwsS3Provider(options.s3);
    if (options.sqs) this.#sqs = new AwsSqsProvider(options.sqs);
    if (options.kms) this.#kms = new AwsKmsProvider(options.kms);
    if (options.rds) this.#rds = new AwsRdsProvider(options.rds);
    if (options.secretsManager) {
      this.#secretsManager = new AwsSecretsManagerProvider(
        options.secretsManager,
      );
    }
  }

  /** ECS Fargate sub-materializer accessor (descriptor `provider.aws.ecs-fargate@v1`). */
  get ecsFargate(): AwsEcsFargateProviderMaterializer | undefined {
    return this.#ecsFargate;
  }

  /** S3 sub-provider accessor (descriptor `provider.aws.s3@v1`). */
  get s3(): AwsS3Provider | undefined {
    return this.#s3;
  }

  /** SQS sub-provider accessor (descriptor `provider.aws.sqs@v1`). */
  get sqs(): AwsSqsProvider | undefined {
    return this.#sqs;
  }

  /** KMS sub-provider accessor (descriptor `provider.aws.kms@v1`). */
  get kms(): AwsKmsProvider | undefined {
    return this.#kms;
  }

  /** RDS sub-provider accessor (descriptor `provider.aws.rds@v1`). */
  get rds(): AwsRdsProvider | undefined {
    return this.#rds;
  }

  /** Secrets Manager sub-provider accessor (descriptor `provider.aws.secrets-manager@v1`). */
  get secretsManager(): AwsSecretsManagerProvider | undefined {
    return this.#secretsManager;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    if (this.#ecsFargate) {
      const plan = await this.#ecsFargate.materialize(desiredState);
      this.#operations.push(...plan.operations);
      return plan;
    }
    return this.#emitSkippedPlan(desiredState);
  }

  async listRecordedOperations(): Promise<
    readonly provider.ProviderOperation[]
  > {
    if (this.#ecsFargate) {
      const downstream = await this.#ecsFargate.listRecordedOperations();
      return [...this.#operations, ...downstream];
    }
    return [...this.#operations];
  }

  async clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    if (this.#ecsFargate) {
      await this.#ecsFargate.clearRecordedOperations();
    }
  }

  #emitSkippedPlan(
    desiredState: RuntimeDesiredState,
  ): provider.ProviderMaterializationPlan {
    const startedAt = this.#clock().toISOString();
    const completedAt = startedAt;
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "aws-provider-skipped",
      provider: "aws",
      desiredStateId: desiredState.id,
      targetName: desiredState.appName,
      command: ["aws", "provider", "skip"],
      details: {
        reason: "no AwsEcsFargateProviderOptions configured",
        workloadCount: desiredState.workloads.length,
        resourceCount: desiredState.resources.length,
        routeCount: desiredState.routes.length,
      },
      recordedAt: completedAt,
      execution: {
        status: "skipped",
        code: 0,
        skipped: true,
        startedAt,
        completedAt,
      },
    };
    this.#operations.push(operation);
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "aws",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      createdByOperationId: operation.id,
      operations: [operation],
    });
  }
}

/**
 * Aggregate descriptor ID list for documentation / capability negotiation.
 * The descriptor schemas are consumed by the resource subsystem; this module
 * exports the ID set so shape-provider authors can pin a closure
 * deterministically.
 */
export const AWS_PROVIDER_DESCRIPTOR_IDS = [
  "provider.aws.ecs-fargate@v1",
  "provider.aws.rds@v1",
  "provider.aws.s3@v1",
  "provider.aws.sqs@v1",
  "provider.aws.kms@v1",
  "provider.aws.secrets-manager@v1",
] as const;

export type AwsProviderDescriptorId =
  typeof AWS_PROVIDER_DESCRIPTOR_IDS[number];

export function createAwsProviderMaterializer(
  options: AwsProviderMaterializerOptions,
): AwsProviderMaterializer {
  return new AwsProviderMaterializer(options);
}

/**
 * Convenience: creates a {@link AwsProviderMaterializer} that is wired only to
 * the ECS Fargate sub-materializer. This matches the most common AWS profile
 * (single ECS service per app) and is the recommended starting point.
 */
export function createAwsEcsFargateProviderMaterializer(
  options:
    & { readonly client: AwsEcsFargateClient }
    & Omit<AwsEcsFargateProviderOptions, "client">
    & Pick<
      AwsProviderMaterializerOptions,
      "clock" | "idGenerator"
    >,
): AwsProviderMaterializer {
  const { clock, idGenerator, ...ecsFargate } = options;
  return new AwsProviderMaterializer({
    ecsFargate,
    clock,
    idGenerator,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
