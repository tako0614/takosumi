import type { Shape } from "takosumi-contract/reference/shape";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  requireNonEmptyString,
  requireRoot,
} from "./_validators.ts";
import {
  GATEWAY_CAPABILITY_TERMS,
  GATEWAY_DESCRIPTION,
  GATEWAY_KIND_SHAPE_ID,
  GATEWAY_KIND_VERSION,
  GATEWAY_OUTPUT_FIELDS,
  type GatewayCapabilityTerm,
  type GatewayOutputs,
  type GatewaySpec,
} from "./gateway.generated.ts";

export type { GatewayCapabilityTerm, GatewayOutputs, GatewaySpec };

const PROTOCOLS = new Set(["http", "https"]);
const TLS_POLICIES = new Set(["auto", "manual", "off"]);

/**
 * `gateway@v1` component kind descriptor. It models HTTP listeners, TLS
 * policy, and route rules as a normal component kind.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/plugins/spec/kinds/v1/gateway.jsonld` via `gateway.generated.ts`;
 * validation diagnostics are hand-written below.
 */
export const GatewayKind: Shape<
  GatewaySpec,
  GatewayOutputs,
  GatewayCapabilityTerm
> = {
  id: GATEWAY_KIND_SHAPE_ID,
  version: GATEWAY_KIND_VERSION,
  description: GATEWAY_DESCRIPTION,
  capabilityTerms: GATEWAY_CAPABILITY_TERMS,
  outputFields: GATEWAY_OUTPUT_FIELDS,
  validateSpec(value, issues) {
    if (!requireRoot(value, issues)) return;

    if (!isRecord(value.listeners)) {
      issues.push({ path: "$.listeners", message: "must be an object" });
    } else {
      for (const [name, listener] of Object.entries(value.listeners)) {
        const path = `$.listeners.${name}`;
        if (!isRecord(listener)) {
          issues.push({ path, message: "must be an object" });
          continue;
        }
        if (
          !isNonEmptyString(listener.protocol) ||
          !PROTOCOLS.has(listener.protocol)
        ) {
          issues.push({
            path: `${path}.protocol`,
            message: 'must be "http" or "https"',
          });
        }
        optionalNonEmptyString(listener.host, `${path}.host`, issues);
        if (
          listener.tls !== undefined &&
          (typeof listener.tls !== "string" || !TLS_POLICIES.has(listener.tls))
        ) {
          issues.push({
            path: `${path}.tls`,
            message: 'must be "auto", "manual", or "off"',
          });
        }
      }
    }

    if (!Array.isArray(value.routes) || value.routes.length === 0) {
      issues.push({
        path: "$.routes",
        message: "must be a non-empty array",
      });
    } else {
      value.routes.forEach((route, index) => {
        const path = `$.routes[${index}]`;
        if (!isRecord(route)) {
          issues.push({ path, message: "must be an object" });
          return;
        }
        requireNonEmptyString(route.listener, `${path}.listener`, issues);
        requireNonEmptyString(route.to, `${path}.to`, issues);
        if (!isNonEmptyString(route.path) || !route.path.startsWith("/")) {
          issues.push({
            path: `${path}.path`,
            message: 'must be a path beginning with "/"',
          });
        }
      });
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    requireNonEmptyString(value.url, "$.url", issues);
    requireNonEmptyString(value.host, "$.host", issues);
    requireNonEmptyString(value.listener, "$.listener", issues);
    if (!Array.isArray(value.routes) || value.routes.length === 0) {
      issues.push({
        path: "$.routes",
        message: "must be a non-empty array",
      });
    } else {
      value.routes.forEach((route, index) => {
        const path = `$.routes[${index}]`;
        if (!isRecord(route)) {
          issues.push({ path, message: "must be an object" });
          return;
        }
        requireNonEmptyString(route.pathPrefix, `${path}.pathPrefix`, issues);
        requireNonEmptyString(route.to, `${path}.to`, issues);
      });
    }
    if (
      !isNonEmptyString(value.scheme) ||
      !PROTOCOLS.has(value.scheme)
    ) {
      issues.push({
        path: "$.scheme",
        message: 'must be "http" or "https"',
      });
    }
  },
};
