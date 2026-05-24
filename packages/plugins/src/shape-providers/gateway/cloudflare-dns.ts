import type { ProviderPlugin } from "takosumi-contract";
import type {
  GatewayCapability,
  GatewayOutputs,
  GatewaySpec,
} from "../../kinds/gateway.ts";

export interface CloudflareDnsRecordDescriptor {
  readonly recordId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly proxied: boolean;
  readonly zoneId: string;
}

export interface CloudflareDnsLifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly proxied: boolean;
  }): Promise<CloudflareDnsRecordDescriptor>;
  describeRecord(input: {
    readonly recordId: string;
  }): Promise<CloudflareDnsRecordDescriptor | undefined>;
  deleteRecord(input: {
    readonly recordId: string;
  }): Promise<boolean>;
}

export interface CloudflareDnsProviderOptions {
  readonly lifecycle: CloudflareDnsLifecycleClient;
  readonly zoneId: string;
  readonly accountId: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly GatewayCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "http3",
];

export function createCloudflareDnsProvider(
  options: CloudflareDnsProviderOptions,
): ProviderPlugin<GatewaySpec, GatewayOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/cloudflare-dns",
    version: "1.0.0",
    implements: { id: "gateway", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const target = requireInjectedTarget(spec);
      const fqdn = requireRequestedHost(spec);
      const desc = await lifecycle.createRecord({
        fqdn,
        target,
        proxied: true,
      });
      return {
        handle: desc.recordId,
        outputs: endpointOutputs(desc.fqdn),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteRecord({ recordId: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeRecord({ recordId: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: endpointOutputs(desc.fqdn),
        observedAt: clock().toISOString(),
      };
    },
  };
}

export class InMemoryCloudflareDnsLifecycle
  implements CloudflareDnsLifecycleClient {
  readonly #records = new Map<string, CloudflareDnsRecordDescriptor>();
  readonly #zoneId: string;
  #counter = 0;

  constructor(zoneId: string) {
    this.#zoneId = zoneId;
  }

  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly proxied: boolean;
  }): Promise<CloudflareDnsRecordDescriptor> {
    const recordId = `cf-rec-${++this.#counter}`;
    const desc: CloudflareDnsRecordDescriptor = {
      recordId,
      fqdn: input.fqdn,
      target: input.target,
      proxied: input.proxied,
      zoneId: this.#zoneId,
    };
    this.#records.set(recordId, desc);
    return Promise.resolve(desc);
  }

  describeRecord(input: {
    readonly recordId: string;
  }): Promise<CloudflareDnsRecordDescriptor | undefined> {
    return Promise.resolve(this.#records.get(input.recordId));
  }

  deleteRecord(input: {
    readonly recordId: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#records.delete(input.recordId));
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

function endpointOutputs(
  host: string,
  certificateId?: string,
): GatewayOutputs {
  return {
    url: `https://${host}`,
    host,
    scheme: "https",
    ...(certificateId ? { certificateId } : {}),
  };
}
