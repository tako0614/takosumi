import type { provider } from "takosumi-contract";
import type { RuntimeDesiredState } from "takosumi-contract";
import type {
  K8sApplyClient,
  K8sDeleteClient,
  K8sGetClient,
  K8sIngressClass,
} from "./clients.ts";
import { deepFreeze } from "./common.ts";
import { K8sNamespaceMaterializer } from "./namespace.ts";
import { K8sDeploymentMaterializer } from "./deployment.ts";
import { K8sIngressMaterializer } from "./ingress.ts";
import { K8sConfigMapMaterializer } from "./configmap.ts";
import { K8sSecretMaterializer } from "./secret.ts";
import type { K8sReconcileOptions } from "./reconcile.ts";

export interface K8sProviderMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly namespacePrefix?: string;
  readonly ingressClassName?: K8sIngressClass;
  readonly defaultReplicas?: number;
  readonly defaultPort?: number;
  readonly imageDefault?: string;
  readonly defaultTlsSecretName?: string;
  readonly extraNamespaceLabels?: Record<string, string>;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly reconcile?: K8sReconcileOptions;
}

/**
 * Top-level k8s provider materializer that fans out a `RuntimeDesiredState`
 * across the 6 descriptor materializers (namespace / deployment / service /
 * ingress / configmap / secret).
 *
 * Each descriptor produces a `ProviderOperation` so the deployment service can
 * stream them onto `Deployment.conditions[]` without needing per-descriptor
 * special-casing.
 */
export class K8sProviderMaterializer implements provider.ProviderMaterializer {
  readonly #namespace: K8sNamespaceMaterializer;
  readonly #deployment: K8sDeploymentMaterializer;
  readonly #ingress: K8sIngressMaterializer;
  readonly #configMap: K8sConfigMapMaterializer;
  readonly #secret: K8sSecretMaterializer;
  readonly #operations: provider.ProviderOperation[] = [];
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: K8sProviderMaterializerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    const shared = {
      apply: options.apply,
      get: options.get,
      remove: options.remove,
      clock: this.#clock,
      idGenerator: this.#idGenerator,
      reconcile: options.reconcile,
    };
    this.#namespace = new K8sNamespaceMaterializer({
      ...shared,
      namespacePrefix: options.namespacePrefix,
      extraLabels: options.extraNamespaceLabels,
    });
    this.#deployment = new K8sDeploymentMaterializer({
      ...shared,
      defaultReplicas: options.defaultReplicas,
      defaultPort: options.defaultPort,
      imageDefault: options.imageDefault,
    });
    this.#ingress = new K8sIngressMaterializer({
      ...shared,
      ingressClassName: options.ingressClassName,
      defaultTlsSecretName: options.defaultTlsSecretName,
    });
    this.#configMap = new K8sConfigMapMaterializer(shared);
    this.#secret = new K8sSecretMaterializer(shared);
  }

  async materialize(
    desiredState: RuntimeDesiredState,
  ): Promise<provider.ProviderMaterializationPlan> {
    const recordedAt = this.#now();
    const operations: provider.ProviderOperation[] = [];
    const namespaceOp = await this.#namespace.ensure(desiredState);
    operations.push(namespaceOp);
    const namespaceName = this.#namespace.resolveNamespace(desiredState);

    const configMapOp = await this.#configMap.materialize(
      namespaceName,
      desiredState,
    );
    if (configMapOp) operations.push(configMapOp);
    const secretOp = await this.#secret.materialize(
      namespaceName,
      desiredState,
    );
    if (secretOp) operations.push(secretOp);

    for (const workload of desiredState.workloads) {
      const { deployment, service } = await this.#deployment.materialize(
        namespaceName,
        desiredState,
        workload,
      );
      operations.push(deployment, service);
    }

    const ingressOp = await this.#ingress.materialize(
      namespaceName,
      desiredState,
    );
    if (ingressOp) operations.push(ingressOp);

    this.#operations.push(...operations);
    const createdByOperationId = namespaceOp.id;
    return deepFreeze({
      id: `provider_plan_${this.#idGenerator()}`,
      provider: "k8s",
      desiredStateId: desiredState.id,
      recordedAt,
      createdByOperationId,
      operations,
    });
  }

  listRecordedOperations(): Promise<readonly provider.ProviderOperation[]> {
    return Promise.resolve([...this.#operations]);
  }

  clearRecordedOperations(): Promise<void> {
    this.#operations.splice(0, this.#operations.length);
    return Promise.resolve();
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

/**
 * Stable list of descriptor IDs the k8s provider claims to materialize. Plugin
 * registry / profile composition reads this list to build the provider-support
 * report consumed by descriptor pinning.
 */
export type K8sProviderDescriptorId =
  | "provider.k8s.namespace@v1"
  | "provider.k8s.deployment@v1"
  | "provider.k8s.service@v1"
  | "provider.k8s.ingress@v1"
  | "provider.k8s.configmap@v1"
  | "provider.k8s.secret@v1";

export const K8S_PROVIDER_DESCRIPTORS: readonly K8sProviderDescriptorId[] =
  Object.freeze([
    "provider.k8s.namespace@v1",
    "provider.k8s.deployment@v1",
    "provider.k8s.service@v1",
    "provider.k8s.ingress@v1",
    "provider.k8s.configmap@v1",
    "provider.k8s.secret@v1",
  ]);
