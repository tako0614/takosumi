import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare Analytics Engine dataset materialization.
 *
 * Descriptor: `provider.cloudflare.analytics-engine@v1`
 *
 * Analytics Engine datasets are append-only telemetry sinks queryable via
 * SQL (Workers Analytics Engine SQL). This adapter ensures the dataset
 * binding exists (datasets are largely zero-config; we record the binding
 * mapping) and provides a `writeDataPoint` API that mirrors the
 * `AnalyticsEngineDataset.writeDataPoint` runtime binding.
 */

export interface CloudflareAnalyticsEngineDatasetSpec {
  readonly dataset: string;
  readonly bindingName: string;
}

export interface CloudflareAnalyticsEngineDatasetRecord {
  readonly dataset: string;
  readonly bindingName: string;
  readonly accountId?: string;
}

export interface CloudflareAnalyticsEngineDataPoint {
  readonly indexes?: readonly string[];
  readonly blobs?: readonly string[];
  readonly doubles?: readonly number[];
  readonly timestampMs?: number;
}

export interface CloudflareAnalyticsEngineWriteInput {
  readonly dataset: string;
  readonly point: CloudflareAnalyticsEngineDataPoint;
}

export interface CloudflareAnalyticsEngineMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly datasets: readonly CloudflareAnalyticsEngineDatasetSpec[];
  readonly accountId?: string;
  readonly requestedAt: string;
}

export interface CloudflareAnalyticsEngineMaterializationResult {
  readonly datasets: readonly CloudflareAnalyticsEngineDatasetRecord[];
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareAnalyticsEngineClient {
  ensureDataset(
    spec: CloudflareAnalyticsEngineDatasetSpec,
  ): Promise<CloudflareAnalyticsEngineDatasetRecord>;
  writeDataPoint(input: CloudflareAnalyticsEngineWriteInput): Promise<void>;
  materializeDatasets(
    input: CloudflareAnalyticsEngineMaterializationInput,
  ): Promise<CloudflareAnalyticsEngineMaterializationResult>;
}

export interface CloudflareAnalyticsEngineProviderOptions {
  readonly client: CloudflareAnalyticsEngineClient;
  readonly accountId?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extractDatasets?: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareAnalyticsEngineDatasetSpec[];
}

export class CloudflareAnalyticsEngineProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareAnalyticsEngineClient;
  readonly #accountId?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareAnalyticsEngineDatasetSpec[];

  constructor(options: CloudflareAnalyticsEngineProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extract = options.extractDatasets ??
      defaultExtractAnalyticsEngineDatasets;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const datasets = this.#extract(desiredState);
    const result = await this.#client.materializeDatasets({
      desiredState: structuredClone(desiredState),
      datasets,
      accountId: this.#accountId,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-analytics-engine-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      command: ["wrangler", "analytics-engine", "configure"],
      details: {
        accountId: this.#accountId,
        datasetCount: result.datasets.length,
        datasets: result.datasets.map((d) => ({
          dataset: d.dataset,
          bindingName: d.bindingName,
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

function defaultExtractAnalyticsEngineDatasets(
  desiredState: RuntimeDesiredState,
): readonly CloudflareAnalyticsEngineDatasetSpec[] {
  const out: CloudflareAnalyticsEngineDatasetSpec[] = [];
  for (const resource of desiredState.resources) {
    const kind = (resource as { kind?: string }).kind;
    if (
      kind !== "analytics-engine" &&
      kind !== "cloudflare-analytics-engine"
    ) continue;
    const meta = resource as unknown as {
      readonly name?: string;
      readonly dataset?: string;
      readonly bindingName?: string;
    };
    if (!meta.dataset && !meta.name) continue;
    out.push({
      dataset: meta.dataset ?? meta.name ?? "default",
      bindingName: meta.bindingName ?? meta.name ?? "AE",
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
