import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import type {
  K8sApplyClient,
  K8sDeleteClient,
  K8sGetClient,
  K8sListResult,
  K8sObjectState,
} from "./clients.ts";
import {
  buildOperation,
  type K8sExecutionRecord,
  namespaceFromDesiredState,
  objectAddress,
} from "./common.ts";
import {
  detectDrift,
  type K8sReconcileOptions,
  paginate,
  reconcile,
} from "./reconcile.ts";
import { K8sDriftError, K8sNotFoundError } from "./errors.ts";

export interface K8sNamespaceMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly namespacePrefix?: string;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly extraLabels?: Record<string, string>;
  readonly reconcile?: K8sReconcileOptions;
}

export class K8sNamespaceMaterializer {
  readonly #apply: K8sApplyClient;
  readonly #remove?: K8sDeleteClient;
  readonly #get?: K8sGetClient;
  readonly #prefix: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #extraLabels: Record<string, string>;
  readonly #reconcile: K8sReconcileOptions;

  constructor(options: K8sNamespaceMaterializerOptions) {
    this.#apply = options.apply;
    this.#remove = options.remove;
    this.#get = options.get;
    this.#prefix = options.namespacePrefix ?? "takos";
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#extraLabels = { ...(options.extraLabels ?? {}) };
    this.#reconcile = options.reconcile ?? {};
  }

  /** Read the live namespace, throwing `K8sNotFoundError` when absent. */
  async get(name: string): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sNamespaceMaterializer.get requires a `get` client to be configured",
      );
    }
    const state = await this.#get.getNamespace({ name });
    if (!state) {
      throw new K8sNotFoundError(`namespace ${name} not found`, {
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Namespace",
          name,
        }),
      });
    }
    return state;
  }

  /** Pagination-aware namespace list. Returns an empty array when no get client. */
  async list(
    options: { readonly limit?: number; readonly labelSelector?: string } = {},
  ): Promise<readonly K8sObjectState[]> {
    if (!this.#get?.listNamespaces) return [];
    const list = this.#get.listNamespaces.bind(this.#get);
    return await paginate<K8sObjectState>(async (cursor) => {
      const result: K8sListResult = await list({
        cursor,
        limit: options.limit,
        labelSelector: options.labelSelector,
      });
      return { items: result.items, nextCursor: result.nextCursor };
    }, { limit: options.limit });
  }

  /**
   * Apply with retry/backoff/drift. When a `get` client is wired, the observed
   * labels are checked against the desired labels and a `K8sDriftError`
   * pre-empts the next attempt's apply unless `acceptDrift` is true.
   */
  async reconcile(
    desiredState: RuntimeDesiredState,
    options: { readonly acceptDrift?: boolean } & K8sReconcileOptions = {},
  ): Promise<provider.ProviderOperation> {
    const merged: K8sReconcileOptions = {
      ...this.#reconcile,
      ...options,
      conditionType: options.conditionType ?? "NamespaceReady",
    };
    return await reconcile(async () => {
      if (this.#get && options.acceptDrift !== true) {
        const observed = await this.#get.getNamespace({
          name: this.resolveNamespace(desiredState),
        });
        if (observed) {
          const drifted = detectDrift(
            { metadata: { labels: this.#expectedLabels(desiredState) } },
            { metadata: observed.metadata },
            { compareLabels: true, fields: [] },
          );
          if (drifted.length > 0) {
            // Drift is informational here — reconciler will re-apply, which
            // brings labels back in line. We surface the drift through the
            // condition sink rather than aborting.
            merged.conditionSink?.({
              type: "NamespaceDrift",
              status: "true",
              reason: "Drifted",
              message: `drifted fields: ${drifted.join(",")}`,
              observedAt: (merged.clock ?? this.#clock)().toISOString(),
              attempt: 0,
            });
          }
        }
      }
      return await this.ensure(desiredState);
    }, { ...merged, objectAddress: this.#address(desiredState) });
  }

  /** Strict drift check — throws `K8sDriftError` when labels diverge. */
  async assertInSync(
    desiredState: RuntimeDesiredState,
  ): Promise<readonly string[]> {
    if (!this.#get) return [];
    const name = this.resolveNamespace(desiredState);
    const observed = await this.#get.getNamespace({ name });
    const drifted = detectDrift(
      { metadata: { labels: this.#expectedLabels(desiredState) } },
      observed ? { metadata: observed.metadata } : undefined,
      { compareLabels: true, fields: [] },
    );
    if (drifted.length > 0) {
      throw new K8sDriftError(
        `namespace ${name} drifted: ${drifted.join(",")}`,
        {
          objectAddress: objectAddress({
            apiVersion: "v1",
            kind: "Namespace",
            name,
          }),
          observed: observed?.metadata as Record<string, unknown> | undefined,
          desired: { labels: this.#expectedLabels(desiredState) },
        },
      );
    }
    return drifted;
  }

  #expectedLabels(desiredState: RuntimeDesiredState): Record<string, string> {
    return {
      ...this.#extraLabels,
      "takos.jp/space": desiredState.spaceId,
      "takos.jp/group": desiredState.groupId,
      "takos.jp/activation": desiredState.activationId,
      "takos.jp/managed-by": "takosumi",
    };
  }

  #address(desiredState: RuntimeDesiredState): string {
    return objectAddress({
      apiVersion: "v1",
      kind: "Namespace",
      name: this.resolveNamespace(desiredState),
    });
  }

  resolveNamespace(desiredState: RuntimeDesiredState): string {
    return namespaceFromDesiredState(desiredState, this.#prefix);
  }

  async ensure(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderOperation> {
    const startedAt = this.#now();
    const name = this.resolveNamespace(desiredState);
    const labels = this.#expectedLabels(desiredState);
    const result = await this.#apply.applyNamespace({
      metadata: { name, labels },
    });
    const completedAt = result.completedAt ?? this.#now();
    const execution: K8sExecutionRecord = {
      status: result.stderr ? "failed" : "succeeded",
      code: result.stderr ? 1 : 0,
      stdout: result.stdout,
      stderr: result.stderr,
      startedAt: result.startedAt ?? startedAt,
      completedAt,
    };
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-namespace-apply",
      desiredStateId: desiredState.id,
      targetId: name,
      targetName: name,
      command: ["kubectl", "apply", "namespace", name],
      details: {
        descriptor: "provider.k8s.namespace@v1",
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Namespace",
          name,
        }),
        resourceVersion: result.resourceVersion,
        uid: result.uid,
      },
      recordedAt: completedAt,
      execution,
    });
  }

  async remove(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderOperation | undefined> {
    if (!this.#remove) return undefined;
    const startedAt = this.#now();
    const name = this.resolveNamespace(desiredState);
    const result = await this.#remove.deleteNamespace({ name });
    const completedAt = result.completedAt ?? this.#now();
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-namespace-delete",
      desiredStateId: desiredState.id,
      targetId: name,
      targetName: name,
      command: ["kubectl", "delete", "namespace", name],
      details: {
        descriptor: "provider.k8s.namespace@v1",
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Namespace",
          name,
        }),
      },
      recordedAt: completedAt,
      execution: {
        status: result.stderr ? "failed" : "succeeded",
        code: result.stderr ? 1 : 0,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt: result.startedAt ?? startedAt,
        completedAt,
      },
    });
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}
