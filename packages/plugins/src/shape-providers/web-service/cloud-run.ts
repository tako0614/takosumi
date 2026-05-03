import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";
import { resolveOciImage } from "./_artifact_image.ts";

export interface CloudRunServiceDescriptor {
  readonly serviceName: string;
  readonly project: string;
  readonly region: string;
  readonly url: string;
  readonly internalHost: string;
  readonly port: number;
}

export interface CloudRunLifecycleClient {
  createService(input: {
    readonly serviceName: string;
    readonly image: string;
    readonly minInstances: number;
    readonly maxInstances: number;
    readonly cpu?: string;
    readonly memory?: string;
    readonly port: number;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<CloudRunServiceDescriptor>;
  describeService(input: {
    readonly serviceName: string;
  }): Promise<CloudRunServiceDescriptor | undefined>;
  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean>;
}

export interface CloudRunWebServiceProviderOptions {
  readonly lifecycle: CloudRunLifecycleClient;
  readonly project: string;
  readonly region: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "scale-to-zero",
  "websocket",
  "long-request",
];

export function createCloudRunWebServiceProvider(
  options: CloudRunWebServiceProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "cloud-run",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const image = resolveOciImage(spec);
      const desc = await lifecycle.createService({
        serviceName: serviceNameOf(image),
        image,
        minInstances: spec.scale.min,
        maxInstances: spec.scale.max,
        cpu: spec.resources?.cpu,
        memory: spec.resources?.memory,
        port: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
      });
      return {
        handle: `${desc.project}/${desc.region}/${desc.serviceName}`,
        outputs: {
          url: desc.url,
          internalHost: desc.internalHost,
          internalPort: desc.port,
        },
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteService({
        serviceName: serviceNameFromHandle(handle),
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeService({
        serviceName: serviceNameFromHandle(handle),
      });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: {
          url: desc.url,
          internalHost: desc.internalHost,
          internalPort: desc.port,
        },
        observedAt: clock().toISOString(),
      };
    },
  };
}

function serviceNameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "svc";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function serviceNameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}

export class InMemoryCloudRunLifecycle implements CloudRunLifecycleClient {
  readonly #services = new Map<string, CloudRunServiceDescriptor>();
  readonly #project: string;
  readonly #region: string;

  constructor(project: string, region: string) {
    this.#project = project;
    this.#region = region;
  }

  createService(input: {
    readonly serviceName: string;
    readonly image: string;
    readonly port: number;
  }): Promise<CloudRunServiceDescriptor> {
    const desc: CloudRunServiceDescriptor = {
      serviceName: input.serviceName,
      project: this.#project,
      region: this.#region,
      url: `https://${input.serviceName}-xxxx-${this.#region}.a.run.app`,
      internalHost:
        `${input.serviceName}.${this.#region}.${this.#project}.run.app`,
      port: input.port,
    };
    this.#services.set(input.serviceName, desc);
    return Promise.resolve(desc);
  }

  describeService(input: {
    readonly serviceName: string;
  }): Promise<CloudRunServiceDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#services.delete(input.serviceName));
  }
}
