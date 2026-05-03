import type { ProviderPlugin } from "takosumi-contract";
import type {
  CustomDomainCapability,
  CustomDomainOutputs,
  CustomDomainSpec,
} from "../../shapes/custom-domain.ts";

export interface CoreDnsRecordDescriptor {
  readonly recordName: string;
  readonly fqdn: string;
  readonly target: string;
  readonly zoneFile: string;
}

export interface CoreDnsLifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
  }): Promise<CoreDnsRecordDescriptor>;
  describeRecord(input: {
    readonly recordName: string;
  }): Promise<CoreDnsRecordDescriptor | undefined>;
  deleteRecord(input: {
    readonly recordName: string;
  }): Promise<boolean>;
}

export interface CoreDnsLocalProviderOptions {
  readonly lifecycle: CoreDnsLifecycleClient;
  readonly zoneFile: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
];

export function createCoreDnsLocalProvider(
  options: CoreDnsLocalProviderOptions,
): ProviderPlugin<CustomDomainSpec, CustomDomainOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/selfhost-coredns",
    version: "1.0.0",
    implements: { id: "custom-domain", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createRecord({
        fqdn: spec.name,
        target: spec.target,
      });
      return { handle: desc.recordName, outputs: { fqdn: desc.fqdn } };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteRecord({ recordName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeRecord({ recordName: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: { fqdn: desc.fqdn },
        observedAt: clock().toISOString(),
      };
    },
  };
}

export class InMemoryCoreDnsLifecycle implements CoreDnsLifecycleClient {
  readonly #records = new Map<string, CoreDnsRecordDescriptor>();
  readonly #zoneFile: string;
  #counter = 0;

  constructor(zoneFile: string) {
    this.#zoneFile = zoneFile;
  }

  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
  }): Promise<CoreDnsRecordDescriptor> {
    const recordName = `coredns-${++this.#counter}`;
    const desc: CoreDnsRecordDescriptor = {
      recordName,
      fqdn: input.fqdn,
      target: input.target,
      zoneFile: this.#zoneFile,
    };
    this.#records.set(recordName, desc);
    return Promise.resolve(desc);
  }

  describeRecord(input: {
    readonly recordName: string;
  }): Promise<CoreDnsRecordDescriptor | undefined> {
    return Promise.resolve(this.#records.get(input.recordName));
  }

  deleteRecord(input: {
    readonly recordName: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#records.delete(input.recordName));
  }
}
