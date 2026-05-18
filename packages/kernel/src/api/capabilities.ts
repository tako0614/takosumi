import {
  describePaaSProcessRole,
  type PaaSProcessRole,
  type PaaSProcessRoleDescription,
} from "../process/mod.ts";
import {
  ARTIFACTS_BASE_PATH,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import { TAKOSUMI_METRICS_PATH } from "./metrics_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

export interface CreateApiCapabilitiesDescriptionOptions {
  readonly internalRoutesMounted?: boolean;
  readonly installerPublicRoutesMounted?: boolean;
  readonly artifactRoutesMounted?: boolean;
  readonly runtimeAgentRoutesMounted?: boolean;
  readonly openApiRouteMounted?: boolean;
  readonly readinessRoutesMounted?: boolean;
  readonly metricsRoutesMounted?: boolean;
}

export interface ApiCapabilitiesDescription {
  readonly service: "takosumi";
  readonly role: PaaSProcessRole;
  readonly roleDescription: PaaSProcessRoleDescription;
  readonly endpoints: readonly ApiEndpointDescription[];
}

export interface ApiEndpointDescription {
  readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly summary: string;
  readonly auth:
    | "none"
    | "internal-service"
    | "deploy-token"
    | "artifact-read"
    | "installer-token"
    | "metrics-token";
}

export function createApiCapabilitiesDescription(
  role: PaaSProcessRole,
  options: CreateApiCapabilitiesDescriptionOptions = {},
): ApiCapabilitiesDescription {
  const endpoints: ApiEndpointDescription[] = [
    {
      method: "GET",
      path: "/health",
      summary: "Process-local health probe for the current PaaS role.",
      auth: "none",
    },
    {
      method: "GET",
      path: "/capabilities",
      summary:
        "Describes the current process role, its declared capabilities, and guards.",
      auth: "none",
    },
  ];
  if (options.openApiRouteMounted) {
    endpoints.push({
      method: "GET",
      path: "/openapi.json",
      summary: "Returns the OpenAPI document for mounted route families.",
      auth: "none",
    });
  }
  if (options.internalRoutesMounted) endpoints.push(...internalEndpoints());
  if (options.installerPublicRoutesMounted) {
    endpoints.push(...installerPublicEndpoints());
  }
  if (options.artifactRoutesMounted) endpoints.push(...artifactEndpoints());
  if (options.runtimeAgentRoutesMounted) {
    endpoints.push(...runtimeAgentEndpoints());
  }
  if (options.readinessRoutesMounted) {
    endpoints.push(...readinessEndpoints());
  }
  if (options.metricsRoutesMounted) {
    endpoints.push({
      method: "GET",
      path: TAKOSUMI_METRICS_PATH,
      summary: "Returns Prometheus text exposition for recorded metrics.",
      auth: "metrics-token",
    });
  }
  return {
    service: "takosumi",
    role,
    roleDescription: describePaaSProcessRole(role),
    endpoints,
  };
}

function installerPublicEndpoints(): ApiEndpointDescription[] {
  return [
    [
      "POST",
      "/v1/installations/dry-run",
      "Plans a fresh AppSpec install without persisting state.",
    ],
    [
      "POST",
      "/v1/installations",
      "Creates an Installation from a posted AppSpec.",
    ],
    [
      "POST",
      "/v1/installations/:id/deployments/dry-run",
      "Plans a re-deploy against an existing Installation.",
    ],
    [
      "POST",
      "/v1/installations/:id/deployments",
      "Applies a Deployment against an existing Installation.",
    ],
    [
      "POST",
      "/v1/installations/:id/rollback",
      "Rolls an Installation back to a prior Deployment.",
    ],
  ].map(([method, path, summary]) => ({
    method: method as ApiEndpointDescription["method"],
    path,
    summary,
    auth: "installer-token" as const,
  }));
}

function artifactEndpoints(): ApiEndpointDescription[] {
  return [
    [
      "POST",
      ARTIFACTS_BASE_PATH,
      "Uploads a content-addressed artifact for runtime agents.",
      "deploy-token",
    ],
    [
      "GET",
      ARTIFACTS_BASE_PATH,
      "Lists uploaded artifacts with cursor pagination.",
      "deploy-token",
    ],
    [
      "GET",
      `${ARTIFACTS_BASE_PATH}/kinds`,
      "Lists artifact kinds registered in the kernel.",
      "deploy-token",
    ],
    [
      "HEAD",
      `${ARTIFACTS_BASE_PATH}/:hash`,
      "Returns artifact metadata headers without a body.",
      "artifact-read",
    ],
    [
      "GET",
      `${ARTIFACTS_BASE_PATH}/:hash`,
      "Streams artifact bytes to a runtime agent or operator.",
      "artifact-read",
    ],
    [
      "DELETE",
      `${ARTIFACTS_BASE_PATH}/:hash`,
      "Deletes an artifact from object storage.",
      "deploy-token",
    ],
    [
      "POST",
      `${ARTIFACTS_BASE_PATH}/gc`,
      "Runs mark-and-sweep artifact garbage collection.",
      "deploy-token",
    ],
  ].map(([method, path, summary, auth]) => ({
    method: method as ApiEndpointDescription["method"],
    path,
    summary,
    auth: auth as ApiEndpointDescription["auth"],
  }));
}

function internalEndpoints(): ApiEndpointDescription[] {
  return [
    {
      method: "GET",
      path: TAKOSUMI_INTERNAL_PATHS.spaces,
      summary: "Lists internal space summaries visible to the actor.",
      auth: "internal-service",
    },
    {
      method: "POST",
      path: TAKOSUMI_INTERNAL_PATHS.spaces,
      summary: "Creates a space through the internal service API.",
      auth: "internal-service",
    },
    {
      method: "GET",
      path: TAKOSUMI_INTERNAL_PATHS.groups,
      summary: "Lists groups for a space through the internal service API.",
      auth: "internal-service",
    },
    {
      method: "POST",
      path: TAKOSUMI_INTERNAL_PATHS.groups,
      summary: "Creates a group through the internal service API.",
      auth: "internal-service",
    },
    {
      method: "POST",
      path: TAKOSUMI_INTERNAL_PATHS.deployments,
      summary: "Resolves a Deployment through the internal service API.",
      auth: "internal-service",
    },
    {
      method: "POST",
      path: TAKOSUMI_INTERNAL_PATHS.deploymentApply,
      summary:
        "Applies a resolved Deployment through the internal service API.",
      auth: "internal-service",
    },
  ];
}

function runtimeAgentEndpoints(): ApiEndpointDescription[] {
  return [
    [
      "POST",
      TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.enroll,
      "Enrolls a runtime agent.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.heartbeat,
      "Records a runtime agent heartbeat.",
    ],
    ["POST", TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.lease, "Leases runtime work."],
    [
      "POST",
      TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.report,
      "Reports runtime work completion.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.drain,
      "Requests runtime-agent drain.",
    ],
  ].map(([method, path, summary]) => ({
    method: method as ApiEndpointDescription["method"],
    path,
    summary,
    auth: "internal-service" as const,
  }));
}

function readinessEndpoints(): ApiEndpointDescription[] {
  return [
    {
      method: "GET",
      path: TAKOSUMI_PAAS_READINESS_PATHS.ready,
      summary: "Readiness probe for the current PaaS role.",
      auth: "none",
    },
    {
      method: "GET",
      path: TAKOSUMI_PAAS_READINESS_PATHS.live,
      summary: "Liveness probe for the current PaaS role.",
      auth: "none",
    },
    {
      method: "GET",
      path: TAKOSUMI_PAAS_READINESS_PATHS.statusSummary,
      summary: "Returns the current group summary status projection.",
      auth: "none",
    },
  ];
}
