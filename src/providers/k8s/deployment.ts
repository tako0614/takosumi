import type { provider } from "takosumi-contract";
import type {
  RuntimeDesiredState,
  RuntimeWorkloadSpec,
} from "takosumi-contract";
import type {
  K8sApplyClient,
  K8sContainerPort,
  K8sContainerSpec,
  K8sDeleteClient,
  K8sEnvVar,
  K8sGetClient,
  K8sObjectState,
  K8sServicePort,
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

const DEFAULT_PORT = 8080;

export interface K8sDeploymentMaterializerOptions {
  readonly apply: K8sApplyClient;
  readonly remove?: K8sDeleteClient;
  readonly get?: K8sGetClient;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly defaultReplicas?: number;
  readonly defaultPort?: number;
  readonly imageDefault?: string;
  readonly reconcile?: K8sReconcileOptions;
}

export class K8sDeploymentMaterializer {
  readonly #apply: K8sApplyClient;
  readonly #remove?: K8sDeleteClient;
  readonly #get?: K8sGetClient;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #defaultReplicas: number;
  readonly #defaultPort: number;
  readonly #imageDefault: string;
  readonly #reconcile: K8sReconcileOptions;

  constructor(options: K8sDeploymentMaterializerOptions) {
    this.#apply = options.apply;
    this.#remove = options.remove;
    this.#get = options.get;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.#defaultReplicas = options.defaultReplicas ?? 1;
    this.#defaultPort = options.defaultPort ?? DEFAULT_PORT;
    this.#imageDefault = options.imageDefault ??
      "ghcr.io/takos-jp/runner:latest";
    this.#reconcile = options.reconcile ?? {};
  }

  async getDeployment(
    namespace: string,
    name: string,
  ): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sDeploymentMaterializer.getDeployment requires a `get` client",
      );
    }
    const state = await this.#get.getDeployment({ namespace, name });
    if (!state) {
      throw new K8sNotFoundError(
        `deployment ${namespace}/${name} not found`,
        {
          objectAddress: objectAddress({
            apiVersion: "apps/v1",
            kind: "Deployment",
            namespace,
            name,
          }),
        },
      );
    }
    return state;
  }

  async getService(
    namespace: string,
    name: string,
  ): Promise<K8sObjectState> {
    if (!this.#get) {
      throw new Error(
        "K8sDeploymentMaterializer.getService requires a `get` client",
      );
    }
    const state = await this.#get.getService({ namespace, name });
    if (!state) {
      throw new K8sNotFoundError(`service ${namespace}/${name} not found`, {
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Service",
          namespace,
          name,
        }),
      });
    }
    return state;
  }

  async deleteDeployment(
    namespace: string,
    name: string,
  ): Promise<provider.ProviderOperation | undefined> {
    if (!this.#remove) return undefined;
    const startedAt = this.#now();
    const result = await this.#remove.deleteDeployment({ namespace, name });
    const completedAt = result.completedAt ?? this.#now();
    return buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-deployment-delete",
      desiredStateId: namespace,
      targetId: name,
      targetName: name,
      command: ["kubectl", "delete", "deployment", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.deployment@v1",
        namespace,
        objectAddress: objectAddress({
          apiVersion: "apps/v1",
          kind: "Deployment",
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
    workload: RuntimeWorkloadSpec,
    options: K8sReconcileOptions = {},
  ): Promise<{
    readonly deployment: provider.ProviderOperation;
    readonly service: provider.ProviderOperation;
    readonly serviceName: string;
  }> {
    const merged: K8sReconcileOptions = {
      ...this.#reconcile,
      ...options,
      conditionType: options.conditionType ?? "DeploymentAvailable",
    };
    return await reconcile(async () => {
      return await this.materialize(namespace, desiredState, workload);
    }, {
      ...merged,
      objectAddress: objectAddress({
        apiVersion: "apps/v1",
        kind: "Deployment",
        namespace,
        name: workloadName(workload.componentName),
      }),
    });
  }

  /**
   * Strict drift assertion. Compares replicas / image / ports of the live
   * deployment against the desired projection. Throws K8sDriftError when
   * fields diverge.
   */
  async assertInSync(
    namespace: string,
    workload: RuntimeWorkloadSpec,
  ): Promise<readonly string[]> {
    if (!this.#get) return [];
    const name = workloadName(workload.componentName);
    const observed = await this.#get.getDeployment({ namespace, name });
    if (!observed) {
      throw new K8sDriftError(`deployment ${namespace}/${name} missing`, {
        observed: undefined,
      });
    }
    const desired = {
      replicas: this.#defaultReplicas,
      image: workload.image ?? this.#imageDefault,
    };
    const observedSpec = (observed.spec ?? {}) as Record<string, unknown>;
    const observedImage = ((observedSpec.template as Record<string, unknown>)
      ?.spec as Record<string, unknown>)?.containers as
        | readonly { readonly image?: string }[]
        | undefined;
    const observedFlat = {
      replicas: observedSpec.replicas,
      image: observedImage?.[0]?.image,
    };
    const drifted = detectDrift(desired, observedFlat, {
      compareLabels: false,
      fields: ["replicas", "image"],
    });
    if (drifted.length > 0) {
      throw new K8sDriftError(
        `deployment ${namespace}/${name} drifted: ${drifted.join(",")}`,
        { observed: observedFlat, desired },
      );
    }
    return drifted;
  }

  async materialize(
    namespace: string,
    desiredState: RuntimeDesiredState,
    workload: RuntimeWorkloadSpec,
  ): Promise<{
    readonly deployment: provider.ProviderOperation;
    readonly service: provider.ProviderOperation;
    readonly serviceName: string;
  }> {
    const name = workloadName(workload.componentName);
    const port = inferPort(workload, this.#defaultPort);
    const labels = {
      "app.kubernetes.io/name": name,
      "app.kubernetes.io/instance": `${desiredState.activationId}-${name}`,
      "app.kubernetes.io/managed-by": "takos-paas",
      "takos.jp/component": workload.componentName,
    };

    const startedDeploy = this.#now();
    const containers: readonly K8sContainerSpec[] = [{
      name,
      image: workload.image ?? this.#imageDefault,
      command: workload.command.length > 0 ? [...workload.command] : undefined,
      args: workload.args.length > 0 ? [...workload.args] : undefined,
      env: envVarsFromWorkload(workload),
      ports: [
        {
          name: "http",
          containerPort: port,
          protocol: "TCP",
        } satisfies K8sContainerPort,
      ],
    }];

    const deployResult = await this.#apply.applyDeployment({
      metadata: { name, namespace, labels },
      replicas: this.#defaultReplicas,
      containers,
    });
    const completedDeploy = deployResult.completedAt ?? this.#now();
    const deployExecution: K8sExecutionRecord = {
      status: deployResult.stderr ? "failed" : "succeeded",
      code: deployResult.stderr ? 1 : 0,
      stdout: deployResult.stdout,
      stderr: deployResult.stderr,
      startedAt: deployResult.startedAt ?? startedDeploy,
      completedAt: completedDeploy,
    };

    const deployment = buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-deployment-apply",
      desiredStateId: desiredState.id,
      targetId: workload.id,
      targetName: name,
      command: ["kubectl", "apply", "deployment", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.deployment@v1",
        namespace,
        replicas: this.#defaultReplicas,
        objectAddress: objectAddress({
          apiVersion: "apps/v1",
          kind: "Deployment",
          namespace,
          name,
        }),
        resourceVersion: deployResult.resourceVersion,
        uid: deployResult.uid,
      },
      recordedAt: completedDeploy,
      execution: deployExecution,
    });

    const startedService = this.#now();
    const ports: readonly K8sServicePort[] = [{
      name: "http",
      port,
      targetPort: port,
      protocol: "TCP",
    }];
    const serviceResult = await this.#apply.applyService({
      metadata: { name, namespace, labels },
      ports,
      selector: {
        "app.kubernetes.io/name": name,
        "app.kubernetes.io/instance": `${desiredState.activationId}-${name}`,
      },
      type: "ClusterIP",
    });
    const completedService = serviceResult.completedAt ?? this.#now();

    const service = buildOperation({
      id: `provider_op_${this.#idGenerator()}`,
      kind: "k8s-service-apply",
      desiredStateId: desiredState.id,
      targetId: `${workload.id}-svc`,
      targetName: name,
      command: ["kubectl", "apply", "service", `${namespace}/${name}`],
      details: {
        descriptor: "provider.k8s.service@v1",
        namespace,
        port,
        objectAddress: objectAddress({
          apiVersion: "v1",
          kind: "Service",
          namespace,
          name,
        }),
        resourceVersion: serviceResult.resourceVersion,
      },
      recordedAt: completedService,
      execution: {
        status: serviceResult.stderr ? "failed" : "succeeded",
        code: serviceResult.stderr ? 1 : 0,
        stdout: serviceResult.stdout,
        stderr: serviceResult.stderr,
        startedAt: serviceResult.startedAt ?? startedService,
        completedAt: completedService,
      },
    });

    return { deployment, service, serviceName: name };
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

function envVarsFromWorkload(
  workload: RuntimeWorkloadSpec,
): readonly K8sEnvVar[] {
  return Object.entries(workload.env ?? {}).map(([name, value]) => ({
    name,
    value,
  }));
}

function inferPort(workload: RuntimeWorkloadSpec, fallback: number): number {
  const explicit = workload.env?.PORT;
  const parsed = explicit ? Number.parseInt(explicit, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
