/**
 * Azure Container Apps materializer (reference stub).
 *
 * This is a *reference* implementation provided as a template for 3rd-party
 * plugin authors who want to add Azure as a hosting target. It is NOT bundled
 * into the default Takosumi profile factory list. Operators that want Azure
 * support import `createAzureKernelPlugin` directly and register it with the
 * kernel.
 *
 * The materializer never speaks to the Azure ARM API itself; operators inject
 * an `AzureContainerAppsClient` that wraps `@azure/arm-appcontainers` (or a
 * gateway). The materializer only translates a `RuntimeDesiredState` into
 * apply / remove calls and records `ProviderOperation` entries.
 */
import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

export interface AzureContainerAppsClient {
  apply(
    input: AzureContainerAppsApplyInput,
  ): Promise<AzureContainerAppsApplyResult>;
  remove?(
    input: AzureContainerAppsRemoveInput,
  ): Promise<AzureContainerAppsRemoveResult>;
}

export interface AzureContainerAppsApplyInput {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly desiredStateId: string;
  readonly activationId: string;
  readonly workloads: readonly AzureContainerAppsWorkload[];
}

export interface AzureContainerAppsWorkload {
  readonly name: string;
  readonly image: string;
  readonly minReplicas?: number;
  readonly maxReplicas?: number;
  readonly cpu?: number;
  readonly memoryGib?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AzureContainerAppsApplyResult {
  readonly status: "succeeded" | "failed";
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly appliedNames: readonly string[];
}

export interface AzureContainerAppsRemoveInput {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly activationId: string;
}

export interface AzureContainerAppsRemoveResult {
  readonly status: "succeeded" | "failed";
  readonly code?: number;
}

export interface AzureContainerAppsMaterializerOptions {
  readonly client: AzureContainerAppsClient;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
}

export const AZURE_PROVIDER_DESCRIPTORS = [
  "provider.azure.container-apps@v1",
] as const;

export class AzureContainerAppsMaterializer
  implements provider.ProviderMaterializer {
  readonly #client: AzureContainerAppsClient;
  readonly #subscriptionId: string;
  readonly #resourceGroup: string;
  readonly #region: string;
  readonly #environmentName: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #operations: provider.ProviderOperation[] = [];

  constructor(options: AzureContainerAppsMaterializerOptions) {
    this.#client = options.client;
    this.#subscriptionId = options.subscriptionId;
    this.#resourceGroup = options.resourceGroup;
    this.#region = options.region;
    this.#environmentName = options.environmentName;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const recordedAt = this.#clock().toISOString();
    const workloads = desiredState.workloads.map((workload) => ({
      name: `${desiredState.appName}-${workload.id}`.toLowerCase(),
      image: ((workload as { image?: string }).image) ?? "",
    }));
    const applyResult = await this.#client.apply({
      subscriptionId: this.#subscriptionId,
      resourceGroup: this.#resourceGroup,
      region: this.#region,
      environmentName: this.#environmentName,
      desiredStateId: desiredState.id,
      activationId: desiredState.activationId,
      workloads,
    });
    const completedAt = applyResult.completedAt ?? this.#clock().toISOString();
    const operation: provider.ProviderOperation = Object.freeze({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "azure-container-apps-apply" as const,
      provider: "azure",
      desiredStateId: desiredState.id,
      targetId: desiredState.activationId,
      targetName: desiredState.appName,
      command: [
        "az",
        "containerapp",
        "update",
        "--resource-group",
        this.#resourceGroup,
      ],
      details: {
        subscriptionId: this.#subscriptionId,
        resourceGroup: this.#resourceGroup,
        region: this.#region,
        environmentName: this.#environmentName,
        appliedCount: applyResult.appliedNames.length,
      },
      recordedAt,
      execution: {
        status: applyResult.status,
        code: applyResult.code ?? (applyResult.status === "succeeded" ? 0 : 1),
        stdout: applyResult.stdout,
        stderr: applyResult.stderr,
        startedAt: applyResult.startedAt ?? recordedAt,
        completedAt,
      },
    });
    this.#operations.push(operation);
    return Object.freeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "azure",
      desiredStateId: desiredState.id,
      recordedAt,
      createdByOperationId: operation.id,
      operations: [operation],
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve(this.#operations.slice());
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }
}
