import type { ProviderPlugin } from "takosumi-contract/reference/provider-plugin";
import type {
  GatewayCapabilityTerm,
  GatewayOutputs,
  GatewaySpec,
} from "../../kinds/gateway.ts";

export interface CoreDnsRecordDescriptor {
  readonly recordName: string;
  readonly fqdn: string;
  readonly target: string;
  readonly listener: string;
  readonly routes: readonly Record<string, unknown>[];
  readonly zoneFile: string;
}

export interface CoreDnsLifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
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

const SUPPORTED_CAPABILITIES: readonly GatewayCapabilityTerm[] = [
  "wildcard",
];

export function createCoreDnsLocalProvider(
  options: CoreDnsLocalProviderOptions,
): ProviderPlugin<GatewaySpec, GatewayOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/coredns-gateway",
    version: "1.0.0",
    implements: { id: "gateway", version: "v1" },
    capabilities: SUPPORTED_CAPABILITIES,
    async apply(spec, _ctx) {
      const target = requireInjectedTarget(spec);
      const endpoint = requireEndpointRequest(spec);
      const desc = await lifecycle.createRecord({
        fqdn: endpoint.host,
        target,
        listener: endpoint.listener,
        routes: endpoint.routes,
      });
      return {
        handle: desc.recordName,
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
      };
    },
    async destroy(handle, _ctx) {
      await lifecycle.deleteRecord({ recordName: handle });
    },
    async status(handle, _ctx) {
      const desc = await lifecycle.describeRecord({ recordName: handle });
      if (!desc) return { kind: "deleted", observedAt: clock().toISOString() };
      return {
        kind: "ready",
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
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
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
  }): Promise<CoreDnsRecordDescriptor> {
    const recordName = `coredns-${++this.#counter}`;
    const desc: CoreDnsRecordDescriptor = {
      recordName,
      fqdn: input.fqdn,
      target: input.target,
      listener: input.listener,
      routes: input.routes,
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

function requireInjectedTarget(spec: GatewaySpec): string {
  const target = (spec as { target?: unknown }).target;
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("gateway requires listen-derived target");
  }
  return target;
}

function requireEndpointRequest(spec: GatewaySpec): {
  readonly host: string;
  readonly listener: string;
  readonly routes: readonly Record<string, unknown>[];
} {
  for (const [name, listener] of Object.entries(spec.listeners)) {
    if (typeof listener.host === "string" && listener.host.length > 0) {
      return {
        host: listener.host,
        listener: name,
        routes: routesForListener(spec, name),
      };
    }
  }
  throw new Error("gateway requires at least one listener host");
}

function routesForListener(
  spec: GatewaySpec,
  listener: string,
): readonly Record<string, unknown>[] {
  return spec.routes
    .filter((route) => route.listener === listener)
    .map((route) => ({ pathPrefix: route.path, to: route.to }));
}

function endpointOutputs(
  host: string,
  listener: string,
  routes: readonly Record<string, unknown>[],
): GatewayOutputs {
  return {
    url: `https://${host}`,
    host,
    scheme: "https",
    listener,
    routes,
  };
}
