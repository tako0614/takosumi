import {
  ARTIFACTS_BASE_PATH,
  CORE_CONDITION_REASONS,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract/reference/compat";
import {
  TAKOSUMI_APPLY_RUN_ROUTE,
  TAKOSUMI_APPLY_RUNS_ROUTE,
  TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
  TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE,
  TAKOSUMI_INSTALLATION_ROUTE,
  TAKOSUMI_PLAN_RUN_ROUTE,
  TAKOSUMI_PLAN_RUNS_ROUTE,
  TAKOSUMI_RUNNER_PROFILES_ROUTE,
} from "./deploy_control_public_routes.ts";
import {
  PROMETHEUS_CONTENT_TYPE,
  TAKOSUMI_METRICS_PATH,
} from "./metrics_routes.ts";
import { TAKOSUMI_SERVICE_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";
import { mountedOpenApiTags } from "./route_families.ts";

export type OpenApiHttpMethod = "delete" | "get" | "head" | "post";

/**
 * Canonical version emitted in `info.version`. Kept in lockstep with the
 * `@takosjp/takosumi` package version declared in `package.json`.
 * Bump this when the service publishes a new minor/major release.
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

export interface CreateTakosumiOpenApiDocumentOptions {
  readonly deployControlPublicRoutesMounted?: boolean;
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
   * Mounted by default on `takosumi-api` as reference process route
   * inventory. Public deploy API docs remain the source of truth for
   * OpenTofu plan/apply/destroy contract semantics.
   */
  readonly openApiRouteMounted?: boolean;
  /**
   * Optional list of `servers[]` entries. Defaults to a single relative
   * `{ url: "/" }` so clients can resolve against the host they fetched the
   * document from. Operators that publish the document to an SDK pipeline
   * can pass concrete `https://service.example.com` URLs.
   */
  readonly servers?: readonly OpenApiServer[];
}

export function createTakosumiOpenApiDocument(
  options: CreateTakosumiOpenApiDocumentOptions = {},
): OpenApiDocument {
  const servers: readonly OpenApiServer[] =
    options.servers && options.servers.length > 0
      ? options.servers
      : [{ url: "/", description: "Relative to the service host" }];
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Takosumi API",
      version: TAKOSUMI_OPENAPI_VERSION,
      description:
        "Dependency-free OpenAPI-ish description for mounted Takosumi process, deployControl, internal, runtime-agent, readiness, and status route families.",
    },
    servers,
    "x-takos-service": "takosumi",
    paths: {
      "/health": {
        get: operation({
          operationId: "getHealth",
          summary: "Process-local health probe for the current Takosumi role.",
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
            "Returns Prometheus exposition format metrics for service scrape pipelines.",
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
            "Returns the OpenAPI 3.1 document describing the current service surface (this document).",
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
      [TAKOSUMI_RUNNER_PROFILES_ROUTE]: {
        get: operation({
          operationId: "listRunnerProfiles",
          summary: "Lists OpenTofu runner profiles and provider allowlists.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          okSchema: "ListRunnerProfilesResponse",
          mountedPath: TAKOSUMI_RUNNER_PROFILES_ROUTE,
        }),
      },
      [TAKOSUMI_PLAN_RUNS_ROUTE]: {
        post: operation({
          operationId: "createPlanRun",
          summary: "Creates an OpenTofu plan run for a plain module source.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          requestSchema: "CreatePlanRunRequest",
          okStatus: "201",
          okSchema: "PlanRunResponse",
          mountedPath: TAKOSUMI_PLAN_RUNS_ROUTE,
        }),
      },
      [toOpenApiPath(TAKOSUMI_PLAN_RUN_ROUTE)]: {
        get: operation({
          operationId: "getPlanRun",
          summary: "Reads an OpenTofu PlanRun.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          pathParams: ["planRunId"],
          okSchema: "PlanRunResponse",
          mountedPath: TAKOSUMI_PLAN_RUN_ROUTE,
        }),
      },
      [TAKOSUMI_APPLY_RUNS_ROUTE]: {
        post: operation({
          operationId: "createApplyRun",
          summary: "Creates an apply run from a succeeded PlanRun.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          requestSchema: "CreateApplyRunRequest",
          okStatus: "201",
          okSchema: "ApplyRunResponse",
          mountedPath: TAKOSUMI_APPLY_RUNS_ROUTE,
        }),
      },
      [toOpenApiPath(TAKOSUMI_APPLY_RUN_ROUTE)]: {
        get: operation({
          operationId: "getApplyRun",
          summary: "Reads an OpenTofu ApplyRun.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          pathParams: ["applyRunId"],
          okSchema: "ApplyRunResponse",
          mountedPath: TAKOSUMI_APPLY_RUN_ROUTE,
        }),
      },
      [toOpenApiPath(TAKOSUMI_INSTALLATION_ROUTE)]: {
        get: operation({
          operationId: "getInstallation",
          summary: "Reads an Installation ledger record.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          pathParams: ["installationId"],
          okSchema: "GetInstallationResponse",
          mountedPath: TAKOSUMI_INSTALLATION_ROUTE,
        }),
      },
      [toOpenApiPath(TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE)]: {
        get: operation({
          operationId: "listInstallationDeployments",
          summary: "Lists Deployment records for an Installation.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          pathParams: ["installationId"],
          okSchema: "ListDeploymentsResponse",
          mountedPath: TAKOSUMI_INSTALLATION_DEPLOYMENTS_ROUTE,
        }),
      },
      [toOpenApiPath(TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE)]: {
        get: operation({
          operationId: "listInstallationDeploymentOutputs",
          summary:
            "Lists non-sensitive DeploymentOutput records for the current Deployment of an Installation.",
          tag: "deployControl-public",
          auth: "deploy-control-token",
          pathParams: ["installationId"],
          okSchema: "ListDeploymentOutputsResponse",
          mountedPath: TAKOSUMI_INSTALLATION_DEPLOYMENT_OUTPUTS_ROUTE,
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
      [toOpenApiPath(`${ARTIFACTS_BASE_PATH}/:hash`)]: {
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
      [TAKOSUMI_RUNTIME_AGENT_PATHS.enroll]: {
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
      [toOpenApiPath(TAKOSUMI_RUNTIME_AGENT_PATHS.heartbeat)]: {
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
      [toOpenApiPath(TAKOSUMI_RUNTIME_AGENT_PATHS.lease)]: {
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
      [toOpenApiPath(TAKOSUMI_RUNTIME_AGENT_PATHS.report)]: {
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
      [toOpenApiPath(TAKOSUMI_RUNTIME_AGENT_PATHS.drain)]: {
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
      [toOpenApiPath(TAKOSUMI_RUNTIME_AGENT_PATHS.gatewayManifest)]: {
        post: operation({
          operationId: "issueGatewayManifest",
          summary:
            "Issues a service-trusted Ed25519 signed gateway manifest the agent pins for fail-closed identity verification.",
          tag: "runtime-agent",
          auth: "internal-service",
          pathParams: ["agentId"],
          okSchema: "GatewayManifestResponse",
        }),
      },
      [TAKOSUMI_SERVICE_READINESS_PATHS.ready]: {
        get: operation({
          operationId: "getReadyz",
          summary: "Readiness probe for the current Takosumi role.",
          tag: "readiness",
          auth: "none",
          okSchema: "HealthProbeResponse",
        }),
      },
      [TAKOSUMI_SERVICE_READINESS_PATHS.live]: {
        get: operation({
          operationId: "getLivez",
          summary: "Liveness probe for the current Takosumi role.",
          tag: "readiness",
          auth: "none",
          okSchema: "HealthProbeResponse",
        }),
      },
      [TAKOSUMI_SERVICE_READINESS_PATHS.statusSummary]: {
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
        deployBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Artifact write bearer from TAKOSUMI_DEPLOY_TOKEN for /v1/artifacts write routes.",
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
        deployControlBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "DeployControl bearer from TAKOSUMI_DEPLOY_CONTROL_TOKEN for OpenTofu plan/apply/destroy routes.",
        },
      },
      schemas: createSchemas(),
    },
  };
  return filterMountedRouteFamilies(document, options);
}

function filterMountedRouteFamilies(
  document: OpenApiDocument,
  options: CreateTakosumiOpenApiDocumentOptions,
): OpenApiDocument {
  const mountedTags = mountedOpenApiTags(options);
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
    components: {
      ...document.components,
      schemas: filterReferencedSchemas(document.components.schemas, paths),
    },
  };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function operation(input: {
  readonly operationId: string;
  readonly summary: string;
  readonly tag:
    | "process"
    | "deployControl-public"
    | "artifact"
    | "internal"
    | "runtime-agent"
    | "readiness"
    | "status";
  readonly auth:
    | "none"
    | "deploy-token"
    | "artifact-read"
    | "deploy-control-token"
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
      ...(input.tag === "deployControl-public"
        ? {
          "403": errorResponse(),
          "404": errorResponse(),
          "409": errorResponse(),
          "413": errorResponse(),
          "500": errorResponse(),
          "501": errorResponse(),
        }
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
    | "deploy-control-token"
    | "internal-service",
): readonly Record<string, readonly string[]>[] {
  if (auth === "deploy-token") return [{ deployBearer: [] }];
  if (auth === "deploy-control-token") return [{ deployControlBearer: [] }];
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
            expectedDigest: {
              type: "string",
              pattern: "^sha256:[0-9a-f]{64}$",
            },
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

function filterReferencedSchemas(
  schemas: Record<string, Record<string, unknown>>,
  paths: Record<string, OpenApiPathItem>,
): Record<string, Record<string, unknown>> {
  const referenced = new Set<string>();
  collectSchemaRefs(paths, referenced);
  const queue = [...referenced];
  for (let i = 0; i < queue.length; i += 1) {
    const before = referenced.size;
    const schemaName = queue[i];
    const schema = schemas[schemaName];
    if (schema) collectSchemaRefs(schema, referenced);
    if (referenced.size > before) {
      for (const name of referenced) {
        if (!queue.includes(name)) queue.push(name);
      }
    }
  }
  return Object.fromEntries(
    [...referenced]
      .sort()
      .flatMap((schemaName) => {
        const schema = schemas[schemaName];
        return schema ? [[schemaName, schema] as const] : [];
      }),
  );
}

function collectSchemaRefs(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, output);
    return;
  }
  const record = value as Record<string, unknown>;
  const maybeRef = record["$ref"];
  if (typeof maybeRef === "string") {
    const prefix = "#/components/schemas/";
    if (maybeRef.startsWith(prefix)) {
      output.add(maybeRef.slice(prefix.length));
    }
  }
  for (const item of Object.values(record)) collectSchemaRefs(item, output);
}

function createSchemas(): Record<string, Record<string, unknown>> {
  const jsonObject = {
    type: "object",
    additionalProperties: true,
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
  return {
    CoreConditionReason: {
      enum: [...CORE_CONDITION_REASONS],
      description:
        "Canonical condition reason catalog exported by takosumi-contract. CLI, app UI, API clients, controllers, and status projections must use these values for condition.reason.",
    },
    Condition: condition,
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
    OpenTofuGitModuleSource: {
      type: "object",
      required: ["kind", "url"],
      properties: {
        kind: { const: "git" },
        url: { type: "string" },
        ref: { type: "string" },
        commit: { type: "string" },
        modulePath: { type: "string" },
      },
      additionalProperties: false,
    },
    OpenTofuPreparedModuleSource: {
      type: "object",
      required: ["kind", "url", "digest"],
      properties: {
        kind: { const: "prepared" },
        url: { type: "string" },
        digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        modulePath: { type: "string" },
      },
      additionalProperties: false,
    },
    OpenTofuLocalModuleSource: {
      type: "object",
      required: ["kind", "path"],
      properties: {
        kind: { const: "local" },
        path: { type: "string" },
        modulePath: { type: "string" },
      },
      additionalProperties: false,
    },
    OpenTofuModuleSource: {
      oneOf: [
        ref("OpenTofuGitModuleSource"),
        ref("OpenTofuPreparedModuleSource"),
        ref("OpenTofuLocalModuleSource"),
      ],
      description:
        "Plain OpenTofu module source. Display metadata comes from Git identity, module path, and OpenTofu outputs.",
    },
    RunnerProfile: {
      type: "object",
      required: [
        "id",
        "name",
        "substrate",
        "stateBackend",
        "allowedProviders",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        substrate: { type: "string" },
        description: { type: "string" },
        tofuVersion: { type: "string" },
        stateBackend: ref("RunnerStateBackend"),
        allowedProviders: { type: "array", items: { type: "string" } },
        deniedProviders: { type: "array", items: { type: "string" } },
        credentialRefs: {
          type: "array",
          items: ref("RunnerCredentialReference"),
        },
        requireCredentialRefs: { type: "boolean" },
        sourcePolicy: ref("RunnerSourcePolicy"),
        resourceLimits: ref("RunnerResourceLimits"),
        networkPolicy: ref("RunnerNetworkPolicy"),
        cloudflareContainer: ref("CloudflareContainerExecution"),
        cloudflareWorkersForPlatforms: ref(
          "CloudflareWorkersForPlatformsExecution",
        ),
        secretExposurePolicy: ref("RunnerSecretExposurePolicy"),
        concurrency: { type: "number" },
        labels: { type: "object", additionalProperties: { type: "string" } },
        createdAt: { type: "number" },
      },
      additionalProperties: false,
    },
    RunnerStateLockPolicy: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string" },
        ref: { type: "string" },
      },
      additionalProperties: false,
    },
    RunnerStateBackend: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { type: "string" },
        ref: { type: "string" },
        lock: ref("RunnerStateLockPolicy"),
      },
      additionalProperties: false,
    },
    RunnerCredentialReference: {
      type: "object",
      required: ["provider", "ref"],
      properties: {
        provider: { type: "string" },
        ref: { type: "string" },
        required: { type: "boolean" },
      },
      additionalProperties: false,
    },
    RunnerSourcePolicy: {
      type: "object",
      properties: {
        allowLocalSource: { type: "boolean" },
      },
      additionalProperties: false,
    },
    RunnerResourceLimits: {
      type: "object",
      properties: {
        maxRunSeconds: { type: "number" },
        maxSourceArchiveBytes: { type: "number" },
        maxSourceDecompressedBytes: { type: "number" },
        cpu: { type: "string" },
        memoryMb: { type: "number" },
      },
      additionalProperties: false,
    },
    RunnerNetworkPolicy: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string" },
        allowedHosts: { type: "array", items: { type: "string" } },
        allowedHostPatterns: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    CloudflareContainerExecution: {
      type: "object",
      required: ["image"],
      properties: {
        image: { type: "string" },
        queueName: { type: "string" },
        durableObjectBinding: { type: "string" },
        workDir: { type: "string" },
      },
      additionalProperties: false,
    },
    CloudflareWorkersForPlatformsExecution: {
      type: "object",
      required: ["dispatchNamespace"],
      properties: {
        dispatchNamespace: { type: "string" },
        dispatchWorkerBinding: { type: "string" },
        outboundWorker: ref("CloudflareOutboundWorkerPolicy"),
        userWorkerBindings: ref("CloudflareUserWorkerBindingPolicy"),
      },
      additionalProperties: false,
    },
    CloudflareOutboundWorkerPolicy: {
      type: "object",
      properties: {
        serviceBinding: { type: "string" },
        enforceNetworkPolicy: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CloudflareUserWorkerBindingPolicy: {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string" },
        allowedBindingKinds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    RunnerSecretExposurePolicy: {
      type: "object",
      required: ["providerCredentials", "tenantWorkerOperatorSecrets"],
      properties: {
        providerCredentials: { type: "string" },
        tenantWorkerOperatorSecrets: { type: "string" },
        redactLogs: { type: "boolean" },
        blockSensitiveOutputs: { type: "boolean" },
      },
      additionalProperties: false,
    },
    ListRunnerProfilesResponse: {
      type: "object",
      required: ["runnerProfiles"],
      properties: {
        runnerProfiles: { type: "array", items: ref("RunnerProfile") },
      },
      additionalProperties: false,
    },
    PolicyDecision: {
      type: "object",
      required: ["status", "reasons", "checkedAt"],
      properties: {
        status: { enum: ["passed", "blocked"] },
        reasons: { type: "array", items: { type: "string" } },
        checkedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    DeployControlAuditEvent: {
      type: "object",
      required: ["id", "type", "at"],
      properties: {
        id: { type: "string" },
        type: { type: "string" },
        at: { type: "number" },
        actor: { type: "string" },
        message: { type: "string" },
        data: jsonObject,
      },
      additionalProperties: false,
    },
    RunDiagnostic: {
      type: "object",
      required: ["severity", "message"],
      properties: {
        severity: { enum: ["info", "warning", "error"] },
        message: { type: "string" },
        detail: { type: "string" },
      },
      additionalProperties: false,
    },
    PlanRunSummary: {
      type: "object",
      properties: {
        add: { type: "number" },
        change: { type: "number" },
        destroy: { type: "number" },
      },
      additionalProperties: false,
    },
    OpenTofuPlanArtifact: {
      type: "object",
      required: ["kind", "ref", "digest"],
      properties: {
        kind: { type: "string" },
        ref: { type: "string" },
        digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        contentType: { type: "string" },
        sizeBytes: { type: "number" },
        createdAt: { type: "number" },
      },
      additionalProperties: false,
    },
    PlanRun: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "source",
        "sourceDigest",
        "operation",
        "runnerProfileId",
        "variablesDigest",
        "requiredProviders",
        "status",
        "policy",
        "policyDecisionDigest",
        "auditEvents",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        installationCurrentDeploymentId: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        source: ref("OpenTofuModuleSource"),
        sourceDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        operation: { enum: ["create", "update", "destroy"] },
        runnerProfileId: { type: "string" },
        variablesDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        requiredProviders: { type: "array", items: { type: "string" } },
        status: {
          enum: ["queued", "running", "succeeded", "failed", "blocked", "cancelled"],
        },
        policy: ref("PolicyDecision"),
        policyDecisionDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        planDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        planArtifact: ref("OpenTofuPlanArtifact"),
        sourceCommit: { type: "string" },
        providerLockDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        summary: ref("PlanRunSummary"),
        diagnostics: { type: "array", items: ref("RunDiagnostic") },
        auditEvents: {
          type: "array",
          items: ref("DeployControlAuditEvent"),
        },
        createdAt: { type: "number" },
        updatedAt: { type: "number" },
        finishedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    CreatePlanRunRequest: {
      type: "object",
      required: ["spaceId", "source"],
      properties: {
        spaceId: { type: "string" },
        source: ref("OpenTofuModuleSource"),
        runnerProfileId: { type: "string" },
        installationId: { type: "string" },
        operation: { enum: ["create", "update", "destroy"] },
        variables: jsonObject,
        requiredProviders: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    PlanRunResponse: {
      type: "object",
      required: ["planRun"],
      properties: {
        planRun: ref("PlanRun"),
      },
      additionalProperties: false,
    },
    ApplyExpectedGuard: {
      type: "object",
      required: [
        "planRunId",
        "runnerProfileId",
        "sourceDigest",
        "variablesDigest",
        "policyDecisionDigest",
        "planDigest",
        "planArtifactDigest",
      ],
      properties: {
        planRunId: { type: "string" },
        installationId: { type: "string" },
        currentDeploymentId: {
          anyOf: [{ type: "string" }, { type: "null" }],
        },
        runnerProfileId: { type: "string" },
        sourceDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        variablesDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        policyDecisionDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        planDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        planArtifactDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        sourceCommit: { type: "string" },
        providerLockDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
      },
      additionalProperties: false,
    },
    RunApproval: {
      type: "object",
      properties: {
        approvedBy: { type: "string" },
        approvedAt: { type: "number" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    CreateApplyRunRequest: {
      type: "object",
      required: ["planRunId", "expected"],
      properties: {
        planRunId: { type: "string" },
        approval: ref("RunApproval"),
        expected: ref("ApplyExpectedGuard"),
      },
      additionalProperties: false,
    },
    DeploymentOutput: {
      type: "object",
      required: [
        "name",
        "kind",
        "value",
        "sensitive",
      ],
      properties: {
        name: { type: "string" },
        kind: { type: "string" },
        value: {},
        sensitive: { const: false },
        labels: { type: "object", additionalProperties: { type: "string" } },
      },
      additionalProperties: false,
    },
    RunnerStateLockEvidence: {
      type: "object",
      required: ["status", "backendRef"],
      properties: {
        status: { enum: ["pending", "recorded", "not_required"] },
        backendRef: { type: "string" },
        lockRef: { type: "string" },
        acquiredAt: { type: "number" },
        releasedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    ApplyRun: {
      type: "object",
      required: [
        "id",
        "planRunId",
        "spaceId",
        "operation",
        "runnerProfileId",
        "status",
        "expected",
        "stateBackend",
        "stateLock",
        "auditEvents",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        planRunId: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        deploymentId: { type: "string" },
        operation: { enum: ["create", "update", "destroy"] },
        runnerProfileId: { type: "string" },
        status: {
          enum: ["queued", "running", "succeeded", "failed", "blocked", "cancelled"],
        },
        approval: ref("RunApproval"),
        expected: ref("ApplyExpectedGuard"),
        stateBackend: ref("RunnerStateBackend"),
        stateLock: ref("RunnerStateLockEvidence"),
        outputs: { type: "array", items: ref("DeploymentOutput") },
        diagnostics: { type: "array", items: ref("RunDiagnostic") },
        auditEvents: {
          type: "array",
          items: ref("DeployControlAuditEvent"),
        },
        createdAt: { type: "number" },
        updatedAt: { type: "number" },
        finishedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    Installation: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "appId",
        "source",
        "runnerProfileId",
        "currentDeploymentId",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        appId: { type: "string" },
        source: ref("OpenTofuModuleSource"),
        runnerProfileId: { type: "string" },
        currentDeploymentId: { type: "string", nullable: true },
        status: {
          enum: ["installing", "ready", "failed", "destroying", "destroyed", "suspended"],
        },
        createdAt: { type: "number" },
        updatedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    Deployment: {
      type: "object",
      required: [
        "id",
        "installationId",
        "planRunId",
        "applyRunId",
        "source",
        "runnerProfileId",
        "status",
        "outputs",
        "auditEvents",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        installationId: { type: "string" },
        planRunId: { type: "string" },
        applyRunId: { type: "string" },
        source: ref("OpenTofuModuleSource"),
        runnerProfileId: { type: "string" },
        status: { enum: ["running", "succeeded", "failed", "destroyed"] },
        planDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        sourceCommit: { type: "string" },
        providerLockDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        outputs: { type: "array", items: ref("DeploymentOutput") },
        auditEvents: {
          type: "array",
          items: ref("DeployControlAuditEvent"),
        },
        createdAt: { type: "number" },
        completedAt: { type: "number" },
      },
      additionalProperties: false,
    },
    ApplyRunResponse: {
      type: "object",
      properties: {
        applyRun: ref("ApplyRun"),
        installation: ref("Installation"),
        deployment: ref("Deployment"),
      },
      required: ["applyRun"],
      additionalProperties: false,
    },
    GetInstallationResponse: {
      type: "object",
      required: ["installation"],
      properties: {
        installation: ref("Installation"),
      },
      additionalProperties: false,
    },
    ListDeploymentsResponse: {
      type: "object",
      required: ["deployments"],
      properties: {
        deployments: { type: "array", items: ref("Deployment") },
      },
      additionalProperties: false,
    },
    ListDeploymentOutputsResponse: {
      type: "object",
      required: ["outputs"],
      properties: {
        outputs: { type: "array", items: ref("DeploymentOutput") },
      },
      additionalProperties: false,
    },
    ArtifactStored: {
      type: "object",
      required: ["hash", "kind", "size", "uploadedAt"],
      properties: {
        hash: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
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
    ArtifactGcResponse: jsonObject,
    BinaryResponse: {
      type: "string",
      format: "binary",
    },
    EmptyResponse: {
      description: "No response body.",
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
          required: ["code", "message", "requestId"],
          properties: {
            code: {
              enum: [
                "invalid_argument",
                "unauthenticated",
                "permission_denied",
                "not_found",
                "failed_precondition",
                "resource_exhausted",
                "not_implemented",
                "internal_error",
              ],
            },
            message: { type: "string" },
            requestId: { type: "string" },
            details: {},
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  };
}
