import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";
import { resolveOciImage } from "./_artifact_image.ts";

export interface CloudflareContainerDescriptor {
  readonly accountId: string;
  readonly serviceName: string;
  readonly publicUrl: string;
  readonly internalHost: string;
  readonly port: number;
}

export interface CloudflareContainerLifecycleClient {
  createService(input: {
    readonly serviceName: string;
    readonly image: string;
    readonly minInstances: number;
    readonly maxInstances: number;
    readonly port: number;
    readonly env?: Readonly<Record<string, string>>;
  }): Promise<CloudflareContainerDescriptor>;
  describeService(input: {
    readonly serviceName: string;
  }): Promise<CloudflareContainerDescriptor | undefined>;
  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean>;
}

export interface CloudflareContainerProviderOptions {
  readonly lifecycle: CloudflareContainerLifecycleClient;
  readonly accountId: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "scale-to-zero",
  "geo-routing",
];

export function createCloudflareContainerWebServiceProvider(
  options: CloudflareContainerProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/cloudflare-container",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const image = resolveOciImage(spec);
      const desc = await lifecycle.createService({
        serviceName: nameOf(image),
        image,
        minInstances: spec.scale.min === 0 ? 0 : Math.max(0, spec.scale.min),
        maxInstances: spec.scale.max,
        port: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
      });
      return {
        handle: `${desc.accountId}/${desc.serviceName}`,
        outputs: {
          url: desc.publicUrl,
          internalHost: desc.internalHost,
          internalPort: desc.port,
        },
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteService({ serviceName: nameFromHandle(handle) });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeService({
        serviceName: nameFromHandle(handle),
      });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: {
          url: desc.publicUrl,
          internalHost: desc.internalHost,
          internalPort: desc.port,
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

function nameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}

export class InMemoryCloudflareContainerLifecycle
  implements CloudflareContainerLifecycleClient {
  readonly #services = new Map<string, CloudflareContainerDescriptor>();
  readonly #accountId: string;

  constructor(accountId: string) {
    this.#accountId = accountId;
  }

  createService(input: {
    readonly serviceName: string;
    readonly port: number;
  }): Promise<CloudflareContainerDescriptor> {
    const desc: CloudflareContainerDescriptor = {
      accountId: this.#accountId,
      serviceName: input.serviceName,
      publicUrl: `https://${input.serviceName}.cf-containers.example`,
      internalHost: `${input.serviceName}.cf.local`,
      port: input.port,
    };
    this.#services.set(input.serviceName, desc);
    return Promise.resolve(desc);
  }

  describeService(input: {
    readonly serviceName: string;
  }): Promise<CloudflareContainerDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#services.delete(input.serviceName));
  }
}
