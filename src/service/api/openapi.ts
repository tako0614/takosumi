import { CORE_CONDITION_REASONS } from "takosumi-contract/reference/compat";
import {
  type ApiEndpoint,
  endpointTag,
  mountedEndpoints,
  mountedOpenApiTags,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

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
        "Dependency-free OpenAPI-ish description for mounted Takosumi process, deployControl, runtime-agent, readiness, and status route families.",
    },
    servers,
    "x-takos-service": "takosumi",
    paths: buildPaths(),
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

/**
 * Maps each {@link ApiEndpoint} to its owning family `id` (used for the primary
 * OpenAPI tag fallback and the `x-takos-mounted-path` extension which the
 * original document set only on the deployControl-public + artifact families).
 */
function endpointFamilyIndex(): Map<ApiEndpoint, string> {
  const index = new Map<ApiEndpoint, string>();
  for (const family of ROUTE_FAMILIES) {
    for (const endpoint of family.endpoints) index.set(endpoint, family.id);
  }
  return index;
}

/**
 * Families that historically surfaced an `x-takos-mounted-path` extension on
 * each operation. Preserved verbatim to keep the document byte-shape stable.
 */
const MOUNTED_PATH_FAMILIES = new Set(["deployControl-public", "artifact"]);

/**
 * Derives the full OpenAPI `paths` object from the single-source endpoint
 * descriptors (always-mounted process endpoints + every family). The result is
 * later filtered down to the mounted families by {@link filterMountedRouteFamilies}.
 */
function buildPaths(): Record<string, OpenApiPathItem> {
  const familyIndex = endpointFamilyIndex();
  const paths: Record<string, OpenApiPathItem> = {};
  // All endpoints (process + every family); filtering by mounted tags happens
  // afterwards so the schema-reference pruning sees the full surface.
  const allFlags = Object.fromEntries(
    ROUTE_FAMILIES.map((family) => [family.flag, true]),
  ) as RouteFamilyMountedFlags;
  for (const endpoint of mountedEndpoints(allFlags)) {
    const openApiPath = toOpenApiPath(endpoint.path);
    const method = endpoint.method.toLowerCase() as OpenApiHttpMethod;
    const familyId = familyIndex.get(endpoint) ?? "process";
    const item = paths[openApiPath] ?? {};
    paths[openApiPath] = {
      ...item,
      [method]: endpointOperation(endpoint, familyId),
    };
  }
  return paths;
}

function endpointOperation(
  endpoint: ApiEndpoint,
  familyId: string,
): OpenApiOperation {
  if (endpoint.openapi.customOperation) {
    // The descriptor stays the single source of `operationId` + `summary`; the
    // custom operation supplies only the non-JSON response shape and security.
    return {
      operationId: endpoint.operationId,
      summary: endpoint.summary,
      ...endpoint.openapi.customOperation,
    } as unknown as OpenApiOperation;
  }
  return operation({
    operationId: endpoint.operationId,
    summary: endpoint.summary,
    tag: endpointTag(endpoint, familyId),
    auth: endpoint.auth,
    okSchema: endpoint.openapi.okSchema,
    okStatus: endpoint.openapi.okStatus,
    requestSchema: endpoint.openapi.requestSchema,
    requestBody: endpoint.openapi.requestBody,
    query: endpoint.openapi.query,
    pathParams: endpoint.openapi.pathParams,
    mountedPath: MOUNTED_PATH_FAMILIES.has(familyId)
      ? endpoint.path
      : undefined,
  });
}

