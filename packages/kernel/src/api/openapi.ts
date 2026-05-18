import {
  ARTIFACTS_BASE_PATH,
  CORE_CONDITION_REASONS,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import {
  PROMETHEUS_CONTENT_TYPE,
  TAKOSUMI_METRICS_PATH,
} from "./metrics_routes.ts";
import { TAKOSUMI_PAAS_PUBLIC_PATHS } from "./public_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

export type OpenApiHttpMethod = "delete" | "get" | "head" | "post";

/**
 * Canonical version emitted in `info.version`. Kept in lockstep with the
 * `@takos/takosumi-kernel` package version declared in `packages/kernel/deno.json`.
 * Bump this when the kernel publishes a new minor/major release.
 */
export const TAKOSUMI_OPENAPI_VERSION = "0.14.0" as const;

export interface OpenApiServer {
  readonly url: string;
  readonly description?: string;
}

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly OpenApiServer[];
  readonly paths: Record<string, OpenApiPathItem>;
  readonly components: {
    readonly securitySchemes: Record<string, Record<string, unknown>>;
    readonly schemas: Record<string, Record<string, unknown>>;
  };
  readonly [extension: `x-${string}`]: unknown;
}

export type OpenApiPathItem = Partial<
  Record<OpenApiHttpMethod, OpenApiOperation>
>;

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly security?: readonly Record<string, readonly string[]>[];
  readonly parameters?: readonly Record<string, unknown>[];
  readonly requestBody?: Record<string, unknown>;
  readonly responses: Record<string, Record<string, unknown>>;
  readonly [extension: `x-${string}`]: unknown;
}

export interface CreatePaaSOpenApiDocumentOptions {
  readonly publicRoutesMounted?: boolean;
  readonly installerPublicRoutesMounted?: boolean;
  readonly artifactRoutesMounted?: boolean;
  readonly internalRoutesMounted?: boolean;
  readonly runtimeAgentRoutesMounted?: boolean;
  readonly readinessRoutesMounted?: boolean;
  /**
   * Mounted when `registerMetricsRoutes` is enabled on `takosumi-api`
   * (typically when `TAKOSUMI_METRICS_SCRAPE_TOKEN` is configured). Surfaces
   * the Prometheus exposition `/metrics` endpoint in the OpenAPI document.
   */
  readonly metricsRoutesMounted?: boolean;
  /**
   * Mounted by default on `takosumi-api` so SDK pipelines can self-discover
   * the API surface. Surfaces the OpenAPI document at `/openapi.json`.
   */
  readonly openApiRouteMounted?: boolean;
  /**
   * Optional list of `servers[]` entries. Defaults to a single relative
   * `{ url: "/" }` so clients can resolve against the host they fetched the
   * document from. Operators that publish the document to an SDK pipeline
   * can pass concrete `https://kernel.example.com` URLs.
   */
  readonly servers?: readonly OpenApiServer[];
}

