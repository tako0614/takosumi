import type { ProviderPlugin } from "takosumi-contract";
import type {
  CustomDomainCapability,
  CustomDomainOutputs,
  CustomDomainSpec,
} from "../../shapes/custom-domain.ts";

export interface Route53RecordDescriptor {
  readonly recordSetId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly hostedZoneId: string;
  readonly certificateArn?: string;
}

export interface Route53LifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly recordType: "A" | "AAAA" | "CNAME";
  }): Promise<Route53RecordDescriptor>;
  describeRecord(input: {
    readonly recordSetId: string;
  }): Promise<Route53RecordDescriptor | undefined>;
  deleteRecord(input: {
    readonly recordSetId: string;
  }): Promise<boolean>;
}

export interface Route53ProviderOptions {
  readonly lifecycle: Route53LifecycleClient;
  readonly hostedZoneId: string;
  readonly clock?: () => Date;
}

const SUPPORTED_CAPABILITIES: readonly CustomDomainCapability[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "alpn-acme",
];

export function createRoute53Provider(
  options: Route53ProviderOptions,
): ProviderPlugin<CustomDomainSpec, CustomDomainOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/aws-route53",
    version: "1.0.0",
    implements: { id: "custom-domain", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const desc = await lifecycle.createRecord({
        fqdn: spec.name,
        target: spec.target,
        recordType: "CNAME",
      });
      return {
        handle: desc.recordSetId,
        outputs: {
          fqdn: desc.fqdn,
          certificateArn: desc.certificateArn,
        },
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteRecord({ recordSetId: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeRecord({ recordSetId: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: {
          fqdn: desc.fqdn,
          certificateArn: desc.certificateArn,
        },
        observedAt: clock().toISOString(),
      };
    },
  };
}

export class InMemoryRoute53Lifecycle implements Route53LifecycleClient {
  readonly #records = new Map<string, Route53RecordDescriptor>();
  readonly #hostedZoneId: string;
  #counter = 0;

  constructor(hostedZoneId: string) {
    this.#hostedZoneId = hostedZoneId;
  }

  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
  }): Promise<Route53RecordDescriptor> {
    const recordSetId = `r53-${++this.#counter}`;
    const desc: Route53RecordDescriptor = {
      recordSetId,
      fqdn: input.fqdn,
      target: input.target,
      hostedZoneId: this.#hostedZoneId,
    };
    this.#records.set(recordSetId, desc);
    return Promise.resolve(desc);
  }

  describeRecord(input: {
    readonly recordSetId: string;
  }): Promise<Route53RecordDescriptor | undefined> {
    return Promise.resolve(this.#records.get(input.recordSetId));
  }

  deleteRecord(input: {
    readonly recordSetId: string;
  }): Promise<boolean> {
    return Promise.resolve(this.#records.delete(input.recordSetId));
  }
}
