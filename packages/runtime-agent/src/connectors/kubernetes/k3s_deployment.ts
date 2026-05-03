/**
 * `K3sDeploymentConnector` — wraps `DirectK3sDeploymentLifecycle` for
 * `web-service@v1`.
 */

import type {
  JsonObject,
  LifecycleApplyRequest,
  LifecycleApplyResponse,
  LifecycleDescribeRequest,
  LifecycleDescribeResponse,
  LifecycleDestroyRequest,
  LifecycleDestroyResponse,
} from "takosumi-contract";
import type {
  Connector,
  ConnectorContext,
  ConnectorVerifyResult,
} from "../connector.ts";
import {
  verifyResultFromError,
  verifyResultFromStatus,
} from "../_verify_helpers.ts";
import {
  DirectK3sDeploymentLifecycle,
  type K3sDeploymentDescriptor,
} from "./_k3s_lifecycle.ts";

export interface K3sDeploymentConnectorOptions {
  readonly apiServerUrl: string;
  readonly bearerToken: string;
  readonly namespace: string;
  readonly clusterDomain?: string;
  readonly fetch?: typeof fetch;
}

export class K3sDeploymentConnector implements Connector {
  readonly provider = "@takos/kubernetes-deployment";
  readonly shape = "web-service@v1";
  readonly acceptedArtifactKinds: readonly string[] = ["oci-image"];
  readonly #lifecycle: DirectK3sDeploymentLifecycle;
  readonly #namespace: string;
  readonly #clusterDomain: string;

  constructor(opts: K3sDeploymentConnectorOptions) {
    this.#lifecycle = new DirectK3sDeploymentLifecycle({
      apiServerUrl: opts.apiServerUrl,
      bearerToken: opts.bearerToken,
      fetch: opts.fetch,
    });
    this.#namespace = opts.namespace;
    this.#clusterDomain = opts.clusterDomain ?? "cluster.local";
  }

  async apply(
    req: LifecycleApplyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleApplyResponse> {
    const spec = req.spec as unknown as {
      image?: string;
      artifact?: { kind: string; uri?: string };
      port: number;
      scale: { min: number; max: number };
      resources?: { cpu?: string; memory?: string };
      env?: Record<string, string>;
      bindings?: Record<string, string>;
    };
    const image = spec.image ?? spec.artifact?.uri;
    if (!image) {
      throw new Error("web-service spec requires `image` or `artifact.uri`");
    }
    const desc = await this.#lifecycle.createDeployment({
      namespace: this.#namespace,
      name: nameOf(image),
      image,
      replicas: spec.scale.min,
      port: spec.port,
      env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
      cpu: spec.resources?.cpu,
      memory: spec.resources?.memory,
    });
    return {
      handle: `${desc.namespace}/${desc.deploymentName}`,
      outputs: this.#outputsFor(desc),
    };
  }

  async destroy(
    req: LifecycleDestroyRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDestroyResponse> {
    const [ns, name] = req.handle.split("/", 2);
    const deleted = await this.#lifecycle.deleteDeployment({
      namespace: ns,
      name,
    });
    return deleted ? { ok: true } : { ok: true, note: "deployment not found" };
  }

  async describe(
    req: LifecycleDescribeRequest,
    _ctx: ConnectorContext,
  ): Promise<LifecycleDescribeResponse> {
    const [ns, name] = req.handle.split("/", 2);
    const desc = await this.#lifecycle.describeDeployment({
      namespace: ns,
      name,
    });
    if (!desc) return { status: "missing" };
    return { status: "running", outputs: this.#outputsFor(desc) };
  }

  async verify(_ctx: ConnectorContext): Promise<ConnectorVerifyResult> {
    try {
      const response = await this.#lifecycle.listNamespacesResponse();
      const text = response.ok ? "" : await response.text().catch(() => "");
      return verifyResultFromStatus(response.status, {
        okStatuses: [200],
        responseText: text,
        context: "k8s:ListNamespaces",
      });
    } catch (error) {
      return verifyResultFromError(error, "k8s:ListNamespaces");
    }
  }

  #outputsFor(desc: K3sDeploymentDescriptor): JsonObject {
    return {
      url:
        `http://${desc.serviceName}.${desc.namespace}.svc.${this.#clusterDomain}:${desc.internalPort}`,
      internalHost:
        `${desc.serviceName}.${desc.namespace}.svc.${this.#clusterDomain}`,
      internalPort: desc.internalPort,
    };
  }
}

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "svc";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}
