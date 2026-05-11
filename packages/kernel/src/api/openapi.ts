import {
  ARTIFACTS_BASE_PATH,
  CORE_CONDITION_REASONS,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import { TAKOSUMI_DEPLOY_PUBLIC_PATH } from "./deploy_public_routes.ts";
import { TAKOSUMI_PAAS_PUBLIC_PATHS } from "./public_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

export type OpenApiHttpMethod = "delete" | "get" | "head" | "post";

export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
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
  readonly deployPublicRoutesMounted?: boolean;
  readonly artifactRoutesMounted?: boolean;
  readonly internalRoutesMounted?: boolean;
  readonly runtimeAgentRoutesMounted?: boolean;
  readonly readinessRoutesMounted?: boolean;
}

export function createPaaSOpenApiDocument(
  options: CreatePaaSOpenApiDocumentOptions = {},
): OpenApiDocument {
  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info: {
      title: "Takosumi API",
      version: "0.1.0",
      description:
        "Dependency-free OpenAPI-ish description for mounted Takosumi process, public, internal, runtime-agent, readiness, and status route families.",
    },
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
      [TAKOSUMI_DEPLOY_PUBLIC_PATH]: {
        post: operation({
          operationId: "runDeployPublicDeployment",
          summary:
            "Runs the operator deploy entrypoint in apply, plan, or destroy mode.",
          tag: "deploy-public",
          auth: "deploy-token",
          requestSchema: "DeployPublicRequest",
          okSchema: "DeployPublicResponse",
          mountedPath: TAKOSUMI_DEPLOY_PUBLIC_PATH,
        }),
        get: operation({
          operationId: "listDeployPublicDeployments",
          summary: "Lists deployment records from the operator deploy surface.",
          tag: "deploy-public",
          auth: "deploy-token",
          okSchema: "DeployPublicListResponse",
          query: ["cursor", "limit"],
          mountedPath: TAKOSUMI_DEPLOY_PUBLIC_PATH,
        }),
      },
      [`${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name`]: {
        get: operation({
          operationId: "getDeployPublicDeployment",
          summary: "Returns one deployment record by manifest metadata.name.",
          tag: "deploy-public",
          auth: "deploy-token",
          pathParams: ["name"],
          okSchema: "DeployPublicRecordResponse",
          mountedPath: `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name`,
        }),
      },
      [`${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name/audit`]: {
        get: operation({
          operationId: "getDeployPublicDeploymentAudit",
          summary:
            "Returns WAL, provenance, revoke-debt, and rollback cause chain for one public deployment.",
          tag: "deploy-public",
          auth: "deploy-token",
          pathParams: ["name"],
          okSchema: "DeployPublicAuditResponse",
          mountedPath: `${TAKOSUMI_DEPLOY_PUBLIC_PATH}/:name/audit`,
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
    ...(options.deployPublicRoutesMounted ? ["deploy-public"] : []),
    ...(options.artifactRoutesMounted ? ["artifact"] : []),
    ...(options.internalRoutesMounted ? ["internal"] : []),
    ...(options.runtimeAgentRoutesMounted ? ["runtime-agent"] : []),
    ...(options.readinessRoutesMounted ? ["readiness", "status"] : []),
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
    | "deploy-public"
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
  auth: "actor" | "deploy-token" | "artifact-read" | "internal-service",
): readonly Record<string, readonly string[]>[] {
  if (auth === "actor") return [{ actorBearer: [] }];
  if (auth === "deploy-token") return [{ deployBearer: [] }];
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
    ManifestBody: {
      type: "object",
      required: ["apiVersion", "kind"],
      properties: {
        apiVersion: { const: "1.0" },
        kind: { const: "Manifest" },
        namespace: { type: "string" },
        metadata: ref("ManifestMetadata"),
        template: ref("ManifestTemplate"),
        resources: {
          type: "array",
          items: ref("ManifestResource"),
        },
      },
      additionalProperties: false,
    },
    ManifestMetadata: {
      type: "object",
      properties: {
        name: { type: "string" },
        labels: stringMap,
      },
      additionalProperties: false,
    },
    ManifestTemplate: {
      type: "object",
      properties: {
        template: { type: "string", pattern: "^[^@]+@[^@]+$" },
        inputs: jsonObject,
        ref: {
          type: "string",
          pattern: "^[^@]+@[^@]+$",
          deprecated: true,
          description:
            "Deprecated compatibility alias for template; new manifests use template.",
        },
      },
      additionalProperties: false,
    },
    ManifestResource: {
      type: "object",
      required: ["shape", "name", "provider", "spec"],
      properties: {
        shape: { type: "string", pattern: "^[^@]+@[^@]+$" },
        name: { type: "string" },
        provider: { type: "string" },
        spec: jsonValue,
        requires: {
          type: "array",
          items: { type: "string" },
        },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    DeployPublicRequest: {
      type: "object",
      required: ["manifest"],
      properties: {
        mode: { enum: ["apply", "plan", "destroy"] },
        manifest: ref("ManifestBody"),
        force: { type: "boolean" },
        recoveryMode: { enum: ["inspect", "continue", "compensate"] },
      },
      additionalProperties: false,
    },
    DeployPublicResponse: {
      type: "object",
      required: ["status", "outcome"],
      properties: {
        status: { enum: ["ok"] },
        outcome: {
          oneOf: [
            ref("DeployPublicOutcome"),
            ref("DeployPublicRecoveryInspectOutcome"),
            ref("DeployPublicRecoveryCompensateOutcome"),
          ],
        },
      },
      additionalProperties: false,
    },
    DeployPublicRecoveryInspectOutcome: {
      type: "object",
      required: ["status", "tenantId", "deploymentName", "entries"],
      properties: {
        status: { enum: ["recovery-inspect"] },
        tenantId: { type: "string" },
        deploymentName: { type: "string" },
        journal: ref("DeployPublicJournalSummary"),
        entries: {
          type: "array",
          items: ref("DeployPublicJournalEntrySummary"),
        },
      },
      additionalProperties: false,
    },
    DeployPublicRecoveryCompensateOutcome: {
      type: "object",
      required: ["status", "tenantId", "deploymentName", "debts"],
      properties: {
        status: { enum: ["recovery-compensate"] },
        tenantId: { type: "string" },
        deploymentName: { type: "string" },
        journal: ref("DeployPublicJournalSummary"),
        debts: {
          type: "array",
          items: ref("DeployPublicRevokeDebtRecordSummary"),
        },
      },
      additionalProperties: false,
    },
    DeployPublicOutcome: {
      type: "object",
      required: ["applied", "issues", "status"],
      properties: {
        applied: { type: "array", items: jsonObject },
        issues: { type: "array", items: jsonObject },
        status: {
          enum: [
            "succeeded",
            "failed-validation",
            "failed-apply",
            "partial",
          ],
        },
        planned: { type: "array", items: ref("DeployPublicPlannedResource") },
        operationPlanPreview: ref("OperationPlanPreview"),
        reused: { type: "number" },
      },
      additionalProperties: false,
    },
    DeployPublicPlannedResource: {
      type: "object",
      required: ["name", "shape", "providerId", "op"],
      properties: {
        name: { type: "string" },
        shape: { type: "string" },
        providerId: { type: "string" },
        op: { enum: ["create", "delete"] },
      },
      additionalProperties: false,
    },
    OperationPlanPreview: {
      type: "object",
      required: [
        "planId",
        "spaceId",
        "desiredSnapshotDigest",
        "operationPlanDigest",
        "walStages",
        "operations",
      ],
      properties: {
        planId: { type: "string", pattern: "^plan:[0-9a-f]{64}$" },
        spaceId: { type: "string" },
        deploymentName: { type: "string" },
        desiredSnapshotDigest: { type: "string", pattern: "^sha256:" },
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        walStages: {
          type: "array",
          items: {
            enum: [
              "prepare",
              "pre-commit",
              "commit",
              "post-commit",
              "observe",
              "finalize",
            ],
          },
        },
        operations: {
          type: "array",
          items: ref("OperationPlanPreviewOperation"),
        },
      },
      additionalProperties: false,
    },
    OperationPlanPreviewOperation: {
      type: "object",
      required: [
        "operationId",
        "resourceName",
        "shape",
        "providerId",
        "op",
        "dependsOn",
        "desiredDigest",
        "idempotencyKey",
      ],
      properties: {
        operationId: { type: "string", pattern: "^operation:[0-9a-f]{64}$" },
        resourceName: { type: "string" },
        shape: { type: "string" },
        providerId: { type: "string" },
        op: { enum: ["create", "delete"] },
        dependsOn: { type: "array", items: { type: "string" } },
        desiredDigest: { type: "string", pattern: "^sha256:" },
        idempotencyKey: ref("OperationPlanPreviewIdempotencyKey"),
      },
      additionalProperties: false,
    },
    OperationPlanPreviewIdempotencyKey: {
      type: "object",
      required: ["spaceId", "operationPlanDigest", "journalEntryId"],
      properties: {
        spaceId: { type: "string" },
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        journalEntryId: { type: "string", pattern: "^operation:[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
    DeployPublicListResponse: {
      type: "object",
      required: ["deployments"],
      properties: {
        deployments: {
          type: "array",
          items: ref("DeployPublicDeploymentSummary"),
        },
      },
      additionalProperties: false,
    },
    DeployPublicRecordResponse: ref("DeployPublicDeploymentSummary"),
    DeployPublicAuditResponse: {
      type: "object",
      required: ["status", "audit"],
      properties: {
        status: { enum: ["ok"] },
        audit: ref("DeployPublicAuditSummary"),
      },
      additionalProperties: false,
    },
    DeployPublicAuditSummary: {
      type: "object",
      required: ["deployment", "causeChain", "entries", "revokeDebts"],
      properties: {
        deployment: ref("DeployPublicDeploymentSummary"),
        journal: ref("DeployPublicJournalSummary"),
        provenance: jsonObject,
        causeChain: {
          type: "array",
          items: ref("DeployPublicAuditCauseSummary"),
        },
        entries: {
          type: "array",
          items: ref("DeployPublicJournalEntrySummary"),
        },
        revokeDebts: {
          type: "array",
          items: ref("DeployPublicRevokeDebtRecordSummary"),
        },
      },
      additionalProperties: false,
    },
    DeployPublicAuditCauseSummary: {
      type: "object",
      required: [
        "operationPlanDigest",
        "journalEntryId",
        "operationId",
        "phase",
        "stage",
        "operationKind",
        "effectDigest",
        "status",
        "createdAt",
      ],
      properties: {
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        journalEntryId: { type: "string" },
        operationId: { type: "string" },
        phase: {
          enum: [
            "apply",
            "activate",
            "destroy",
            "rollback",
            "recovery",
            "observe",
          ],
        },
        stage: {
          enum: [
            "prepare",
            "pre-commit",
            "commit",
            "post-commit",
            "observe",
            "finalize",
            "abort",
            "skip",
          ],
        },
        operationKind: { type: "string" },
        resourceName: { type: "string" },
        providerId: { type: "string" },
        effectDigest: { type: "string", pattern: "^sha256:" },
        status: { enum: ["recorded", "succeeded", "failed", "skipped"] },
        createdAt: { type: "string", format: "date-time" },
        reason: { type: "string" },
        outcomeStatus: { type: "string" },
        revokeDebtIds: { type: "array", items: { type: "string" } },
        detail: jsonObject,
        provenance: jsonObject,
      },
      additionalProperties: false,
    },
    DeployPublicDeploymentSummary: {
      type: "object",
      required: [
        "id",
        "name",
        "status",
        "tenantId",
        "appliedAt",
        "updatedAt",
        "resources",
      ],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        status: { enum: ["applied", "destroyed", "failed"] },
        tenantId: { type: "string" },
        appliedAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        provenance: jsonObject,
        journal: ref("DeployPublicJournalSummary"),
        revokeDebt: ref("DeployPublicRevokeDebtSummary"),
        resources: {
          type: "array",
          items: ref("DeployPublicResourceSummary"),
        },
      },
      additionalProperties: false,
    },
    DeployPublicJournalSummary: {
      type: "object",
      required: [
        "operationPlanDigest",
        "phase",
        "latestStage",
        "status",
        "entryCount",
        "failedEntryCount",
        "terminal",
        "updatedAt",
      ],
      properties: {
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        phase: {
          enum: [
            "apply",
            "activate",
            "destroy",
            "rollback",
            "recovery",
            "observe",
          ],
        },
        latestStage: {
          enum: [
            "prepare",
            "pre-commit",
            "commit",
            "post-commit",
            "observe",
            "finalize",
            "abort",
            "skip",
          ],
        },
        status: { enum: ["recorded", "succeeded", "failed", "skipped"] },
        entryCount: { type: "number" },
        failedEntryCount: { type: "number" },
        terminal: { type: "boolean" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    DeployPublicJournalEntrySummary: {
      type: "object",
      required: [
        "operationPlanDigest",
        "journalEntryId",
        "operationId",
        "phase",
        "stage",
        "operationKind",
        "effectDigest",
        "status",
        "createdAt",
      ],
      properties: {
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        journalEntryId: { type: "string" },
        operationId: { type: "string" },
        phase: {
          enum: [
            "apply",
            "activate",
            "destroy",
            "rollback",
            "recovery",
            "observe",
          ],
        },
        stage: {
          enum: [
            "prepare",
            "pre-commit",
            "commit",
            "post-commit",
            "observe",
            "finalize",
            "abort",
            "skip",
          ],
        },
        operationKind: { type: "string" },
        resourceName: { type: "string" },
        providerId: { type: "string" },
        effectDigest: { type: "string", pattern: "^sha256:" },
        status: { enum: ["recorded", "succeeded", "failed", "skipped"] },
        createdAt: { type: "string", format: "date-time" },
        provenance: jsonObject,
      },
      additionalProperties: false,
    },
    DeployPublicRevokeDebtSummary: {
      type: "object",
      required: ["total", "open", "operatorActionRequired", "cleared"],
      properties: {
        total: { type: "integer", minimum: 0 },
        open: { type: "integer", minimum: 0 },
        operatorActionRequired: { type: "integer", minimum: 0 },
        cleared: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    DeployPublicRevokeDebtRecordSummary: {
      type: "object",
      required: [
        "id",
        "generatedObjectId",
        "reason",
        "status",
        "ownerSpaceId",
        "originatingSpaceId",
        "retryAttempts",
        "createdAt",
        "statusUpdatedAt",
      ],
      properties: {
        id: { type: "string", pattern: "^revoke-debt:" },
        generatedObjectId: { type: "string", pattern: "^generated:" },
        reason: {
          enum: [
            "external-revoke",
            "link-revoke",
            "activation-rollback",
            "approval-invalidated",
            "cross-space-share-expired",
          ],
        },
        status: {
          enum: ["open", "operator-action-required", "cleared"],
        },
        ownerSpaceId: { type: "string" },
        originatingSpaceId: { type: "string" },
        deploymentName: { type: "string" },
        operationPlanDigest: { type: "string", pattern: "^sha256:" },
        journalEntryId: { type: "string" },
        operationId: { type: "string" },
        resourceName: { type: "string" },
        providerId: { type: "string" },
        retryAttempts: { type: "integer", minimum: 0 },
        createdAt: { type: "string", format: "date-time" },
        statusUpdatedAt: { type: "string", format: "date-time" },
        lastRetryAt: { type: "string", format: "date-time" },
        nextRetryAt: { type: "string", format: "date-time" },
        agedAt: { type: "string", format: "date-time" },
        clearedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    DeployPublicResourceSummary: {
      type: "object",
      required: ["name", "shape", "provider", "status", "outputs", "handle"],
      properties: {
        name: { type: "string" },
        shape: { type: "string" },
        provider: { type: "string" },
        status: { enum: ["applied"] },
        outputs: jsonObject,
        handle: jsonValue,
      },
      additionalProperties: false,
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
