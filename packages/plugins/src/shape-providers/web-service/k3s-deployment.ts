import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";

export interface K3sDeploymentDescriptor {
  readonly namespace: string;
  readonly deploymentName: string;
  readonly serviceName: string;
  readonly replicas: number;
  readonly internalHost: string;
  readonly internalPort: number;
  readonly clusterIp?: string;
}

export interface K3sDeploymentLifecycleClient {
  createDeployment(input: {
    readonly namespace: string;
    readonly name: string;
    readonly image: string;
    readonly replicas: number;
    readonly port: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly cpu?: string;
    readonly memory?: string;
  }): Promise<K3sDeploymentDescriptor>;
  describeDeployment(input: {
    readonly namespace: string;
    readonly name: string;
  }): Promise<K3sDeploymentDescriptor | undefined>;
  deleteDeployment(input: {
    readonly namespace: string;
    readonly name: string;
  }): Promise<boolean>;
}

export interface K3sDeploymentProviderOptions {
  readonly lifecycle: K3sDeploymentLifecycleClient;
  readonly namespace: string;
  readonly clusterDomain?: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "websocket",
  "long-request",
  "private-networking",
];

export function createK3sDeploymentWebServiceProvider(
  options: K3sDeploymentProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const namespace = options.namespace;
  const clusterDomain = options.clusterDomain ?? "cluster.local";
  const clock = options.clock ?? (() => new Date());
  return {
    id: "k3s-deployment",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createDeployment({
        namespace,
        name: nameOf(spec.image),
        image: spec.image,
        replicas: spec.scale.min,
        port: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
        cpu: spec.resources?.cpu,
        memory: spec.resources?.memory,
      });
      return {
        handle: `${desc.namespace}/${desc.deploymentName}`,
        outputs: {
          url:
            `http://${desc.serviceName}.${desc.namespace}.svc.${clusterDomain}:${desc.internalPort}`,
          internalHost:
            `${desc.serviceName}.${desc.namespace}.svc.${clusterDomain}`,
          internalPort: desc.internalPort,
        },
      };
    },
    async destroy(handle, _ctx) {
      const [ns, name] = handle.split("/", 2);
      await lifecycle.deleteDeployment({ namespace: ns, name });
    },
    async status(handle, _ctx) {
      const [ns, name] = handle.split("/", 2);
      const desc = await lifecycle.describeDeployment({ namespace: ns, name });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: {
          url:
            `http://${desc.serviceName}.${desc.namespace}.svc.${clusterDomain}:${desc.internalPort}`,
          internalHost:
            `${desc.serviceName}.${desc.namespace}.svc.${clusterDomain}`,
          internalPort: desc.internalPort,
        },
        observedAt: clock().toISOString(),
      };
    },
  };
}

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "svc";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

export class InMemoryK3sDeploymentLifecycle
  implements K3sDeploymentLifecycleClient {
  readonly #deployments = new Map<string, K3sDeploymentDescriptor>();

  createDeployment(input: {
    readonly namespace: string;
    readonly name: string;
    readonly replicas: number;
    readonly port: number;
  }): Promise<K3sDeploymentDescriptor> {
    const desc: K3sDeploymentDescriptor = {
      namespace: input.namespace,
      deploymentName: input.name,
      serviceName: input.name,
      replicas: input.replicas,
      internalHost: `${input.name}.${input.namespace}.svc.cluster.local`,
      internalPort: input.port,
      clusterIp: "10.0.0.1",
    };
    this.#deployments.set(`${input.namespace}/${input.name}`, desc);
    return Promise.resolve(desc);
  }

  describeDeployment(input: {
    readonly namespace: string;
    readonly name: string;
  }): Promise<K3sDeploymentDescriptor | undefined> {
    return Promise.resolve(
      this.#deployments.get(`${input.namespace}/${input.name}`),
    );
  }

  deleteDeployment(input: {
    readonly namespace: string;
    readonly name: string;
  }): Promise<boolean> {
    return Promise.resolve(
      this.#deployments.delete(`${input.namespace}/${input.name}`),
    );
  }
}
