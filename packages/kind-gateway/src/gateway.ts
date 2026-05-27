import type {
  Shape,
  ShapeValidationIssue,
} from "takosumi-contract/reference/shape";
import {
  isNonEmptyString,
  isRecord,
  optionalNonEmptyString,
  rejectUnknownFields,
  requireHttpUrl,
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
const IDENTIFIER_RE = /^[a-z][a-z0-9-]{0,62}$/;
const ROUTE_PATH_RE = /^\/[^?#\0]*$/;

/**
 * `gateway@v1` component kind descriptor. It models HTTP listeners, TLS
 * policy, and route rules as a normal component kind.
 *
 * Spec / outputs / capability terms are derived from
 * `packages/kind-gateway/spec/kind.jsonld` via `gateway.generated.ts`;
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
    rejectUnknownFields(value, "$", ["listeners", "routes"], issues);

    const listenerNames = new Set<string>();
    if (!isRecord(value.listeners)) {
      issues.push({ path: "$.listeners", message: "must be an object" });
    } else {
      if (Object.keys(value.listeners).length === 0) {
        issues.push({
          path: "$.listeners",
          message: "must declare at least one listener",
        });
      }
      for (const [name, listener] of Object.entries(value.listeners)) {
        const path = `$.listeners.${name}`;
        if (!IDENTIFIER_RE.test(name)) {
          issues.push({
            path,
            message: "listener name must match ^[a-z][a-z0-9-]{0,62}$",
          });
        } else {
          listenerNames.add(name);
        }
        if (!isRecord(listener)) {
          issues.push({ path, message: "must be an object" });
          continue;
        }
        rejectUnknownFields(
          listener,
          path,
          ["protocol", "host", "tls"],
          issues,
        );
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
      const seenRoutes = new Map<string, number>();
      value.routes.forEach((route, index) => {
        const path = `$.routes[${index}]`;
        if (!isRecord(route)) {
          issues.push({ path, message: "must be an object" });
          return;
        }
        rejectUnknownFields(route, path, ["listener", "path", "to"], issues);
        if (
          !isNonEmptyString(route.listener) ||
          !IDENTIFIER_RE.test(route.listener)
        ) {
          issues.push({
            path: `${path}.listener`,
            message: "must match ^[a-z][a-z0-9-]{0,62}$",
          });
        } else if (!listenerNames.has(route.listener)) {
          issues.push({
            path: `${path}.listener`,
            message: "must reference a listener declared in $.listeners",
          });
        }
        if (!isNonEmptyString(route.to) || !IDENTIFIER_RE.test(route.to)) {
          issues.push({
            path: `${path}.to`,
            message: "must match ^[a-z][a-z0-9-]{0,62}$",
          });
        }
        if (!isNonEmptyString(route.path) || !ROUTE_PATH_RE.test(route.path)) {
          issues.push({
            path: `${path}.path`,
            message:
              'must be a path beginning with "/" and contain no ?, #, or NUL',
          });
        } else if (hasPathChangingDotSegment(route.path)) {
          issues.push({
            path: `${path}.path`,
            message: "must not contain raw or percent-encoded dot segments",
          });
        } else if (isNonEmptyString(route.listener)) {
          validateDuplicateRoute(
            seenRoutes,
            route.listener,
            route.path,
            index,
            issues,
          );
        }
      });
    }
  },
  validateOutputs(value, issues) {
    if (!requireRoot(value, issues)) return;
    rejectUnknownFields(
      value,
      "$",
      ["url", "host", "listener", "routes", "scheme"],
      issues,
    );
    requireHttpUrl(value.url, "$.url", issues);
    requireNonEmptyString(value.host, "$.host", issues);
    requireNonEmptyString(value.listener, "$.listener", issues);
    if (
      isNonEmptyString(value.listener) &&
      !IDENTIFIER_RE.test(value.listener)
    ) {
      issues.push({
        path: "$.listener",
        message: "must match ^[a-z][a-z0-9-]{0,62}$",
      });
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
        rejectUnknownFields(route, path, ["pathPrefix", "to"], issues);
        if (
          !isNonEmptyString(route.pathPrefix) ||
          !ROUTE_PATH_RE.test(route.pathPrefix)
        ) {
          issues.push({
            path: `${path}.pathPrefix`,
            message:
              'must be a path beginning with "/" and contain no ?, #, or NUL',
          });
        } else if (hasPathChangingDotSegment(route.pathPrefix)) {
          issues.push({
            path: `${path}.pathPrefix`,
            message: "must not contain raw or percent-encoded dot segments",
          });
        }
        if (!isNonEmptyString(route.to) || !IDENTIFIER_RE.test(route.to)) {
          issues.push({
            path: `${path}.to`,
            message: "must match ^[a-z][a-z0-9-]{0,62}$",
          });
        }
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
    } else if (isNonEmptyString(value.url) && isNonEmptyString(value.host)) {
      crossCheckEndpointUrl(value.url, value.scheme, value.host, "$", issues);
    }
  },
};

function validateDuplicateRoute(
  seenRoutes: Map<string, number>,
  listener: string,
  pathValue: string,
  index: number,
  issues: ShapeValidationIssue[],
): void {
  const key = `${listener}\0${pathValue}`;
  const firstIndex = seenRoutes.get(key);
  if (firstIndex !== undefined) {
    issues.push({
      path: `$.routes[${index}]`,
      message:
        `duplicates $.routes[${firstIndex}] for listener/path ${listener} ${pathValue}`,
    });
    return;
  }
  seenRoutes.set(key, index);
}

function hasPathChangingDotSegment(pathValue: string): boolean {
  for (const segment of pathValue.split("/")) {
    const lowered = segment.toLowerCase();
    const normalizedDots = lowered.replaceAll("%2e", ".");
    if (normalizedDots === "." || normalizedDots === "..") return true;
  }
  return false;
}

function crossCheckEndpointUrl(
  urlValue: string,
  scheme: string,
  host: string,
  path: string,
  issues: ShapeValidationIssue[],
): void {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    return;
  }
  const parsedScheme = url.protocol.replace(/:$/, "");
  if (scheme !== parsedScheme) {
    issues.push({
      path: `${path}.scheme`,
      message: "must match the scheme in url",
    });
  }
  if (host !== url.hostname) {
    issues.push({
      path: `${path}.host`,
      message: "must match the host in url",
    });
  }
}
