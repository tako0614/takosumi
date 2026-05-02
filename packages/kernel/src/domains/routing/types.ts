import type { RuntimeRouteBindingSpec } from "../runtime/mod.ts";

export type RouteProjectionId = string;
export type RouteProtocol = "http" | "https" | "tcp" | "udp" | string;
export type RouteOwnershipStatus =
  | "reserved"
  | "active"
  | "released"
  | "conflict";

export interface RouteTargetRef {
  readonly componentName: string;
  readonly runtimeRouteId: string;
  readonly port?: number;
}

export interface ProjectedRoute {
  readonly id: string;
  readonly name: string;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly host?: string;
  readonly path?: string;
  readonly protocol: RouteProtocol;
  readonly port?: number;
  readonly source?: string;
  readonly target: RouteTargetRef;
}

export interface RouteProjection {
  readonly id: RouteProjectionId;
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly projectedAt: string;
  readonly routes: readonly ProjectedRoute[];
}

export interface RouteProjectionInput {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly desiredStateId?: string;
  readonly routes: readonly RuntimeRouteBindingSpec[];
  readonly projectedAt?: string;
}

export interface RouteOwnerRef {
  readonly spaceId: string;
  readonly groupId: string;
  readonly activationId: string;
  readonly routeName: string;
}

export interface RouteOwnershipRecord {
  readonly key: string;
  readonly host?: string;
  readonly path?: string;
  readonly port?: number;
  readonly source?: string;
  readonly protocol: RouteProtocol;
  readonly owner: RouteOwnerRef;
  readonly status: RouteOwnershipStatus;
  readonly updatedAt: string;
}
