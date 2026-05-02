import type { provider } from "takosumi-contract";
import type {
  RuntimeDesiredState,
  RuntimeRouteBindingSpec,
} from "takosumi-contract";
import type {
  K8sApplyClient,
  K8sDeleteClient,
  K8sGetClient,
  K8sIngressClass,
  K8sIngressRule,
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

export interface K8sIngressMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly ingressClassName?: K8sIngressClass;
  readonly defaultTlsSecretName?: string;
  readonly reconcile?: K8sReconcileOptions;
}

export class K8sIngressMaterializer {
  readonly #apply: K8sApplyClient;
  readonly #remove?: K8sDeleteClient;
  readonly #get?: K8sGetClient;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #ingressClassName: K8sIngressClass;
  readonly #defaultTlsSecretName?: string;
  readonly #reconcile: K8sReconcileOptions;

  constructor(options: K8sIngressMaterializerOptions) {
    this.#apply = options.apply;
    this.#remove = options.remove;
    this.#get = options.get;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#ingressClassName = options.ingressClassName ?? "nginx";
    this.#defaultTlsSecretName = options.defaultTlsSecretName;
    this.#reconcile = options.reconcile ?? {};
  }

  async getIngress(
    namespace: string,
    name: string,
  ): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sIngressMaterializer.getIngress requires a `get` client",
      );
    }
    const state = await this.#get.getIngress({ namespace, name });
    if (!state) {
      throw new K8sNotFoundError(`ingress ${namespace}/${name} not found`, {
        objectAddress: objectAddress({
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
          namespace,
          name,
        }),
      });
    }
    return state;
  }

  async deleteIngress(
    namespace: string,
    name: string,
  ): Promise<provider.ProviderOperation | undefined> {
    if (!this.#remove) return undefined;
    const startedAt = this.#now();
    const result = await this.#remove.deleteIngress({ namespace, name });
    const completedAt = result.completedAt ?? this.#now();
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-ingress-delete",
      desiredStateId: namespace,
      targetId: name,
      targetName: name,
      command: ["kubectl", "delete", "ingress", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.ingress@v1",
        namespace,
        objectAddress: objectAddress({
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
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
      conditionType: options.conditionType ?? "IngressReady",
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
    if (desiredState.routes.length === 0) return undefined;

    const startedAt = this.#now();
    const name = workloadName(`${desiredState.appName}-ingress`);
    const rules = desiredState.routes.map((route) => ruleFromRoute(route));
    const tlsHosts = unique(rules.map((rule) => rule.host).filter(isString));
    const tls = tlsHosts.length > 0 && this.#defaultTlsSecretName
      ? [{ hosts: tlsHosts, secretName: this.#defaultTlsSecretName }]
      : undefined;

    const result = await this.#apply.applyIngress({
      metadata: {
        name,
        namespace,
        labels: {
          "takos.jp/group": desiredState.groupId,
          "takos.jp/activation": desiredState.activationId,
        },
        annotations: {
          "takos.jp/route-count": String(desiredState.routes.length),
        },
      },
      ingressClassName: this.#ingressClassName,
      rules,
      tls,
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
      kind: "k8s-ingress-apply",
      desiredStateId: desiredState.id,
      targetId: name,
      targetName: name,
      command: ["kubectl", "apply", "ingress", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.ingress@v1",
        namespace,
        ingressClassName: this.#ingressClassName,
        ruleCount: rules.length,
        objectAddress: objectAddress({
          apiVersion: "networking.k8s.io/v1",
          kind: "Ingress",
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

function ruleFromRoute(route: RuntimeRouteBindingSpec): K8sIngressRule {
  const port = route.targetPort ?? route.port ?? 80;
  return {
    host: route.host,
    path: route.path ?? "/",
    pathType: "Prefix",
    serviceName: workloadName(route.targetComponentName),
    servicePort: port,
  };
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
