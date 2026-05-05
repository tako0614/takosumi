import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import {
  type AwsRetryConfig,
  buildOperation,
  classifyAwsError,
  compactRecord,
  detectDrift,
  type DriftField,
  runAwsCall,
} from "./support.ts";

/**
 * AWS ECS Fargate task / service materializer input. Operator is responsible
 * for translating a {@link RuntimeDesiredState} into a concrete ECS task
 * definition + service. The kernel only consumes the resulting plan.
 */
export interface AwsEcsFargateApplyInput {
  readonly desiredState: RuntimeDesiredState;
  readonly clusterName?: string;
  readonly serviceName?: string;
  readonly taskFamily?: string;
  readonly taskRoleArn?: string;
  readonly executionRoleArn?: string;
  readonly subnetIds?: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly assignPublicIp?: boolean;
  readonly desiredCount?: number;
  readonly artifactBucket?: string;
  readonly requestedAt: string;
}

export interface AwsEcsFargateApplyResult {
  readonly serviceArn: string;
  readonly taskDefinitionArn?: string;
  readonly clusterArn?: string;
  readonly serviceName?: string;
  readonly objectAddress?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface AwsEcsFargateDeleteInput {
  readonly clusterName: string;
  readonly serviceName: string;
  readonly force?: boolean;
}

export interface AwsEcsFargateDeleteResult {
  readonly deleted: boolean;
}

/** Observed state of an ECS service, used for drift detection. */
export interface AwsEcsFargateServiceObservation {
  readonly serviceArn: string;
  readonly clusterArn: string;
  readonly serviceName: string;
  readonly taskDefinitionArn?: string;
  readonly desiredCount?: number;
  readonly runningCount?: number;
  readonly assignPublicIp?: boolean;
  readonly subnetIds?: readonly string[];
  readonly securityGroupIds?: readonly string[];
}

export interface AwsEcsFargateDescribeInput {
  readonly clusterName: string;
  readonly serviceName: string;
}

export interface AwsEcsFargateClient {
  applyEcsService(
    input: AwsEcsFargateApplyInput,
  ): Promise<AwsEcsFargateApplyResult>;
  deleteEcsService?(
    input: AwsEcsFargateDeleteInput,
  ): Promise<AwsEcsFargateDeleteResult>;
  describeEcsService?(
    input: AwsEcsFargateDescribeInput,
  ): Promise<AwsEcsFargateServiceObservation | undefined>;
}

export interface AwsEcsFargateProviderOptions {
  readonly client: AwsEcsFargateClient;
  readonly clusterName?: string;
  readonly serviceName?: string;
  readonly taskFamily?: string;
  readonly taskRoleArn?: string;
  readonly executionRoleArn?: string;
  readonly subnetIds?: readonly string[];
  readonly securityGroupIds?: readonly string[];
  readonly assignPublicIp?: boolean;
  readonly desiredCount?: number;
  readonly artifactBucket?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly retry?: Partial<AwsRetryConfig>;
}

/**
 * `provider.aws.ecs-fargate@v1` materializer. Implements the kernel-facing
 * `ProviderMaterializer` interface and consumes an operator-injected
 * {@link AwsEcsFargateClient}; the kernel never imports the AWS SDK directly.
 *
 * Production-grade behaviour:
 *  - retry / backoff on throttling / 5xx
 *  - timeout per AWS call (30s default)
 *  - condition emission via {@link buildOperation} with `errorCategory` reason
 *  - drift detection between desired and observed service state
 *  - idempotency: same input → same operation kind + target tuple
 */
export class AwsEcsFargateProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: AwsEcsFargateClient;
  readonly #options: AwsEcsFargateProviderOptions;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #retry?: Partial<AwsRetryConfig>;

  constructor(options: AwsEcsFargateProviderOptions) {
    this.#client = options.client;
    this.#options = options;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#retry = options.retry;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const targetName = this.#options.serviceName ?? desiredState.appName;
    const outcome = await runAwsCall(
      {
        kind: "aws-ecs-fargate-apply",
        target: targetName,
        desiredStateId: desiredState.id,
        command: [
          "aws",
          "ecs",
          "update-service",
          "--cluster",
          this.#options.clusterName ?? "",
          "--service",
          targetName,
        ],
        details: compactRecord({
          clusterName: this.#options.clusterName,
          taskFamily: this.#options.taskFamily,
          desiredCount: this.#options.desiredCount,
          workloadCount: desiredState.workloads.length,
          resourceCount: desiredState.resources.length,
          routeCount: desiredState.routes.length,
        }),
        retry: this.#retry,
      },
      { clock: this.#clock, idGenerator: this.#idGenerator },
      () =>
        this.#client.applyEcsService({
          desiredState: structuredClone(desiredState),
          clusterName: this.#options.clusterName,
          serviceName: this.#options.serviceName,
          taskFamily: this.#options.taskFamily,
          taskRoleArn: this.#options.taskRoleArn,
          executionRoleArn: this.#options.executionRoleArn,
          subnetIds: this.#options.subnetIds,
          securityGroupIds: this.#options.securityGroupIds,
          assignPublicIp: this.#options.assignPublicIp,
          desiredCount: this.#options.desiredCount,
          artifactBucket: this.#options.artifactBucket,
          requestedAt: this.#clock().toISOString(),
        }),
    );

