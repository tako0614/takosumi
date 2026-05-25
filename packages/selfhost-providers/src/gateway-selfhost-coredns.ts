/**
 * Bundled `gateway@v1` KernelPlugin factory backed by a self-hosted CoreDNS
 * record. This native KernelPlugin keeps gateway routing as normal AppSpec
 * `listen` material instead of forcing all upstreams through a single legacy
 * provider `target`.
 */

import type {
  KernelPlugin,
  KernelPluginApplyContext,
  NamespaceMaterial,
  ResolvedListenBinding,
} from "takosumi-contract/reference/plugin";
import type { JsonValue } from "takosumi-contract/reference/types";
import {
  type CoreDnsLifecycleClient,
  InMemoryCoreDnsLifecycle,
} from "@takos/takosumi-plugins/shape-providers/gateway/coredns-local";
import { KIND_URI_GATEWAY } from "./_kinds.ts";

export interface SelfhostCoreDnsGatewayProviderOptions {
  readonly zoneFile?: string;
  readonly lifecycle?: CoreDnsLifecycleClient;
  /**
   * Operator-selected fallback host for gateway listeners that request a host
   * from the distribution instead of hard-coding one in AppSpec.
   */
  readonly defaultHost?: string;
  /**
   * DNS target for the self-hosted ingress entrypoint, such as a Caddy or
   * local-substrate address. Defaults to loopback for in-memory/dev profiles.
   */
  readonly ingressTarget?: string;
}

interface GatewayListenerSpec {
  readonly protocol: "http" | "https";
  readonly host?: string;
  readonly tls?: "auto" | "manual" | "off";
}

interface GatewayRouteSpec {
  readonly listener: string;
  readonly path: string;
  readonly to: string;
}

interface SelectedGatewayListener {
  readonly name: string;
  readonly listener: GatewayListenerSpec;
  readonly host: string;
}

interface RouteMaterial extends Record<string, JsonValue> {
  readonly pathPrefix: string;
  readonly to: string;
  readonly target: string;
}

export function selfhostCoreDnsGatewayProvider(
  opts: SelfhostCoreDnsGatewayProviderOptions = {},
): KernelPlugin {
  const zoneFile = opts.zoneFile ?? "/etc/coredns/takosumi.test.db";
  const lifecycle = opts.lifecycle ?? new InMemoryCoreDnsLifecycle(zoneFile);
  const ingressTarget = opts.ingressTarget ?? "127.0.0.1";
  return {
    name: "@takos/selfhost-coredns-gateway",
    version: "1.0.0",
    provides: [KIND_URI_GATEWAY],
    capabilities: ["host-routing", "path-routing", "wildcard", "auto-tls"],
    async apply(ctx) {
      const spec = readGatewaySpec(ctx);
      const selected = selectListener(spec.listeners, opts.defaultHost);
      const routes = routesForListener({
        listenerName: selected.name,
        routes: spec.routes,
        resolvedBindings: ctx.resolvedBindings,
      });
      const desc = await lifecycle.createRecord({
        fqdn: selected.host,
        target: ingressTarget,
        listener: selected.name,
        routes,
      });
      const scheme = selected.listener.protocol;
      return {
        resourceHandle: desc.recordName,
        outputs: {
          url: `${scheme}://${desc.fqdn}`,
          host: desc.fqdn,
          scheme,
          listener: desc.listener,
          ingressTarget: desc.target,
          routes: routes as unknown as JsonValue,
        },
      };
    },
    publishMaterial(ctx) {
      return Promise.resolve(outputsToMaterial(ctx.outputs));
    },
    async destroy(ctx) {
      await lifecycle.deleteRecord({ recordName: ctx.resourceHandle });
    },
  };
}

