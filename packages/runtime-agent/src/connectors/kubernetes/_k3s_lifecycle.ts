/**
 * `DirectK3sDeploymentLifecycle` — calls the Kubernetes API server directly
 * using a bearer token (typical for kubeconfig-mounted operator workflows
 * or in-cluster ServiceAccount tokens).
 */

import {
  parseK8sDeploymentResponse,
  parseK8sObjectResponse,
  parseK8sServiceResponse,
} from "../_wire.ts";

export interface K3sDeploymentDescriptor {
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly replicas: number;
  readonly internalHost: string;
  readonly internalPort: number;
  readonly clusterIp?: string;
}

export interface K3sCreateDeploymentInput {
  readonly namespace: string;
  readonly name: string;
  readonly image: string;
  readonly replicas: number;
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly cpu?: string;
  readonly memory?: string;
}

export interface DirectK3sDeploymentLifecycleOptions {
  readonly apiServerUrl: string;
  readonly bearerToken: string;
  readonly fetch?: typeof fetch;
}

export class DirectK3sDeploymentLifecycle {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: DirectK3sDeploymentLifecycleOptions) {
    this.#base = options.apiServerUrl.replace(/\/$/, "");
    this.#token = options.bearerToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async createDeployment(
    input: K3sCreateDeploymentInput,
  ): Promise<K3sDeploymentDescriptor> {
    const labels = { app: input.name };
    const deploymentBody = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: input.name, namespace: input.namespace, labels },
      spec: {
        replicas: input.replicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: input.name,
                image: input.image,
                ports: [{ containerPort: input.port }],
                env: input.env
                  ? Object.entries(input.env).map(([k, v]) => ({
                    name: k,
                    value: v,
                  }))
                  : [],
                resources: input.cpu || input.memory
                  ? {
                    requests: {
                      cpu: input.cpu ?? "100m",
                      memory: input.memory ?? "128Mi",
                    },
                    limits: {
                      cpu: input.cpu ?? "500m",
                      memory: input.memory ?? "512Mi",
                    },
                  }
                  : undefined,
              },
            ],
          },
        },
      },
    };
    const serviceBody = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: input.name, namespace: input.namespace, labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{
          port: input.port,
          targetPort: input.port,
          protocol: "TCP",
        }],
      },
    };
    await this.#postOrIgnoreConflict(
      `/apis/apps/v1/namespaces/${input.namespace}/deployments`,
      deploymentBody,
      `k8s:CreateDeployment ${input.namespace}/${input.name}`,
    );
    const svcResult = await this.#postOrIgnoreConflict(
      `/api/v1/namespaces/${input.namespace}/services`,
      serviceBody,
      `k8s:CreateService ${input.namespace}/${input.name}`,
    );
    const clusterIp = svcResult?.spec?.clusterIP;
    return {
      namespace: input.namespace,
      deploymentName: input.name,
      serviceName: input.name,
      replicas: input.replicas,
      internalHost: `${input.name}.${input.namespace}.svc.cluster.local`,
      internalPort: input.port,
      clusterIp,
    };
  }

  async describeDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<K3sDeploymentDescriptor | undefined> {
    const depPath =
      `/apis/apps/v1/namespaces/${input.namespace}/deployments/${input.name}`;
    const dep = await this.#getValidatedJson(
      depPath,
      (raw) =>
        parseK8sDeploymentResponse(
          raw,
          `k8s:GetDeployment ${input.namespace}/${input.name}`,
        ),
    );
    if (!dep) return undefined;
    const svcPath =
      `/api/v1/namespaces/${input.namespace}/services/${input.name}`;
    const svc = await this.#getValidatedJson(
      svcPath,
      (raw) =>
        parseK8sServiceResponse(
          raw,
          `k8s:GetService ${input.namespace}/${input.name}`,
        ),
    );
    return {
      namespace: input.namespace,
      deploymentName: input.name,
      serviceName: input.name,
      replicas: dep.spec?.replicas ?? dep.status?.replicas ?? 1,
      internalHost: `${input.name}.${input.namespace}.svc.cluster.local`,
      internalPort: svc?.spec?.ports?.[0]?.port ?? 80,
      clusterIp: svc?.spec?.clusterIP,
    };
  }

  async deleteDeployment(
    input: { readonly namespace: string; readonly name: string },
  ): Promise<boolean> {
    const depDeleted = await this.#deleteIgnoreNotFound(
      `/apis/apps/v1/namespaces/${input.namespace}/deployments/${input.name}`,
      `k8s:DeleteDeployment ${input.namespace}/${input.name}`,
    );
    await this.#deleteIgnoreNotFound(
      `/api/v1/namespaces/${input.namespace}/services/${input.name}`,
      `k8s:DeleteService ${input.namespace}/${input.name}`,
    );
    return depDeleted;
  }

  /**
   * Verify-only: GET `/api/v1/namespaces`. Returns the raw `Response` so
   * the connector can produce a verify result without throwing.
   */
  listNamespacesResponse(): Promise<Response> {
    return this.#fetch(`${this.#base}/api/v1/namespaces?limit=1`, {
      method: "GET",
      headers: this.#authHeaders(),
    });
  }

  /**
   * GET `path` and run the response body through a structural parser. The
   * parser owns error reporting (`ConnectorContractError`) so callers do not
   * need to widen the result type. Returns `undefined` on 404.
   */
  async #getValidatedJson<T>(
    path: string,
    parse: (raw: unknown) => T | undefined,
  ): Promise<T | undefined> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: "GET",
      headers: this.#authHeaders(),
    });
    if (response.status === 404) return undefined;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `k8s GET ${path} failed: HTTP ${response.status}: ${text}`,
      );
    }
    if (!text) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `k8s GET ${path} returned non-JSON body: ${(cause as Error).message}`,
      );
    }
    return parse(raw);
  }

  async #postOrIgnoreConflict(
    path: string,
    body: unknown,
    context: string,
  ): Promise<{ spec?: { clusterIP?: string } } | undefined> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: "POST",
      headers: { ...this.#authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (response.status === 409) return undefined;
    if (!response.ok) {
      throw new Error(
        `${context} failed: HTTP ${response.status}: ${text}`,
      );
    }
    if (!text) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (cause) {
      throw new Error(
        `${context} returned non-JSON body: ${(cause as Error).message}`,
      );
    }
    return parseK8sObjectResponse(raw, context);
  }

  async #deleteIgnoreNotFound(
    path: string,
    context: string,
  ): Promise<boolean> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method: "DELETE",
      headers: this.#authHeaders(),
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `${context} failed: HTTP ${response.status}: ${text}`,
      );
    }
    return true;
  }

  #authHeaders(): Record<string, string> {
    return {
      "authorization": `Bearer ${this.#token}`,
      "accept": "application/json",
    };
  }
}