    if (outcome.status === "failed") {
      this.#operations.push(outcome.operation);
      return deepFreeze({
        id: `provider_plan_${this.#idGenerator()}`,
        provider: "aws",
        desiredStateId: desiredState.id,
        recordedAt: outcome.operation.recordedAt,
        createdByOperationId: outcome.operation.id,
        operations: [outcome.operation],
      });
    }

    const result = outcome.result;
    const completedAt = outcome.operation.recordedAt;
    // Re-shape the success operation to include result-derived fields
    // (serviceArn, taskDefinitionArn, objectAddress).
    const operation: provider.ProviderOperation = {
      ...outcome.operation,
      targetId: result.serviceArn,
      targetName: result.serviceName ?? targetName,
      details: compactRecord({
        ...outcome.operation.details,
        clusterArn: result.clusterArn,
        serviceArn: result.serviceArn,
        serviceName: result.serviceName,
        taskDefinitionArn: result.taskDefinitionArn,
        objectAddress: result.objectAddress,
        artifactBucket: this.#options.artifactBucket,
      }),
      execution: result.stderr
        ? {
          ...outcome.operation.execution!,
          status: "failed",
          code: 1,
          stderr: result.stderr,
          stdout: result.stdout,
        }
        : {
          ...outcome.operation.execution!,
          stdout: result.stdout,
          stderr: result.stderr,
        },
    };
    this.#operations.push(operation, ...(result.operations ?? []));
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "aws",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      objectAddress: result.objectAddress,
      createdByOperationId: operation.id,
      operations: [operation, ...(result.operations ?? [])],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  /**
   * Deletes the ECS service. Wrapped with retry / timeout. If the underlying
   * client does not implement deletion, an operation marked `failed` with
   * `validation` category is emitted instead of throwing, so the kernel can
   * surface a clear condition.
   */
  async deleteService(
    input: AwsEcsFargateDeleteInput,
    desiredStateId = "unknown",
  ): Promise<AwsEcsFargateDeleteResult> {
    if (!this.#client.deleteEcsService) {
      const startedAt = this.#clock().toISOString();
      const operation = buildOperation({
        id: `provider_op_${this.#idGenerator()}`,
        kind: "aws-ecs-fargate-delete",
        desiredStateId,
        targetName: input.serviceName,
        command: [
          "aws",
          "ecs",
          "delete-service",
          "--cluster",
          input.clusterName,
          "--service",
          input.serviceName,
        ],
        details: { reason: "client.deleteEcsService unavailable" },
        startedAt,
        completedAt: startedAt,
        status: "failed",
        errorCategory: "validation",
        errorMessage:
          "AwsEcsFargateClient does not implement deleteEcsService; cannot delete service",
      });
      this.#operations.push(operation);
      throw new Error(
        "AwsEcsFargateClient does not implement deleteEcsService; cannot delete service",
      );
    }
    const outcome = await runAwsCall(
      {
        kind: "aws-ecs-fargate-delete",
        target: input.serviceName,
        desiredStateId,
        command: [
          "aws",
          "ecs",
          "delete-service",
          "--cluster",
          input.clusterName,
          "--service",
          input.serviceName,
        ],
        details: { force: input.force === true },
        retry: this.#retry,
      },
      { clock: this.#clock, idGenerator: this.#idGenerator },
      () => this.#client.deleteEcsService!(input),
    );
    this.#operations.push(outcome.operation);
    if (outcome.status === "failed") throw outcome.error;
    return outcome.result;
  }

  /**
   * Compares observed ECS service state to the desired options and returns
   * the list of fields that differ. `undefined` desired fields are ignored
   * so partial configurations do not produce false positives.
   */
  async detectDrift(
    input: AwsEcsFargateDescribeInput,
  ): Promise<readonly DriftField[]> {
    if (!this.#client.describeEcsService) {
      throw new Error(
        "AwsEcsFargateClient does not implement describeEcsService; cannot detect drift",
      );
    }
    const observed = await this.#client.describeEcsService(input);
    if (!observed) return [];
    const desired = compactRecord({
      desiredCount: this.#options.desiredCount,
      assignPublicIp: this.#options.assignPublicIp,
      subnetIds: this.#options.subnetIds,
      securityGroupIds: this.#options.securityGroupIds,
    });
    const observedSubset = compactRecord({
      desiredCount: observed.desiredCount,
      assignPublicIp: observed.assignPublicIp,
      subnetIds: observed.subnetIds,
      securityGroupIds: observed.securityGroupIds,
    });
    return detectDrift(desired, observedSubset);
  }
}

// Re-export classifier for downstream tests / docs.
export { classifyAwsError };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
