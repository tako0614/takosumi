import type { ProviderPlugin } from "takosumi-contract";
import type {
  CustomDomainCapability,
  CustomDomainOutputs,
  CustomDomainSpec,
} from "../../shapes/custom-domain.ts";

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

const SUPPORTED_CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "http3",
];

export function createCloudflareDnsProvider(
  options: CloudflareDnsProviderOptions,
): ProviderPlugin<CustomDomainSpec, CustomDomainOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "cloudflare-dns",
    version: "1.0.0",
    implements: { id: "custom-domain", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createRecord({
        fqdn: spec.name,
        target: spec.target,
        proxied: true,
      });
      return {
        handle: desc.recordId,
        outputs: {
          fqdn: desc.fqdn,
          nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
        },
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
        outputs: {
          fqdn: desc.fqdn,
          nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
        },
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
