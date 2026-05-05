import {
  describePaaSProcessRole,
  type PaaSProcessRole,
  type PaaSProcessRoleDescription,
} from "../process/mod.ts";
import {
  ARTIFACTS_BASE_PATH,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import { TAKOSUMI_DEPLOY_PUBLIC_PATH } from "./deploy_public_routes.ts";
import { TAKOSUMI_METRICS_PATH } from "./metrics_routes.ts";
import { TAKOSUMI_PAAS_PUBLIC_PATHS } from "./public_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

export interface CreateApiCapabilitiesDescriptionOptions {
  readonly internalRoutesMounted?: boolean;
  readonly publicRoutesMounted?: boolean;
  readonly deployPublicRoutesMounted?: boolean;
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
    | "actor"
    | "deploy-token"
    | "artifact-read"
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
  if (options.publicRoutesMounted) endpoints.push(...publicEndpoints());
  if (options.deployPublicRoutesMounted) {
    endpoints.push(...deployPublicEndpoints());
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

function deployPublicEndpoints(): ApiEndpointDescription[] {
  return [
    [
      "POST",
      TAKOSUMI_DEPLOY_PUBLIC_PATH,
      "Runs the operator deploy entrypoint in apply, plan, or destroy mode.",
    ],
    [
      "GET",
      TAKOSUMI_DEPLOY_PUBLIC_PATH,
      "Lists deployment records from the operator deploy surface.",
    ],
    [
      "GET",
      `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name`,
      "Returns one deployment record by manifest metadata.name.",
    ],
  ].map(([method, path, summary]) => ({
    method: method as ApiEndpointDescription["method"],
    path,
    summary,
    auth: "deploy-token" as const,
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

function publicEndpoints(): ApiEndpointDescription[] {
  return [
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities,
      "Returns public API route capabilities.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
      "Lists spaces visible to the authenticated actor.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
      "Creates a space for the authenticated actor.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.groups,
      "Lists groups for a space visible to the authenticated actor.",
    ],
    ["POST", TAKOSUMI_PAAS_PUBLIC_PATHS.groups, "Creates a group in a space."],
    [
      "POST",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
      "Creates a Deployment with mode=preview|resolve|apply|rollback.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
      "Lists Deployments for a group / status filter.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deployment,
      "Returns a Deployment by id.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply,
      "Applies a resolved Deployment.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove,
      "Attaches an approval to a Deployment.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations,
      "Streams provider observations for a Deployment.",
    ],
    [
      "GET",
      TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead,
      "Returns the GroupHead pointer for a group.",
    ],
    [
      "POST",
      TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback,
      "Rolls a GroupHead back to its previous Deployment.",
    ],
  ].map(([method, path, summary]) => ({
    method: method as ApiEndpointDescription["method"],
    path,
    summary,
    auth: "actor" as const,
  }));
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
