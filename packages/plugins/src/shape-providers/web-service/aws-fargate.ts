import type { ProviderPlugin } from "takosumi-contract";
import type {
  WebServiceCapability,
  WebServiceOutputs,
  WebServiceSpec,
} from "../../shapes/web-service.ts";

export interface AwsFargateServiceDescriptor {
  readonly serviceName: string;
  readonly clusterName: string;
  readonly region: string;
  readonly serviceArn: string;
  readonly loadBalancerUrl?: string;
  readonly internalHost: string;
  readonly internalPort: number;
}

export interface AwsFargateServiceCreateInput {
  readonly serviceName: string;
  readonly image: string;
  readonly cpu: number;
  readonly memory: number;
  readonly minTasks: number;
  readonly maxTasks: number;
  readonly internalPort: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AwsFargateLifecycleClient {
  createService(
    input: AwsFargateServiceCreateInput,
  ): Promise<AwsFargateServiceDescriptor>;
  describeService(input: {
    readonly serviceName: string;
  }): Promise<AwsFargateServiceDescriptor | undefined>;
  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean>;
}

export interface AwsFargateWebServiceProviderOptions {
  readonly lifecycle: AwsFargateLifecycleClient;
  readonly clusterName: string;
  readonly region: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly WebServiceCapability[] = [
  "always-on",
  "websocket",
  "long-request",
  "sticky-session",
  "private-networking",
];

export function createAwsFargateWebServiceProvider(
  options: AwsFargateWebServiceProviderOptions,
): ProviderPlugin<WebServiceSpec, WebServiceOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "aws-fargate",
    version: "1.0.0",
    implements: { id: "web-service", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const cpu = parseCpu(spec.resources?.cpu);
      const memory = parseMemory(spec.resources?.memory);
      const desc = await lifecycle.createService({
        serviceName: serviceNameFromImage(spec.image),
        image: spec.image,
        cpu,
        memory,
        minTasks: spec.scale.min,
        maxTasks: spec.scale.max,
        internalPort: spec.port,
        env: { ...(spec.env ?? {}), ...(spec.bindings ?? {}) },
      });
      return { handle: desc.serviceArn, outputs: outputsOf(desc) };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteService({
        serviceName: serviceNameFromArn(handle),
      });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeService({
        serviceName: serviceNameFromArn(handle),
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

function outputsOf(desc: AwsFargateServiceDescriptor): WebServiceOutputs {
  return {
    url: desc.loadBalancerUrl ?? `https://${desc.internalHost}`,
    internalHost: desc.internalHost,
    internalPort: desc.internalPort,
  };
}

function serviceNameFromImage(image: string): string {
  const tail = image.split("/").at(-1)?.split(":")[0] ?? "service";
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function serviceNameFromArn(arn: string): string {
  return arn.split("/").at(-1) ?? arn;
}

function parseCpu(cpu: string | undefined): number {
  if (!cpu) return 256;
  if (cpu.endsWith("m")) return parseInt(cpu, 10);
  return Math.round(parseFloat(cpu) * 1024);
}

function parseMemory(memory: string | undefined): number {
  if (!memory) return 512;
  if (memory.endsWith("Mi")) return parseInt(memory, 10);
  if (memory.endsWith("Gi")) return parseInt(memory, 10) * 1024;
  return parseInt(memory, 10);
}

export class InMemoryAwsFargateLifecycle implements AwsFargateLifecycleClient {
  readonly #services = new Map<string, AwsFargateServiceDescriptor>();
  readonly #cluster: string;
  readonly #region: string;

  constructor(cluster: string, region: string) {
    this.#cluster = cluster;
    this.#region = region;
  }

  createService(
    input: AwsFargateServiceCreateInput,
  ): Promise<AwsFargateServiceDescriptor> {
    const desc: AwsFargateServiceDescriptor = {
      serviceName: input.serviceName,
      clusterName: this.#cluster,
      region: this.#region,
      serviceArn:
        `arn:aws:ecs:${this.#region}:000000000000:service/${this.#cluster}/${input.serviceName}`,
      loadBalancerUrl:
        `https://${input.serviceName}.${this.#region}.elb.example.com`,
      internalHost: `${input.serviceName}.svc.cluster.local`,
      internalPort: input.internalPort,
    };
    this.#services.set(input.serviceName, desc);
    return Promise.resolve(desc);
  }

  describeService(input: {
    readonly serviceName: string;
  }): Promise<AwsFargateServiceDescriptor | undefined> {
    return Promise.resolve(this.#services.get(input.serviceName));
  }

  deleteService(input: {
    readonly serviceName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#services.delete(input.serviceName));
  }
}
