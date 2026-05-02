import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

export interface CloudflareWorkerContainerDeploymentInput {
  readonly desiredState: RuntimeDesiredState;
  readonly accountId?: string;
  readonly workerName?: string;
  readonly artifactBucket?: string;
  readonly requestedAt: string;
}

export interface CloudflareWorkerContainerDeploymentResult {
  readonly deploymentId: string;
  readonly workerName?: string;
  readonly objectAddress?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly operations?: readonly provider.ProviderOperation[];
}

export interface CloudflareWorkerContainerDeploymentClient {
  applyWorkerContainerDeployment(
    input: CloudflareWorkerContainerDeploymentInput,
  ): Promise<CloudflareWorkerContainerDeploymentResult>;
}

export interface CloudflareWorkerContainerProviderOptions {
  readonly client: CloudflareWorkerContainerDeploymentClient;
  readonly accountId?: string;
  readonly workerName?: string;
  readonly artifactBucket?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export class CloudflareWorkerContainerProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareWorkerContainerDeploymentClient;
  readonly #accountId?: string;
  readonly #workerName?: string;
  readonly #artifactBucket?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: CloudflareWorkerContainerProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#workerName = options.workerName;
    this.#artifactBucket = options.artifactBucket;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const result = await this.#client.applyWorkerContainerDeployment({
      desiredState: structuredClone(desiredState),
      accountId: this.#accountId,
      workerName: this.#workerName,
      artifactBucket: this.#artifactBucket,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-worker-container-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      targetId: result.deploymentId,
      targetName: result.workerName ?? this.#workerName ?? desiredState.appName,
      command: [
        "wrangler",
        "deploy",
        "--config",
        "deploy/cloudflare/wrangler.toml",
      ],
      details: compactRecord({
        accountId: this.#accountId,
        artifactBucket: this.#artifactBucket,
        workerName: result.workerName ?? this.#workerName,
        deploymentId: result.deploymentId,
        objectAddress: result.objectAddress,
        workloadCount: desiredState.workloads.length,
        resourceCount: desiredState.resources.length,
        routeCount: desiredState.routes.length,
      }),
      recordedAt: completedAt,
      execution: {
        status: result.stderr ? "failed" : "succeeded",
        code: result.stderr ? 1 : 0,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
        completedAt,
      },
    };
    this.#operations.push(operation, ...(result.operations ?? []));
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "cloudflare",
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
}

function compactRecord(
  input: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
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