export function createPaaSOpenApiDocument(
  options: CreatePaaSOpenApiDocumentOptions = {},
): OpenApiDocument {
  const servers: readonly OpenApiServer[] =
    options.servers && options.servers.length > 0
      ? options.servers
      : [{ url: "/", description: "Relative to the kernel host" }];
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Takosumi API",
      version: TAKOSUMI_OPENAPI_VERSION,
      description:
        "Dependency-free OpenAPI-ish description for mounted Takosumi process, public, internal, runtime-agent, readiness, and status route families.",
    },
    servers,
    "x-takos-service": "takosumi",
    paths: {
      "/health": {
        get: operation({
          operationId: "getHealth",
          summary: "Process-local health probe for the current PaaS role.",
          tag: "process",
          auth: "none",
          okSchema: "HealthResponse",
        }),
      },
      "/capabilities": {
        get: operation({
          operationId: "getCapabilities",
          summary:
            "Describes the current process role, declared capabilities, and route guards.",
          tag: "process",
          auth: "none",
          okSchema: "CapabilitiesResponse",
        }),
      },
      [TAKOSUMI_METRICS_PATH]: {
        get: {
          operationId: "getMetrics",
          summary:
            "Returns Prometheus exposition format metrics for kernel scrape pipelines.",
          tags: ["metrics"],
          security: [{ metricsBearer: [] }],
          responses: {
            "200": {
              description: "Prometheus exposition document.",
              content: {
                [PROMETHEUS_CONTENT_TYPE]: {
                  schema: {
                    type: "string",
                    description:
                      "Prometheus text exposition format (one metric per line).",
                  },
                },
              },
            },
            "401": errorResponse(),
            "404": errorResponse(),
          },
          "x-takos-auth": "metrics-scrape",
          "x-takos-mounted-path": TAKOSUMI_METRICS_PATH,
        } satisfies OpenApiOperation,
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          summary:
            "Returns the OpenAPI 3.1 document describing the current kernel surface (this document).",
          tags: ["openapi"],
          responses: {
            "200": {
              description: "OpenAPI 3.1 document.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    description:
                      "OpenAPI 3.1 document; clients should treat its shape as opaque except for the standard OpenAPI fields.",
                    additionalProperties: true,
                  },
                },
              },
            },
          },
          "x-takos-auth": "none",
          "x-takos-mounted-path": "/openapi.json",
        } satisfies OpenApiOperation,
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities]: {
        get: operation({
          operationId: "getPublicCapabilities",
          summary: "Returns public API route capabilities.",
          tag: "public",
          auth: "actor",
          okSchema: "PublicCapabilitiesResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.capabilities,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.spaces]: {
        get: operation({
          operationId: "listSpaces",
          summary: "Lists spaces visible to the authenticated actor.",
          tag: "public",
          auth: "actor",
          okSchema: "SpacesResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
        }),
        post: operation({
          operationId: "createSpace",
          summary: "Creates a space for the authenticated actor.",
          tag: "public",
          auth: "actor",
          requestSchema: "PublicSpaceCreateRequest",
          okStatus: "201",
          okSchema: "SpaceResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.spaces,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.groups]: {
        get: operation({
          operationId: "listGroups",
          summary:
            "Lists groups for a space visible to the authenticated actor.",
          tag: "public",
          auth: "actor",
          okSchema: "GroupsResponse",
          query: ["spaceId"],
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.groups,
        }),
        post: operation({
          operationId: "createGroup",
          summary: "Creates a group in a space.",
          tag: "public",
          auth: "actor",
          requestSchema: "PublicGroupCreateRequest",
          okStatus: "201",
          okSchema: "GroupResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.groups,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.deployments]: {
        post: operation({
          operationId: "createDeployment",
          summary:
            "Creates a Deployment. mode chooses preview / resolve / apply / rollback (Core).",
          tag: "public",
          auth: "actor",
          requestSchema: "DeploymentCreateRequest",
          okStatus: "201",
          okSchema: "DeploymentMutationResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
        }),
        get: operation({
          operationId: "listDeployments",
          summary:
            "Lists Deployments visible to the authenticated actor, optionally filtered by group / status.",
          tag: "public",
          auth: "actor",
          okSchema: "DeploymentsResponse",
          query: ["group", "status", "space"],
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deployments,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.deployment]: {
        get: operation({
          operationId: "getDeployment",
          summary: "Returns a Deployment by id.",
          tag: "public",
          auth: "actor",
          pathParams: ["deploymentId"],
          okSchema: "DeploymentResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deployment,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply]: {
        post: operation({
          operationId: "applyDeployment",
          summary: "Transitions a resolved Deployment to applying / applied.",
          tag: "public",
          auth: "actor",
          pathParams: ["deploymentId"],
          okStatus: "201",
          okSchema: "DeploymentMutationResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApply,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove]: {
        post: operation({
          operationId: "approveDeployment",
          summary: "Attaches an approval record to a Deployment.",
          tag: "public",
          auth: "actor",
          pathParams: ["deploymentId"],
          requestSchema: "DeploymentApproveRequest",
          okSchema: "DeploymentMutationResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentApprove,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations]: {
        get: operation({
          operationId: "listDeploymentObservations",
          summary: "Streams provider observations for a Deployment.",
          tag: "public",
          auth: "actor",
          pathParams: ["deploymentId"],
          okSchema: "ProviderObservationsResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.deploymentObservations,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead]: {
        get: operation({
          operationId: "getGroupHead",
          summary: "Returns the GroupHead pointer for a group.",
          tag: "public",
          auth: "actor",
          pathParams: ["groupId"],
          query: ["spaceId"],
          okSchema: "GroupHeadResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.groupHead,
        }),
      },
      [TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback]: {
        post: operation({
          operationId: "rollbackGroup",
          summary:
            "Rolls a GroupHead back to its previous Deployment (or supplied target).",
          tag: "public",
          auth: "actor",
          pathParams: ["groupId"],
          query: ["spaceId"],
          requestSchema: "GroupRollbackRequest",
          okStatus: "201",
          okSchema: "DeploymentMutationResponse",
          mountedPath: TAKOSUMI_PAAS_PUBLIC_PATHS.groupRollback,
        }),
      },
      "/v1/installations/dry-run": {
        post: operation({
          operationId: "dryRunInstallation",
          summary: "Plans a fresh AppSpec install without persisting state.",
          tag: "installer-public",
          auth: "installer-token",
          requestSchema: "InstallerAppSpecBody",
          okSchema: "InstallerDryRunResponse",
          mountedPath: "/v1/installations/dry-run",
        }),
      },
      "/v1/installations": {
        post: operation({
          operationId: "createInstallation",
          summary: "Creates an Installation from a posted AppSpec.",
          tag: "installer-public",
          auth: "installer-token",
          requestSchema: "InstallerAppSpecBody",
          okStatus: "201",
          okSchema: "InstallerInstallationResponse",
          mountedPath: "/v1/installations",
        }),
      },
      "/v1/installations/:id/deployments/dry-run": {
        post: operation({
          operationId: "dryRunInstallationDeployment",
          summary: "Plans a re-deploy against an existing Installation.",
          tag: "installer-public",
          auth: "installer-token",
          pathParams: ["id"],
          requestSchema: "InstallerAppSpecBody",
          okSchema: "InstallerDryRunResponse",
          mountedPath: "/v1/installations/:id/deployments/dry-run",
        }),
      },
      "/v1/installations/:id/deployments": {
        post: operation({
          operationId: "applyInstallationDeployment",
          summary: "Applies a Deployment against an existing Installation.",
          tag: "installer-public",
          auth: "installer-token",
          pathParams: ["id"],
          requestSchema: "InstallerAppSpecBody",
          okStatus: "201",
          okSchema: "InstallerInstallationResponse",
          mountedPath: "/v1/installations/:id/deployments",
        }),
      },
      "/v1/installations/:id/rollback": {
        post: operation({
          operationId: "rollbackInstallation",
          summary: "Rolls an Installation back to a prior Deployment.",
          tag: "installer-public",
          auth: "installer-token",
          pathParams: ["id"],
          requestSchema: "InstallerRollbackRequest",
          okSchema: "InstallerInstallationResponse",
          mountedPath: "/v1/installations/:id/rollback",
        }),
      },
      [ARTIFACTS_BASE_PATH]: {
        post: operation({
          operationId: "uploadArtifact",
          summary: "Uploads a content-addressed artifact for runtime agents.",
          tag: "artifact",
          auth: "deploy-token",
          requestBody: multipartArtifactUploadRequestBody(),
          okSchema: "ArtifactStored",
          mountedPath: ARTIFACTS_BASE_PATH,
        }),
        get: operation({
          operationId: "listArtifacts",
          summary: "Lists uploaded artifacts with cursor pagination.",
          tag: "artifact",
          auth: "deploy-token",
          query: ["cursor", "limit"],
          okSchema: "ArtifactListResponse",
          mountedPath: ARTIFACTS_BASE_PATH,
        }),
      },
      [`${ARTIFACTS_BASE_PATH}/kinds`]: {
        get: operation({
          operationId: "listArtifactKinds",
          summary: "Lists artifact kinds registered in the kernel.",
          tag: "artifact",
          auth: "deploy-token",
          okSchema: "ArtifactKindsResponse",
          mountedPath: `${ARTIFACTS_BASE_PATH}/kinds`,
        }),
      },
      [`${ARTIFACTS_BASE_PATH}/:hash`]: {
        head: operation({
          operationId: "headArtifact",
          summary: "Returns artifact metadata headers without a body.",
          tag: "artifact",
          auth: "artifact-read",
          pathParams: ["hash"],
          okStatus: "200",
          okSchema: "EmptyResponse",
          mountedPath: `${ARTIFACTS_BASE_PATH}/:hash`,
        }),
        get: operation({
          operationId: "getArtifact",
          summary: "Streams artifact bytes to a runtime agent or operator.",
          tag: "artifact",
          auth: "artifact-read",
          pathParams: ["hash"],
          okSchema: "BinaryResponse",
          mountedPath: `${ARTIFACTS_BASE_PATH}/:hash`,
        }),
        delete: operation({
          operationId: "deleteArtifact",
          summary: "Deletes an artifact from object storage.",
          tag: "artifact",
          auth: "deploy-token",
          pathParams: ["hash"],
          okStatus: "204",
          okSchema: "EmptyResponse",
          mountedPath: `${ARTIFACTS_BASE_PATH}/:hash`,
        }),
      },
      [`${ARTIFACTS_BASE_PATH}/gc`]: {
        post: operation({
          operationId: "gcArtifacts",
          summary: "Runs mark-and-sweep artifact garbage collection.",
          tag: "artifact",
          auth: "deploy-token",
          query: ["dryRun"],
          okSchema: "ArtifactGcResponse",
          mountedPath: `${ARTIFACTS_BASE_PATH}/gc`,
        }),
      },
      [TAKOSUMI_INTERNAL_PATHS.spaces]: {
        get: operation({
          operationId: "listInternalSpaces",
          summary: "Lists internal space summaries visible to the actor.",
          tag: "internal",
          auth: "internal-service",
          okSchema: "SpacesResponse",
        }),
        post: operation({
          operationId: "createInternalSpace",
          summary: "Creates a space through the internal service API.",
          tag: "internal",
          auth: "internal-service",
          requestSchema: "InternalSpaceRequest",
          okStatus: "201",
          okSchema: "SpaceResponse",
        }),
      },
      [TAKOSUMI_INTERNAL_PATHS.groups]: {
        get: operation({
          operationId: "listInternalGroups",
          summary: "Lists groups for a space through the internal service API.",
          tag: "internal",
          auth: "internal-service",
          query: ["spaceId"],
          okSchema: "GroupsResponse",
        }),
        post: operation({
          operationId: "createInternalGroup",
          summary: "Creates a group through the internal service API.",
          tag: "internal",
          auth: "internal-service",
          requestSchema: "InternalGroupRequest",
          okStatus: "201",
          okSchema: "GroupResponse",
        }),
      },
      [TAKOSUMI_INTERNAL_PATHS.deployments]: {
        post: operation({
          operationId: "resolveInternalDeployment",
          summary:
            "Resolves a Deployment through the internal service API (mode=resolve).",
          tag: "internal",
          auth: "internal-service",
          requestSchema: "InternalDeploymentRequest",
          okSchema: "DeploymentMutationResponse",
        }),
      },
      [TAKOSUMI_INTERNAL_PATHS.deploymentApply]: {
        post: operation({
          operationId: "applyInternalDeployment",
          summary:
            "Applies a resolved Deployment through the internal service API.",
          tag: "internal",
          auth: "internal-service",
          pathParams: ["deploymentId"],
          requestSchema: "InternalDeploymentApplyRequest",
          okStatus: "201",
          okSchema: "DeploymentMutationResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.enroll]: {
        post: operation({
          operationId: "enrollRuntimeAgent",
          summary: "Enrolls a runtime agent for provider work leasing.",
          tag: "runtime-agent",
          auth: "internal-service",
          requestSchema: "RuntimeAgentEnrollRequest",
          okStatus: "201",
          okSchema: "RuntimeAgentResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.heartbeat]: {
        post: operation({
          operationId: "heartbeatRuntimeAgent",
          summary: "Records a runtime agent heartbeat.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          requestSchema: "RuntimeAgentHeartbeatRequest",
          okSchema: "RuntimeAgentResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.lease]: {
        post: operation({
          operationId: "leaseRuntimeAgentWork",
          summary: "Leases work to a runtime agent.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          requestSchema: "RuntimeAgentLeaseRequest",
          okSchema: "RuntimeAgentLeaseResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.report]: {
        post: operation({
          operationId: "reportRuntimeAgentWork",
          summary: "Reports runtime-agent work completion or failure.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          requestSchema: "RuntimeAgentReportRequest",
          okSchema: "RuntimeAgentWorkResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.drain]: {
        post: operation({
          operationId: "drainRuntimeAgent",
          summary: "Requests runtime-agent drain.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          requestSchema: "RuntimeAgentDrainRequest",
          okSchema: "RuntimeAgentResponse",
        }),
      },
      [TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS.gatewayManifest]: {
        post: operation({
          operationId: "issueGatewayManifest",
          summary:
            "Issues a kernel-trusted Ed25519 signed gateway manifest the agent pins for fail-closed identity verification.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          okSchema: "GatewayManifestResponse",
        }),
      },
      [TAKOSUMI_PAAS_READINESS_PATHS.ready]: {
        get: operation({
          operationId: "getReadyz",
          summary: "Readiness probe for the current PaaS role.",
          tag: "readiness",
          auth: "none",
          okSchema: "HealthProbeResponse",
        }),
      },
      [TAKOSUMI_PAAS_READINESS_PATHS.live]: {
        get: operation({
          operationId: "getLivez",
          summary: "Liveness probe for the current PaaS role.",
          tag: "readiness",
          auth: "none",
          okSchema: "HealthProbeResponse",
        }),
      },
      [TAKOSUMI_PAAS_READINESS_PATHS.statusSummary]: {
        get: operation({
          operationId: "getStatusSummary",
          summary: "Returns the current group summary status projection.",
          tag: "status",
          auth: "none",
          okSchema: "StatusSummaryResponse",
        }),
      },
    },
    components: {
      securitySchemes: {
        actorBearer: {
          type: "http",
          scheme: "bearer",
          description: "Actor authentication for public PaaS API routes.",
        },
        deployBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Operator deploy bearer from TAKOSUMI_DEPLOY_TOKEN for /v1 deploy and artifact write routes.",
        },
        artifactFetchBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Read-only artifact bearer from TAKOSUMI_ARTIFACT_FETCH_TOKEN for runtime-agent artifact fetches.",
        },
        internalService: {
          type: "apiKey",
          in: "header",
          name: "x-takos-internal-signature",
          description: "Signed internal service request headers.",
        },
        metricsBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Prometheus scrape bearer from TAKOSUMI_METRICS_SCRAPE_TOKEN. Required for the Prometheus exposition `/metrics` endpoint.",
        },
        installerBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Installer bearer from TAKOSUMI_INSTALLER_TOKEN for /v1/installations and /v1/installations/{id}/deployments routes.",
        },
      },
      schemas: createSchemas(),
    },
  };
  return filterMountedRouteFamilies(document, options);
}

function filterMountedRouteFamilies(
  document: OpenApiDocument,
  options: CreatePaaSOpenApiDocumentOptions,
): OpenApiDocument {
  const mountedTags = new Set([
    "process",
    ...(options.publicRoutesMounted ? ["public"] : []),
    ...(options.installerPublicRoutesMounted ? ["installer-public"] : []),
    ...(options.artifactRoutesMounted ? ["artifact"] : []),
    ...(options.internalRoutesMounted ? ["internal"] : []),
    ...(options.runtimeAgentRoutesMounted ? ["runtime-agent"] : []),
    ...(options.readinessRoutesMounted ? ["readiness", "status"] : []),
    ...(options.metricsRoutesMounted ? ["metrics"] : []),
    ...(options.openApiRouteMounted ? ["openapi"] : []),
  ]);
  const paths = Object.fromEntries(
    Object.entries(document.paths)
      .map(([path, item]) => {
        const filtered = Object.fromEntries(
          Object.entries(item).filter(([, operation]) =>
            operation.tags.some((tag) => mountedTags.has(tag))
          ),
        ) as OpenApiPathItem;
        return [path, filtered] as const;
      })
      .filter(([, item]) => Object.keys(item).length > 0),
  );
  return {
    ...document,
    "x-takos-mounted-route-families": [...mountedTags].sort(),
    paths,
  };
}

function operation(input: {
  readonly operationId: string;
  readonly summary: string;
  readonly tag:
    | "process"
    | "public"
    | "installer-public"
    | "artifact"
    | "internal"
    | "runtime-agent"
    | "readiness"
    | "status";
  readonly auth:
    | "none"
    | "actor"
    | "deploy-token"
    | "artifact-read"
    | "installer-token"
    | "internal-service";
  readonly okSchema: string;
  readonly okStatus?: "200" | "201" | "204";
  readonly requestSchema?: string;
  readonly requestBody?: Record<string, unknown>;
  readonly query?: readonly string[];
  readonly pathParams?: readonly string[];
  readonly mountedPath?: string;
}): OpenApiOperation {
  const op: OpenApiOperation = {
    operationId: input.operationId,
    summary: input.summary,
    tags: [input.tag],
    ...(input.auth === "none"
      ? {}
      : { security: securityRequirements(input.auth) }),
    ...parameters(input),
    ...(input.requestBody
      ? { requestBody: input.requestBody }
      : input.requestSchema
      ? { requestBody: jsonRequestBody(input.requestSchema) }
      : {}),
    responses: {
      [input.okStatus ?? "200"]: input.okStatus === "204"
        ? { description: "No content" }
        : jsonResponse(input.okSchema),
      ...(input.auth === "none" ? {} : { "401": errorResponse() }),
      ...(input.auth === "internal-service" ? { "403": errorResponse() } : {}),
      ...(input.requestSchema || input.requestBody
        ? { "400": errorResponse() }
        : {}),
    },
    "x-takos-auth": input.auth,
    ...(input.mountedPath ? { "x-takos-mounted-path": input.mountedPath } : {}),
  };
  return op;
}

function securityRequirements(
  auth:
    | "actor"
    | "deploy-token"
    | "artifact-read"
    | "installer-token"
    | "internal-service",
): readonly Record<string, readonly string[]>[] {
  if (auth === "actor") return [{ actorBearer: [] }];
  if (auth === "deploy-token") return [{ deployBearer: [] }];
  if (auth === "installer-token") return [{ installerBearer: [] }];
  if (auth === "artifact-read") {
    return [{ deployBearer: [] }, { artifactFetchBearer: [] }];
  }
  return [{ internalService: [] }];
}

function parameters(input: {
  readonly query?: readonly string[];
  readonly pathParams?: readonly string[];
}): { readonly parameters?: readonly Record<string, unknown>[] } {
  const result = [
    ...(input.pathParams ?? []).map(pathParameter),
    ...(input.query ?? []).map(queryParameter),
  ];
  return result.length > 0 ? { parameters: result } : {};
}

function pathParameter(name: string): Record<string, unknown> {
  return {
    name,
    in: "path",
    required: true,
    schema: { type: "string" },
  };
}

function queryParameter(name: string): Record<string, unknown> {
  return {
    name,
    in: "query",
    required: false,
    schema: { type: "string" },
  };
}

function jsonRequestBody(schemaName: string): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": {
        schema: ref(schemaName),
      },
    },
  };
}

function multipartArtifactUploadRequestBody(): Record<string, unknown> {
  return {
    required: true,
    content: {
      "multipart/form-data": {
        schema: {
          type: "object",
          required: ["kind", "body"],
          properties: {
            kind: { type: "string" },
            body: { type: "string", format: "binary" },
            metadata: {
              type: "string",
              description: "Optional JSON object encoded as a string.",
            },
            expectedDigest: { type: "string", pattern: "^sha256:" },
          },
          additionalProperties: false,
        },
      },
    },
  };
}

function jsonResponse(schemaName: string): Record<string, unknown> {
  return {
    description: "JSON response",
    content: {
      "application/json": {
        schema: ref(schemaName),
      },
    },
  };
}

function errorResponse(): Record<string, unknown> {
  return jsonResponse("ErrorResponse");
}

function ref(schemaName: string): Record<string, string> {
  return { "$ref": `#/components/schemas/${schemaName}` };
}

function createSchemas(): Record<string, Record<string, unknown>> {
  const jsonObject = {
    type: "object",
    additionalProperties: true,
  };
  const jsonValue = {
    description: "Any JSON value.",
  };
  const stringMap = {
    type: "object",
    additionalProperties: { type: "string" },
  };
  const condition = {
    type: "object",
    required: ["type", "status"],
    properties: {
      type: { type: "string" },
      status: { enum: ["true", "false", "unknown"] },
      reason: { "$ref": "#/components/schemas/CoreConditionReason" },
      message: { type: "string" },
      observedGeneration: { type: "number" },
      lastTransitionAt: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
  // Deployment / GroupHead / ProviderObservation schemas track the canonical
  // type definitions in takosumi-contract (Core, see § 13-15).
  const deployment = {
    type: "object",
    required: [
      "id",
      "group_id",
      "space_id",
      "input",
      "resolution",
      "desired",
      "status",
      "conditions",
      "created_at",
    ],
    properties: {
      id: { type: "string" },
      group_id: { type: "string" },
      space_id: { type: "string" },
      input: jsonObject,
      resolution: jsonObject,
      desired: jsonObject,
      status: {
        enum: [
          "preview",
          "resolved",
          "applying",
          "applied",
          "failed",
          "rolled-back",
        ],
      },
      conditions: { type: "array", items: ref("Condition") },
      policy_decisions: { type: "array", items: jsonObject },
      approval: { ...jsonObject, nullable: true },
      rollback_target: { type: "string", nullable: true },
      created_at: { type: "string", format: "date-time" },
      applied_at: { type: "string", format: "date-time", nullable: true },
      finalized_at: { type: "string", format: "date-time", nullable: true },
    },
    additionalProperties: true,
  };
  const groupHead = {
    type: "object",
    required: [
      "space_id",
      "group_id",
      "current_deployment_id",
      "generation",
      "advanced_at",
    ],
    properties: {
      space_id: { type: "string" },
      group_id: { type: "string" },
      current_deployment_id: { type: "string" },
      previous_deployment_id: { type: "string", nullable: true },
      generation: { type: "number" },
      advanced_at: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
  const providerObservation = {
    type: "object",
    required: [
      "id",
      "deployment_id",
      "provider_id",
      "object_address",
      "observed_state",
      "observed_at",
    ],
    properties: {
      id: { type: "string" },
      deployment_id: { type: "string" },
      provider_id: { type: "string" },
      object_address: { type: "string" },
      observed_state: { enum: ["present", "missing", "drifted", "unknown"] },
      drift_status: {
        enum: [
          "provider-object-missing",
          "config-drift",
          "status-drift",
          "security-drift",
          "ownership-drift",
          "cache-drift",
        ],
      },
      observed_digest: { type: "string" },
      observed_at: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
  return {
    CoreConditionReason: {
      enum: [...CORE_CONDITION_REASONS],
      description:
        "Canonical condition reason catalog exported by takosumi-contract. CLI, app UI, API clients, controllers, and status projections must use these values for condition.reason.",
    },
    Condition: condition,
    Deployment: deployment,
    GroupHead: groupHead,
    ProviderObservation: providerObservation,
    HealthResponse: {
      type: "object",
      required: ["ok", "service", "domains"],
      properties: {
        ok: { type: "boolean" },
        service: { const: "takosumi" },
        domains: { type: "array", items: { type: "string" } },
      },
    },
    CapabilitiesResponse: jsonObject,
    PublicCapabilitiesResponse: jsonObject,
    HealthProbeResponse: jsonObject,
    StatusSummaryResponse: {
      type: "object",
      required: [
        "spaceId",
        "groupId",
        "status",
        "projectedAt",
        "desired",
        "serving",
        "dependencies",
        "security",
        "conditions",
      ],
      properties: {
        spaceId: { type: "string" },
        groupId: { type: "string" },
        activationId: { type: "string" },
        status: {
          enum: [
            "empty",
            "planning",
            "applying",
            "active",
            "degraded",
            "failed",
            "suspended",
            "deleted",
          ],
        },
        projectedAt: { type: "string", format: "date-time" },
        desired: jsonObject,
        serving: jsonObject,
        dependencies: jsonObject,
        security: jsonObject,
        conditions: { type: "array", items: ref("Condition") },
      },
      additionalProperties: true,
    },
    InstallerAppSpecBody: {
      type: "object",
      description:
        "AppSpec body as parsed from `.takosumi.yml`. See takosumi-contract `app-spec.ts` for the canonical type.",
      additionalProperties: true,
    },
    InstallerDryRunResponse: {
      type: "object",
      description:
        "Installation dry-run plan. See takosumi-contract `installer-api.ts` `InstallationDryRunResponse`.",
      additionalProperties: true,
    },
    InstallerInstallationResponse: {
      type: "object",
      description:
        "Installation / Deployment record. See takosumi-contract `installer-api.ts` `Installation` and `Deployment`.",
      additionalProperties: true,
    },
    InstallerRollbackRequest: {
      type: "object",
      description:
        "Rollback request body. See takosumi-contract `installer-api.ts` `RollbackRequest`.",
      additionalProperties: true,
    },
    ArtifactStored: {
      type: "object",
      required: ["hash", "kind", "size", "uploadedAt"],
      properties: {
        hash: { type: "string", pattern: "^sha256:" },
        kind: { type: "string" },
        size: { type: "number" },
        uploadedAt: { type: "string", format: "date-time" },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    ArtifactListResponse: {
      type: "object",
      required: ["artifacts"],
      properties: {
        artifacts: { type: "array", items: ref("ArtifactStored") },
        nextCursor: { type: "string" },
      },
      additionalProperties: false,
    },
    ArtifactKindsResponse: jsonObject,
    ArtifactGcResponse: jsonObject,
    BinaryResponse: {
      type: "string",
      format: "binary",
    },
    EmptyResponse: {
      description: "No response body.",
    },
    PublicSpaceCreateRequest: {
      type: "object",
      properties: {
        name: { type: "string" },
        slug: { type: "string" },
        metadata: jsonObject,
      },
    },
    PublicGroupCreateRequest: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        name: { type: "string" },
        envName: { type: "string" },
        metadata: jsonObject,
      },
    },
    InternalSpaceRequest: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        name: { type: "string" },
        metadata: jsonObject,
      },
    },
    InternalGroupRequest: {
      type: "object",
      required: ["spaceId"],
      properties: {
        spaceId: { type: "string" },
        groupId: { type: "string" },
        name: { type: "string" },
        envName: { type: "string" },
        metadata: jsonObject,
      },
    },
    DeploymentCreateRequest: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { enum: ["preview", "resolve", "apply", "rollback"] },
        manifest: jsonObject,
        target_id: { type: "string" },
        group: { type: "string" },
        env: { type: "string" },
        space_id: { type: "string" },
      },
      additionalProperties: false,
    },
    DeploymentApproveRequest: {
      type: "object",
      properties: {
        policy_decision_id: { type: "string" },
        space_id: { type: "string" },
        spaceId: { type: "string" },
      },
      additionalProperties: false,
    },
    GroupRollbackRequest: {
      type: "object",
      properties: {
        space_id: { type: "string" },
        spaceId: { type: "string" },
        target_id: { type: "string" },
      },
      additionalProperties: false,
    },
    InternalDeploymentRequest: {
      type: "object",
      required: ["manifest"],
      properties: {
        spaceId: { type: "string" },
        envName: { type: "string" },
        group: { type: "string" },
        manifest: jsonObject,
      },
      additionalProperties: false,
    },
    InternalDeploymentApplyRequest: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        space_id: { type: "string" },
      },
      additionalProperties: false,
    },
    DeploymentMutationResponse: {
      type: "object",
      required: ["deployment_id", "status", "conditions"],
      properties: {
        deployment_id: { type: "string" },
        status: {
          enum: [
            "preview",
            "resolved",
            "applying",
            "applied",
            "failed",
            "rolled-back",
          ],
        },
        conditions: { type: "array", items: ref("Condition") },
        expansion_summary: jsonObject,
      },
      additionalProperties: true,
    },
    DeploymentResponse: {
      type: "object",
      required: ["deployment"],
      properties: {
        deployment: ref("Deployment"),
      },
      additionalProperties: false,
    },
    DeploymentsResponse: {
      type: "object",
      required: ["deployments"],
      properties: {
        deployments: { type: "array", items: ref("Deployment") },
      },
      additionalProperties: false,
    },
    GroupHeadResponse: {
      type: "object",
      required: ["head"],
      properties: {
        head: ref("GroupHead"),
      },
      additionalProperties: false,
    },
    ProviderObservationsResponse: {
      type: "object",
      required: ["observations"],
      properties: {
        observations: { type: "array", items: ref("ProviderObservation") },
      },
      additionalProperties: false,
    },
    SpacesResponse: jsonObject,
    SpaceResponse: jsonObject,
    GroupsResponse: jsonObject,
    GroupResponse: jsonObject,
    RuntimeAgentEnrollRequest: jsonObject,
    RuntimeAgentHeartbeatRequest: jsonObject,
    RuntimeAgentLeaseRequest: jsonObject,
    RuntimeAgentReportRequest: jsonObject,
    RuntimeAgentDrainRequest: jsonObject,
    RuntimeAgentResponse: jsonObject,
    RuntimeAgentLeaseResponse: jsonObject,
    RuntimeAgentWorkResponse: jsonObject,
    GatewayManifestResponse: jsonObject,
    ErrorResponse: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {},
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  };
}
