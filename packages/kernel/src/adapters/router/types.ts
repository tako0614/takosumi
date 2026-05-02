import type {
  RouteProjection,
  RouteProtocol,
} from "../../domains/routing/mod.ts";

export interface RouterConfigRoute {
  readonly id: string;
  readonly name: string;
  readonly host?: string;
  readonly path?: string;
  readonly port?: number;
  readonly protocol: RouteProtocol;
  readonly source?: string;
  readonly target: {
    readonly componentName: string;
    readonly runtimeRouteId: string;
    readonly port?: number;
  };
  readonly activationId: string;
}

export interface RouterConfig {
  readonly id: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly projectedAt: string;
  readonly routes: readonly RouterConfigRoute[];
}

export interface RouterConfigApplyResult {
  readonly adapter: string;
  readonly config: RouterConfig;
  readonly appliedAt: string;
  readonly path?: string;
  readonly noop?: boolean;
}

export interface RouterConfigPort {
  apply(projection: RouteProjection): Promise<RouterConfigApplyResult>;
}

export interface RouterConfigRenderer {
  render(projection: RouteProjection): RouterConfig;
}
