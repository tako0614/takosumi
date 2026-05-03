import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";
import { resolveOciImage } from "./_artifact_image.ts";

export interface SystemdUnitDescriptor {
  readonly unitName: string;
  readonly hostBinding: string;
  readonly hostPort: number;
  readonly internalPort: number;
}

export interface SystemdUnitLifecycleClient {
  createUnit(input: {
    readonly unitName: string;
    readonly image: string;
    readonly hostPort: number;
    readonly internalPort: number;
    readonly env?: Readonly<Record<string, string>>;
    readonly command?: readonly string[];
  }): Promise<SystemdUnitDescriptor>;
  describeUnit(input: {
    readonly unitName: string;
  }): Promise<SystemdUnitDescriptor | undefined>;
  deleteUnit(input: {
    readonly unitName: string;
  }): Promise<boolean>;
}

export interface SystemdUnitProviderOptions {
  readonly lifecycle: SystemdUnitLifecycleClient;
  readonly hostBinding?: string;
  readonly hostPortStart?: number;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "long-request",
];

export function createSystemdUnitWebServiceProvider(
  options: SystemdUnitProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const hostBinding = options.hostBinding ?? "127.0.0.1";
  const portAlloc = createPortAllocator(options.hostPortStart ?? 28080);
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/selfhost-systemd",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const image = resolveOciImage(spec);
      const unitName = `${nameOf(image)}.service`;
      const hostPort = portAlloc();
      const desc = await lifecycle.createUnit({
        unitName,
        image,
        hostPort,
        internalPort: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
        command: spec.command,
      });
      return {
        handle: unitName,
        outputs: {
          url: `http://${hostBinding}:${desc.hostPort}`,
          internalHost: hostBinding,
          internalPort: desc.internalPort,
        },
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteUnit({ unitName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeUnit({ unitName: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: {
          url: `http://${hostBinding}:${desc.hostPort}`,
          internalHost: hostBinding,
          internalPort: desc.internalPort,
        },
        observedAt: clock().toISOString(),
      };
    },
  };
}

function nameOf(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function createPortAllocator(start: number): () => number {
  let next = start;
  return () => next++;
}

export class InMemorySystemdUnitLifecycle
  implements SystemdUnitLifecycleClient {
  readonly #units = new Map<string, SystemdUnitDescriptor>();

  createUnit(input: {
    readonly unitName: string;
    readonly hostPort: number;
    readonly internalPort: number;
  }): Promise<SystemdUnitDescriptor> {
    const desc: SystemdUnitDescriptor = {
      unitName: input.unitName,
      hostBinding: "127.0.0.1",
      hostPort: input.hostPort,
      internalPort: input.internalPort,
    };
    this.#units.set(input.unitName, desc);
    return Promise.resolve(desc);
  }

  describeUnit(input: {
    readonly unitName: string;
  }): Promise<SystemdUnitDescriptor | undefined> {
    return Promise.resolve(this.#units.get(input.unitName));
  }

  deleteUnit(input: {
    readonly unitName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#units.delete(input.unitName));
  }
}