function readGatewaySpec(ctx: KernelPluginApplyContext): {
  readonly listeners: Readonly<Record<string, GatewayListenerSpec>>;
  readonly routes: readonly GatewayRouteSpec[];
} {
  const spec = record(ctx.component.spec, "gateway spec");
  const listenersValue = spec.listeners;
  if (!isRecord(listenersValue)) {
    throw new Error("gateway spec.listeners must be an object");
  }
  const listeners: Record<string, GatewayListenerSpec> = {};
  for (const [name, value] of Object.entries(listenersValue)) {
    if (!isRecord(value)) {
      throw new Error(`gateway spec.listeners.${name} must be an object`);
    }
    const protocol = value.protocol;
    if (protocol !== "http" && protocol !== "https") {
      throw new Error(
        `gateway spec.listeners.${name}.protocol must be "http" or "https"`,
      );
    }
    const host = optionalString(value.host);
    const tls = optionalTls(value.tls, `gateway spec.listeners.${name}.tls`);
    listeners[name] = {
      protocol,
      ...(host ? { host } : {}),
      ...(tls ? { tls } : {}),
    };
  }
  const routesValue = spec.routes;
  if (!Array.isArray(routesValue) || routesValue.length === 0) {
    throw new Error("gateway spec.routes must be a non-empty array");
  }
  const routes = routesValue.map((value, index) => {
    if (!isRecord(value)) {
      throw new Error(`gateway spec.routes[${index}] must be an object`);
    }
    return {
      listener: requiredString(
        value.listener,
        `gateway spec.routes[${index}].listener`,
      ),
      path: requiredString(value.path, `gateway spec.routes[${index}].path`),
      to: requiredString(value.to, `gateway spec.routes[${index}].to`),
    };
  });
  return { listeners, routes };
}

function selectListener(
  listeners: Readonly<Record<string, GatewayListenerSpec>>,
  defaultHost: string | undefined,
): SelectedGatewayListener {
  for (const [name, listener] of Object.entries(listeners)) {
    if (listener.host) return { name, listener, host: listener.host };
  }
  const first = Object.entries(listeners)[0];
  if (!first) {
    throw new Error(
      "gateway spec.listeners must contain at least one listener",
    );
  }
  if (!defaultHost) {
    throw new Error(
      "gateway listener requires spec.listeners.<name>.host or selfhost defaultHost",
    );
  }
  const [name, listener] = first;
  return { name, listener, host: defaultHost };
}

function routesForListener(input: {
  readonly listenerName: string;
  readonly routes: readonly GatewayRouteSpec[];
  readonly resolvedBindings: readonly ResolvedListenBinding[];
}): readonly RouteMaterial[] {
  const bindingByName = new Map(
    input.resolvedBindings.map((binding) => [binding.bindingName, binding]),
  );
  return input.routes
    .filter((route) => route.listener === input.listenerName)
    .map((route) => {
      const binding = bindingByName.get(route.to);
      if (!binding) {
        throw new Error(
          `gateway route ${route.path} refers to unresolved listen binding ${route.to}`,
        );
      }
      const material = binding.target ?? binding.material;
      return {
        pathPrefix: route.path,
        to: route.to,
        target: targetMaterialToString(material, binding.sourceRef),
      };
    });
}

function targetMaterialToString(
  material: NamespaceMaterial,
  sourceRef: string,
): string {
  const url = material.url;
  if (typeof url === "string" && url.length > 0) return url;
  const target = material.target;
  if (typeof target === "string" && target.length > 0) return target;
  throw new Error(
    `gateway listen target ${sourceRef} must publish a string url or target field`,
  );
}

function outputsToMaterial(
  outputs: Readonly<Record<string, JsonValue>>,
): NamespaceMaterial {
  return { ...outputs };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalTls(
  value: unknown,
  path: string,
): "auto" | "manual" | "off" | undefined {
  if (value === undefined) return undefined;
  if (value === "auto" || value === "manual" || value === "off") {
    return value;
  }
  throw new Error(`${path} must be "auto", "manual", or "off"`);
}
