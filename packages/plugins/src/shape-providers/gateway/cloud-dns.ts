import type { ProviderPlugin } from "takosumi-contract";
import type {
  GatewayCapability,
  GatewayOutputs,
  GatewaySpec,
} from "../../kinds/gateway.ts";

export interface CloudDnsRecordDescriptor {
  readonly recordName: string;
  readonly fqdn: string;
  readonly target: string;
  readonly project: string;
  readonly zoneName: string;
}

export interface CloudDnsLifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
  }): Promise<CloudDnsRecordDescriptor>;
  describeRecord(input: {
    readonly recordName: string;
  }): Promise<CloudDnsRecordDescriptor | undefined>;
  deleteRecord(input: {
    readonly recordName: string;
  }): Promise<boolean>;
}

export interface CloudDnsProviderOptions {
  readonly lifecycle: CloudDnsLifecycleClient;
  readonly project: string;
  readonly zoneName: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly GatewayCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
];

export function createCloudDnsProvider(
  options: CloudDnsProviderOptions,
): ProviderPlugin<GatewaySpec, GatewayOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/gcp-cloud-dns",
    version: "1.0.0",
    implements: { id: "gateway", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const target = requireInjectedTarget(spec);
      const desc = await lifecycle.createRecord({
        fqdn: requireRequestedHost(spec),
        target,
      });
      return { handle: desc.recordName, outputs: endpointOutputs(desc.fqdn) };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteRecord({ recordName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeRecord({ recordName: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: endpointOutputs(desc.fqdn),
        observedAt: clock().toISOString(),
      };
    },
  };
}

export class InMemoryCloudDnsLifecycle implements CloudDnsLifecycleClient {
  readonly #records = new Map<string, CloudDnsRecordDescriptor>();
  readonly #project: string;
  readonly #zoneName: string;
  #counter = 0;

  constructor(project: string, zoneName: string) {
    this.#project = project;
    this.#zoneName = zoneName;
  }

  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
  }): Promise<CloudDnsRecordDescriptor> {
    const recordName = `cdns-${++this.#counter}`;
    const desc: CloudDnsRecordDescriptor = {
      recordName,
      fqdn: input.fqdn,
      target: input.target,
      project: this.#project,
      zoneName: this.#zoneName,
    };
    this.#records.set(recordName, desc);
    return Promise.resolve(desc);
  }

  describeRecord(input: {
    readonly recordName: string;
  }): Promise<CloudDnsRecordDescriptor | undefined> {
    return Promise.resolve(this.#records.get(input.recordName));
  }

  deleteRecord(input: {
    readonly recordName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#records.delete(input.recordName));
  }
}

function requireInjectedTarget(spec: GatewaySpec): string {
  const target = (spec as { target?: unknown }).target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("gateway requires listen-derived target");
  }
  return target;
}

function requireRequestedHost(spec: GatewaySpec): string {
  for (const listener of Object.values(spec.listeners)) {
    if (typeof listener.host === "string" && listener.host.length > 0) {
      return listener.host;
    }
  }
  throw new Error("gateway requires at least one listener host");
}

function endpointOutputs(host: string): GatewayOutputs {
  return {
    url: `https://${host}`,
    host,
    scheme: "https",
  };
}
