import type { RouteProjection } from "../../domains/routing/mod.ts";
import type { RouterConfig, RouterConfigRenderer } from "./types.ts";

export class DefaultRouterConfigRenderer implements RouterConfigRenderer {
  render(projection: RouteProjection): RouterConfig {
    const before = activationSnapshot(projection);
    const config = freezeClone<RouterConfig>({
      id: projection.id,
      spaceId: projection.spaceId,
      groupId: projection.groupId,
      activationId: projection.activationId,
      desiredStateId: projection.desiredStateId,
      projectedAt: projection.projectedAt,
      routes: projection.routes.map((route) => ({
        id: route.id,
        name: route.name,
        host: route.host,
        path: route.path,
        ...(route.port === undefined ? {} : { port: route.port }),
        protocol: route.protocol,
        ...(route.source === undefined ? {} : { source: route.source }),
        target: route.target.port === undefined
          ? {
            componentName: route.target.componentName,
            runtimeRouteId: route.target.runtimeRouteId,
          }
          : {
            componentName: route.target.componentName,
            runtimeRouteId: route.target.runtimeRouteId,
            port: route.target.port,
          },
        activationId: route.activationId,
      })),
    });
    validateRouterConfigActivation(projection, config);
    validateProjectionActivationUnchanged(before, projection);
    return config;
  }
}

export function renderRouterConfig(projection: RouteProjection): RouterConfig {
  return new DefaultRouterConfigRenderer().render(projection);
}

export function validateRouterConfigActivation(
  projection: RouteProjection,
  config: RouterConfig,
): void {
  if (config.activationId !== projection.activationId) {
    throw new Error(
      `router config activation mismatch: expected ${projection.activationId}, got ${config.activationId}`,
    );
  }
  for (const route of config.routes) {
    if (route.activationId !== projection.activationId) {
      throw new Error(
        `router config route ${route.id} activation mismatch: expected ${projection.activationId}, got ${route.activationId}`,
      );
    }
  }
  for (const route of projection.routes) {
    if (route.activationId !== projection.activationId) {
      throw new Error(
        `route projection ${route.id} mutates activation: expected ${projection.activationId}, got ${route.activationId}`,
      );
    }
  }
}

export function validateProjectionActivationUnchanged(
  before: string,
  projection: RouteProjection,
): void {
  const after = activationSnapshot(projection);
  if (before !== after) {
    throw new Error("router adapter attempted to mutate activation fields");
  }
}

export function activationSnapshot(projection: RouteProjection): string {
  return JSON.stringify({
    id: projection.id,
    spaceId: projection.spaceId,
    groupId: projection.groupId,
    activationId: projection.activationId,
    desiredStateId: projection.desiredStateId,
    routes: projection.routes.map((route) => ({
      id: route.id,
      activationId: route.activationId,
      targetRuntimeRouteId: route.target.runtimeRouteId,
      protocol: route.protocol,
      port: route.port,
      source: route.source,
    })),
  });
}

export function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