function operation(input: {
  readonly operationId: string;
  readonly summary: string;
  readonly tag: string;
  readonly auth:
    | "none"
    | "deploy-token"
    | "artifact-read"
    | "deploy-control-token"
    | "internal-service"
    | "metrics-scrape";
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
    | "internal-service"
    | "metrics-scrape",
): readonly Record<string, readonly string[]>[] {
  if (auth === "deploy-token") return [{ deployBearer: [] }];
  if (auth === "deploy-control-token") return [{ deployControlBearer: [] }];
  if (auth === "metrics-scrape") return [{ metricsBearer: [] }];
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
    ConnectionScope: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        zoneId: { type: "string" },
        username: { type: "string" },
        knownHostsEntry: { type: "string" },
      },
      additionalProperties: false,
    },
    Connection: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "provider",
        "owner",
        "authMethod",
        "status",
        "envNames",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        provider: { type: "string" },
        kind: {
          enum: ["provider", "source_git_https_token", "source_git_ssh_key"],
        },
        owner: { enum: ["service", "customer"] },
        authMethod: {
          enum: ["static_secret", "aws_assume_role", "github_app_installation"],
        },
        displayName: { type: "string" },
        status: { enum: ["pending", "verified", "revoked"] },
        scope: ref("ConnectionScope"),
        envNames: { type: "array", items: { type: "string" } },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        verifiedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateConnectionRequest: {
      type: "object",
      required: ["spaceId", "provider", "authMethod", "values"],
      properties: {
        spaceId: { type: "string" },
        provider: { type: "string" },
        kind: {
          enum: ["provider", "source_git_https_token", "source_git_ssh_key"],
        },
        authMethod: { enum: ["static_secret"] },
        displayName: { type: "string" },
        owner: { enum: ["service", "customer"] },
        scope: ref("ConnectionScope"),
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Write-only credential values keyed by env name. Never echoed.",
        },
      },
      additionalProperties: false,
    },
    ConnectionResponse: {
      type: "object",
      required: ["connection"],
      properties: {
        connection: ref("Connection"),
      },
      additionalProperties: false,
    },
    ListConnectionsResponse: {
      type: "object",
      required: ["connections"],
      properties: {
        connections: { type: "array", items: ref("Connection") },
      },
      additionalProperties: false,
    },
    TestConnectionResponse: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["verified", "pending"] },
        detail: { type: "string" },
      },
      additionalProperties: false,
    },
    Source: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "name",
        "url",
        "defaultRef",
        "defaultPath",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        defaultRef: { type: "string" },
        defaultPath: { type: "string" },
        authConnectionId: { type: "string" },
        status: { enum: ["active", "disabled", "error"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    SourceSnapshot: {
      type: "object",
      required: [
        "id",
        "sourceId",
        "url",
        "ref",
        "resolvedCommit",
        "path",
        "archiveObjectKey",
        "archiveDigest",
        "archiveSizeBytes",
        "fetchedByRunId",
        "fetchedAt",
      ],
      properties: {
        id: { type: "string" },
        sourceId: { type: "string" },
        url: { type: "string" },
        ref: { type: "string" },
        resolvedCommit: { type: "string" },
        path: { type: "string" },
        archiveObjectKey: { type: "string" },
        archiveDigest: { type: "string" },
        archiveSizeBytes: { type: "number" },
        fetchedByRunId: { type: "string" },
        fetchedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    SourceSyncRun: {
      type: "object",
      required: [
        "id",
        "kind",
        "spaceId",
        "sourceId",
        "url",
        "ref",
        "path",
        "archiveObjectKey",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        kind: { enum: ["source_sync"] },
        spaceId: { type: "string" },
        sourceId: { type: "string" },
        url: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        archiveObjectKey: { type: "string" },
        status: { enum: ["queued", "running", "succeeded", "failed"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        startedAt: { type: "string", format: "date-time" },
        finishedAt: { type: "string", format: "date-time" },
        resolvedCommit: { type: "string" },
        archiveDigest: { type: "string" },
        archiveSizeBytes: { type: "number" },
        snapshotId: { type: "string" },
        error: { type: "string" },
      },
      additionalProperties: false,
    },
    CreateSourceRequest: {
      type: "object",
      required: ["spaceId", "name", "url"],
      properties: {
        spaceId: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        defaultRef: { type: "string" },
        defaultPath: { type: "string" },
        authConnectionId: { type: "string" },
      },
      additionalProperties: false,
    },
    CreateSourceResponse: {
      type: "object",
      required: ["source", "hookSecret"],
      properties: {
        source: ref("Source"),
        hookSecret: {
          type: "string",
          description:
            "Per-source webhook bearer. Returned exactly once at creation; stored hashed.",
        },
      },
      additionalProperties: false,
    },
    SourceResponse: {
      type: "object",
      required: ["source"],
      properties: { source: ref("Source") },
      additionalProperties: false,
    },
    ListSourcesResponse: {
      type: "object",
      required: ["sources"],
      properties: { sources: { type: "array", items: ref("Source") } },
      additionalProperties: false,
    },
    PatchSourceRequest: {
      type: "object",
      properties: {
        name: { type: "string" },
        defaultRef: { type: "string" },
        defaultPath: { type: "string" },
        authConnectionId: { type: ["string", "null"] },
        status: { enum: ["active", "disabled", "error"] },
      },
      additionalProperties: false,
    },
    CreateSourceSyncResponse: {
      type: "object",
      required: ["run"],
      properties: { run: ref("SourceSyncRun") },
      additionalProperties: false,
    },
    ListSourceSnapshotsResponse: {
      type: "object",
      required: ["snapshots"],
      properties: {
        snapshots: { type: "array", items: ref("SourceSnapshot") },
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
    RegisteredArtifactKind: {
      type: "object",
      required: ["kind", "description"],
      properties: {
        kind: { type: "string" },
        description: { type: "string" },
        contentTypeHint: { type: "string" },
        maxSize: { type: "number" },
      },
      additionalProperties: false,
    },
    ArtifactKindsResponse: {
      type: "object",
      required: ["kinds"],
      properties: {
        kinds: { type: "array", items: ref("RegisteredArtifactKind") },
      },
      additionalProperties: false,
    },
    BinaryResponse: {
      type: "string",
      format: "binary",
    },
    EmptyResponse: {
      description: "No response body.",
    },
    CreateAppRequest: jsonObject,
    PatchAppRequest: jsonObject,
    AppResponse: jsonObject,
    ListAppsResponse: jsonObject,
    CreateEnvironmentRequest: jsonObject,
    PatchEnvironmentRequest: jsonObject,
    EnvironmentResponse: jsonObject,
    ListEnvironmentsResponse: jsonObject,
    InstallProfileResponse: jsonObject,
    ListInstallProfilesResponse: jsonObject,
    DeploymentProfileResponse: jsonObject,
    PutDeploymentProfileRequest: jsonObject,
    RunResponse: jsonObject,
    ApproveRunRequest: jsonObject,
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
