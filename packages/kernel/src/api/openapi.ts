import {
  CORE_CONDITION_REASONS,
  TAKOSUMI_INTERNAL_PATHS,
} from "takosumi-contract";
import { TAKOSUMI_PAAS_PUBLIC_PATHS } from "./public_routes.ts";
import { TAKOSUMI_PAAS_READINESS_PATHS } from "./readiness_routes.ts";
import { TAKOSUMI_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

export type OpenApiHttpMethod = "delete" | "get" | "post";

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
    | "internal"
    | "runtime-agent"
    | "readiness"
    | "status";
  readonly auth: "none" | "actor" | "internal-service";
  readonly okSchema: string;
  readonly okStatus?: "200" | "201";
  readonly requestSchema?: string;
  readonly query?: readonly string[];
  readonly pathParams?: readonly string[];
  readonly mountedPath?: string;
}): OpenApiOperation {
  const op: OpenApiOperation = {
    operationId: input.operationId,
    summary: input.summary,
    tags: [input.tag],
    ...(input.auth === "none" ? {} : { security: [security(input.auth)] }),
    ...parameters(input),
    ...(input.requestSchema
      ? { requestBody: jsonRequestBody(input.requestSchema) }
      : {}),
    responses: {
      [input.okStatus ?? "200"]: jsonResponse(input.okSchema),
      ...(input.auth === "none" ? {} : { "401": errorResponse() }),
      ...(input.auth === "internal-service" ? { "403": errorResponse() } : {}),
      ...(input.requestSchema ? { "400": errorResponse() } : {}),
    },
    "x-takos-auth": input.auth,
    ...(input.mountedPath ? { "x-takos-mounted-path": input.mountedPath } : {}),
  };
  return op;
}

function security(
  auth: "actor" | "internal-service",
): Record<string, readonly string[]> {
  return auth === "actor" ? { actorBearer: [] } : { internalService: [] };
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
