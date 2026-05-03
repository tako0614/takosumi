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
import { type K8sReconcileOptions, reconcile } from "./reconcile.ts";
import { K8sNotFoundError } from "./errors.ts";

export interface K8sSecretMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly reconcile?: K8sReconcileOptions;
}

export class K8sSecretMaterializer {
  readonly #apply: K8sApplyClient;
  readonly #remove?: K8sDeleteClient;
  readonly #get?: K8sGetClient;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #reconcile: K8sReconcileOptions;

  constructor(options: K8sSecretMaterializerOptions) {
    this.#apply = options.apply;
    this.#remove = options.remove;
    this.#get = options.get;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#reconcile = options.reconcile ?? {};
  }

  async getSecret(
    namespace: string,
    name: string,
  ): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sSecretMaterializer.getSecret requires a `get` client",
      );
    }
    const state = await this.#get.getSecret({ namespace, name });
    if (!state) {
      throw new K8sNotFoundError(`secret ${namespace}/${name} not found`, {
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Secret",
          namespace,
          name,
        }),
      });
    }
    return state;
  }

  async deleteSecret(
    namespace: string,
    name: string,
  ): Promise<provider.ProviderOperation | undefined> {
    if (!this.#remove) return undefined;
    const startedAt = this.#now();
    const result = await this.#remove.deleteSecret({ namespace, name });
    const completedAt = result.completedAt ?? this.#now();
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-secret-delete",
      desiredStateId: namespace,
      targetId: name,
      targetName: name,
      command: ["kubectl", "delete", "secret", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.secret@v1",
        namespace,
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Secret",
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
      conditionType: options.conditionType ?? "SecretReady",
    };
    return await reconcile(
      () => this.materialize(namespace, desiredState),
      merged,
    );
  }

  async materialize(
    namespace: string,
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderOperation | undefined> {
    const stringData = collectSecrets(desiredState);
    if (Object.keys(stringData).length === 0) return undefined;

    const startedAt = this.#now();
    const name = workloadName(`${desiredState.appName}-secrets`);
    const result = await this.#apply.applySecret({
      metadata: {
        name,
        namespace,
        labels: {
          "takos.jp/activation": desiredState.activationId,
          "takos.jp/managed-by": "takosumi",
        },
      },
      type: "Opaque",
      stringData,
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
      kind: "k8s-secret-apply",
      desiredStateId: desiredState.id,
      targetId: name,
      targetName: name,
      command: ["kubectl", "apply", "secret", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.secret@v1",
        namespace,
        keyCount: Object.keys(stringData).length,
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Secret",
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

function collectSecrets(
  desiredState: RuntimeDesiredState,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const resource of desiredState.resources) {
    for (const [key, value] of Object.entries(resource.env ?? {})) {
      if (!key.startsWith("SECRET_")) continue;
      out[`${resource.resourceName}.${key}`] = value;
    }
  }
  return out;
}
