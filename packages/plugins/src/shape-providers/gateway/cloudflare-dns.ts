import type { ProviderPlugin } from "takosumi-contract/reference/provider-plugin";
import type {
  GatewayCapabilityTerm,
  GatewayOutputs,
  GatewaySpec,
} from "../../kinds/gateway.ts";

export interface CloudflareDnsRecordDescriptor {
  readonly recordId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly listener: string;
  readonly routes: readonly Record<string, unknown>[];
  readonly proxied: boolean;
  readonly zoneId: string;
}

export interface CloudflareDnsLifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
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

const SUPPORTED_CAPABILITIES: readonly GatewayCapabilityTerm[] = [
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
      const endpoint = requireEndpointRequest(spec);
      const desc = await lifecycle.createRecord({
        fqdn: endpoint.host,
        target,
        listener: endpoint.listener,
        routes: endpoint.routes,
        proxied: true,
      });
      return {
        handle: desc.recordId,
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
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
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
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
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
    readonly proxied: boolean;
  }): Promise<CloudflareDnsRecordDescriptor> {
    const recordId = `cf-rec-${++this.#counter}`;
    const desc: CloudflareDnsRecordDescriptor = {
      recordId,
      fqdn: input.fqdn,
      target: input.target,
      listener: input.listener,
      routes: input.routes,
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
