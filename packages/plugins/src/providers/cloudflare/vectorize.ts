import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare Vectorize index materialization.
 *
 * Descriptor: `provider.cloudflare.vectorize@v1`
 *
 * Vectorize hosts vector indexes for ANN search. This adapter ensures the
 * declared indexes exist with the right dimensionality / metric and gives
 * operators an API to insert / query vectors. Tenant Workers consume the
 * resulting binding name.
 */

export type CloudflareVectorizeMetric =
  | "cosine"
  | "euclidean"
  | "dot-product";

export interface CloudflareVectorizeIndexSpec {
  readonly name: string;
  readonly dimensions: number;
  readonly metric: CloudflareVectorizeMetric;
  readonly description?: string;
}

export interface CloudflareVectorizeIndexRecord {
  readonly name: string;
  readonly dimensions: number;
  readonly metric: CloudflareVectorizeMetric;
  readonly id?: string;
  readonly createdAt?: string;
}

export interface CloudflareVectorizeVector {
  readonly id: string;
  readonly values: readonly number[];
  readonly metadata?: Record<string, unknown>;
  readonly namespace?: string;
}

export interface CloudflareVectorizeUpsertInput {
  readonly indexName: string;
  readonly vectors: readonly CloudflareVectorizeVector[];
}

export interface CloudflareVectorizeUpsertResult {
  readonly indexName: string;
  readonly upserted: number;
}

export interface CloudflareVectorizeQueryInput {
  readonly indexName: string;
  readonly vector: readonly number[];
  readonly topK?: number;
  readonly namespace?: string;
  readonly returnMetadata?: boolean;
  readonly returnValues?: boolean;
  readonly filter?: Record<string, unknown>;
}

export interface CloudflareVectorizeMatch {
  readonly id: string;
  readonly score: number;
  readonly values?: readonly number[];
  readonly metadata?: Record<string, unknown>;
}

export interface CloudflareVectorizeQueryResult {
  readonly matches: readonly CloudflareVectorizeMatch[];
}

export interface CloudflareVectorizeMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly indexes: readonly CloudflareVectorizeIndexSpec[];
  readonly accountId?: string;
  readonly requestedAt: string;
}

export interface CloudflareVectorizeMaterializationResult {
  readonly indexes: readonly CloudflareVectorizeIndexRecord[];
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareVectorizeClient {
  ensureIndex(
    spec: CloudflareVectorizeIndexSpec,
  ): Promise<CloudflareVectorizeIndexRecord>;
  listIndexes(): Promise<readonly CloudflareVectorizeIndexRecord[]>;
  deleteIndex(name: string): Promise<boolean>;
  upsert(
    input: CloudflareVectorizeUpsertInput,
  ): Promise<CloudflareVectorizeUpsertResult>;
  query(
    input: CloudflareVectorizeQueryInput,
  ): Promise<CloudflareVectorizeQueryResult>;
  materializeIndexes(
    input: CloudflareVectorizeMaterializationInput,
  ): Promise<CloudflareVectorizeMaterializationResult>;
}

export interface CloudflareVectorizeProviderOptions {
  readonly client: CloudflareVectorizeClient;
  readonly accountId?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extractIndexes?: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareVectorizeIndexSpec[];
}

export class CloudflareVectorizeProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareVectorizeClient;
  readonly #accountId?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareVectorizeIndexSpec[];

  constructor(options: CloudflareVectorizeProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extract = options.extractIndexes ?? defaultExtractVectorizeIndexes;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const indexes = this.#extract(desiredState);
    const result = await this.#client.materializeIndexes({
      desiredState: structuredClone(desiredState),
      indexes,
      accountId: this.#accountId,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-vectorize-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      command: ["wrangler", "vectorize", "create"],
      details: {
        accountId: this.#accountId,
        indexCount: result.indexes.length,
        indexes: result.indexes.map((i) => ({
          name: i.name,
          dimensions: i.dimensions,
          metric: i.metric,
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

function defaultExtractVectorizeIndexes(
  desiredState: RuntimeDesiredState,
): readonly CloudflareVectorizeIndexSpec[] {
  const out: CloudflareVectorizeIndexSpec[] = [];
  for (const resource of desiredState.resources) {
    const kind = (resource as { kind?: string }).kind;
    if (kind !== "vectorize" && kind !== "cloudflare-vectorize") continue;
    const meta = resource as unknown as {
      readonly name?: string;
      readonly dimensions?: number;
      readonly metric?: CloudflareVectorizeMetric;
      readonly description?: string;
    };
    if (!meta.name || typeof meta.dimensions !== "number") continue;
    out.push({
      name: meta.name,
      dimensions: meta.dimensions,
      metric: meta.metric ?? "cosine",
      description: meta.description,
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
