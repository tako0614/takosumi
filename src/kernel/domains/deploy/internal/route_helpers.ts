// Protocol classification and small per-route normalisers shared between
// the validation phase (`validateRoutes`) and the spec-emit phase
// (`normalizeNamedCollection` for routes).

import { HTTP_METHOD_PATTERN } from "./manifest_common.ts";
import type { PublicComputeSpec } from "../types.ts";
import { interfaceContractRefFor } from "./contract_refs.ts";

export function isHttpRouteProtocol(protocol: string | undefined): boolean {
  const normalized = normalizeRouteProtocol(protocol);
  return normalized === "http" || normalized === "https";
}

export function isPortProtocol(protocol: string): boolean {
  return protocol === "tcp" || protocol === "udp";
}

export function isQueueRouteProtocol(protocol: string): boolean {
  return protocol === "queue";
}

export function normalizeRouteProtocol(protocol: string | undefined): string {
  const normalized = (protocol ?? "https").toLowerCase();
  interfaceContractRefFor(normalized);
  return normalized;
}

export function normalizeRoutePort(
  routeName: string,
  port: unknown,
): number | undefined {
  if (port === undefined) return undefined;
  if (
    typeof port !== "number" || !Number.isInteger(port) || port < 1 ||
    port > 65535
  ) {
    throw new TypeError(`route.${routeName}.port must be integer 1..65535`);
  }
  return port;
}

export function portForCompute(
  compute: PublicComputeSpec | undefined,
): number | undefined {
  return typeof compute?.port === "number" && Number.isInteger(compute.port)
    ? compute.port
    : undefined;
}

export function normalizeRouteMethods(
  routeName: string,
  methods: string[] | undefined,
): readonly string[] | undefined {
  if (methods === undefined) return undefined;
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new TypeError(
      `route.${routeName}.methods must be non-empty string array`,
    );
  }
  const normalized = methods.map((method) => {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError(`route.${routeName}.methods must be string array`);
    }
    const upper = method.toUpperCase();
    if (!HTTP_METHOD_PATTERN.test(upper)) {
      throw new TypeError(`route.${routeName}.methods contains invalid method`);
    }
    return upper;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`route.${routeName}.methods contains duplicate method`);
  }
  return normalized;
}

export function routeMethodsOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (!left || !right) return true;
  const rightSet = new Set(right);
  return left.some((method) => rightSet.has(method));
}
