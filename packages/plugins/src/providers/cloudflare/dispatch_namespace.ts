import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare Workers for Platforms dispatch namespace materialization.
 *
 * Descriptor: `provider.cloudflare.dispatch-namespace@v1`
 *
 * In Workers for Platforms each tenant Worker is deployed under a dispatch
 * namespace, and a parent dispatcher Worker routes requests by tenant key.
 * This adapter ensures the namespace exists, deploys the tenant Worker into
 * it, and emits the binding metadata operators need to wire the dispatcher
 * route.
 */

export interface CloudflareDispatchNamespaceSpec {
  readonly name: string;
  readonly description?: string;
}

export interface CloudflareDispatchNamespaceRecord {
  readonly name: string;
  readonly id: string;
  readonly createdAt: string;
}

export interface CloudflareDispatchTenantWorkerSpec {
  readonly namespace: string;
  readonly scriptName: string;
  readonly tenantKey: string;
  readonly script: Uint8Array | string;
  readonly bindings?: Record<string, unknown>;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
}

export interface CloudflareDispatchTenantWorkerRecord {
  readonly namespace: string;
  readonly scriptName: string;
  readonly tenantKey: string;
  readonly etag?: string;
  readonly deployedAt: string;
}

export interface CloudflareDispatchMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly namespace: CloudflareDispatchNamespaceSpec;
  readonly tenantWorker?: CloudflareDispatchTenantWorkerSpec;
  readonly accountId?: string;
  readonly requestedAt: string;
}

export interface CloudflareDispatchMaterializationResult {
  readonly namespace: CloudflareDispatchNamespaceRecord;
  readonly tenantWorker?: CloudflareDispatchTenantWorkerRecord;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareDispatchNamespaceClient {
  ensureNamespace(
    spec: CloudflareDispatchNamespaceSpec,
  ): Promise<CloudflareDispatchNamespaceRecord>;
  listNamespaces(): Promise<readonly CloudflareDispatchNamespaceRecord[]>;
  deleteNamespace(name: string): Promise<boolean>;
  deployTenantWorker(
    spec: CloudflareDispatchTenantWorkerSpec,
  ): Promise<CloudflareDispatchTenantWorkerRecord>;
  materialize(
    input: CloudflareDispatchMaterializationInput,
  ): Promise<CloudflareDispatchMaterializationResult>;
}

export interface CloudflareDispatchNamespaceProviderOptions {
  readonly client: CloudflareDispatchNamespaceClient;
  readonly accountId?: string;
  readonly namespaceName: string;
  readonly description?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly resolveTenantWorker?: (
    desiredState: RuntimeDesiredState,
  ) => CloudflareDispatchTenantWorkerSpec | undefined;
}

export class CloudflareDispatchNamespaceProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareDispatchNamespaceClient;
  readonly #accountId?: string;
  readonly #namespaceName: string;
  readonly #description?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #resolveTenantWorker?: (
    desiredState: RuntimeDesiredState,
  ) => CloudflareDispatchTenantWorkerSpec | undefined;

  constructor(options: CloudflareDispatchNamespaceProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#namespaceName = options.namespaceName;
    this.#description = options.description;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#resolveTenantWorker = options.resolveTenantWorker;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const tenantWorker = this.#resolveTenantWorker?.(desiredState);
    const result = await this.#client.materialize({
      desiredState: structuredClone(desiredState),
      namespace: {
        name: this.#namespaceName,
        description: this.#description,
      },
      tenantWorker,
      accountId: this.#accountId,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-dispatch-namespace-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      targetId: result.namespace.id,
      targetName: result.namespace.name,
      command: [
        "wrangler",
        "dispatch-namespace",
        "deploy",
        result.namespace.name,
      ],
      details: {
        accountId: this.#accountId,
        namespace: result.namespace.name,
        namespaceId: result.namespace.id,
        tenantScriptName: result.tenantWorker?.scriptName,
        tenantKey: result.tenantWorker?.tenantKey,
      },
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
    this.#operations.push(operation);
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      recordedAt: completedAt,
      createdByOperationId: operation.id,
      operations: [operation],
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
