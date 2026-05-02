/**
 * Operator-injected k8s client surface used by the Phase 12 k8s provider.
 *
 * Operators inject one of:
 *   - a kubeconfig-driven client (in-cluster service account or out-of-cluster
 *     kubeconfig)
 *   - a fetch-based gateway proxying to the API server
 *
 * Each method maps one-to-one with a kubernetes apply / delete primitive that
 * the plugin treats as idempotent ("server-side apply"-like semantics).
 */

export interface K8sClient {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
}

/**
 * Optional read-side surface used by the deepening reconciler for drift
 * detection and namespace pagination. An adapter without a `K8sGetClient`
 * still works — drift simply falls back to "no observed state".
 */
export interface K8sGetClient {
  getNamespace(
    input: { readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  getDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  getService(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  getIngress(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  getConfigMap(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  getSecret(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sObjectState | undefined>;
  listNamespaces?(input?: K8sListInput): Promise<K8sListResult>;
  listInNamespace?(input: {
    readonly kind: K8sObjectKind;
    readonly namespace: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly labelSelector?: string;
  }): Promise<K8sListResult>;
}

export type K8sObjectKind =
  | "Namespace"
  | "Deployment"
  | "Service"
  | "Ingress"
  | "ConfigMap"
  | "Secret";

export interface K8sObjectState {
  readonly apiVersion: string;
  readonly kind: K8sObjectKind | string;
  readonly metadata: K8sObjectMeta & {
    readonly resourceVersion?: string;
    readonly uid?: string;
    readonly generation?: number;
  };
  readonly spec?: Record<string, unknown>;
  readonly status?: Record<string, unknown>;
  readonly data?: Record<string, string>;
  readonly stringData?: Record<string, string>;
}

export interface K8sListInput {
  readonly cursor?: string;
  readonly limit?: number;
  readonly labelSelector?: string;
}

export interface K8sListResult {
  readonly items: readonly K8sObjectState[];
  readonly nextCursor?: string;
}

export interface K8sApplyClient {
  applyNamespace(input: K8sNamespaceSpec): Promise<K8sApplyResult>;
  applyDeployment(input: K8sDeploymentSpec): Promise<K8sApplyResult>;
  applyService(input: K8sServiceSpec): Promise<K8sApplyResult>;
  applyIngress(input: K8sIngressSpec): Promise<K8sApplyResult>;
  applyConfigMap(input: K8sConfigMapSpec): Promise<K8sApplyResult>;
  applySecret(input: K8sSecretSpec): Promise<K8sApplyResult>;
}

export interface K8sDeleteClient {
  deleteNamespace(input: { readonly name: string }): Promise<K8sApplyResult>;
  deleteDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult>;
  deleteService(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult>;
  deleteIngress(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult>;
  deleteConfigMap(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult>;
  deleteSecret(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K8sApplyResult>;
}

export interface K8sApplyResult {
  readonly resourceVersion?: string;
  readonly uid?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly skipped?: boolean;
}

export interface K8sObjectMeta {
  readonly name: string;
  readonly namespace?: string;
  readonly labels?: Record<string, string>;
  readonly annotations?: Record<string, string>;
}

export interface K8sNamespaceSpec {
  readonly metadata: K8sObjectMeta;
}

export interface K8sContainerPort {
  readonly name?: string;
  readonly containerPort: number;
  readonly protocol?: "TCP" | "UDP";
}

export interface K8sContainerSpec {
  readonly name: string;
  readonly image: string;
  readonly command?: readonly string[];
  readonly args?: readonly string[];
  readonly env?: readonly K8sEnvVar[];
  readonly ports?: readonly K8sContainerPort[];
}

export interface K8sEnvVar {
  readonly name: string;
  readonly value?: string;
  readonly valueFromConfigMapKey?: {
    readonly name: string;
    readonly key: string;
  };
  readonly valueFromSecretKey?: { readonly name: string; readonly key: string };
}

export interface K8sDeploymentSpec {
  readonly metadata: K8sObjectMeta;
  readonly replicas?: number;
  readonly containers: readonly K8sContainerSpec[];
  readonly imagePullSecrets?: readonly { readonly name: string }[];
}

export interface K8sServicePort {
  readonly name?: string;
  readonly port: number;
  readonly targetPort?: number;
  readonly protocol?: "TCP" | "UDP";
}

export interface K8sServiceSpec {
  readonly metadata: K8sObjectMeta;
  readonly ports: readonly K8sServicePort[];
  readonly selector: Record<string, string>;
  readonly type?: "ClusterIP" | "NodePort" | "LoadBalancer";
}

export type K8sIngressClass = "nginx" | "traefik" | "contour" | string;

export interface K8sIngressRule {
  readonly host?: string;
  readonly path?: string;
  readonly pathType?: "Prefix" | "Exact" | "ImplementationSpecific";
  readonly serviceName: string;
  readonly servicePort: number | string;
}

export interface K8sIngressSpec {
  readonly metadata: K8sObjectMeta;
  readonly ingressClassName?: K8sIngressClass;
  readonly rules: readonly K8sIngressRule[];
  readonly tls?: readonly {
    readonly hosts: readonly string[];
    readonly secretName?: string;
  }[];
}

export interface K8sConfigMapSpec {
  readonly metadata: K8sObjectMeta;
  readonly data: Record<string, string>;
}

export interface K8sSecretSpec {
  readonly metadata: K8sObjectMeta;
  readonly type?:
    | "Opaque"
    | "kubernetes.io/dockerconfigjson"
    | "kubernetes.io/tls";
  readonly stringData?: Record<string, string>;
  readonly data?: Record<string, string>;
}
