import type { ProviderPlugin } from "takosumi-contract";
import type {
  CustomDomainCapability,
  CustomDomainOutputs,
  CustomDomainSpec,
} from "../../shapes/custom-domain.ts";

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

const SUPPORTED_CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
];

export function createCloudDnsProvider(
  options: CloudDnsProviderOptions,
): ProviderPlugin<CustomDomainSpec, CustomDomainOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "cloud-dns",
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
