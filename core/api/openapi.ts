import { CORE_CONDITION_REASONS } from "takosumi-contract/reference/compat";
import { PUBLIC_PROVIDER_RESOLUTION_STATUSES } from "takosumi-contract/provider-resolution";
import { PROVIDER_CREDENTIAL_OWNERSHIPS } from "takosumi-contract/connections";
import {
  PROVIDER_ENV_MATERIALIZATIONS,
  PROVIDER_ENV_STATUSES,
} from "takosumi-contract/provider-envs";
import {
  type ApiEndpoint,
  endpointTag,
  mountedEndpoints,
  mountedOpenApiTags,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

export type OpenApiHttpMethod =
  | "delete"
  | "get"
  | "head"
  | "patch"
  | "post"
  | "put";

/**
 * Canonical version emitted in `info.version`. Kept in lockstep with the
 * `@takosjp/takosumi` package version declared in `package.json`.
 * Bump this when the service publishes a new minor/major release.
 */
export const TAKOSUMI_OPENAPI_VERSION = "0.17.0" as const;

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

type OpenApiSchema = Record<string, unknown> & {
  readonly properties?: Record<string, OpenApiSchema>;
};

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
  readonly deployControlInternalRoutesMounted?: boolean;
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
      title: "Takosumi process route inventory",
      version: TAKOSUMI_OPENAPI_VERSION,
      description:
        "Dependency-free OpenAPI-ish inventory for mounted Takosumi process route families. Host-internal /internal/v1 callback seams are omitted even when mounted; external integrations should use the documented /api/v1 surface.",
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
            "Artifact write bearer from TAKOSUMI_DEPLOY_TOKEN for /internal/v1/artifacts write routes.",
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
        inventoryBearer: {
          type: "http",
          scheme: "bearer",
          description:
            "Operator inventory bearer used to fetch /capabilities and /openapi.json process inventories.",
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
            operation.tags.some((tag) => mountedTags.has(tag)),
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
      schemas: filterReferencedSchemas(
        narrowApiEndpointAuthEnum(document.components.schemas, paths),
        paths,
      ),
    },
  };
}

function narrowApiEndpointAuthEnum(
  schemas: Record<string, OpenApiSchema>,
  paths: Record<string, OpenApiPathItem>,
): Record<string, OpenApiSchema> {
  const authValues = new Set<string>();
  for (const item of Object.values(paths)) {
    for (const operation of Object.values(item)) {
      const auth = operation["x-takos-auth"];
      if (typeof auth === "string") authValues.add(auth);
    }
  }
  const endpoint = schemas.ApiEndpointDescription;
  const auth = endpoint?.properties?.auth;
  if (!endpoint || !auth || authValues.size === 0) return schemas;
  return {
    ...schemas,
    ApiEndpointDescription: {
      ...endpoint,
      properties: {
        ...endpoint.properties,
        auth: {
          ...auth,
          enum: [...authValues].sort(),
        },
      },
    },
  };
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/**
 * Maps each {@link ApiEndpoint} to its owning family `id` (used for the primary
 * OpenAPI tag fallback and the `x-takos-mounted-path` extension which the
 * original document set only on the deployControl-internal + artifact families).
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
const MOUNTED_PATH_FAMILIES = new Set(["deployControl-internal", "artifact"]);

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
    | "inventory-bearer"
    | "deploy-control-token"
    | "internal-service"
    | "metrics-scrape";
  readonly okSchema: string;
  readonly okStatus?: "200" | "201" | "202" | "204";
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
      [input.okStatus ?? "200"]:
        input.okStatus === "204"
          ? { description: "No content" }
          : jsonResponse(input.okSchema),
      ...(input.auth === "none" ? {} : { "401": errorResponse() }),
      ...(input.auth === "internal-service" ? { "403": errorResponse() } : {}),
      ...(input.requestSchema || input.requestBody
        ? { "400": errorResponse() }
        : {}),
      ...(input.tag === "deployControl-internal"
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
    | "inventory-bearer"
    | "deploy-control-token"
    | "internal-service"
    | "metrics-scrape",
): readonly Record<string, readonly string[]>[] {
  if (auth === "inventory-bearer") return [{ inventoryBearer: [] }];
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
  return { $ref: `#/components/schemas/${schemaName}` };
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
    [...referenced].sort().flatMap((schemaName) => {
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

/**
 * Open JSON object schema (`{ type: "object", additionalProperties: true }`)
 * shared by several fragments. Hoisted to module scope so the per-domain
 * fragment functions below can reuse the identical shape.
 */
const jsonObject = {
  type: "object",
  additionalProperties: true,
};

/**
 * Composes the OpenAPI `components.schemas` map from cohesive per-domain
 * fragment functions. The order of fragments is cosmetic only —
 * {@link filterReferencedSchemas} re-sorts schema names before emission, so the
 * produced document is byte-identical regardless of fragment order.
 */
function createSchemas(): Record<string, Record<string, unknown>> {
  return {
    ...processSchemas(),
    ...runnerSchemas(),
    ...installationSchemas(),
    ...capsuleSchemas(),
    ...providerCatalogSchemas(),
    ...providerResolutionSchemas(),
    ...outputSchemas(),
    ...connectionSchemas(),
    ...sourceSchemas(),
    ...deploySchemas(),
    ...artifactSchemas(),
    ...billingSchemas(),
    ...dependencySchemas(),
    ...serviceGraphSchemas(),
    ...spaceSchemas(),
    ...runSchemas(),
    ...activitySchemas(),
    ...backupSchemas(),
    ...outputShareSchemas(),
    ...runtimeAgentSchemas(),
    ...errorSchemas(),
  };
}

/** Process inventory, health, capabilities, and the shared Condition shape. */
function processSchemas(): Record<string, Record<string, unknown>> {
  const condition = {
    type: "object",
    required: ["type", "status"],
    properties: {
      type: { type: "string" },
      status: { enum: ["true", "false", "unknown"] },
      reason: { $ref: "#/components/schemas/CoreConditionReason" },
      message: { type: "string" },
      observedGeneration: { type: "number" },
      lastTransitionAt: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
  return {
    LocalizedText: {
      type: "object",
      required: ["ja", "en"],
      properties: {
        ja: { type: "string" },
        en: { type: "string" },
      },
      additionalProperties: false,
    },
    CoreConditionReason: {
      enum: [...CORE_CONDITION_REASONS],
      description:
        "Canonical condition reason catalog exported by takosumi-contract. CLI, app UI, API clients, controllers, and status projections must use these values for condition.reason.",
    },
    Condition: condition,
    ApiEndpointDescription: {
      type: "object",
      required: ["method", "path", "summary", "auth"],
      properties: {
        method: { enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
        path: { type: "string" },
        summary: { type: "string" },
        auth: {
          enum: [
            "none",
            "inventory-bearer",
            "deploy-token",
            "artifact-read",
            "deploy-control-token",
            "metrics-scrape",
          ],
        },
      },
      additionalProperties: false,
    },
    ProcessRoleDescription: {
      type: "object",
      required: ["role", "description"],
      properties: {
        role: {
          enum: ["takosumi-api", "takosumi-worker", "takosumi-runtime-agent"],
        },
        description: { type: "string" },
      },
      additionalProperties: false,
    },
    CapabilitiesResponse: {
      type: "object",
      required: ["service", "role", "roleDescription", "endpoints"],
      properties: {
        service: { const: "takosumi" },
        role: {
          enum: ["takosumi-api", "takosumi-worker", "takosumi-runtime-agent"],
        },
        roleDescription: ref("ProcessRoleDescription"),
        endpoints: {
          type: "array",
          items: ref("ApiEndpointDescription"),
        },
      },
      additionalProperties: false,
    },
    HealthProbeResponse: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        state: { enum: ["ready", "not-ready", "booting"] },
        status: { type: "integer" },
        reason: { type: "string" },
      },
      additionalProperties: {
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "integer" },
          { type: "boolean" },
          { type: "array" },
          { type: "object" },
          { type: "null" },
        ],
      },
    },
  };
}

/**
 * OpenTofu module source variants plus the runner contract shapes (state
 * backend, credential references, execution targets, policy, plan artifacts).
 */
