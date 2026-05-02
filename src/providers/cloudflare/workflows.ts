import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare Workflows materialization.
 *
 * Descriptor: `provider.cloudflare.workflows@v1`
 *
 * Cloudflare Workflows is a durable execution engine for long-running, async
 * task graphs. This adapter deploys (or updates) Workflow definitions to a
 * Cloudflare account and offers an API to invoke instances and inspect their
 * status.
 */

export type CloudflareWorkflowInstanceStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "completed"
  | "terminated";

export interface CloudflareWorkflowSpec {
  readonly name: string;
  readonly script: Uint8Array | string;
  readonly className: string;
  readonly bindings?: Record<string, unknown>;
  readonly compatibilityDate?: string;
  readonly compatibilityFlags?: readonly string[];
}

export interface CloudflareWorkflowRecord {
  readonly name: string;
  readonly className: string;
  readonly version?: string;
  readonly etag?: string;
  readonly deployedAt: string;
}

export interface CloudflareWorkflowInvokeInput {
  readonly workflowName: string;
  readonly instanceId?: string;
  readonly params?: Record<string, unknown>;
}

export interface CloudflareWorkflowInstance {
  readonly workflowName: string;
  readonly instanceId: string;
  readonly status: CloudflareWorkflowInstanceStatus;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly output?: unknown;
  readonly error?: string;
}

export interface CloudflareWorkflowsMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly workflows: readonly CloudflareWorkflowSpec[];
  readonly accountId?: string;
  readonly requestedAt: string;
}

export interface CloudflareWorkflowsMaterializationResult {
  readonly workflows: readonly CloudflareWorkflowRecord[];
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareWorkflowsClient {
  deployWorkflow(
    spec: CloudflareWorkflowSpec,
  ): Promise<CloudflareWorkflowRecord>;
  listWorkflows(): Promise<readonly CloudflareWorkflowRecord[]>;
  invoke(
    input: CloudflareWorkflowInvokeInput,
  ): Promise<CloudflareWorkflowInstance>;
  describeInstance(
    workflowName: string,
    instanceId: string,
  ): Promise<CloudflareWorkflowInstance | undefined>;
  terminateInstance(
    workflowName: string,
    instanceId: string,
  ): Promise<boolean>;
  materializeWorkflows(
    input: CloudflareWorkflowsMaterializationInput,
  ): Promise<CloudflareWorkflowsMaterializationResult>;
}

export interface CloudflareWorkflowsProviderOptions {
  readonly client: CloudflareWorkflowsClient;
  readonly accountId?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extractWorkflows?: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareWorkflowSpec[];
}

export class CloudflareWorkflowsProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareWorkflowsClient;
  readonly #accountId?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareWorkflowSpec[];

  constructor(options: CloudflareWorkflowsProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extract = options.extractWorkflows ?? defaultExtractWorkflows;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const workflows = this.#extract(desiredState);
    const result = await this.#client.materializeWorkflows({
      desiredState: structuredClone(desiredState),
      workflows,
      accountId: this.#accountId,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-workflows-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      command: ["wrangler", "workflows", "deploy"],
      details: {
        accountId: this.#accountId,
        workflowCount: result.workflows.length,
        workflows: result.workflows.map((w) => ({
          name: w.name,
          className: w.className,
          version: w.version,
        })),
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

function defaultExtractWorkflows(
  desiredState: RuntimeDesiredState,
): readonly CloudflareWorkflowSpec[] {
  const out: CloudflareWorkflowSpec[] = [];
  for (const workload of desiredState.workloads) {
    const kind = (workload as { kind?: string }).kind;
    if (kind !== "workflow" && kind !== "cloudflare-workflow") continue;
    const meta = workload as unknown as {
      readonly name?: string;
      readonly script?: Uint8Array | string;
      readonly className?: string;
      readonly bindings?: Record<string, unknown>;
      readonly compatibilityDate?: string;
      readonly compatibilityFlags?: readonly string[];
    };
    if (!meta.name || !meta.script || !meta.className) continue;
    out.push({
      name: meta.name,
      script: meta.script,
      className: meta.className,
      bindings: meta.bindings,
      compatibilityDate: meta.compatibilityDate,
      compatibilityFlags: meta.compatibilityFlags,
    });
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
