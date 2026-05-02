import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import type {
  K8sApplyClient,
  K8sDeleteClient,
  K8sGetClient,
  K8sObjectState,
} from "./clients.ts";
import {
  buildOperation,
  type K8sExecutionRecord,
  objectAddress,
  workloadName,
} from "./common.ts";
import {
  detectDrift,
  type K8sReconcileOptions,
  reconcile,
} from "./reconcile.ts";
import { K8sDriftError, K8sNotFoundError } from "./errors.ts";

export interface K8sConfigMapMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly reconcile?: K8sReconcileOptions;
}

export class K8sConfigMapMaterializer {
  readonly #apply: K8sApplyClient;
  readonly #remove?: K8sDeleteClient;
  readonly #get?: K8sGetClient;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #reconcile: K8sReconcileOptions;

  constructor(options: K8sConfigMapMaterializerOptions) {
    this.#apply = options.apply;
    this.#remove = options.remove;
    this.#get = options.get;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#reconcile = options.reconcile ?? {};
  }

  async getConfigMap(
    namespace: string,
    name: string,
  ): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sConfigMapMaterializer.getConfigMap requires a `get` client",
      );
    }
    const state = await this.#get.getConfigMap({ namespace, name });
    if (!state) {
      throw new K8sNotFoundError(
        `configmap ${namespace}/${name} not found`,
        {
          objectAddress: objectAddress({
            apiVersion: "v1",
            kind: "ConfigMap",
            namespace,
            name,
          }),
        },
      );
    }
    return state;
  }

  async deleteConfigMap(
    namespace: string,
    name: string,
  ): Promise<provider.ProviderOperation | undefined> {
    if (!this.#remove) return undefined;
    const startedAt = this.#now();
    const result = await this.#remove.deleteConfigMap({ namespace, name });
    const completedAt = result.completedAt ?? this.#now();
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-configmap-delete",
      desiredStateId: namespace,
      targetId: name,
      targetName: name,
      command: ["kubectl", "delete", "configmap", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.configmap@v1",
        namespace,
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "ConfigMap",
          namespace,
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

  async reconcile(
    namespace: string,
    desiredState: RuntimeDesiredState,
    options: K8sReconcileOptions = {},
  ): Promise<provider.ProviderOperation | undefined> {
    const merged: K8sReconcileOptions = {
      ...this.#reconcile,
      ...options,
      conditionType: options.conditionType ?? "ConfigMapReady",
    };
    return await reconcile(
      () => this.materialize(namespace, desiredState),
      merged,
    );
  }

  /** Strict drift assertion: compares ConfigMap.data to expected projection. */
  async assertInSync(
    namespace: string,
    desiredState: RuntimeDesiredState,
  ): Promise<readonly string[]> {
    if (!this.#get) return [];
    const name = workloadName(`${desiredState.appName}-config`);
    const observed = await this.#get.getConfigMap({ namespace, name });
    const expected = collectAppConfig(desiredState);
    if (!observed) {
      if (Object.keys(expected).length === 0) return [];
      throw new K8sDriftError(`configmap ${namespace}/${name} missing`);
    }
    const drifted = detectDrift({ data: expected }, {
      data: observed.data ?? {},
    }, {
      compareLabels: false,
      fields: ["data"],
    });
    if (drifted.length > 0) {
      throw new K8sDriftError(
        `configmap ${namespace}/${name} drifted: ${drifted.join(",")}`,
        { observed: observed.data, desired: expected },
      );
    }
    return drifted;
  }

  async materialize(
    namespace: string,
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderOperation | undefined> {
    const data = collectAppConfig(desiredState);
    if (Object.keys(data).length === 0) return undefined;

    const startedAt = this.#now();
    const name = workloadName(`${desiredState.appName}-config`);
    const result = await this.#apply.applyConfigMap({
      metadata: {
        name,
        namespace,
        labels: {
          "takos.jp/activation": desiredState.activationId,
          "takos.jp/managed-by": "takos-paas",
        },
      },
      data,
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
      kind: "k8s-configmap-apply",
      desiredStateId: desiredState.id,
      targetId: name,
      targetName: name,
      command: ["kubectl", "apply", "configmap", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.configmap@v1",
        namespace,
        keyCount: Object.keys(data).length,
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "ConfigMap",
          namespace,
          name,
        }),
        resourceVersion: result.resourceVersion,
      },
      recordedAt: completedAt,
      execution,
    });
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

/**
 * Resource specs may carry non-secret operator config. We project the union of
 * env values across resources keyed by `<resourceName>.<envKey>`.
 */
function collectAppConfig(
  desiredState: RuntimeDesiredState,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const resource of desiredState.resources) {
    for (const [key, value] of Object.entries(resource.env ?? {})) {
      if (key.startsWith("SECRET_")) continue;
      out[`${resource.resourceName}.${key}`] = value;
    }
  }
  return out;
}
