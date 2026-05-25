import type { ProviderPlugin } from "takosumi-contract/reference/provider-plugin";
import type {
  GatewayCapabilityTerm,
  GatewayOutputs,
  GatewaySpec,
} from "../../kinds/gateway.ts";

export interface Route53RecordDescriptor {
  readonly recordSetId: string;
  readonly fqdn: string;
  readonly target: string;
  readonly listener: string;
  readonly routes: readonly Record<string, unknown>[];
  readonly hostedZoneId: string;
  readonly certificateArn?: string;
}

export interface Route53LifecycleClient {
  createRecord(input: {
    readonly fqdn: string;
    readonly target: string;
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
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

const SUPPORTED_CAPABILITIES: readonly GatewayCapabilityTerm[] = [
  "wildcard",
  "auto-tls",
  "sni",
  "alpn-acme",
];

export function createRoute53Provider(
  options: Route53ProviderOptions,
): ProviderPlugin<GatewaySpec, GatewayOutputs> {
  const lifecycle = options.lifecycle;
  const clock = options.clock ?? (() => new Date());
  return {
    id: "@takos/aws-route53",
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
        recordType: "CNAME",
      });
      return {
        handle: desc.recordSetId,
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
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
        outputs: endpointOutputs(desc.fqdn, desc.listener, desc.routes),
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
    readonly listener: string;
    readonly routes: readonly Record<string, unknown>[];
  }): Promise<Route53RecordDescriptor> {
    const recordSetId = `r53-${++this.#counter}`;
    const desc: Route53RecordDescriptor = {
      recordSetId,
      fqdn: input.fqdn,
      target: input.target,
      listener: input.listener,
      routes: input.routes,
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
