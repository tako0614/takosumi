import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";

export interface AzureContainerAppDescriptor {
  readonly serviceName: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  /** Public FQDN exposed by the container app, when ingress is enabled. */
  readonly fqdn?: string;
  readonly internalHost: string;
  readonly internalPort: number;
}

export interface AzureContainerAppCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly cpu: number;
  readonly memoryGib: number;
  readonly minReplicas: number;
  readonly maxReplicas: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AzureContainerAppsLifecycleClient {
  createService(
    input: AzureContainerAppCreateInput,
  ): Promise<AzureContainerAppDescriptor>;
  describeService(input: {
    readonly serviceName: string;
  }): Promise<AzureContainerAppDescriptor | undefined>;
  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean>;
}

export interface AzureContainerAppsWebServiceProviderOptions {
  readonly lifecycle: AzureContainerAppsLifecycleClient;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly region: string;
  readonly environmentName: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "scale-to-zero",
  "websocket",
  "long-request",
];

export function createAzureContainerAppsWebServiceProvider(
  options: AzureContainerAppsWebServiceProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "azure-container-apps",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createService({
        serviceName: serviceNameFromImage(spec.image),
        image: spec.image,
        cpu: parseCpu(spec.resources?.cpu),
        memoryGib: parseMemoryGib(spec.resources?.memory),
        minReplicas: spec.scale.min,
        maxReplicas: spec.scale.max,
        internalPort: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
      });
      return {
        handle: handleOf(desc),
        outputs: outputsOf(desc),
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
        outputs: outputsOf(desc),
        observedAt: clock().toISOString(),
      };
    },
  };
}

function outputsOf(desc: AzureContainerAppDescriptor): WebServiceOutputs {
  return {
    url: desc.fqdn ? `https://${desc.fqdn}` : `https://${desc.internalHost}`,
    internalHost: desc.internalHost,
    internalPort: desc.internalPort,
  };
}

function handleOf(desc: AzureContainerAppDescriptor): string {
  return `/subscriptions/${desc.subscriptionId}/resourceGroups/${desc.resourceGroup}/providers/Microsoft.App/containerApps/${desc.serviceName}`;
}

function serviceNameFromHandle(handle: string): string {
  return handle.split("/").at(-1) ?? handle;
}

function serviceNameFromImage(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function parseCpu(cpu: string | undefined): number {
  if (!cpu) return 0.5;
  if (cpu.endsWith("m")) return parseInt(cpu, 10) / 1000;
  return parseFloat(cpu);
}

function parseMemoryGib(memory: string | undefined): number {
  if (!memory) return 1.0;
  if (memory.endsWith("Gi")) return parseFloat(memory);
  if (memory.endsWith("Mi")) return parseInt(memory, 10) / 1024;
  return parseFloat(memory);
}

export class InMemoryAzureContainerAppsLifecycle
  implements AzureContainerAppsLifecycleClient {
  readonly #services = new Map<string, AzureContainerAppDescriptor>();
  readonly #subscriptionId: string;
  readonly #resourceGroup: string;
  readonly #region: string;
  readonly #environmentName: string;

  constructor(
    subscriptionId: string,
    resourceGroup: string,
    region: string,
    environmentName: string,
  ) {
    this.#subscriptionId = subscriptionId;
    this.#resourceGroup = resourceGroup;
    this.#region = region;
    this.#environmentName = environmentName;
  }

  createService(
    input: AzureContainerAppCreateInput,
  ): Promise<AzureContainerAppDescriptor> {
    const desc: AzureContainerAppDescriptor = {
      serviceName: input.serviceName,
      subscriptionId: this.#subscriptionId,
      resourceGroup: this.#resourceGroup,
      region: this.#region,
      environmentName: this.#environmentName,
      fqdn: `${input.serviceName}.${this.#region}.azurecontainerapps.io`,
      internalHost: `${input.serviceName}.internal.${this.#environmentName}`,
      internalPort: input.internalPort,
    };
    this.#services.set(input.serviceName, desc);
    return Promise.resolve(desc);
  }

  describeService(input: {
    readonly serviceName: string;
  }): Promise<AzureContainerAppDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#services.delete(input.serviceName));
  }
}
