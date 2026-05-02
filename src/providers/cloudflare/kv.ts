import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";

/**
 * Cloudflare KV namespace materialization.
 *
 * Descriptor: `provider.cloudflare.kv@v1`
 *
 * Materializes KV namespaces declared in a `RuntimeDesiredState`. Each
 * namespace is created (or reused) on the configured Cloudflare account, and
 * the returned binding name is what tenant Workers consume. CRUD on KV pairs
 * (put / get / delete) is exposed through the same client so operator-side
 * tools can manage seed data without re-implementing the wrangler API.
 */

export interface CloudflareKvNamespaceSpec {
  readonly id?: string;
  readonly title: string;
  readonly bindingName: string;
  readonly preview?: boolean;
}

export interface CloudflareKvNamespaceRecord {
  readonly id: string;
  readonly title: string;
  readonly bindingName: string;
  readonly preview: boolean;
}

export interface CloudflareKvPutInput {
  readonly namespaceId: string;
  readonly key: string;
  readonly value: string | Uint8Array;
  readonly expirationTtl?: number;
  readonly metadata?: Record<string, string>;
}

export interface CloudflareKvGetInput {
  readonly namespaceId: string;
  readonly key: string;
}

export interface CloudflareKvGetResult {
  readonly key: string;
  readonly value: Uint8Array;
  readonly metadata?: Record<string, string>;
}

export interface CloudflareKvDeleteInput {
  readonly namespaceId: string;
  readonly key: string;
}

export interface CloudflareKvMaterializationInput {
  readonly desiredState: RuntimeDesiredState;
  readonly namespaces: readonly CloudflareKvNamespaceSpec[];
  readonly accountId?: string;
  readonly requestedAt: string;
}

export interface CloudflareKvMaterializationResult {
  readonly namespaces: readonly CloudflareKvNamespaceRecord[];
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface CloudflareKvClient {
  ensureNamespace(
    spec: CloudflareKvNamespaceSpec,
  ): Promise<CloudflareKvNamespaceRecord>;
  listNamespaces(): Promise<readonly CloudflareKvNamespaceRecord[]>;
  deleteNamespace(namespaceId: string): Promise<boolean>;
  put(input: CloudflareKvPutInput): Promise<void>;
  get(input: CloudflareKvGetInput): Promise<CloudflareKvGetResult | undefined>;
  delete(input: CloudflareKvDeleteInput): Promise<boolean>;
  materializeNamespaces(
    input: CloudflareKvMaterializationInput,
  ): Promise<CloudflareKvMaterializationResult>;
}

export interface CloudflareKvProviderOptions {
  readonly client: CloudflareKvClient;
  readonly accountId?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extractNamespaces?: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareKvNamespaceSpec[];
}

export class CloudflareKvProviderMaterializer
  implements provider.ProviderMaterializer {
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #client: CloudflareKvClient;
  readonly #accountId?: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extract: (
    desiredState: RuntimeDesiredState,
  ) => readonly CloudflareKvNamespaceSpec[];

  constructor(options: CloudflareKvProviderOptions) {
    this.#client = options.client;
    this.#accountId = options.accountId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extract = options.extractNamespaces ?? defaultExtractKvNamespaces;
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const startedAt = this.#clock().toISOString();
    const namespaces = this.#extract(desiredState);
    const result = await this.#client.materializeNamespaces({
      desiredState: structuredClone(desiredState),
      namespaces,
      accountId: this.#accountId,
      requestedAt: startedAt,
    });
    const completedAt = this.#clock().toISOString();
    const operation: provider.ProviderOperation = {
      id: `provider_op_${this.#idGenerator()}`,
      kind: "cloudflare-kv-namespace-apply",
      provider: "cloudflare",
      desiredStateId: desiredState.id,
      command: ["wrangler", "kv:namespace", "create"],
      details: {
        accountId: this.#accountId,
        namespaceCount: result.namespaces.length,
        namespaces: result.namespaces.map((ns) => ({
          id: ns.id,
          title: ns.title,
          bindingName: ns.bindingName,
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

function defaultExtractKvNamespaces(
  desiredState: RuntimeDesiredState,
): readonly CloudflareKvNamespaceSpec[] {
  const out: CloudflareKvNamespaceSpec[] = [];
  for (const resource of desiredState.resources) {
    const kind = (resource as { kind?: string }).kind;
    if (kind !== "kv" && kind !== "cloudflare-kv") continue;
    const meta = resource as unknown as {
      readonly name?: string;
      readonly id?: string;
      readonly bindingName?: string;
      readonly title?: string;
      readonly preview?: boolean;
    };
    out.push({
      id: meta.id,
      title: meta.title ?? meta.name ?? meta.bindingName ?? "kv",
      bindingName: meta.bindingName ?? meta.name ?? "KV",
      preview: meta.preview,
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
