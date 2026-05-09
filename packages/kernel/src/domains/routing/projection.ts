import type {
  ProjectedRoute,
  RouteProjection,
  RouteProjectionInput,
} from "./types.ts";

export interface RouteProjector {
  project(input: RouteProjectionInput): Promise<RouteProjection>;
}

export class DefaultRouteProjector implements RouteProjector {
  readonly #clock: () => Date;

  constructor(options: { readonly clock?: () => Date } = {}) {
    this.#clock = options.clock ?? (() => new Date());
  }

  project(input: RouteProjectionInput): Promise<RouteProjection> {
    const projectedAt = input.projectedAt ?? this.#clock().toISOString();
    const projection: RouteProjection = Object.freeze({
      id: routeProjectionId(input.spaceId, input.groupId, input.activationId),
      spaceId: input.spaceId,
      groupId: input.groupId,
      activationId: input.activationId,
      desiredStateId: input.desiredStateId,
      projectedAt,
      routes: input.routes.map((route) => {
        const target = route.targetPort === undefined
          ? {
            componentName: route.targetComponentName,
            runtimeRouteId: route.id,
          }
          : {
            componentName: route.targetComponentName,
            runtimeRouteId: route.id,
            port: route.targetPort,
          };
        return Object.freeze<ProjectedRoute>({
          id: route.id,
          name: route.routeName,
          spaceId: route.spaceId,
          groupId: route.groupId,
          activationId: route.activationId,
          host: route.host,
          path: route.path,
          protocol: route.protocol ?? "https",
          ...(route.port === undefined ? {} : { port: route.port }),
          ...(route.source === undefined ? {} : { source: route.source }),
          target,
        });
      }),
    });
    return Promise.resolve(projection);
  }
}

export function routeProjectionId(
  spaceId: string,
  groupId: string,
  activationId: string,
): string {
  return `${spaceId}:${groupId}:${activationId}`;
}

export function routeOwnershipKey(
  route: {
    readonly host?: string;
    readonly path?: string;
    readonly port?: number;
    readonly protocol?: string;
    readonly source?: string;
  },
): string;
export function routeOwnershipKey(
  host: string | undefined,
  path: string | undefined,
  protocol: string,
  port?: number,
  source?: string,
): string;
export function routeOwnershipKey(
  host:
    | string
    | undefined
    | {
      readonly host?: string;
      readonly path?: string;
      readonly port?: number;
      readonly protocol?: string;
      readonly source?: string;
    },
  path?: string,
  protocol?: string,
  port?: number,
  source?: string,
): string {
  const route = typeof host === "object"
    ? host
    : { host, path, protocol: protocol ?? "https", port, source };
  const normalized = (route.protocol ?? "https").toLowerCase();
  if (normalized === "tcp" || normalized === "udp") {
    return `${normalized}:${route.host ?? "*"}:${route.port ?? "*"}`;
  }
  if (normalized === "queue") {
    return `${normalized}:${route.source ?? route.path ?? "*"}`;
  }
  return `${normalized}:${route.host ?? "*"}:${route.path ?? "/"}`;
}
