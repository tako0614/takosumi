import {
  describeTakosumiProcessRole,
  type TakosumiProcessRole,
  type TakosumiProcessRoleDescription,
} from "../process/mod.ts";
import {
  type ApiEndpointAuth,
  type ApiEndpointMethod,
  mountedEndpoints,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

export type CreateApiCapabilitiesDescriptionOptions = Partial<
  RouteFamilyMountedFlags
>;

export interface ApiCapabilitiesDescription {
  readonly service: "takosumi";
  readonly role: TakosumiProcessRole;
  readonly roleDescription: TakosumiProcessRoleDescription;
  readonly endpoints: readonly ApiEndpointDescription[];
}

export interface ApiEndpointDescription {
  readonly method: ApiEndpointMethod;
  readonly path: string;
  readonly summary: string;
  readonly auth: ApiEndpointAuth;
}

/**
 * Builds the `/capabilities` endpoint inventory by projecting the single-source
 * {@link mountedEndpoints} list (driven by the per-family `mounted` flags) down
 * to the public `{method, path, summary, auth}` shape. This is derived from the
 * same descriptors the OpenAPI document uses, so the two surfaces can no longer
 * drift.
 */
export function createApiCapabilitiesDescription(
  role: TakosumiProcessRole,
  options: CreateApiCapabilitiesDescriptionOptions = {},
): ApiCapabilitiesDescription {
  const endpoints = mountedEndpoints(options).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary,
    auth: endpoint.auth,
  }));
  return {
    service: "takosumi",
    role,
    roleDescription: describeTakosumiProcessRole(role),
    endpoints,
  };
}
