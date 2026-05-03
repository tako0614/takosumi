import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";
import { resolveOciImage } from "./_artifact_image.ts";

export interface DockerComposeServiceDescriptor {
  readonly serviceName: string;
  readonly image: string;
  readonly hostPort: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface DockerComposeServiceCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly hostPort: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly command?: readonly string[];
  readonly restart?: "no" | "on-failure" | "always" | "unless-stopped";
}

export interface DockerComposeServiceLifecycleClient {
  createService(
    input: DockerComposeServiceCreateInput,
  ): Promise<DockerComposeServiceDescriptor>;
  describeService(input: {
    readonly serviceName: string;
  }): Promise<DockerComposeServiceDescriptor | undefined>;
  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean>;
}

export interface DockerComposeWebServiceProviderOptions {
  readonly lifecycle: DockerComposeServiceLifecycleClient;
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "websocket",
  "long-request",
  "sticky-session",
];

export function createDockerComposeWebServiceProvider(
  options: DockerComposeWebServiceProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const hostBinding = options.hostBinding ?? "localhost";
  const portAllocator = createPortAllocator(options.hostPortStart ?? 18080);
  const clock = options.clock ?? (() => new Date());

  return {
    id: "docker-compose",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const image = resolveOciImage(spec);
      const serviceName = serviceNameFromImage(image);
      const hostPort = portAllocator();
      const desc = await lifecycle.createService({
        serviceName,
        image,
        hostPort,
        internalPort: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
        command: spec.command,
        restart: "unless-stopped",
      });
      return {
        handle: serviceName,
        outputs: outputsFromDescriptor(desc, hostBinding),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteService({ serviceName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeService({ serviceName: handle });
      if (!desc) {
        return { kind: "deleted", observedAt: clock().toISOString() };
      }
      return {
        kind: "ready",
        outputs: outputsFromDescriptor(desc, hostBinding),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function serviceNameFromImage(image: string): string {
  const fromImage = image.split("/").at(-1)?.split(":")[0] ??
    "web-service";
  return fromImage.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}

function outputsFromDescriptor(
  desc: DockerComposeServiceDescriptor,
  hostBinding: string,
): WebServiceOutputs {
  return {
    url: `http://${hostBinding}:${desc.hostPort}`,
    internalHost: desc.serviceName,
    internalPort: desc.internalPort,
  };
}

export class InMemoryDockerComposeLifecycle
  implements DockerComposeServiceLifecycleClient {
  readonly #services = new Map<string, DockerComposeServiceDescriptor>();

  createService(
    input: DockerComposeServiceCreateInput,
  ): Promise<DockerComposeServiceDescriptor> {
    const desc: DockerComposeServiceDescriptor = {
      serviceName: input.serviceName,
      image: input.image,
      hostPort: input.hostPort,
      internalPort: input.internalPort,
      env: input.env,
    };
    this.#services.set(input.serviceName, desc);
    return Promise.resolve(desc);
  }

  describeService(
    input: { readonly serviceName: string },
  ): Promise<DockerComposeServiceDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  deleteService(
    input: { readonly serviceName: string },
  ): Promise<boolean> {
    return Promise.resolve(this.#services.delete(input.serviceName));
  }

  size(): number {
    return this.#services.size;
  }

  get(name: string): DockerComposeServiceDescriptor | undefined {
    return this.#services.get(name);
  }
}