function runnerSchemas(): Record<string, Record<string, unknown>> {
  return {
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
    RunAuditEvent: {
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
  };
}

/** Installation records and their service-side InstallConfig. */
function installationSchemas(): Record<string, Record<string, unknown>> {
  return {
    Installation: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "name",
        "slug",
        "sourceId",
        "installConfigId",
        "environment",
        "currentStateGeneration",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        sourceId: { type: "string" },
        installConfigId: { type: "string" },
        environment: { type: "string" },
        currentDeploymentId: { type: "string" },
        currentStateGeneration: { type: "number" },
        compatibilityStatus: {
          enum: ["ready", "auto_capsulized", "needs_patch", "unsupported"],
        },
        status: {
          enum: [
            "pending",
            "active",
            "stale",
            "error",
            "disabled",
            "destroyed",
          ],
        },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      additionalProperties: false,
    },
    InstallConfig: {
      type: "object",
      required: [
        "id",
        "name",
        "sourceKind",
        "trustLevel",
        "variableMapping",
        "outputAllowlist",
        "policy",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        name: { type: "string" },
        sourceKind: {
          enum: ["generic_capsule", "first_party_capsule"],
        },
        trustLevel: {
          enum: ["official", "trusted", "space", "raw"],
        },
        modulePath: { type: "string" },
        normalization: {
          type: "object",
          required: [
            "allowBackendRewrite",
            "allowProviderLift",
            "allowAliasInjection",
          ],
          properties: {
            allowBackendRewrite: { type: "boolean" },
            allowProviderLift: { type: "boolean" },
            allowAliasInjection: { type: "boolean" },
          },
          additionalProperties: false,
        },
        build: {
          type: "object",
          required: ["enabled", "commands"],
          properties: {
            enabled: { type: "boolean" },
            workingDirectory: { type: "string" },
            commands: { type: "array", items: { type: "string" } },
            artifactPath: { type: "string" },
          },
          additionalProperties: false,
        },
        variableMapping: { type: "object", additionalProperties: true },
        outputAllowlist: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["from", "type"],
            properties: {
              from: { type: "string" },
              type: {
                enum: [
                  "string",
                  "url",
                  "hostname",
                  "number",
                  "boolean",
                  "json",
                ],
              },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        policy: { type: "object", additionalProperties: true },
        catalog: {
          type: "object",
          required: [
            "order",
            "surface",
            "kind",
            "provider",
            "suggestedName",
            "badge",
            "name",
            "description",
            "inputs",
          ],
          properties: {
            templateId: { type: "string" },
            templateVersion: { type: "string" },
            source: {
              type: "object",
              required: ["git", "ref", "path"],
              properties: {
                git: { type: "string" },
                ref: { type: "string" },
                path: { type: "string" },
              },
              additionalProperties: false,
            },
            order: { type: "integer", minimum: 0 },
            surface: { enum: ["service", "building_block", "example"] },
            kind: { enum: ["worker", "storage", "site"] },
            provider: { type: "string" },
            suggestedName: { type: "string" },
            badge: { $ref: "#/components/schemas/LocalizedText" },
            name: { $ref: "#/components/schemas/LocalizedText" },
            description: { $ref: "#/components/schemas/LocalizedText" },
            inputs: {
              type: "array",
              items: {
                type: "object",
                required: ["name", "label"],
                properties: {
                  name: { type: "string" },
                  type: { enum: ["string", "number", "boolean"] },
                  required: { type: "boolean" },
                  defaultValue: {
                    enum: [
                      "service-name",
                      "service-name-with-space",
                      "main",
                      "us-east-1",
                    ],
                  },
                  label: { $ref: "#/components/schemas/LocalizedText" },
                  helper: { $ref: "#/components/schemas/LocalizedText" },
                  placeholder: { type: "string" },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        backup: {
          type: "object",
          required: ["enabled", "mode"],
          properties: {
            enabled: { type: "boolean" },
            mode: {
              enum: [
                "none",
                "artifact_export",
                "provider_snapshot",
                "custom_command",
              ],
            },
            command: { type: "array", items: { type: "string" } },
            outputPath: { type: "string" },
          },
          additionalProperties: false,
        },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/**
 * Capsule Gate / Compatibility Report shapes: findings, provider / resource /
 * data-source / provisioner requirements, and the aggregate report.
 */
function capsuleSchemas(): Record<string, Record<string, unknown>> {
  return {
    CapsuleCompatibilityFinding: {
      type: "object",
      required: ["severity", "code", "message"],
      properties: {
        severity: { enum: ["info", "warning", "error"] },
        code: { type: "string" },
        message: { type: "string" },
        path: { type: "string" },
        suggestion: { type: "string" },
      },
      additionalProperties: false,
    },
    CapsuleProviderRequirement: {
      type: "object",
      required: ["source", "aliases", "allowed"],
      properties: {
        source: { type: "string" },
        versionConstraint: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        allowed: { type: "boolean" },
        ownershipOptions: {
          type: "array",
          items: ref("ProviderCredentialOwnership"),
        },
      },
      additionalProperties: false,
    },
    CapsuleResourceRequirement: {
      type: "object",
      required: ["type", "allowed"],
      properties: {
        type: { type: "string" },
        count: { type: "number" },
        allowed: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CapsuleDataSourceRequirement: {
      type: "object",
      required: ["type", "allowed"],
      properties: {
        type: { type: "string" },
        allowed: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CapsuleProvisionerRequirement: {
      type: "object",
      required: ["type", "allowed"],
      properties: {
        type: { type: "string" },
        allowed: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CapsuleCompatibilityReport: {
      type: "object",
      required: [
        "id",
        "sourceSnapshotId",
        "level",
        "findings",
        "providers",
        "resources",
        "dataSources",
        "provisioners",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        sourceId: { type: "string" },
        installationId: { type: "string" },
        sourceSnapshotId: { type: "string" },
        level: {
          enum: ["ready", "auto_capsulized", "needs_patch", "unsupported"],
        },
        findings: {
          type: "array",
          items: ref("CapsuleCompatibilityFinding"),
        },
        providers: {
          type: "array",
          items: ref("CapsuleProviderRequirement"),
        },
        resources: {
          type: "array",
          items: ref("CapsuleResourceRequirement"),
        },
        dataSources: {
          type: "array",
          items: ref("CapsuleDataSourceRequirement"),
        },
        provisioners: {
          type: "array",
          items: ref("CapsuleProvisionerRequirement"),
        },
        providerRequirements: {
          type: "array",
          items: ref("ProviderRequirement"),
        },
        providerResolutions: {
          type: "array",
          items: ref("ProviderResolution"),
        },
        normalizedObjectKey: { type: "string" },
        normalizedDigest: { type: "string" },
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

function providerResolutionSchemas(): Record<string, Record<string, unknown>> {
  return {
    ProviderEnvMaterialization: { enum: [...PROVIDER_ENV_MATERIALIZATIONS] },
    ProviderCredentialOwnership: { enum: [...PROVIDER_CREDENTIAL_OWNERSHIPS] },
    ProviderResolutionStatus: {
      enum: [...PUBLIC_PROVIDER_RESOLUTION_STATUSES],
    },
    ProviderRequirement: {
      type: "object",
      required: [
        "providerSource",
        "providerName",
        "modulePath",
        "discoveredFrom",
        "requiredForPhases",
      ],
      properties: {
        providerSource: { type: "string" },
        providerName: { type: "string" },
        alias: { type: "string" },
        versionConstraint: { type: "string" },
        modulePath: { type: "string" },
        discoveredFrom: {
          enum: ["required_providers", "provider_block", "generated_root"],
        },
        requiredForPhases: {
          type: "array",
          items: {
            enum: ["init", "plan", "apply", "destroy", "drift_check"],
          },
        },
      },
      additionalProperties: false,
    },
    ProviderResolution: {
      type: "object",
      required: ["requirement", "status", "evidence"],
      properties: {
        requirement: ref("ProviderRequirement"),
        status: ref("ProviderResolutionStatus"),
        connectionId: { type: "string" },
        ownership: ref("ProviderCredentialOwnership"),
        blockedReason: { type: "string" },
        evidence: ref("ProviderResolutionEvidence"),
      },
      additionalProperties: false,
    },
    ProviderResolutionEvidence: {
      oneOf: [
        ref("ProviderConnectionResolutionEvidence"),
        ref("BlockedProviderResolutionEvidence"),
      ],
    },
    ProviderConnectionResolutionEvidence: {
      type: "object",
      required: [
        "kind",
        "provider",
        "connectionId",
        "ownership",
        "requiredEnvNames",
      ],
      properties: {
        kind: { const: "provider_connection" },
        provider: { type: "string" },
        connectionId: { type: "string" },
        ownership: { enum: [...PROVIDER_CREDENTIAL_OWNERSHIPS] },
        requiredEnvNames: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    BlockedProviderResolutionEvidence: {
      type: "object",
      required: ["kind", "provider", "reason"],
      properties: {
        kind: { const: "blocked" },
        provider: { type: "string" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    RuntimeGrantProjection: {
      type: "object",
      required: [
        "grantId",
        "serviceExportId",
        "serviceBindingId",
        "installationId",
        "capability",
      ],
      properties: {
        grantId: { type: "string" },
        serviceExportId: { type: "string" },
        serviceBindingId: { type: "string" },
        installationId: { type: "string" },
        capability: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
        rotationPolicyId: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/**
 * Provider catalog (ownership options / helpers / catalog records)
 * plus the compatibility-check request/response wrappers that bind to it.
 */
function providerCatalogSchemas(): Record<string, Record<string, unknown>> {
  return {
    ProviderCredentialHelper: {
      enum: [
        "cloudflare_api_token",
        "cloudflare_oauth",
        "aws_assume_role",
        "gcp_oauth_bootstrap",
        "gcp_service_account_json",
        "gcp_service_account_impersonation",
        "generic_env",
      ],
    },
    ProviderCatalogEntry: {
      type: "object",
      required: [
        "id",
        "providerSource",
        "displayName",
        "recommendedEnvNames",
        "helpers",
        "ownershipOptions",
        "allowedResources",
        "allowedDataSources",
        "policyPackId",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        providerSource: { type: "string" },
        displayName: { type: "string" },
        recommendedEnvNames: { type: "array", items: { type: "string" } },
        credentialRecipeIds: { type: "array", items: { type: "string" } },
        requiredEnvGroups: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        genericEnvSupported: { type: "boolean" },
        helpers: { type: "array", items: ref("ProviderCredentialHelper") },
        ownershipOptions: {
          type: "array",
          items: ref("ProviderCredentialOwnership"),
        },
        allowedResources: { type: "array", items: { type: "string" } },
        allowedDataSources: { type: "array", items: { type: "string" } },
        policyPackId: { type: "string" },
        costEstimatorId: { type: "string" },
        docsUrl: { type: "string" },
        createdAt: { type: "string" },
        updatedAt: { type: "string" },
      },
      additionalProperties: false,
    },
    ProviderEnvStatus: { enum: [...PROVIDER_ENV_STATUSES] },
    ProviderEnv: {
      type: "object",
      required: [
        "id",
        "providerSource",
        "displayName",
        "materialization",
        "status",
        "requiredEnvNames",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        providerSource: { type: "string" },
        displayName: { type: "string" },
        materialization: ref("ProviderEnvMaterialization"),
        status: ref("ProviderEnvStatus"),
        requiredEnvNames: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    PutProviderEnvRequest: {
      type: "object",
      required: ["providerSource", "displayName", "materialization"],
      properties: {
        spaceId: { type: "string" },
        providerSource: { type: "string" },
        displayName: { type: "string" },
        materialization: ref("ProviderEnvMaterialization"),
        status: ref("ProviderEnvStatus"),
        requiredEnvNames: { type: "array", items: { type: "string" } },
        secretRef: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    ProviderEnvResponse: {
      type: "object",
      required: ["providerEnv"],
      properties: { providerEnv: ref("ProviderEnv") },
      additionalProperties: false,
    },
    ListProviderEnvsResponse: {
      type: "object",
      required: ["providerEnvs"],
      properties: {
        providerEnvs: { type: "array", items: ref("ProviderEnv") },
      },
      additionalProperties: false,
    },
    ProviderCatalogEntryResponse: {
      type: "object",
      required: ["provider"],
      properties: { provider: ref("ProviderCatalogEntry") },
      additionalProperties: false,
    },
    ListProviderCatalogEntriesResponse: {
      type: "object",
      required: ["providers"],
      properties: {
        providers: { type: "array", items: ref("ProviderCatalogEntry") },
      },
      additionalProperties: false,
    },
    CreateSourceCompatibilityCheckRequest: {
      type: "object",
      properties: {
        sourceSnapshotId: { type: "string" },
        installationId: { type: "string" },
      },
      additionalProperties: false,
    },
    CapsuleCompatibilityReportResponse: {
      type: "object",
      required: ["report"],
      properties: {
        report: ref("CapsuleCompatibilityReport"),
        run: ref("Run"),
      },
      additionalProperties: false,
    },
  };
}

/** OutputSnapshot / Deployment projections and their read wrappers. */
function outputSchemas(): Record<string, Record<string, unknown>> {
  return {
    OutputSnapshot: {
      type: "object",
      description:
        "Public tofu output generation projection. Raw output JSON remains an encrypted artifact on the internal ledger and is not exposed on this schema; publicOutputs and spaceOutputs are allowlisted non-secret projections.",
      required: [
        "id",
        "spaceId",
        "installationId",
        "stateGeneration",
        "publicOutputs",
        "spaceOutputs",
        "outputDigest",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        stateGeneration: { type: "number" },
        publicOutputs: { type: "object", additionalProperties: true },
        spaceOutputs: { type: "object", additionalProperties: true },
        outputDigest: { type: "string" },
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
    Deployment: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "installationId",
        "environment",
        "applyRunId",
        "stateGeneration",
        "outputsPublic",
        "status",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        environment: { type: "string" },
        applyRunId: { type: "string" },
        sourceSnapshotId: { type: "string" },
        dependencySnapshotId: { type: "string" },
        stateGeneration: { type: "number" },
        outputsPublic: { type: "object", additionalProperties: true },
        status: { enum: ["active", "superseded", "rolled_back", "destroyed"] },
        createdAt: { type: "string" },
      },
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
  };
}

/**
 * Connection records, internal provider resolver records, and the credential
 * creation / OAuth / impersonation / test helper request+response shapes.
 */
function connectionSchemas(): Record<string, Record<string, unknown>> {
  return {
    ConnectionScope: {
      type: "object",
      properties: {
        accountId: { type: "string" },
        zoneId: { type: "string" },
        cloudflareTokenVending: {
          type: "object",
          required: ["policies"],
          properties: {
            policies: {
              type: "array",
              items: {
                type: "object",
                required: ["effect", "permission_groups", "resources"],
                properties: {
                  id: { type: "string" },
                  effect: { enum: ["allow", "deny"] },
                  permission_groups: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id"],
                      properties: {
                        id: { type: "string" },
                        meta: {
                          type: "object",
                          additionalProperties: { type: "string" },
                        },
                        name: { type: "string" },
                      },
                      additionalProperties: false,
                    },
                  },
                  resources: {
                    type: "object",
                    additionalProperties: true,
                  },
                },
                additionalProperties: false,
              },
            },
            ttlSeconds: { type: "integer", minimum: 60, maximum: 86400 },
            namePrefix: { type: "string" },
            condition: {
              type: "object",
              additionalProperties: true,
            },
          },
          additionalProperties: false,
        },
        username: { type: "string" },
        knownHostsEntry: { type: "string" },
        awsRoleArn: { type: "string" },
        awsExternalId: { type: "string" },
        awsRegion: { type: "string" },
        gcpServiceAccountEmail: { type: "string" },
        gcpProjectId: { type: "string" },
        templateId: { type: "string" },
      },
      additionalProperties: false,
    },
    Connection: {
      type: "object",
      required: [
        "id",
        "provider",
        "scope",
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
          enum: [
            "source_git_https_token",
            "source_git_ssh_key",
            "cloudflare_oauth",
            "cloudflare_api_token",
            "aws_assume_role",
            "gcp_oauth_bootstrap",
            "gcp_service_account_json",
            "gcp_service_account_impersonation",
            "static_secret",
            "generic_env_provider",
            "manual",
          ],
        },
        credentialDriver: ref("ConnectionCredentialDriver"),
        scope: { enum: ["operator", "space"] },
        authMethod: {
          enum: [
            "static_secret",
            "aws_assume_role",
            "oauth",
            "impersonation",
            "api_token",
            "kubeconfig",
            "generic_env",
            "manual",
          ],
        },
        displayName: { type: "string" },
        status: {
          enum: ["pending", "verified", "revoked", "expired", "error"],
        },
        scopeHints: ref("ConnectionScope"),
        envNames: { type: "array", items: { type: "string" } },
        fileEnvNames: { type: "array", items: { type: "string" } },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        verifiedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateConnectionFile: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: {
          type: "string",
          description:
            "Relative credential file path to create in the runner sandbox.",
        },
        content: {
          type: "string",
          description:
            "Write-only credential file content. Stored encrypted and never echoed.",
        },
        mode: {
          type: "integer",
          minimum: 0,
          maximum: 511,
          description:
            "POSIX file mode for the generated credential file. Defaults to 0600.",
        },
        envName: {
          type: "string",
          description:
            "Optional env var name whose value becomes the generated credential file path.",
        },
      },
      additionalProperties: false,
    },
    CreateConnectionRequest: {
      type: "object",
      required: ["provider", "authMethod", "values"],
      properties: {
        spaceId: { type: "string" },
        provider: { type: "string" },
        kind: {
          enum: [
            "source_git_https_token",
            "source_git_ssh_key",
            "cloudflare_oauth",
            "cloudflare_api_token",
            "aws_assume_role",
            "gcp_oauth_bootstrap",
            "gcp_service_account_json",
            "gcp_service_account_impersonation",
            "static_secret",
            "generic_env_provider",
            "manual",
          ],
        },
        credentialDriver: ref("ConnectionCredentialDriver"),
        authMethod: {
          enum: [
            "static_secret",
            "aws_assume_role",
            "oauth",
            "impersonation",
            "api_token",
            "kubeconfig",
            "generic_env",
            "manual",
          ],
        },
        displayName: { type: "string" },
        scope: { enum: ["operator", "space"] },
        scopeHints: ref("ConnectionScope"),
        expiresAt: { type: "string", format: "date-time" },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Write-only credential values keyed by env name. Never echoed.",
        },
        files: {
          type: "array",
          items: ref("CreateConnectionFile"),
          description:
            "Write-only credential files for generic-env Provider Connections. File contents are never echoed.",
        },
      },
      additionalProperties: false,
    },
    ConnectionCredentialDriver: {
      enum: [
        "cloudflare_oauth",
        "cloudflare_api_token",
        "aws_assume_role",
        "gcp_oauth_bootstrap",
        "gcp_service_account_json",
        "gcp_service_account_impersonation",
        "generic_env",
        "static_secret",
        "manual",
      ],
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
    CreateConnectionSubrouteRequest: {
      type: "object",
      required: ["values"],
      properties: {
        spaceId: { type: "string" },
        provider: { type: "string" },
        displayName: { type: "string" },
        scope: { enum: ["operator", "space"] },
        scopeHints: ref("ConnectionScope"),
        expiresAt: { type: "string", format: "date-time" },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Write-only credential values keyed by env name. The subroute fixes provider, kind, and authMethod; values are never echoed.",
        },
        files: {
          type: "array",
          items: ref("CreateConnectionFile"),
          description:
            "Write-only credential files accepted by the generic-env provider subroute. Fixed provider subroutes reject credential files.",
        },
      },
      additionalProperties: false,
    },
    ConnectionOAuthStartRequest: {
      type: "object",
      properties: {
        spaceId: { type: "string" },
        displayName: { type: "string" },
        scope: { enum: ["operator", "space"] },
        scopeHints: ref("ConnectionScope"),
        expiresAt: { type: "string", format: "date-time" },
        redirectUri: { type: "string" },
        successRedirectUri: { type: "string" },
      },
      additionalProperties: false,
    },
    ConnectionOAuthStartResponse: {
      type: "object",
      required: ["authorizationUrl", "state"],
      properties: {
        authorizationUrl: { type: "string" },
        state: { type: "string" },
        expiresAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    GcpImpersonationConnectionRequest: {
      type: "object",
      required: ["scopeHints", "values"],
      properties: {
        spaceId: { type: "string" },
        displayName: { type: "string" },
        scope: { enum: ["operator", "space"] },
        scopeHints: ref("ConnectionScope"),
        expiresAt: { type: "string", format: "date-time" },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Write-only Google provider bootstrap env values. Never echoed.",
        },
      },
      additionalProperties: false,
    },
    TestConnectionResponse: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["verified", "pending", "expired"] },
        detail: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/** Git Source registrations, SourceSnapshots, and source-sync run shapes. */
function sourceSchemas(): Record<string, Record<string, unknown>> {
  return {
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
        "origin",
        "spaceId",
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
        origin: { enum: ["git", "upload"] },
        spaceId: { type: "string" },
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
    UploadSnapshotResponse: {
      type: "object",
      required: ["snapshot"],
      properties: { snapshot: ref("SourceSnapshot") },
      additionalProperties: false,
    },
  };
}

/** Direct upload deploy entry point shapes. */
function deploySchemas(): Record<string, Record<string, unknown>> {
  const installationProviderConnectionBinding = {
    type: "object",
    required: ["provider", "connectionId"],
    properties: {
      provider: { type: "string" },
      alias: { type: "string" },
      connectionId: { type: "string" },
      region: { type: "string" },
    },
    additionalProperties: false,
  };
  const internalProviderResolverBinding = {
    type: "object",
    required: ["provider", "envId"],
    properties: {
      provider: { type: "string" },
      alias: { type: "string" },
      envId: { type: "string" },
      region: { type: "string" },
    },
    additionalProperties: false,
  };
  const jsonValue = {
    oneOf: [
      { type: "string" },
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      { type: "array" },
      { type: "object" },
      { type: "null" },
    ],
  };
  return {
    DeployRequest: {
      type: "object",
      required: ["spaceId", "name", "snapshotId"],
      properties: {
        spaceId: { type: "string" },
        name: { type: "string" },
        environment: { type: "string" },
        snapshotId: { type: "string" },
        modulePath: { type: "string" },
        runnerId: { type: "string" },
        vars: {
          type: "object",
          additionalProperties: jsonValue,
        },
        outputAllowlist: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["from", "type"],
            properties: {
              from: { type: "string" },
              type: {
                enum: [
                  "string",
                  "url",
                  "hostname",
                  "number",
                  "boolean",
                  "json",
                ],
              },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        providerConnections: {
          type: "array",
          items: installationProviderConnectionBinding,
        },
        planOnly: { type: "boolean" },
        autoApprove: { type: "boolean" },
      },
      additionalProperties: false,
    },
    DeployUploadSnapshotRequest: {
      type: "object",
      required: ["spaceId", "name", "snapshotId"],
      properties: {
        spaceId: { type: "string" },
        name: { type: "string" },
        environment: { type: "string" },
        snapshotId: { type: "string" },
        modulePath: { type: "string" },
        runnerId: { type: "string" },
        vars: {
          type: "object",
          additionalProperties: jsonValue,
        },
        outputAllowlist: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["from", "type"],
            properties: {
              from: { type: "string" },
              type: {
                enum: [
                  "string",
                  "url",
                  "hostname",
                  "number",
                  "boolean",
                  "json",
                ],
              },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        providerEnvBindings: {
          type: "array",
          items: internalProviderResolverBinding,
        },
        planOnly: { type: "boolean" },
        autoApprove: { type: "boolean" },
      },
      additionalProperties: false,
    },
    DeployResponse: {
      type: "object",
      required: ["installation", "installConfigId", "run", "created"],
      properties: {
        installation: ref("Installation"),
        installConfigId: { type: "string" },
        run: ref("Run"),
        planRun: ref("Run"),
        applyRun: ref("Run"),
        status: {
          enum: [
            "planned",
            "applying",
            "applied",
            "waiting_approval",
            "failed",
          ],
        },
        runGroupId: { type: "string" },
        created: { type: "boolean" },
      },
      additionalProperties: false,
    },
  };
}

/** Artifact store shapes plus the shared binary / empty response stubs. */
function artifactSchemas(): Record<string, Record<string, unknown>> {
  return {
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
    ArtifactGcResponse: {
      type: "object",
      required: ["deleted", "retained", "dryRun"],
      properties: {
        deleted: {
          type: "array",
          items: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        },
        retained: { type: "integer", minimum: 0 },
        dryRun: { type: "boolean" },
        warning: { type: "string" },
      },
      additionalProperties: false,
    },
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
  };
}

/**
 * Space-scoped billing ledger: settings, credit balance/usage/reservation,
 * account/subscription/plan records, and the billing request+response wrappers.
 */
function billingSchemas(): Record<string, Record<string, unknown>> {
  return {
    BillingSettings: {
      oneOf: [
        {
          type: "object",
          required: ["mode", "provider"],
          properties: {
            mode: { const: "disabled" },
            provider: { const: "none" },
            reservationRequired: { const: false },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["mode", "provider"],
          properties: {
            mode: { const: "showback" },
            provider: { enum: ["stripe", "manual", "none"] },
            reservationRequired: { const: false },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["mode", "provider", "reservationRequired"],
          properties: {
            mode: { const: "enforce" },
            provider: { enum: ["stripe", "manual"] },
            reservationRequired: { const: true },
          },
          additionalProperties: false,
        },
      ],
    },
    CreditBalance: {
      type: "object",
      required: [
        "spaceId",
        "availableCredits",
        "reservedCredits",
        "monthlyIncludedCredits",
        "purchasedCredits",
        "updatedAt",
      ],
      properties: {
        spaceId: { type: "string" },
        availableCredits: { type: "number" },
        reservedCredits: { type: "number" },
        monthlyIncludedCredits: { type: "number" },
        purchasedCredits: { type: "number" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    UsageEvent: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "kind",
        "quantity",
        "credits",
        "source",
        "idempotencyKey",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        runId: { type: "string" },
        kind: { type: "string" },
        quantity: { type: "number" },
        credits: { type: "number" },
        source: {
          type: "string",
          enum: [
            "runner",
            "resource_meter",
            "billing_reconciliation",
            "manual_adjustment",
          ],
        },
        idempotencyKey: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreditReservation: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "runId",
        "estimatedCredits",
        "status",
        "mode",
        "createdAt",
        "expiresAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        runId: { type: "string" },
        estimatedCredits: { type: "number" },
        status: {
          type: "string",
          enum: ["reserved", "captured", "released", "expired"],
        },
        mode: { type: "string", enum: ["disabled", "showback", "enforce"] },
        createdAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    BillingAccount: {
      type: "object",
      required: [
        "id",
        "ownerType",
        "ownerId",
        "provider",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        ownerType: { type: "string", enum: ["user", "space"] },
        ownerId: { type: "string" },
        provider: { type: "string", enum: ["stripe", "manual", "none"] },
        stripeCustomerId: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "past_due", "disabled", "trialing"],
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    SpaceSubscription: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "billingAccountId",
        "planId",
        "status",
        "currentPeriodStart",
        "currentPeriodEnd",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        billingAccountId: { type: "string" },
        planId: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "trialing", "past_due", "cancelled"],
        },
        currentPeriodStart: { type: "string", format: "date-time" },
        currentPeriodEnd: { type: "string", format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    BillingPlan: {
      type: "object",
      required: [
        "id",
        "name",
        "monthlyBasePrice",
        "includedCredits",
        "limits",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        monthlyBasePrice: { type: "number" },
        includedCredits: { type: "number" },
        limits: {
          type: "object",
          properties: {
            maxEstimatedCreditsPerRun: { type: "number" },
            quota: {
              type: "object",
              additionalProperties: { type: "number" },
            },
          },
          additionalProperties: false,
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    SpaceBillingResponse: {
      type: "object",
      required: ["billing"],
      properties: {
        billing: {
          type: "object",
          required: ["settings"],
          properties: {
            settings: ref("BillingSettings"),
            balance: ref("CreditBalance"),
            account: ref("BillingAccount"),
            subscription: ref("SpaceSubscription"),
            plan: ref("BillingPlan"),
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    SpaceUsageResponse: {
      type: "object",
      required: ["usageEvents"],
      properties: {
        usageEvents: { type: "array", items: ref("UsageEvent") },
      },
      additionalProperties: false,
    },
    SpaceCreditReservationsResponse: {
      type: "object",
      required: ["creditReservations"],
      properties: {
        creditReservations: {
          type: "array",
          items: ref("CreditReservation"),
        },
      },
      additionalProperties: false,
    },
    CreditsTopUpRequest: {
      type: "object",
      required: ["credits"],
      properties: {
        credits: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    CreditBalanceResponse: {
      type: "object",
      required: ["balance"],
      properties: {
        balance: ref("CreditBalance"),
      },
      additionalProperties: false,
    },
    SubscriptionChangeRequest: {
      type: "object",
      required: ["billingSettings"],
      properties: {
        billingSettings: ref("BillingSettings"),
      },
      additionalProperties: false,
    },
  };
}

/** Dependency DAG edge shapes and their request/response wrappers. */
function dependencySchemas(): Record<string, Record<string, unknown>> {
  return {
    DependencyOutputMapping: {
      type: "object",
      required: ["from", "to", "required"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
        required: { type: "boolean" },
        type: {
          enum: ["string", "url", "hostname", "number", "boolean", "json"],
        },
      },
      additionalProperties: false,
    },
    Dependency: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "producerInstallationId",
        "consumerInstallationId",
        "mode",
        "outputs",
        "visibility",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        producerInstallationId: { type: "string" },
        consumerInstallationId: { type: "string" },
        mode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        outputs: {
          type: "object",
          additionalProperties: ref("DependencyOutputMapping"),
        },
        visibility: { enum: ["space", "cross_space"] },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateDependencyRequest: {
      type: "object",
      required: ["producerInstallationId", "mode", "outputs"],
      properties: {
        producerInstallationId: { type: "string" },
        mode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        outputs: {
          type: "object",
          additionalProperties: ref("DependencyOutputMapping"),
        },
        visibility: { enum: ["space", "cross_space"] },
      },
      additionalProperties: false,
    },
    DependencyResponse: {
      type: "object",
      required: ["dependency"],
      properties: { dependency: ref("Dependency") },
      additionalProperties: false,
    },
    InstallationDependenciesResponse: {
      type: "object",
      required: ["dependencies"],
      properties: {
        dependencies: { type: "array", items: ref("Dependency") },
      },
      additionalProperties: false,
    },
  };
}

/** Service Graph v1 support records: export, binding, and grant. */
function serviceGraphSchemas(): Record<string, Record<string, unknown>> {
  const capabilityArray = {
    type: "array",
    minItems: 1,
    items: {
      type: "string",
      pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$",
    },
  };
  return {
    ServiceGraphEndpoint: {
      type: "object",
      properties: {
        name: { type: "string" },
        url: { type: "string" },
        protocol: { type: "string" },
        host: { type: "string" },
        port: { type: "integer", minimum: 1 },
        pathPrefix: { type: "string" },
      },
      additionalProperties: false,
    },
    ServiceGraphAuth: {
      type: "object",
      required: ["scheme"],
      properties: {
        scheme: { enum: ["none", "bearer", "oidc", "signed_webhook"] },
        audience: { type: "array", items: { type: "string" } },
        scopes: { type: "array", items: { type: "string" } },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    ServiceExport: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "producerCapsuleId",
        "name",
        "capabilities",
        "visibility",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        producerCapsuleId: { type: "string" },
        applyRunId: { type: "string" },
        stateVersionId: { type: "string" },
        outputId: { type: "string" },
        outputGeneration: { type: "integer" },
        name: { type: "string" },
        capabilities: capabilityArray,
        visibility: { enum: ["private", "space", "public", "shared"] },
        status: { enum: ["ready", "unavailable", "revoked", "stale"] },
        endpoints: {
          type: "array",
          items: ref("ServiceGraphEndpoint"),
        },
        auth: { type: "array", items: ref("ServiceGraphAuth") },
        labels: { type: "object", additionalProperties: { type: "string" } },
        metadata: jsonObject,
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        revokedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateServiceExportRequest: {
      type: "object",
      required: ["producerCapsuleId", "name", "capabilities"],
      properties: {
        id: { type: "string" },
        producerCapsuleId: { type: "string" },
        applyRunId: { type: "string" },
        stateVersionId: { type: "string" },
        outputId: { type: "string" },
        outputGeneration: { type: "integer" },
        name: { type: "string" },
        capabilities: capabilityArray,
        visibility: { enum: ["private", "space", "public", "shared"] },
        status: { enum: ["ready", "unavailable", "revoked", "stale"] },
        endpoints: {
          type: "array",
          items: ref("ServiceGraphEndpoint"),
        },
        auth: { type: "array", items: ref("ServiceGraphAuth") },
        labels: { type: "object", additionalProperties: { type: "string" } },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    ServiceBindingSelector: {
      type: "object",
      required: ["capabilities"],
      properties: {
        capabilities: capabilityArray,
        producerCapsuleId: { type: "string" },
        serviceExportId: { type: "string" },
        name: { type: "string" },
        labels: { type: "object", additionalProperties: { type: "string" } },
      },
      additionalProperties: false,
    },
    ServiceBindingTarget: {
      type: "object",
      required: ["kind"],
      properties: {
        kind: { enum: ["generated_root", "workload", "runtime"] },
        name: { type: "string" },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    ServiceGrantRequest: {
      type: "object",
      required: ["scopes"],
      properties: {
        scopes: { type: "array", items: { type: "string" } },
        audience: { type: "array", items: { type: "string" } },
        env: { type: "array", items: { type: "string" } },
        ttlSeconds: { type: "integer", minimum: 1 },
        metadata: jsonObject,
      },
      additionalProperties: false,
    },
    ServiceBinding: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "consumerCapsuleId",
        "target",
        "selector",
        "dependencyMode",
        "grantRequest",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        consumerCapsuleId: { type: "string" },
        target: ref("ServiceBindingTarget"),
        selector: ref("ServiceBindingSelector"),
        selectedServiceExportId: { type: "string" },
        dependencySnapshotId: { type: "string" },
        dependencyMode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        grantRequest: ref("ServiceGrantRequest"),
        status: { enum: ["pending", "bound", "blocked", "stale", "revoked"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        revokedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateServiceBindingRequest: {
      type: "object",
      required: ["target", "selector", "grantRequest"],
      properties: {
        id: { type: "string" },
        target: ref("ServiceBindingTarget"),
        selector: ref("ServiceBindingSelector"),
        dependencyMode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        grantRequest: ref("ServiceGrantRequest"),
        dependencySnapshotId: { type: "string" },
      },
      additionalProperties: false,
    },
    ServiceGrant: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "bindingId",
        "serviceExportId",
        "consumerCapsuleId",
        "scopes",
        "audience",
        "material",
        "status",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        bindingId: { type: "string" },
        serviceExportId: { type: "string" },
        consumerCapsuleId: { type: "string" },
        scopes: { type: "array", items: { type: "string" } },
        audience: { type: "array", items: { type: "string" } },
        material: jsonObject,
        status: { enum: ["active", "expired", "revoked", "superseded"] },
        createdAt: { type: "string", format: "date-time" },
        rotatedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        revokedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateServiceGrantRequest: {
      type: "object",
      properties: {
        id: { type: "string" },
        material: jsonObject,
        expiresAt: { type: "string", format: "date-time" },
        rotatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    ServiceExportResponse: {
      type: "object",
      required: ["serviceExport"],
      properties: { serviceExport: ref("ServiceExport") },
      additionalProperties: false,
    },
    ServiceExportsResponse: {
      type: "object",
      required: ["serviceExports"],
      properties: {
        serviceExports: { type: "array", items: ref("ServiceExport") },
      },
      additionalProperties: false,
    },
    ServiceBindingResponse: {
      type: "object",
      required: ["serviceBinding"],
      properties: { serviceBinding: ref("ServiceBinding") },
      additionalProperties: false,
    },
    ServiceBindingsResponse: {
      type: "object",
      required: ["serviceBindings"],
      properties: {
        serviceBindings: { type: "array", items: ref("ServiceBinding") },
      },
      additionalProperties: false,
    },
    ServiceGrantResponse: {
      type: "object",
      required: ["serviceGrant"],
      properties: { serviceGrant: ref("ServiceGrant") },
      additionalProperties: false,
    },
  };
}

/**
 * Space records plus the Installation create/patch/read wrappers and
 * InstallConfig list/read responses that hang off a Space.
 */
function spaceSchemas(): Record<string, Record<string, unknown>> {
  return {
    Space: {
      type: "object",
      required: [
        "id",
        "handle",
        "displayName",
        "type",
        "ownerUserId",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        handle: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,38}$" },
        displayName: { type: "string" },
        type: { enum: ["personal", "organization"] },
        ownerUserId: { type: "string" },
        billingAccountId: { type: "string" },
        billingSettings: ref("BillingSettings"),
        archivedAt: { type: "string", format: "date-time" },
        policy: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateSpaceRequest: {
      type: "object",
      required: ["handle", "displayName", "type", "ownerUserId"],
      properties: {
        handle: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,38}$" },
        displayName: { type: "string" },
        type: { enum: ["personal", "organization"] },
        ownerUserId: { type: "string" },
        billingAccountId: { type: "string" },
      },
      additionalProperties: false,
    },
    SpaceResponse: {
      type: "object",
      required: ["space"],
      properties: { space: ref("Space") },
      additionalProperties: false,
    },
    ListSpacesResponse: {
      type: "object",
      required: ["spaces"],
      properties: {
        spaces: { type: "array", items: ref("Space") },
      },
      additionalProperties: false,
    },
    CreateInstallationRequest: {
      type: "object",
      required: ["name", "environment", "sourceId", "installConfigId"],
      properties: {
        name: { type: "string" },
        environment: { type: "string" },
        sourceId: { type: "string" },
        installConfigId: { type: "string" },
        modulePath: { type: "string" },
        runnerId: { type: "string" },
        outputAllowlist: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["from", "type"],
            properties: {
              from: { type: "string" },
              type: {
                enum: [
                  "string",
                  "url",
                  "hostname",
                  "number",
                  "boolean",
                  "json",
                ],
              },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        vars: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    PatchInstallationRequest: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["active", "stale", "error"] },
      },
      additionalProperties: false,
    },
    InstallationPlanRequest: {
      type: "object",
      properties: {
        runnerId: { type: "string" },
      },
      additionalProperties: false,
    },
    InstallationResponse: {
      type: "object",
      required: ["installation"],
      properties: {
        installation: ref("Installation"),
      },
      additionalProperties: false,
    },
    ListInstallationsResponse: {
      type: "object",
      required: ["installations"],
      properties: {
        installations: { type: "array", items: ref("Installation") },
      },
      additionalProperties: false,
    },
    ListInstallConfigsResponse: {
      type: "object",
      required: ["installConfigs"],
      properties: {
        installConfigs: { type: "array", items: ref("InstallConfig") },
      },
      additionalProperties: false,
    },
    InstallConfigResponse: {
      type: "object",
      required: ["installConfig"],
      properties: {
        installConfig: ref("InstallConfig"),
      },
      additionalProperties: false,
    },
  };
}

/** Run + RunGroup ledger shapes and their log/event/read wrappers. */
function runSchemas(): Record<string, Record<string, unknown>> {
  return {
    Run: {
      type: "object",
      required: ["id", "spaceId", "type", "status", "createdBy", "createdAt"],
      properties: {
        id: { type: "string" },
        runGroupId: { type: "string" },
        spaceId: { type: "string" },
        sourceId: { type: "string" },
        installationId: { type: "string" },
        environment: { type: "string" },
        type: {
          description:
            "Run type. `restore` is a destructive Backup-backed state restore that is created waiting_approval and dispatches only after approval.",
          enum: [
            "source_sync",
            "compatibility_check",
            "plan",
            "apply",
            "destroy_plan",
            "destroy_apply",
            "drift_check",
            "backup",
            "restore",
          ],
        },
        status: {
          enum: [
            "queued",
            "running",
            "waiting_approval",
            "succeeded",
            "failed",
            "cancelled",
            "expired",
          ],
        },
        sourceSnapshotId: { type: "string" },
        dependencySnapshotId: { type: "string" },
        compatibilityReportId: { type: "string" },
        baseStateGeneration: { type: "integer" },
        planDigest: { type: "string" },
        planArtifactKey: { type: "string" },
        applyExpected: { $ref: "#/components/schemas/RunApplyExpectedGuard" },
        summary: { $ref: "#/components/schemas/RunChangeSummary" },
        planResources: {
          type: "array",
          items: ref("RunPlanResource"),
        },
        policyStatus: { enum: ["pass", "warn", "deny"] },
        providerResolutions: {
          type: "array",
          items: ref("ProviderResolution"),
        },
        runEnvironmentEvidenceDigest: { type: "string" },
        redactionProfileId: { type: "string" },
        backupId: { type: "string" },
        restoreStateGeneration: { type: "integer" },
        restoreServiceData: { type: "boolean" },
        restoredStateSnapshotId: { type: "string" },
        restoredFromStateSnapshotId: { type: "string" },
        restoredServiceData: ref("RunServiceDataRestoreResult"),
        errorCode: { type: "string" },
        createdBy: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        startedAt: { type: "string", format: "date-time" },
        finishedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    RunServiceDataRestoreResult: {
      type: "object",
      required: ["status", "objectKey", "digest", "sizeBytes"],
      properties: {
        status: { enum: ["restored"] },
        objectKey: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
        restoredCount: { type: "integer" },
      },
      additionalProperties: false,
    },
    RunApplyExpectedGuard: {
      type: "object",
      required: [
        "reviewedPlanId",
        "runnerId",
        "sourceDigest",
        "variablesDigest",
        "policyDecisionDigest",
        "planDigest",
        "planArtifactDigest",
      ],
      properties: {
        reviewedPlanId: { type: "string" },
        installationId: { type: "string" },
        currentApplyLedgerId: {
          oneOf: [{ type: "string" }, { type: "null" }],
        },
        runnerId: { type: "string" },
        sourceDigest: { type: "string" },
        variablesDigest: { type: "string" },
        policyDecisionDigest: { type: "string" },
        planDigest: { type: "string" },
        planArtifactDigest: { type: "string" },
        sourceCommit: { type: "string" },
        providerLockDigest: { type: "string" },
        resolvedProviderEnvBindingsDigest: { type: "string" },
      },
      additionalProperties: false,
    },
    RunChangeSummary: {
      type: "object",
      properties: {
        add: { type: "integer", minimum: 0 },
        change: { type: "integer", minimum: 0 },
        destroy: { type: "integer", minimum: 0 },
      },
      additionalProperties: false,
    },
    RunPlanResource: {
      type: "object",
      required: ["address", "type", "actions"],
      properties: {
        address: { type: "string" },
        type: { type: "string" },
        actions: {
          type: "array",
          items: { type: "string" },
        },
        scope: {
          type: "object",
          properties: {
            cloudflareAccountId: { type: "string" },
            cloudflareZoneId: { type: "string" },
            awsAccountId: { type: "string" },
            awsRegion: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    RunResponse: {
      type: "object",
      required: ["run"],
      properties: { run: ref("Run") },
      additionalProperties: false,
    },
    RunCostInfo: {
      type: "object",
      required: [
        "runId",
        "billingMode",
        "estimatedCredits",
        "blocked",
        "reasons",
      ],
      properties: {
        runId: { type: "string" },
        billingMode: { enum: ["disabled", "showback", "enforce"] },
        estimatedCredits: { type: "number" },
        availableCredits: { type: "number" },
        reservationStatus: { enum: ["reserved", "insufficient_credits"] },
        creditShortfall: { type: "number" },
        blocked: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    RunCostResponse: {
      type: "object",
      required: ["cost"],
      properties: { cost: ref("RunCostInfo") },
      additionalProperties: false,
    },
    RunLogsResponse: {
      type: "object",
      required: ["diagnostics", "auditEvents"],
      properties: {
        diagnostics: { type: "array", items: ref("RunDiagnostic") },
        auditEvents: { type: "array", items: ref("RunAuditEvent") },
      },
      additionalProperties: false,
    },
    RunEventsResponse: {
      type: "object",
      required: ["auditEvents"],
      properties: {
        auditEvents: { type: "array", items: ref("RunAuditEvent") },
      },
      additionalProperties: false,
    },
    RunGroup: {
      type: "object",
      required: ["id", "spaceId", "type", "status", "graphJson", "createdAt"],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        type: {
          enum: [
            "space_update",
            "space_drift_check",
            "installation_install",
            "installation_update",
            "installation_destroy",
          ],
        },
        status: {
          enum: [
            "queued",
            "running",
            "waiting_approval",
            "succeeded",
            "failed",
            "cancelled",
          ],
        },
        graphJson: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
        finishedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    RunGroupResponse: {
      type: "object",
      required: ["runGroup", "runs"],
      properties: {
        runGroup: ref("RunGroup"),
        runs: { type: "array", items: ref("Run") },
      },
      additionalProperties: false,
    },
  };
}

/** Space-scoped Activity audit-trail shapes. */
function activitySchemas(): Record<string, Record<string, unknown>> {
  return {
    ActivityEvent: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "action",
        "targetType",
        "targetId",
        "metadata",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        actorId: { type: "string" },
        action: { type: "string" },
        targetType: { type: "string" },
        targetId: { type: "string" },
        runId: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    ListActivityResponse: {
      type: "object",
      required: ["events"],
      properties: {
        events: { type: "array", items: ref("ActivityEvent") },
      },
      additionalProperties: false,
    },
  };
}

/**
 * Backup record / artifact-pointer shapes, plus the co-located PatchSpace and
 * Deployment read wrappers.
 */
function backupSchemas(): Record<string, Record<string, unknown>> {
  return {
    BackupArtifactPointer: {
      type: "object",
      required: ["objectKey", "digest", "sizeBytes"],
      properties: {
        objectKey: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
      },
      additionalProperties: false,
    },
    ServiceDataBackupPointer: {
      type: "object",
      required: [
        "objectKey",
        "digest",
        "sizeBytes",
        "exportedCount",
        "unsupportedCount",
        "missingCount",
      ],
      properties: {
        objectKey: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
        exportedCount: { type: "integer" },
        unsupportedCount: { type: "integer" },
        missingCount: { type: "integer" },
      },
      additionalProperties: false,
    },
    BackupRestoreTarget: {
      type: "object",
      required: [
        "installationId",
        "environment",
        "stateGeneration",
        "stateSnapshotId",
      ],
      properties: {
        installationId: { type: "string" },
        environment: { type: "string" },
        stateGeneration: { type: "integer" },
        stateSnapshotId: { type: "string" },
      },
      additionalProperties: false,
    },
    BackupRecord: {
      type: "object",
      required: [
        "id",
        "spaceId",
        "objectKey",
        "digest",
        "sizeBytes",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        spaceId: { type: "string" },
        installationId: { type: "string" },
        environment: { type: "string" },
        restoreTarget: ref("BackupRestoreTarget"),
        objectKey: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
        stateArchive: ref("BackupArtifactPointer"),
        artifactsManifest: ref("BackupArtifactPointer"),
        serviceData: ref("ServiceDataBackupPointer"),
        createdByRunId: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateBackupResponse: {
      type: "object",
      required: ["backup"],
      properties: { backup: ref("BackupRecord") },
      additionalProperties: false,
    },
    CreateRestoreRequest: {
      type: "object",
      required: ["stateGeneration"],
      properties: {
        installationId: { type: "string" },
        environment: { type: "string" },
        stateGeneration: { type: "integer", minimum: 0 },
        expectedBackupDigest: { type: "string" },
        restoreServiceData: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CreateRestoreResponse: {
      type: "object",
      required: ["run"],
      properties: { run: ref("Run") },
      additionalProperties: false,
    },
    ListBackupsResponse: {
      type: "object",
      required: ["backups"],
      properties: {
        backups: { type: "array", items: ref("BackupRecord") },
      },
      additionalProperties: false,
    },
    PatchSpaceRequest: {
      type: "object",
      properties: {
        displayName: { type: "string" },
        policy: { type: "object", additionalProperties: true },
        archived: { type: "boolean" },
      },
      additionalProperties: false,
      minProperties: 1,
    },
    DeploymentResponse: {
      type: "object",
      required: ["deployment"],
      properties: { deployment: ref("Deployment") },
      additionalProperties: false,
    },
  };
}

/**
 * Cross-Space OutputShare shapes plus the co-located ApproveRun request body.
 */
function outputShareSchemas(): Record<string, Record<string, unknown>> {
  return {
    OutputShareEntry: {
      type: "object",
      required: ["name", "sensitive"],
      properties: {
        name: { type: "string" },
        alias: { type: "string" },
        type: { type: "string" },
        sensitive: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CreateOutputShareEntry: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        alias: { type: "string" },
        sensitive: { type: "boolean" },
      },
      additionalProperties: false,
    },
    SensitiveOutputSharePolicy: {
      type: "object",
      required: ["allow"],
      properties: {
        allow: { type: "boolean" },
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
    OutputShare: {
      type: "object",
      required: [
        "id",
        "fromSpaceId",
        "toSpaceId",
        "producerInstallationId",
        "outputs",
        "status",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        fromSpaceId: { type: "string" },
        toSpaceId: { type: "string" },
        producerInstallationId: { type: "string" },
        outputs: { type: "array", items: ref("OutputShareEntry") },
        status: { enum: ["pending", "active", "revoked"] },
        createdAt: { type: "string", format: "date-time" },
        acceptedAt: { type: "string", format: "date-time" },
        revokedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateOutputShareRequest: {
      type: "object",
      required: [
        "fromSpaceId",
        "toSpaceId",
        "producerInstallationId",
        "outputs",
      ],
      properties: {
        fromSpaceId: { type: "string" },
        toSpaceId: { type: "string" },
        producerInstallationId: { type: "string" },
        outputs: { type: "array", items: ref("CreateOutputShareEntry") },
        sensitivePolicy: ref("SensitiveOutputSharePolicy"),
      },
      additionalProperties: false,
    },
    OutputShareResponse: {
      type: "object",
      required: ["share"],
      properties: { share: ref("OutputShare") },
      additionalProperties: false,
    },
    ListOutputSharesResponse: {
      type: "object",
      required: ["shares"],
      properties: {
        shares: { type: "array", items: ref("OutputShare") },
      },
      additionalProperties: false,
    },
    ApproveRunRequest: {
      type: "object",
      properties: {
        reason: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/**
 * Runtime-agent enrollment / lease / heartbeat / report shapes and the gateway
 * manifest contract for external runners outside the configured Takosumi runner policy.
 */
function runtimeAgentSchemas(): Record<string, Record<string, unknown>> {
  return {
    RuntimeAgentCapabilities: {
      type: "object",
      required: ["providers"],
      properties: {
        providers: { type: "array", items: { type: "string" } },
        maxConcurrentLeases: { type: "integer", minimum: 1 },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    RuntimeAgentRecord: {
      type: "object",
      required: [
        "id",
        "provider",
        "capabilities",
        "status",
        "registeredAt",
        "lastHeartbeatAt",
        "metadata",
      ],
      properties: {
        id: { type: "string" },
        provider: { type: "string" },
        endpoint: { type: "string" },
        capabilities: ref("RuntimeAgentCapabilities"),
        status: {
          enum: ["registered", "ready", "draining", "revoked", "expired"],
        },
        registeredAt: { type: "string", format: "date-time" },
        lastHeartbeatAt: { type: "string", format: "date-time" },
        drainRequestedAt: { type: "string", format: "date-time" },
        revokedAt: { type: "string", format: "date-time" },
        expiredAt: { type: "string", format: "date-time" },
        hostKeyDigest: { type: "string" },
        metadata: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    RuntimeAgentWorkItem: {
      type: "object",
      required: [
        "id",
        "kind",
        "status",
        "payload",
        "priority",
        "queuedAt",
        "attempts",
        "metadata",
      ],
      properties: {
        id: { type: "string" },
        kind: { type: "string" },
        status: {
          enum: ["queued", "leased", "completed", "failed", "cancelled"],
        },
        payload: { type: "object", additionalProperties: true },
        provider: { type: "string" },
        priority: { type: "integer" },
        queuedAt: { type: "string", format: "date-time" },
        leasedByAgentId: { type: "string" },
        leaseId: { type: "string" },
        leaseExpiresAt: { type: "string", format: "date-time" },
        completedAt: { type: "string", format: "date-time" },
        failedAt: { type: "string", format: "date-time" },
        failureReason: { type: "string" },
        attempts: { type: "integer", minimum: 0 },
        metadata: { type: "object", additionalProperties: true },
        idempotencyKey: { type: "string" },
        lastProgress: { type: "object", additionalProperties: true },
        lastProgressAt: { type: "string", format: "date-time" },
        result: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    RuntimeAgentWorkLease: {
      type: "object",
      required: [
        "id",
        "workId",
        "agentId",
        "leasedAt",
        "expiresAt",
        "renewAfter",
        "work",
      ],
      properties: {
        id: { type: "string" },
        workId: { type: "string" },
        agentId: { type: "string" },
        leasedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        renewAfter: { type: "string", format: "date-time" },
        work: ref("RuntimeAgentWorkItem"),
      },
      additionalProperties: false,
    },
    RuntimeAgentEnrollRequest: {
      type: "object",
      required: ["provider"],
      properties: {
        agentId: { type: "string" },
        provider: { type: "string" },
        endpoint: { type: "string" },
        capabilities: ref("RuntimeAgentCapabilities"),
        metadata: { type: "object", additionalProperties: true },
        heartbeatAt: { type: "string", format: "date-time" },
        enrolledAt: { type: "string", format: "date-time" },
        hostKeyDigest: { type: "string" },
        spaceId: { type: "string" },
        groupId: { type: "string" },
      },
      additionalProperties: false,
    },
    RuntimeAgentHeartbeatRequest: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        heartbeatAt: { type: "string", format: "date-time" },
        status: { enum: ["ready", "draining"] },
        inFlightLeases: { type: "integer", minimum: 0 },
        ttlMs: { type: "integer", minimum: 1 },
        metadata: { type: "object", additionalProperties: true },
        spaceId: { type: "string" },
        groupId: { type: "string" },
      },
      additionalProperties: false,
    },
    RuntimeAgentLeaseRequest: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        leaseTtlMs: { type: "integer", minimum: 1 },
        now: { type: "string", format: "date-time" },
        spaceId: { type: "string" },
        groupId: { type: "string" },
      },
      additionalProperties: false,
    },
    RuntimeAgentReportRequest: {
      oneOf: [
        {
          type: "object",
          required: ["leaseId", "status"],
          properties: {
            agentId: { type: "string" },
            leaseId: { type: "string" },
            status: { const: "progress" },
            reportedAt: { type: "string", format: "date-time" },
            progress: { type: "object", additionalProperties: true },
            extendUntil: { type: "string", format: "date-time" },
            spaceId: { type: "string" },
            groupId: { type: "string" },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["leaseId", "status"],
          properties: {
            agentId: { type: "string" },
            leaseId: { type: "string" },
            status: { const: "completed" },
            reportedAt: { type: "string", format: "date-time" },
            completedAt: { type: "string", format: "date-time" },
            result: { type: "object", additionalProperties: true },
            spaceId: { type: "string" },
            groupId: { type: "string" },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["leaseId", "status"],
          properties: {
            agentId: { type: "string" },
            leaseId: { type: "string" },
            status: { const: "failed" },
            reportedAt: { type: "string", format: "date-time" },
            reason: { type: "string" },
            retry: { type: "boolean" },
            failedAt: { type: "string", format: "date-time" },
            result: { type: "object", additionalProperties: true },
            spaceId: { type: "string" },
            groupId: { type: "string" },
          },
          additionalProperties: false,
        },
      ],
    },
    RuntimeAgentDrainRequest: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        drainRequestedAt: { type: "string", format: "date-time" },
        reason: { type: "string" },
        spaceId: { type: "string" },
        groupId: { type: "string" },
      },
      additionalProperties: false,
    },
    RuntimeAgentResponse: {
      type: "object",
      required: ["agent"],
      properties: {
        agent: ref("RuntimeAgentRecord"),
        renewAfterMs: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    RuntimeAgentLeaseResponse: {
      type: "object",
      required: ["lease"],
      properties: {
        lease: {
          anyOf: [ref("RuntimeAgentWorkLease"), { type: "null" }],
        },
      },
      additionalProperties: false,
    },
    RuntimeAgentWorkResponse: {
      type: "object",
      required: ["work"],
      properties: { work: ref("RuntimeAgentWorkItem") },
      additionalProperties: false,
    },
    GatewayManifest: {
      type: "object",
      required: [
        "gatewayUrl",
        "issuer",
        "agentId",
        "issuedAt",
        "expiresAt",
        "allowedProviderKinds",
        "pubkey",
        "pubkeyFingerprint",
      ],
      properties: {
        gatewayUrl: { type: "string" },
        issuer: { type: "string" },
        agentId: { type: "string" },
        issuedAt: { type: "string", format: "date-time" },
        expiresAt: { type: "string", format: "date-time" },
        allowedProviderKinds: {
          type: "array",
          items: { type: "string" },
        },
        pubkey: { type: "string" },
        pubkeyFingerprint: { type: "string" },
        tlsPubkeySha256: { type: "string" },
      },
      additionalProperties: false,
    },
    GatewayManifestResponse: {
      type: "object",
      required: ["manifest", "signature"],
      properties: {
        manifest: ref("GatewayManifest"),
        signature: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/** Canonical RFC-7807-ish error envelope referenced by every error response. */
function errorSchemas(): Record<string, Record<string, unknown>> {
  return {
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
