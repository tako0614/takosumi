import { PUBLIC_PROVIDER_RESOLUTION_STATUSES } from "takosumi-contract/provider-resolution";
import { SOURCE_GIT_CONNECTION_KINDS } from "takosumi-contract/sources";
import {
  type ApiEndpoint,
  endpointTag,
  mountedEndpoints,
  mountedOpenApiTags,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "./route_families.ts";

export type OpenApiHttpMethod =
  "delete" | "get" | "head" | "patch" | "post" | "put";

/**
 * Canonical version emitted in `info.version`. Kept in lockstep with the
 * `@takosjp/takosumi` package version declared in `package.json`.
 * Bump this when the service publishes a new minor/major release.
 */
export const TAKOSUMI_OPENAPI_VERSION = "1.0.0" as const;

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
    alternateOkStatuses: endpoint.openapi.alternateOkStatuses,
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
    | "inventory-bearer"
    | "deploy-control-token"
    | "internal-service"
    | "metrics-scrape";
  readonly okSchema: string;
  readonly okStatus?: "200" | "201" | "202" | "204";
  readonly alternateOkStatuses?: readonly ("200" | "201" | "202")[];
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
      ...Object.fromEntries(
        (input.alternateOkStatuses ?? []).map((status) => [
          status,
          jsonResponse(input.okSchema),
        ]),
      ),
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
      ...(input.tag === "resource-shape"
        ? {
            "400": errorResponse(),
            "403": errorResponse(),
            "404": errorResponse(),
            "409": errorResponse(),
            "502": errorResponse(),
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
    | "inventory-bearer"
    | "deploy-control-token"
    | "internal-service"
    | "metrics-scrape",
): readonly Record<string, readonly string[]>[] {
  if (auth === "inventory-bearer") return [{ inventoryBearer: [] }];
  if (auth === "deploy-control-token") return [{ deployControlBearer: [] }];
  if (auth === "metrics-scrape") return [{ metricsBearer: [] }];
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
    ...policySchemas(),
    ...interfaceSchemas(),
    ...resourceShapeSchemas(),
    ...runnerSchemas(),
    ...capsuleAndInstallConfigSchemas(),
    ...capsuleSchemas(),
    ...providerConnectionAndRecipeSchemas(),
    ...providerResolutionSchemas(),
    ...outputSchemas(),
    ...connectionSchemas(),
    ...sourceSchemas(),
    ...responseSchemas(),
    ...billingSchemas(),
    ...dependencySchemas(),
    ...workspaceProjectAndCapsuleRequestSchemas(),
    ...runSchemas(),
    ...activitySchemas(),
    ...backupSchemas(),
    ...outputShareSchemas(),
    ...errorSchemas(),
  };
}

/** Provider-neutral plan policy and scope-selector contracts. */
function policySchemas(): Record<string, Record<string, unknown>> {
  const scopeScalar = {
    oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
  };
  return {
    ScopeBoundaryDimension: {
      type: "object",
      required: ["selector", "allowedValues"],
      properties: {
        selector: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          pattern: "^/",
          description:
            "RFC 6901 JSON Pointer relative to the resource before/after value.",
        },
        allowedValues: {
          type: "array",
          maxItems: 256,
          items: scopeScalar,
        },
      },
      additionalProperties: false,
    },
    ScopeBoundaryRule: {
      type: "object",
      required: ["resourceTypePattern", "dimensions"],
      properties: {
        resourceTypePattern: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^[A-Za-z0-9_*?.:-]+$",
          description: "OpenTofu resource type glob supporting * and ?.",
        },
        dimensions: {
          type: "object",
          maxProperties: 32,
          additionalProperties: ref("ScopeBoundaryDimension"),
        },
      },
      additionalProperties: false,
    },
    ScopeBoundaryPolicy: {
      type: "object",
      required: ["rules"],
      properties: {
        mode: { enum: ["permissive", "strict"] },
        rules: {
          type: "array",
          maxItems: 64,
          items: ref("ScopeBoundaryRule"),
        },
      },
      additionalProperties: false,
    },
    PolicyConfig: {
      type: "object",
      properties: {
        allowedProviders: { type: "array", items: { type: "string" } },
        allowedResourceTypes: {
          type: "array",
          items: { type: "string" },
        },
        allowedDataSourceTypes: {
          type: "array",
          items: { type: "string" },
        },
        allowedProvisionerTypes: {
          type: "array",
          items: { type: "string" },
        },
        destructiveChanges: {
          type: "object",
          required: ["requireExplicitConfirmation"],
          properties: { requireExplicitConfirmation: { type: "boolean" } },
          additionalProperties: false,
        },
        providerLockfile: {
          type: "object",
          required: ["requireDigest"],
          properties: { requireDigest: { type: "boolean" } },
          additionalProperties: false,
        },
        providerInstallation: {
          type: "object",
          required: ["requireMirror"],
          properties: { requireMirror: { type: "boolean" } },
          additionalProperties: false,
        },
        providerCredentials: {
          type: "object",
          properties: {
            requireTemporary: { type: "boolean" },
            requireTtlEnforced: { type: "boolean" },
          },
          additionalProperties: false,
        },
        lifecycleActions: {
          type: "object",
          required: ["allowedExecutors", "allowedRunnerCapabilities"],
          properties: {
            allowedExecutors: {
              type: "array",
              items: { enum: ["runner", "operator"] },
            },
            allowedRunnerCapabilities: {
              type: "array",
              items: { type: "string" },
            },
            allowProviderCredentials: { type: "boolean" },
          },
          additionalProperties: false,
        },
        scopeBoundary: ref("ScopeBoundaryPolicy"),
        quota: {
          type: "object",
          additionalProperties: { type: "number", minimum: 0 },
        },
      },
      additionalProperties: false,
    },
  };
}

/** Public Resource Shape, TargetPool, and SpacePolicy response contracts. */
function resourceShapeSchemas(): Record<string, Record<string, unknown>> {
  const timestamp = { type: "string", format: "date-time" };
  const stateAdoptionCandidateProperties = {
    resourceId: { type: "string", minLength: 1 },
    resourceUpdatedAt: timestamp,
    expectedLegacyCapsuleName: { type: "string", minLength: 1 },
    capsuleId: { type: "string", minLength: 1 },
    stateVersionId: { type: "string", minLength: 1 },
    stateGeneration: { type: "integer", minimum: 0 },
    stateRef: { type: "string", minLength: 1 },
    stateDigest: { type: "string", minLength: 1 },
  };
  const stateAdoptionCandidateRequired = Object.keys(
    stateAdoptionCandidateProperties,
  );
  const nativeResource = {
    type: "object",
    required: ["type", "id"],
    properties: {
      type: { type: "string", minLength: 1 },
      id: { type: "string", minLength: 1 },
    },
    additionalProperties: false,
  };
  const resourceShape = {
    type: "object",
    required: ["apiVersion", "kind", "metadata", "spec"],
    properties: {
      id: { type: "string" },
      apiVersion: { const: "takosumi.dev/v1alpha1" },
      kind: {
        type: "string",
        pattern: "^[A-Za-z][A-Za-z0-9._-]{0,127}$",
        examples: [
          "EdgeWorker",
          "ObjectBucket",
          "KVStore",
          "Queue",
          "SQLDatabase",
          "ContainerService",
        ],
        description:
          "Bundled kinds have typed provider schemas. Additional tokens require an explicitly installed host schema and adapter/plugin.",
      },
      metadata: {
        type: "object",
        required: ["name", "space", "managedBy"],
        properties: {
          name: { type: "string", minLength: 1 },
          space: { type: "string", minLength: 1 },
          project: { type: "string" },
          environment: { type: "string" },
          owner: { type: "string" },
          managedBy: { type: "string" },
          labels: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        additionalProperties: false,
      },
      spec: jsonObject,
      status: jsonObject,
    },
    additionalProperties: false,
  };
  const targetPoolRecord = {
    type: "object",
    required: ["id", "spaceId", "name", "spec", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      spaceId: { type: "string" },
      name: { type: "string" },
      spec: jsonObject,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    additionalProperties: false,
  };
  const spacePolicyRecord = {
    type: "object",
    required: ["id", "spaceId", "name", "spec", "createdAt", "updatedAt"],
    properties: {
      id: { type: "string" },
      spaceId: { type: "string" },
      name: { type: "string" },
      spec: jsonObject,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    additionalProperties: false,
  };
  return {
    ResourceShapeResponse: resourceShape,
    ResourceDeploymentReview: {
      type: "object",
      required: ["planDigest"],
      properties: {
        planDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        quoteId: { type: "string", minLength: 1 },
        quoteDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      },
      additionalProperties: false,
    },
    ResourceDeploymentQuote: {
      type: "object",
      required: [
        "quoteId",
        "quoteDigest",
        "planDigest",
        "specDigest",
        "resolutionFingerprint",
        "ratingStatus",
        "currency",
        "lineItems",
        "estimatedTotalUsdMicros",
        "expiresAt",
      ],
      properties: {
        quoteId: { type: "string", minLength: 1 },
        quoteDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        planDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        specDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        resolutionFingerprint: { type: "string", minLength: 1 },
        ratingStatus: { enum: ["rated", "unrated"] },
        currency: { type: "string", pattern: "^[A-Z]{3}$" },
        catalogId: { type: "string", minLength: 1 },
        catalogVersion: { type: "string", minLength: 1 },
        offeringId: { type: "string", minLength: 1 },
        offeringVersion: { type: "string", minLength: 1 },
        region: { type: "string", minLength: 1 },
        lineItems: {
          type: "array",
          items: {
            type: "object",
            required: [
              "sku",
              "skuVersion",
              "chargeKind",
              "unit",
              "quantity",
              "unitPriceUsdMicros",
              "amountUsdMicros",
            ],
            properties: {
              sku: { type: "string", minLength: 1 },
              skuVersion: { type: "string", minLength: 1 },
              description: { type: "string" },
              taxTreatment: { type: "string", minLength: 1 },
              invoiceDescription: { type: "string", minLength: 1 },
              chargeKind: {
                enum: ["one_time", "recurring", "usage_estimate"],
              },
              meterId: { type: "string", minLength: 1 },
              meterIdPrefix: { type: "string", minLength: 1 },
              meterKind: { type: "string", minLength: 1 },
              unit: { type: "string", minLength: 1 },
              billingUnit: { type: "integer", minimum: 1 },
              quantity: { type: "number", minimum: 0 },
              unitPriceUsdMicros: { type: "integer", minimum: 0 },
              minimumChargeUsdMicros: { type: "integer", minimum: 0 },
              amountUsdMicros: { type: "integer", minimum: 0 },
            },
            additionalProperties: false,
          },
        },
        estimatedTotalUsdMicros: { type: "integer", minimum: 0 },
        expiresAt: timestamp,
      },
      additionalProperties: false,
    },
    ResourceShapeApplyRequest: {
      type: "object",
      required: ["metadata", "spec", "review"],
      properties: {
        apiVersion: { const: "takosumi.dev/v1alpha1" },
        kind: resourceShape.properties.kind,
        metadata: {
          type: "object",
          required: ["space"],
          properties: resourceShape.properties.metadata.properties,
          additionalProperties: false,
        },
        spec: jsonObject,
        targetPoolName: { type: "string", minLength: 1 },
        spacePolicyName: { type: "string", minLength: 1 },
        review: ref("ResourceDeploymentReview"),
      },
      additionalProperties: false,
    },
    ResourceShapeImportRequest: {
      type: "object",
      required: ["metadata", "spec", "nativeId"],
      properties: {
        apiVersion: { const: "takosumi.dev/v1alpha1" },
        kind: resourceShape.properties.kind,
        metadata: {
          type: "object",
          required: ["space"],
          properties: resourceShape.properties.metadata.properties,
          additionalProperties: false,
        },
        spec: jsonObject,
        nativeId: { type: "string", minLength: 1, maxLength: 2048 },
        targetPoolName: { type: "string", minLength: 1 },
        spacePolicyName: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    ResourceShapeImportResponse: {
      ...resourceShape,
      required: [...resourceShape.required, "import"],
      properties: {
        ...resourceShape.properties,
        import: {
          type: "object",
          required: ["summary"],
          properties: {
            summary: { type: "string", minLength: 1 },
            runId: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
      },
    },
    ResourceEvent: {
      type: "object",
      required: [
        "id",
        "space",
        "resourceId",
        "action",
        "metadata",
        "createdAt",
      ],
      properties: {
        id: { type: "string", minLength: 1 },
        space: { type: "string", minLength: 1 },
        resourceId: { type: "string", minLength: 1 },
        action: { type: "string", minLength: 1 },
        actorId: { type: "string", minLength: 1 },
        runId: { type: "string", minLength: 1 },
        metadata: jsonObject,
        createdAt: timestamp,
      },
      additionalProperties: false,
    },
    ListResourceEventsResponse: {
      type: "object",
      required: ["events"],
      properties: {
        events: { type: "array", items: ref("ResourceEvent") },
        nextCursor: { type: "string" },
      },
      additionalProperties: false,
    },
    ListResourceShapesResponse: {
      type: "object",
      required: ["resources"],
      properties: {
        resources: { type: "array", items: ref("ResourceShapeResponse") },
        nextCursor: { type: "string" },
      },
      additionalProperties: false,
    },
    ResourceShapePreviewResponse: {
      type: "object",
      required: [
        "resource",
        "planDigest",
        "specDigest",
        "resolutionFingerprint",
        "selectedImplementation",
        "selectedTarget",
        "portability",
        "nativeResourcePlan",
        "riskNotes",
        "summary",
      ],
      properties: {
        resource: ref("ResourceShapeResponse"),
        planDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        specDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        resolutionFingerprint: { type: "string", minLength: 1 },
        quote: ref("ResourceDeploymentQuote"),
        selectedImplementation: { type: "string" },
        selectedTarget: { type: "string" },
        portability: { type: "string" },
        nativeResourcePlan: { type: "array", items: nativeResource },
        riskNotes: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
      additionalProperties: false,
    },
    LegacyResourceStateAdoptionCandidate: {
      type: "object",
      required: stateAdoptionCandidateRequired,
      properties: stateAdoptionCandidateProperties,
      additionalProperties: false,
    },
    LegacyResourceStateAdoptionIssue: {
      type: "object",
      required: ["resourceId", "expectedLegacyCapsuleName", "reason", "detail"],
      properties: {
        resourceId: { type: "string", minLength: 1 },
        expectedLegacyCapsuleName: { type: "string", minLength: 1 },
        reason: {
          enum: [
            "resource_state_already_owned",
            "adoption_already_pending",
            "legacy_capsule_not_found",
            "legacy_capsule_ambiguous",
            "legacy_capsule_destroyed",
            "legacy_state_version_missing",
            "legacy_state_pointer_invalid",
          ],
        },
        capsuleIds: { type: "array", items: { type: "string" } },
        detail: { type: "string" },
      },
      additionalProperties: false,
    },
    LegacyResourceStateAdoptionReportResponse: {
      type: "object",
      required: ["workspaceId", "candidates", "issues"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        candidates: {
          type: "array",
          items: ref("LegacyResourceStateAdoptionCandidate"),
        },
        issues: {
          type: "array",
          items: ref("LegacyResourceStateAdoptionIssue"),
        },
      },
      additionalProperties: false,
    },
    ConfirmLegacyResourceStateAdoptionRequest: {
      type: "object",
      required: stateAdoptionCandidateRequired,
      properties: stateAdoptionCandidateProperties,
      additionalProperties: false,
    },
    ResourceShapeStateAdoptionDescriptor: {
      type: "object",
      required: [
        "kind",
        "sourceWorkspaceId",
        "sourceCapsuleId",
        "sourceEnvironment",
        "sourceStateVersionId",
        "stateGeneration",
        "stateRef",
        "stateDigest",
        "confirmedBy",
        "confirmedAt",
      ],
      properties: {
        kind: { const: "legacy_backing_capsule_state" },
        sourceWorkspaceId: { type: "string", minLength: 1 },
        sourceCapsuleId: { type: "string", minLength: 1 },
        sourceEnvironment: { type: "string", minLength: 1 },
        sourceStateVersionId: { type: "string", minLength: 1 },
        stateGeneration: { type: "integer", minimum: 0 },
        stateRef: { type: "string", minLength: 1 },
        stateDigest: { type: "string", minLength: 1 },
        confirmedBy: { type: "string", minLength: 1 },
        confirmedAt: timestamp,
      },
      additionalProperties: false,
    },
    ConfirmLegacyResourceStateAdoptionResponse: {
      type: "object",
      required: ["descriptor"],
      properties: {
        descriptor: ref("ResourceShapeStateAdoptionDescriptor"),
      },
      additionalProperties: false,
    },
    TargetPoolResponse: targetPoolRecord,
    ListTargetPoolsResponse: {
      type: "object",
      required: ["targetPools"],
      properties: {
        targetPools: { type: "array", items: ref("TargetPoolResponse") },
        nextCursor: { type: "string" },
      },
      additionalProperties: false,
    },
    SpacePolicyResponse: spacePolicyRecord,
    ListSpacePoliciesResponse: {
      type: "object",
      required: ["spacePolicies"],
      properties: {
        spacePolicies: {
          type: "array",
          items: ref("SpacePolicyResponse"),
        },
        nextCursor: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

/** Shared runtime Interface and InterfaceBinding HTTP contract. */
function interfaceSchemas(): Record<string, Record<string, unknown>> {
  const labels = {
    type: "object",
    maxProperties: 64,
    additionalProperties: { type: "string" },
  };
  const interfaceCondition = {
    type: "object",
    required: ["type", "status"],
    properties: {
      type: { type: "string" },
      status: { enum: ["true", "false", "unknown"] },
      reason: { type: "string" },
      message: { type: "string" },
      observedGeneration: { type: "integer", minimum: 0 },
      lastTransitionAt: { type: "string", format: "date-time" },
    },
    additionalProperties: false,
  };
  return {
    InterfaceOwnerRef: {
      type: "object",
      required: ["kind", "id"],
      properties: {
        kind: { enum: ["Workspace", "Capsule", "Resource"] },
        id: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    InterfaceLiteralInput: {
      type: "object",
      required: ["source", "value"],
      properties: { source: { const: "literal" }, value: {} },
      additionalProperties: false,
    },
    InterfaceCapsuleOutputInput: {
      type: "object",
      required: ["source", "capsuleId", "outputName"],
      properties: {
        source: { const: "capsule_output" },
        capsuleId: { type: "string", minLength: 1 },
        outputName: { type: "string", minLength: 1 },
        pointer: { type: "string", pattern: "^(|/)" },
      },
      additionalProperties: false,
    },
    InterfaceResourceOutputInput: {
      type: "object",
      required: ["source", "resourceId", "outputName"],
      properties: {
        source: { const: "resource_output" },
        resourceId: { type: "string", minLength: 1 },
        outputName: { type: "string", minLength: 1 },
        pointer: { type: "string", pattern: "^(|/)" },
      },
      additionalProperties: false,
    },
    InterfaceInput: {
      oneOf: [
        ref("InterfaceLiteralInput"),
        ref("InterfaceCapsuleOutputInput"),
        ref("InterfaceResourceOutputInput"),
      ],
    },
    CapsuleInterfaceBlueprintCapsuleOutputInput: {
      type: "object",
      required: ["source", "outputName"],
      properties: {
        source: { const: "capsule_output" },
        outputName: { type: "string", minLength: 1 },
        pointer: { type: "string", pattern: "^(|/)" },
      },
      additionalProperties: false,
    },
    CapsuleInterfaceBlueprintInput: {
      oneOf: [
        ref("InterfaceLiteralInput"),
        ref("CapsuleInterfaceBlueprintCapsuleOutputInput"),
        ref("InterfaceResourceOutputInput"),
      ],
    },
    CapsuleInterfaceBlueprintSpec: {
      type: "object",
      required: ["type", "version", "document", "access"],
      properties: {
        type: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^\\S+$",
        },
        version: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^\\S+$",
        },
        document: {},
        inputs: {
          type: "object",
          maxProperties: 64,
          additionalProperties: ref("CapsuleInterfaceBlueprintInput"),
        },
        access: ref("InterfaceAccess"),
      },
      additionalProperties: false,
    },
    CapsuleInterfaceBindingProposal: {
      type: "object",
      required: ["key", "permissions", "delivery"],
      properties: {
        key: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^\\S+$",
        },
        subjectRef: ref("InterfaceSubjectRef"),
        subject: {
          type: "object",
          required: ["source"],
          properties: {
            source: { enum: ["installing_principal"] },
          },
          additionalProperties: false,
        },
        permissions: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 256 },
        },
        delivery: ref("InterfaceBindingDelivery"),
      },
      oneOf: [{ required: ["subjectRef"] }, { required: ["subject"] }],
      additionalProperties: false,
    },
    CapsuleInterfaceBlueprint: {
      type: "object",
      required: ["key", "name", "spec"],
      properties: {
        key: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          pattern: "^\\S+$",
        },
        name: {
          type: "string",
          pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,127}$",
        },
        labels,
        spec: ref("CapsuleInterfaceBlueprintSpec"),
        bindings: {
          type: "array",
          maxItems: 64,
          items: ref("CapsuleInterfaceBindingProposal"),
        },
      },
      additionalProperties: false,
    },
    InterfaceAccess: {
      type: "object",
      required: ["visibility"],
      properties: {
        visibility: { enum: ["private", "workspace", "public"] },
        policyRef: { type: "string", minLength: 1 },
        resourceUriInput: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    InterfaceSpec: {
      type: "object",
      required: ["type", "version", "document", "access"],
      properties: {
        type: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        document: {},
        inputs: {
          type: "object",
          maxProperties: 64,
          additionalProperties: ref("InterfaceInput"),
        },
        access: ref("InterfaceAccess"),
      },
      additionalProperties: false,
    },
    InterfaceMetadata: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "name",
        "ownerRef",
        "generation",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        name: { type: "string" },
        ownerRef: ref("InterfaceOwnerRef"),
        generation: { type: "integer", minimum: 1 },
        labels,
        materializedFrom: {
          type: "object",
          required: ["source", "key"],
          properties: {
            source: { const: "capsule_blueprint" },
            key: { type: "string", minLength: 1 },
          },
          additionalProperties: false,
        },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    InterfaceStatus: {
      type: "object",
      required: ["phase", "observedGeneration", "resolvedRevision"],
      properties: {
        phase: {
          enum: [
            "Pending",
            "Resolved",
            "NotReady",
            "Unknown",
            "Terminating",
            "Retired",
          ],
        },
        observedGeneration: { type: "integer", minimum: 0 },
        resolvedRevision: { type: "integer", minimum: 0 },
        resolvedInputs: { type: "object", additionalProperties: true },
        provenance: { type: "object", additionalProperties: true },
        conditions: { type: "array", items: interfaceCondition },
      },
      additionalProperties: false,
    },
    Interface: {
      type: "object",
      required: ["apiVersion", "kind", "metadata", "spec", "status"],
      properties: {
        apiVersion: { const: "takosumi.dev/v1alpha1" },
        kind: { const: "Interface" },
        metadata: ref("InterfaceMetadata"),
        spec: ref("InterfaceSpec"),
        status: ref("InterfaceStatus"),
      },
      additionalProperties: false,
    },
    CreateInterfaceRequest: {
      type: "object",
      required: ["workspaceId", "name", "ownerRef", "spec"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        name: { type: "string", minLength: 1 },
        ownerRef: ref("InterfaceOwnerRef"),
        labels,
        spec: ref("InterfaceSpec"),
      },
      additionalProperties: false,
    },
    UpdateInterfaceRequest: {
      type: "object",
      minProperties: 1,
      properties: {
        name: { type: "string", minLength: 1 },
        labels,
        spec: ref("InterfaceSpec"),
      },
      additionalProperties: false,
    },
    ListInterfacesResponse: {
      type: "object",
      required: ["interfaces"],
      properties: {
        interfaces: { type: "array", items: ref("Interface") },
      },
      additionalProperties: false,
    },
    InterfaceSubjectRef: {
      type: "object",
      required: ["kind", "id"],
      properties: {
        kind: {
          enum: ["Principal", "ServiceAccount", "Capsule", "Resource"],
        },
        id: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    InterfaceBindingDelivery: {
      type: "object",
      required: ["type"],
      properties: {
        type: { type: "string", minLength: 1 },
        credentialRef: {
          type: "string",
          minLength: 3,
          maxLength: 256,
          pattern: "^(secret|credential)[/:][A-Za-z0-9][A-Za-z0-9._:/-]*$",
        },
        options: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    InterfaceBindingSpec: {
      type: "object",
      required: ["interfaceId", "subjectRef", "permissions", "delivery"],
      properties: {
        interfaceId: { type: "string" },
        subjectRef: ref("InterfaceSubjectRef"),
        permissions: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string" },
        },
        delivery: ref("InterfaceBindingDelivery"),
      },
      additionalProperties: false,
    },
    InterfaceBindingStatus: {
      type: "object",
      required: ["phase", "observedInterfaceRevision"],
      properties: {
        phase: { enum: ["Pending", "Ready", "NotReady", "Revoked"] },
        observedInterfaceRevision: { type: "integer", minimum: 0 },
        conditions: { type: "array", items: interfaceCondition },
      },
      additionalProperties: false,
    },
    InterfaceBinding: {
      type: "object",
      required: ["apiVersion", "kind", "metadata", "spec", "status"],
      properties: {
        apiVersion: { const: "takosumi.dev/v1alpha1" },
        kind: { const: "InterfaceBinding" },
        metadata: {
          type: "object",
          required: [
            "id",
            "workspaceId",
            "generation",
            "createdAt",
            "updatedAt",
          ],
          properties: {
            id: { type: "string" },
            workspaceId: { type: "string" },
            generation: { type: "integer", minimum: 1 },
            materializedFrom: {
              type: "object",
              required: ["source", "interfaceKey", "key"],
              properties: {
                source: { const: "capsule_blueprint" },
                interfaceKey: { type: "string", minLength: 1 },
                key: { type: "string", minLength: 1 },
              },
              additionalProperties: false,
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
          additionalProperties: false,
        },
        spec: ref("InterfaceBindingSpec"),
        status: ref("InterfaceBindingStatus"),
      },
      additionalProperties: false,
    },
    CreateInterfaceBindingRequest: {
      type: "object",
      required: ["subjectRef", "permissions", "delivery"],
      properties: {
        subjectRef: ref("InterfaceSubjectRef"),
        permissions: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string" },
        },
        delivery: ref("InterfaceBindingDelivery"),
      },
      additionalProperties: false,
    },
    IssueInterfaceTokenRequest: {
      type: "object",
      required: ["permission"],
      properties: {
        permission: { type: "string", minLength: 1, maxLength: 256 },
      },
      additionalProperties: false,
    },
    IssueInterfaceTokenResponse: {
      type: "object",
      required: [
        "access_token",
        "token_type",
        "expires_in",
        "expires_at",
        "scope",
        "resource",
      ],
      properties: {
        access_token: { type: "string", minLength: 1 },
        token_type: { const: "Bearer" },
        expires_in: { type: "integer", minimum: 1, maximum: 60 },
        expires_at: { type: "string", format: "date-time" },
        scope: { type: "string", minLength: 1 },
        resource: { type: "string", format: "uri" },
      },
      additionalProperties: false,
    },
    ListInterfaceBindingsResponse: {
      type: "object",
      required: ["bindings"],
      properties: {
        bindings: { type: "array", items: ref("InterfaceBinding") },
      },
      additionalProperties: false,
    },
    LegacyOutputInterfaceMigrationCandidate: {
      type: "object",
      required: [
        "capsuleId",
        "capsuleUpdatedAt",
        "installConfigId",
        "installConfigUpdatedAt",
        "outputId",
        "outputDigest",
        "outputNamesDigest",
        "legacyConventionNames",
        "availableOutputNames",
        "mode",
      ],
      properties: {
        capsuleId: { type: "string", minLength: 1 },
        capsuleUpdatedAt: { type: "string", format: "date-time" },
        installConfigId: { type: "string", minLength: 1 },
        installConfigUpdatedAt: { type: "string", format: "date-time" },
        outputId: { type: "string", minLength: 1 },
        outputDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
        outputNamesDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
        legacyConventionNames: {
          type: "array",
          uniqueItems: true,
          items: {
            enum: ["service_exports", "service_bindings", "app_deployment"],
          },
        },
        availableOutputNames: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        mode: {
          enum: ["service_blueprints", "owner_selection_required"],
        },
        interfaceBlueprintsDigest: {
          type: "string",
          pattern: "^sha256:[0-9a-f]{64}$",
        },
      },
      additionalProperties: false,
    },
    LegacyOutputInterfaceMigrationCompletion: {
      type: "object",
      required: ["capsuleId", "evidenceEventId", "interfaceIds"],
      properties: {
        capsuleId: { type: "string", minLength: 1 },
        evidenceEventId: { type: "string", minLength: 1 },
        interfaceIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    LegacyOutputInterfaceMigrationIssue: {
      type: "object",
      required: ["capsuleId", "reason", "detail"],
      properties: {
        capsuleId: { type: "string", minLength: 1 },
        reason: {
          enum: [
            "install_config_missing",
            "current_output_missing",
            "current_output_inconsistent",
            "blueprint_retired",
            "blueprint_output_missing",
          ],
        },
        detail: { type: "string", minLength: 1 },
        names: {
          type: "array",
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
      },
      additionalProperties: false,
    },
    LegacyOutputInterfaceMigrationReportResponse: {
      type: "object",
      required: ["workspaceId", "candidates", "completed", "issues"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        candidates: {
          type: "array",
          items: ref("LegacyOutputInterfaceMigrationCandidate"),
        },
        completed: {
          type: "array",
          items: ref("LegacyOutputInterfaceMigrationCompletion"),
        },
        issues: {
          type: "array",
          items: ref("LegacyOutputInterfaceMigrationIssue"),
        },
      },
      additionalProperties: false,
    },
    LegacyOutputInterfaceManualSelection: {
      type: "object",
      required: [
        "name",
        "type",
        "version",
        "document",
        "inputName",
        "outputName",
        "access",
      ],
      properties: {
        name: { type: "string", minLength: 1 },
        type: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
        document: {},
        inputName: { type: "string", minLength: 1 },
        outputName: { type: "string", minLength: 1 },
        pointer: { type: "string", pattern: "^(|/)" },
        access: ref("InterfaceAccess"),
      },
      additionalProperties: false,
    },
    ConfirmLegacyOutputInterfaceMigrationRequest: {
      type: "object",
      required: ["candidate"],
      properties: {
        candidate: ref("LegacyOutputInterfaceMigrationCandidate"),
        selection: ref("LegacyOutputInterfaceManualSelection"),
      },
      additionalProperties: false,
    },
    ConfirmLegacyOutputInterfaceMigrationResponse: {
      type: "object",
      required: ["capsuleId", "outputId", "interfaceIds", "evidenceEventId"],
      properties: {
        capsuleId: { type: "string", minLength: 1 },
        outputId: { type: "string", minLength: 1 },
        interfaceIds: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", minLength: 1 },
        },
        evidenceEventId: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
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
      reason: { $ref: "#/components/schemas/ConditionReason" },
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
    ConditionReason: {
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^[A-Za-z][A-Za-z0-9._:-]*$",
      description:
        "Open machine-readable condition reason token. Core emits its documented reasons, while installed adapters may add versioned extension reasons without changing the Takosumi API schema.",
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
          enum: ["takosumi-api"],
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
          enum: ["takosumi-api"],
        },
        roleDescription: ref("ProcessRoleDescription"),
        endpoints: {
          type: "array",
          items: ref("ApiEndpointDescription"),
        },
      },
      additionalProperties: false,
    },
    TakosumiWellKnownFeatures: {
      type: "object",
      required: [
        "stacks",
        "resource_shapes",
        "opentofu_runner",
        "oidc",
        "workload_identity",
        "compat_framework",
        "compatibility_profiles",
        "interfaces",
      ],
      properties: {
        stacks: { type: "boolean" },
        resource_shapes: { type: "boolean" },
        opentofu_runner: { type: "boolean" },
        oidc: { type: "boolean" },
        workload_identity: { type: "boolean" },
        compat_framework: { type: "boolean" },
        compatibility_profiles: {
          type: "array",
          items: { type: "string" },
        },
        interfaces: { type: "boolean" },
      },
      additionalProperties: false,
    },
    TakosumiWellKnownEndpoints: {
      type: "object",
      required: ["api", "capabilities", "oidc_issuer"],
      properties: {
        api: { type: "string", format: "uri" },
        capabilities: { type: "string", format: "uri" },
        oidc_issuer: { type: "string", format: "uri" },
        extensions: {
          type: "object",
          additionalProperties: { type: "string", format: "uri" },
        },
      },
      additionalProperties: false,
    },
    TakosumiWellKnownResponse: {
      type: "object",
      required: ["api_versions", "features", "endpoints"],
      properties: {
        api_versions: {
          type: "array",
          items: { const: "takosumi.dev/v1alpha1" },
        },
        features: ref("TakosumiWellKnownFeatures"),
        endpoints: ref("TakosumiWellKnownEndpoints"),
      },
      additionalProperties: false,
    },
    TakosumiResourceCapabilities: {
      type: "object",
      required: [
        "Stack",
        "EdgeWorker",
        "ObjectBucket",
        "KVStore",
        "Queue",
        "SQLDatabase",
        "ContainerService",
      ],
      properties: {
        Stack: { type: "boolean" },
        EdgeWorker: { type: "boolean" },
        ObjectBucket: { type: "boolean" },
        KVStore: { type: "boolean" },
        Queue: { type: "boolean" },
        SQLDatabase: { type: "boolean" },
        ContainerService: { type: "boolean" },
      },
      additionalProperties: { type: "boolean" },
    },
    TakosumiAdapterCapabilities: {
      type: "object",
      required: ["opentofu"],
      properties: {
        opentofu: { type: "boolean" },
      },
      additionalProperties: { type: "boolean" },
    },
    TakosumiCompatCapabilities: {
      type: "object",
      required: ["framework"],
      properties: {
        framework: { type: "boolean" },
      },
      additionalProperties: { type: "boolean" },
    },
    TakosumiIdentityCapabilities: {
      type: "object",
      required: ["oidc_issuer", "external_oidc_login", "workload_identity"],
      properties: {
        oidc_issuer: { type: "boolean" },
        external_oidc_login: { type: "boolean" },
        workload_identity: { type: "boolean" },
      },
      additionalProperties: false,
    },
    TakosumiOperatorCapabilities: {
      type: "object",
      required: [
        "multi_tenant_workspaces",
        "workspace_members",
        "runner_pools",
        "operator_connections",
        "managed_target_catalog",
        "db_backed_configuration",
        "cli_api_operations",
        "usage_showback",
        "audit_evidence",
      ],
      properties: {
        multi_tenant_workspaces: { type: "boolean" },
        workspace_members: { type: "boolean" },
        runner_pools: { type: "boolean" },
        operator_connections: { type: "boolean" },
        managed_target_catalog: { type: "boolean" },
        db_backed_configuration: { type: "boolean" },
        cli_api_operations: { type: "boolean" },
        usage_showback: { type: "boolean" },
        audit_evidence: { type: "boolean" },
      },
      additionalProperties: { type: "boolean" },
    },
    TakosumiCompatibilityProfileCapabilities: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["planes"],
        properties: {
          planes: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { enum: ["control", "data"] },
          },
        },
        additionalProperties: false,
      },
    },
    TakosumiProductCapabilitiesResponse: {
      type: "object",
      required: [
        "apiVersion",
        "resources",
        "adapters",
        "compat",
        "compatibilityProfiles",
        "identity",
        "operator",
        "extensions",
      ],
      properties: {
        apiVersion: { const: "takosumi.dev/v1alpha1" },
        resources: ref("TakosumiResourceCapabilities"),
        adapters: ref("TakosumiAdapterCapabilities"),
        compat: ref("TakosumiCompatCapabilities"),
        compatibilityProfiles: ref("TakosumiCompatibilityProfileCapabilities"),
        identity: ref("TakosumiIdentityCapabilities"),
        operator: ref("TakosumiOperatorCapabilities"),
        extensions: { type: "array", items: { type: "string" } },
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
    OpenTofuModuleSource: {
      allOf: [ref("OpenTofuGitModuleSource")],
      description:
        "Git-backed OpenTofu module source. Source authoring is Git-only; immutable archives are runner transport, not another source kind.",
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
        code: {
          type: "string",
          description:
            "Stable machine-readable classification. Clients must not parse message or detail.",
        },
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

/** Capsule records and their service-side InstallConfig. */
function capsuleAndInstallConfigSchemas(): Record<
  string,
  Record<string, unknown>
> {
  return {
    Capsule: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "projectId",
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
        workspaceId: { type: "string" },
        projectId: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        sourceId: { type: "string" },
        installConfigId: { type: "string" },
        environment: { type: "string" },
        currentStateVersionId: { type: "string" },
        currentStateGeneration: { type: "number" },
        compatibilityReportId: { type: "string" },
        compatibilityStatus: {
          enum: ["ready", "needs_patch", "unsupported"],
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
        autoUpdate: { type: "boolean" },
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
        "variableMapping",
        "outputAllowlist",
        "policy",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        name: { type: "string" },
        modulePath: { type: "string" },
        lifecycleActions: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: [
              "apiVersion",
              "kind",
              "id",
              "phase",
              "executor",
              "command",
              "runnerCapability",
            ],
            properties: {
              apiVersion: { const: "takosumi.dev/v1alpha1" },
              kind: { const: "command" },
              id: { type: "string" },
              phase: { enum: ["post_apply", "pre_destroy"] },
              executor: { enum: ["runner", "operator"] },
              command: {
                type: "array",
                minItems: 1,
                maxItems: 40,
                items: { type: "string" },
              },
              workingDirectory: { type: "string" },
              env: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              timeoutSeconds: {
                type: "integer",
                minimum: 1,
                maximum: 21600,
              },
              runnerCapability: { type: "string" },
              useProviderCredentials: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        variableMapping: { type: "object", additionalProperties: true },
        installContextVariableMapping: {
          type: "object",
          propertyNames: {
            pattern: "^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*$",
          },
          additionalProperties: { enum: ["workspace_id", "capsule_id"] },
        },
        variablePresentation: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "label"],
            properties: {
              name: { type: "string" },
              type: { enum: ["string", "number", "boolean", "json"] },
              format: {
                type: "string",
                minLength: 1,
                maxLength: 64,
                pattern: "^[A-Za-z][A-Za-z0-9._:-]*$",
                description:
                  "Open presentation hint. Unknown hints fall back to a generic input and never grant execution authority.",
              },
              required: { type: "boolean" },
              advanced: { type: "boolean" },
              secret: { type: "boolean" },
              defaultValue: {
                oneOf: [
                  {
                    type: "object",
                    required: ["source", "value"],
                    properties: {
                      source: { const: "literal" },
                      value: {},
                    },
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    required: ["source"],
                    properties: { source: { const: "capsule_name" } },
                    additionalProperties: false,
                  },
                  {
                    type: "object",
                    required: ["source"],
                    properties: {
                      source: {
                        const: "workspace_scoped_capsule_name",
                      },
                    },
                    additionalProperties: false,
                  },
                ],
              },
              label: { $ref: "#/components/schemas/LocalizedText" },
              helper: { $ref: "#/components/schemas/LocalizedText" },
              placeholder: { type: "string" },
            },
            additionalProperties: false,
          },
        },
        installExperience: {
          type: "object",
          properties: {
            projections: {
              type: "array",
              maxItems: 20,
              items: {
                type: "object",
                required: ["kind"],
                allOf: [
                  {
                    if: {
                      properties: { kind: { const: "oidc_client" } },
                      required: ["kind"],
                    },
                    then: { required: ["variables", "callbackPath"] },
                  },
                ],
                properties: {
                  kind: {
                    enum: [
                      "service_name",
                      "public_endpoint",
                      "initial_secret",
                      "oidc_client",
                      "artifact",
                    ],
                  },
                  variable: { type: "string" },
                  variables: { type: "object", additionalProperties: true },
                  baseDomain: { type: "string" },
                  secretKind: {
                    enum: ["password", "password_or_hash", "token"],
                  },
                  optional: { type: "boolean" },
                  callbackPath: {
                    type: "string",
                    minLength: 1,
                    pattern: "^/",
                  },
                  scopes: { type: "array", items: { type: "string" } },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        interfaceBlueprints: {
          type: "array",
          maxItems: 64,
          items: ref("CapsuleInterfaceBlueprint"),
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
              sensitive: { type: "boolean" },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        policy: ref("PolicyConfig"),
        store: {
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
          ],
          properties: {
            source: {
              type: "object",
              required: ["url", "path"],
              properties: {
                url: { type: "string" },
                ref: { type: "string" },
                path: { type: "string" },
              },
              additionalProperties: false,
            },
            order: { type: "integer", minimum: 0 },
            surface: {
              type: "string",
              description:
                "Operator-defined discovery surface with no execution semantics.",
            },
            kind: {
              type: "string",
              description:
                "Operator-defined discovery kind with no execution semantics.",
            },
            provider: { type: "string" },
            suggestedName: { type: "string" },
            badge: { $ref: "#/components/schemas/LocalizedText" },
            name: { $ref: "#/components/schemas/LocalizedText" },
            description: { $ref: "#/components/schemas/LocalizedText" },
            iconUrl: { type: "string" },
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
            adapterId: {
              type: "string",
              pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$",
              description:
                "Exact operator-installed producer adapter; required for provider_snapshot.",
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
      required: ["severity", "compatibilityImpact", "code", "message"],
      properties: {
        severity: { enum: ["info", "warning", "error"] },
        compatibilityImpact: {
          enum: ["none", "needs_patch", "unsupported"],
          description:
            "Structured effect on the aggregate compatibility level; clients must not infer it from the finding code.",
        },
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
        "sourceId",
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
        capsuleId: { type: "string" },
        sourceSnapshotId: { type: "string" },
        level: {
          enum: ["ready", "needs_patch", "unsupported"],
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
        rootModuleVariables: {
          type: "array",
          items: { type: "string" },
        },
        rootModuleOutputs: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "sensitive", "ephemeral"],
            properties: {
              name: { type: "string" },
              sensitive: { type: ["boolean", "null"] },
              ephemeral: { type: ["boolean", "null"] },
            },
            additionalProperties: false,
          },
        },
        providerRequirements: {
          type: "array",
          items: ref("ProviderRequirement"),
        },
        providerResolutions: {
          type: "array",
          items: ref("ProviderResolution"),
        },
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
  };
}

function providerResolutionSchemas(): Record<string, Record<string, unknown>> {
  return {
    ProviderConnectionMaterialization: {
      type: "string",
      description:
        "Opaque inert audit/UI label. CredentialRecipe controls execution.",
      examples: ["secret", "oauth"],
    },
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
      required: ["kind", "provider", "connectionId", "requiredEnvNames"],
      properties: {
        kind: { const: "provider_connection" },
        provider: { type: "string" },
        connectionId: { type: "string" },
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
  };
}

/**
 * Guided Credential Recipe discovery + unified Provider Connection reads.
 */
function providerConnectionAndRecipeSchemas(): Record<
  string,
  Record<string, unknown>
> {
  return {
    SourceGitConnectionKind: {
      enum: [...SOURCE_GIT_CONNECTION_KINDS],
      description:
        "Source-phase Git credential transport. Provider Connections select a CredentialRecipe instead.",
    },
    ProviderConnectionRecipeRef: {
      type: "object",
      required: ["id", "authMode"],
      properties: {
        id: { type: "string" },
        authMode: { type: "string" },
        secretPartition: {
          type: "string",
          description:
            "Opaque at-rest partition pinned when the connection is created.",
        },
        envNames: { type: "array", items: { type: "string" } },
        fileEnvNames: { type: "array", items: { type: "string" } },
        requiredEnvGroups: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        declaredEnv: {
          type: "boolean",
          description:
            "Resolved installed-recipe capability pinned by the service; caller values cannot enable it.",
        },
        preRunAction: {
          type: "string",
          description: "Opaque installed pre-run driver token, when selected.",
        },
      },
      additionalProperties: false,
    },
    CredentialRecipeMaterial: {
      type: "object",
      required: ["from"],
      properties: {
        from: {
          enum: ["secret", "value", "generated", "literal", "user_defined"],
        },
        name: { type: "string" },
        value: { type: "string" },
      },
      additionalProperties: false,
    },
    CredentialRecipeFileMaterial: {
      allOf: [
        ref("CredentialRecipeMaterial"),
        {
          type: "object",
          properties: {
            envName: { type: "string" },
            mode: { type: "integer" },
          },
        },
      ],
    },
    CredentialRecipePresentationText: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: { type: "string" },
        },
      ],
      description:
        "Presentation-only text. Locale keys are open language tags and never affect credential execution.",
    },
    CredentialRecipeInputHint: {
      type: "object",
      properties: {
        label: ref("CredentialRecipePresentationText"),
        placeholder: ref("CredentialRecipePresentationText"),
        required: { type: "boolean" },
        secret: { type: "boolean" },
        hidden: { type: "boolean" },
      },
      additionalProperties: false,
    },
    CredentialRecipeAuthModePresentation: {
      type: "object",
      properties: {
        showInConnectionSetup: { type: "boolean" },
        displayName: ref("CredentialRecipePresentationText"),
        description: ref("CredentialRecipePresentationText"),
        setupGuide: {
          type: "object",
          required: ["url"],
          properties: {
            url: { type: "string", format: "uri" },
            steps: {
              type: "array",
              items: ref("CredentialRecipePresentationText"),
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
      description:
        "Optional setup presentation. env/files/preRun remain the only execution authority.",
    },
    CredentialRecipeAuthMode: {
      type: "object",
      properties: {
        env: {
          type: "object",
          additionalProperties: ref("CredentialRecipeMaterial"),
        },
        files: {
          type: "object",
          additionalProperties: ref("CredentialRecipeFileMaterial"),
        },
        preRun: {
          type: "object",
          required: ["type"],
          properties: {
            type: { type: "string" },
            inputs: {
              type: "object",
              additionalProperties: ref("CredentialRecipeMaterial"),
            },
          },
          additionalProperties: false,
        },
        inputHints: {
          type: "object",
          additionalProperties: ref("CredentialRecipeInputHint"),
        },
        presentation: ref("CredentialRecipeAuthModePresentation"),
      },
      additionalProperties: false,
    },
    CredentialRecipe: {
      type: "object",
      required: ["id", "displayName", "terraformSource", "authModes"],
      properties: {
        id: { type: "string" },
        displayName: { type: "string" },
        secretPartition: { type: "string" },
        terraformSource: {
          oneOf: [{ const: "*" }, { type: "array", items: { type: "string" } }],
        },
        envNames: { type: "array", items: { type: "string" } },
        requiredEnvGroups: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
        },
        declaredEnv: { type: "boolean" },
        authModes: {
          type: "object",
          additionalProperties: ref("CredentialRecipeAuthMode"),
        },
      },
      additionalProperties: false,
    },
    ProviderConnection: {
      type: "object",
      required: [
        "id",
        "provider",
        "providerSource",
        "scope",
        "status",
        "materialization",
        "envNames",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        provider: { type: "string" },
        providerSource: { type: "string" },
        credentialRecipe: ref("ProviderConnectionRecipeRef"),
        kind: ref("SourceGitConnectionKind"),
        scope: { enum: ["operator", "workspace"] },
        displayName: { type: "string" },
        status: {
          enum: ["pending", "verified", "revoked", "expired", "error"],
        },
        materialization: ref("ProviderConnectionMaterialization"),
        scopeHints: ref("ConnectionScope"),
        envNames: { type: "array", items: { type: "string" } },
        fileEnvNames: { type: "array", items: { type: "string" } },
        expiresAt: { type: "string", format: "date-time" },
        verifiedAt: { type: "string", format: "date-time" },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CredentialRecipeResponse: {
      type: "object",
      required: ["recipe"],
      properties: { recipe: ref("CredentialRecipe") },
      additionalProperties: false,
    },
    ListCredentialRecipesResponse: {
      type: "object",
      required: ["recipes"],
      properties: {
        recipes: { type: "array", items: ref("CredentialRecipe") },
      },
      additionalProperties: false,
    },
    CreateSourceCompatibilityCheckRequest: {
      type: "object",
      properties: {
        sourceSnapshotId: { type: "string" },
        modulePath: {
          type: "string",
          description:
            "Safe relative OpenTofu/Terraform module path inside the SourceSnapshot archive.",
        },
        capsuleId: { type: "string" },
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

/** Output / StateVersion projections and their read wrappers. */
function outputSchemas(): Record<string, Record<string, unknown>> {
  return {
    Output: {
      type: "object",
      description:
        "Public OpenTofu output projection. Raw output JSON remains an encrypted internal artifact; publicOutputs is the explicit InstallConfig projection and workspaceOutputs is a bounded non-secret Workspace-local capture for Dependency and Interface resolution.",
      required: [
        "id",
        "workspaceId",
        "capsuleId",
        "stateGeneration",
        "publicOutputs",
        "workspaceOutputs",
        "outputDigest",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        capsuleId: { type: "string" },
        stateGeneration: { type: "number" },
        publicOutputs: { type: "object", additionalProperties: true },
        workspaceOutputs: { type: "object", additionalProperties: true },
        outputDigest: { type: "string" },
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
    OutputResponse: {
      type: "object",
      required: ["output"],
      properties: {
        output: {
          oneOf: [ref("Output"), { type: "null" }],
        },
      },
      additionalProperties: false,
    },
    StateVersion: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "capsuleId",
        "environment",
        "generation",
        "stateRef",
        "digest",
        "createdByRunId",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        capsuleId: { type: "string" },
        environment: { type: "string" },
        generation: { type: "integer" },
        stateRef: { type: "string" },
        digest: { type: "string" },
        createdByRunId: { type: "string" },
        createdAt: { type: "string" },
      },
      additionalProperties: false,
    },
    ListStateVersionsResponse: {
      type: "object",
      required: ["stateVersions"],
      properties: {
        stateVersions: { type: "array", items: ref("StateVersion") },
        nextCursor: { type: "string" },
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
        managedProvider: { type: "boolean" },
        providerConfig: {
          type: "object",
          additionalProperties: true,
        },
        moduleInputDefaults: {
          type: "object",
          additionalProperties: true,
        },
        providerSettings: {
          type: "object",
          description:
            "Opaque non-secret settings decoded only by the explicitly selected provider helper or credential recipe driver.",
          additionalProperties: true,
        },
        managedProviderProfile: {
          type: "string",
          description:
            "Opaque operator-owned profile authorizing this public managed Provider Connection. It must exactly match the receiving extension profile and is never inferred from providerConfig.",
        },
        managedPublicBaseDomain: { type: "string", format: "hostname" },
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
      required: ["provider", "values"],
      properties: {
        workspaceId: { type: "string" },
        provider: { type: "string" },
        credentialRecipe: ref("ProviderConnectionRecipeRef"),
        kind: ref("SourceGitConnectionKind"),
        materialization: ref("ProviderConnectionMaterialization"),
        displayName: { type: "string" },
        scope: { enum: ["operator", "workspace"] },
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
    ConnectionResponse: {
      type: "object",
      required: ["connection"],
      properties: {
        connection: ref("ProviderConnection"),
      },
      additionalProperties: false,
    },
    ListConnectionsResponse: {
      type: "object",
      required: ["connections"],
      properties: {
        connections: { type: "array", items: ref("ProviderConnection") },
      },
      additionalProperties: false,
    },
    ConnectionSetupRequest: {
      type: "object",
      required: ["values"],
      properties: {
        workspaceId: { type: "string" },
        provider: { type: "string" },
        displayName: { type: "string" },
        scope: { enum: ["operator", "workspace"] },
        scopeHints: ref("ConnectionScope"),
        expiresAt: { type: "string", format: "date-time" },
        values: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Write-only credential values passed to the explicitly selected provider-owned setup helper; values are never echoed.",
        },
        files: {
          type: "array",
          items: ref("CreateConnectionFile"),
          description:
            "Write-only credential files passed to the explicitly selected provider-owned setup helper.",
        },
      },
      additionalProperties: false,
    },
    ConnectionOAuthStartRequest: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        displayName: { type: "string" },
        scope: { enum: ["operator", "workspace"] },
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
        "workspaceId",
        "name",
        "url",
        "defaultRef",
        "defaultPath",
        "status",
        "autoSync",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        defaultRef: { type: "string" },
        defaultPath: { type: "string" },
        authConnectionId: { type: "string" },
        status: { enum: ["active", "disabled", "error"] },
        autoSync: { type: "boolean" },
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
        "workspaceId",
        "sourceId",
        "url",
        "ref",
        "resolvedCommit",
        "path",
        "archiveRef",
        "archiveDigest",
        "archiveSizeBytes",
        "fetchedByRunId",
        "fetchedAt",
      ],
      properties: {
        id: { type: "string" },
        origin: { const: "git" },
        workspaceId: { type: "string" },
        sourceId: { type: "string" },
        url: { type: "string" },
        ref: { type: "string" },
        resolvedCommit: { type: "string" },
        path: { type: "string" },
        archiveRef: { type: "string" },
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
        "workspaceId",
        "sourceId",
        "url",
        "ref",
        "path",
        "archiveRef",
        "status",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        kind: { enum: ["source_sync"] },
        workspaceId: { type: "string" },
        sourceId: { type: "string" },
        url: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        archiveRef: { type: "string" },
        intent: { enum: ["observe", "manual_plan"] },
        status: { enum: ["queued", "running", "succeeded", "failed"] },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
        startedAt: { type: "string", format: "date-time" },
        finishedAt: { type: "string", format: "date-time" },
        resolvedCommit: { type: "string" },
        archiveDigest: { type: "string" },
        archiveSizeBytes: { type: "number" },
        snapshotId: { type: "string" },
        phaseTimings: {
          type: "array",
          items: {
            type: "object",
            required: ["phase", "startedAt", "finishedAt", "durationMs"],
            properties: {
              phase: { type: "string" },
              startedAt: { type: "string", format: "date-time" },
              finishedAt: { type: "string", format: "date-time" },
              durationMs: { type: "number" },
            },
            additionalProperties: false,
          },
        },
        error: { type: "string" },
      },
      additionalProperties: false,
    },
    CreateSourceRequest: {
      type: "object",
      required: ["workspaceId", "name", "url"],
      properties: {
        workspaceId: { type: "string" },
        name: { type: "string" },
        url: { type: "string" },
        defaultRef: { type: "string" },
        defaultPath: { type: "string" },
        authConnectionId: { type: "string" },
        autoSync: { type: "boolean" },
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
        autoSync: { type: "boolean" },
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
  };
}

/** Shared response stubs used by no-content process and control routes. */
function responseSchemas(): Record<string, Record<string, unknown>> {
  return {
    EmptyResponse: {
      description: "No response body.",
    },
  };
}

/** Provider-neutral OSS disabled/showback settings and usage records. */
function billingSchemas(): Record<string, Record<string, unknown>> {
  return {
    BillingSettings: {
      oneOf: [
        {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { const: "disabled" },
          },
          additionalProperties: false,
        },
        {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { const: "showback" },
          },
          additionalProperties: false,
        },
      ],
    },
    UsageEvent: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "kind",
        "quantity",
        "usdMicros",
        "ratingStatus",
        "source",
        "idempotencyKey",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        capsuleId: { type: "string" },
        runId: { type: "string" },
        meterId: {
          type: "string",
          description: "Stable producer-defined resource meter id.",
        },
        resourceFamily: {
          type: "string",
          description: "Stable producer-defined resource family token.",
        },
        resourceId: { type: "string" },
        operation: { type: "string" },
        resourceMetadata: {
          type: "object",
          description: "Optional non-secret producer-defined metadata.",
          additionalProperties: {
            anyOf: [
              { type: "string" },
              { type: "number" },
              { type: "boolean" },
              { type: "null" },
            ],
          },
        },
        kind: { type: "string" },
        quantity: { type: "number" },
        usdMicros: {
          type: "integer",
          description:
            "USD-denominated usage amount in micros. 1 USD = 1,000,000 micros.",
        },
        ratingStatus: {
          type: "string",
          enum: ["rated", "unrated"],
          description:
            "Whether usdMicros came from an explicit host rating policy. Unrated events always carry zero.",
        },
        source: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[a-z0-9][a-z0-9_.:-]*$",
          description:
            "Open usage producer token. runner is reserved for Core; operator-installed meters use their own stable token.",
        },
        idempotencyKey: { type: "string" },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    WorkspaceBillingResponse: {
      type: "object",
      required: ["billing"],
      properties: {
        billing: {
          type: "object",
          required: ["settings"],
          properties: {
            settings: ref("BillingSettings"),
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    WorkspaceUsageResponse: {
      type: "object",
      required: ["usageEvents"],
      properties: {
        usageEvents: { type: "array", items: ref("UsageEvent") },
      },
      additionalProperties: false,
    },
    BillingSettingsUpdateRequest: {
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
        "workspaceId",
        "producerCapsuleId",
        "consumerCapsuleId",
        "mode",
        "outputs",
        "visibility",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        producerCapsuleId: { type: "string" },
        consumerCapsuleId: { type: "string" },
        mode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        outputs: {
          type: "object",
          additionalProperties: ref("DependencyOutputMapping"),
        },
        visibility: { enum: ["workspace", "cross_workspace"] },
        createdAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateDependencyRequest: {
      type: "object",
      required: ["producerCapsuleId", "mode", "outputs", "visibility"],
      properties: {
        producerCapsuleId: { type: "string" },
        mode: {
          enum: ["variable_injection", "remote_state", "published_output"],
        },
        outputs: {
          type: "object",
          additionalProperties: ref("DependencyOutputMapping"),
        },
        visibility: { enum: ["workspace", "cross_workspace"] },
      },
      additionalProperties: false,
    },
    DependencyResponse: {
      type: "object",
      required: ["dependency"],
      properties: { dependency: ref("Dependency") },
      additionalProperties: false,
    },
    CapsuleDependenciesResponse: {
      type: "object",
      required: ["asProducer", "asConsumer"],
      properties: {
        asProducer: { type: "array", items: ref("Dependency") },
        asConsumer: { type: "array", items: ref("Dependency") },
      },
      additionalProperties: false,
    },
  };
}

/** Workspace, Project, Capsule request/response, and InstallConfig wrappers. */
function workspaceProjectAndCapsuleRequestSchemas(): Record<
  string,
  Record<string, unknown>
> {
  return {
    Workspace: {
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
        billingSettings: ref("BillingSettings"),
        archivedAt: { type: "string", format: "date-time" },
        policy: ref("PolicyConfig"),
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateWorkspaceRequest: {
      type: "object",
      required: ["handle", "displayName", "type", "ownerUserId"],
      properties: {
        handle: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{1,38}$" },
        displayName: { type: "string" },
        type: { enum: ["personal", "organization"] },
        ownerUserId: { type: "string" },
      },
      additionalProperties: false,
    },
    WorkspaceResponse: {
      type: "object",
      required: ["workspace"],
      properties: { workspace: ref("Workspace") },
      additionalProperties: false,
    },
    ListWorkspacesResponse: {
      type: "object",
      required: ["workspaces"],
      properties: {
        workspaces: { type: "array", items: ref("Workspace") },
      },
      additionalProperties: false,
    },
    Project: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "name",
        "slug",
        "projectJson",
        "createdAt",
        "updatedAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        name: { type: "string" },
        slug: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
        },
        projectJson: { type: "object", additionalProperties: true },
        createdAt: { type: "string", format: "date-time" },
        updatedAt: { type: "string", format: "date-time" },
      },
      additionalProperties: false,
    },
    CreateProjectRequest: {
      type: "object",
      required: ["name", "slug"],
      properties: {
        name: { type: "string", minLength: 1 },
        slug: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,62}$",
        },
        projectJson: { type: "object", additionalProperties: true },
      },
      additionalProperties: false,
    },
    ProjectResponse: {
      type: "object",
      required: ["project"],
      properties: { project: ref("Project") },
      additionalProperties: false,
    },
    ListProjectsResponse: {
      type: "object",
      required: ["projects"],
      properties: {
        projects: { type: "array", items: ref("Project") },
      },
      additionalProperties: false,
    },
    CreateCapsuleRequest: {
      type: "object",
      required: ["name", "environment", "sourceId", "installConfigId"],
      properties: {
        name: { type: "string" },
        environment: { type: "string" },
        projectId: { type: "string" },
        sourceId: { type: "string" },
        installConfigId: { type: "string" },
        autoUpdate: { type: "boolean" },
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
              sensitive: { type: "boolean" },
              required: { type: "boolean" },
            },
            additionalProperties: false,
          },
        },
        interfaceBlueprints: {
          type: "array",
          maxItems: 64,
          items: ref("CapsuleInterfaceBlueprint"),
        },
        vars: { type: "object", additionalProperties: true },
        managedPublicHostname: {
          type: "object",
          required: ["mode"],
          properties: {
            mode: { enum: ["scoped", "vanity"] },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    PatchCapsuleRequest: {
      type: "object",
      required: ["status"],
      properties: {
        status: { enum: ["active", "stale", "error"] },
      },
      additionalProperties: false,
    },
    CapsulePlanRequest: {
      type: "object",
      properties: {
        compatibilityReportId: { type: "string" },
        runnerId: { type: "string" },
      },
      additionalProperties: false,
    },
    CapsuleResponse: {
      type: "object",
      required: ["capsule"],
      properties: {
        capsule: ref("Capsule"),
      },
      additionalProperties: false,
    },
    ListCapsulesResponse: {
      type: "object",
      required: ["capsules"],
      properties: {
        capsules: { type: "array", items: ref("Capsule") },
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
    PatchWorkspaceRequest: {
      type: "object",
      properties: {
        displayName: { type: "string" },
        policy: ref("PolicyConfig"),
        archived: { type: "boolean" },
      },
      additionalProperties: false,
      minProperties: 1,
    },
  };
}

/** Run + RunGroup ledger shapes and their log/event/read wrappers. */
function runSchemas(): Record<string, Record<string, unknown>> {
  return {
    Run: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "type",
        "status",
        "createdBy",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        runGroupId: { type: "string" },
        workspaceId: { type: "string" },
        sourceId: { type: "string" },
        subject: {
          type: "object",
          required: ["kind", "id"],
          properties: {
            kind: { enum: ["capsule", "resource", "source"] },
            id: { type: "string" },
          },
          additionalProperties: false,
        },
        resourceOperation: {
          enum: ["preview", "apply", "import", "observe", "refresh", "delete"],
        },
        capsuleId: { type: "string" },
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
        planArtifactRef: { type: "string" },
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
        requiresApproval: { type: "boolean" },
        backupId: { type: "string" },
        restoreStateGeneration: { type: "integer" },
        restoreServiceData: { type: "boolean" },
        restoredStateVersionId: { type: "string" },
        restoredFromStateVersionId: { type: "string" },
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
      required: ["status", "ref", "digest", "sizeBytes"],
      properties: {
        status: { enum: ["restored"] },
        ref: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
        restoredCount: { type: "integer" },
      },
      additionalProperties: false,
    },
    RunApplyExpectedGuard: {
      type: "object",
      required: [
        "planId",
        "runnerId",
        "sourceDigest",
        "variablesDigest",
        "policyDecisionDigest",
        "planDigest",
        "planArtifactDigest",
      ],
      properties: {
        planId: { type: "string" },
        capsuleId: { type: "string" },
        currentStateVersionId: {
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
        resolvedProviderBindingsDigest: { type: "string" },
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
          required: ["facts"],
          properties: {
            facts: {
              type: "object",
              additionalProperties: {
                oneOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                ],
              },
            },
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
        "estimatedUsdMicros",
        "ratingStatus",
        "blocked",
        "reasons",
      ],
      properties: {
        runId: { type: "string" },
        billingMode: { enum: ["disabled", "showback"] },
        estimatedUsdMicros: {
          type: "integer",
          description:
            "Estimated USD amount for this run in micros. 1 USD = 1,000,000 micros.",
        },
        ratingStatus: {
          enum: ["not_applicable", "rated", "unrated"],
          description:
            "Whether the estimate came from an explicit host rating policy; disabled plans are not_applicable.",
        },
        blocked: { type: "boolean" },
        reasons: { type: "array", items: { type: "string" } },
        extension: {
          type: "object",
          description:
            "Opaque non-secret data supplied by a host billing extension.",
          additionalProperties: true,
        },
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
      required: [
        "id",
        "workspaceId",
        "type",
        "status",
        "graphJson",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        type: {
          enum: [
            "workspace_update",
            "workspace_drift_check",
            "capsule_install",
            "capsule_update",
            "capsule_destroy",
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

/** Workspace-scoped Activity audit-trail shapes. */
function activitySchemas(): Record<string, Record<string, unknown>> {
  return {
    ActivityEvent: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "action",
        "targetType",
        "targetId",
        "metadata",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
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

/** Backup record / artifact-pointer shapes and StateVersion read wrappers. */
function backupSchemas(): Record<string, Record<string, unknown>> {
  return {
    BackupArtifactPointer: {
      type: "object",
      required: ["ref", "digest", "sizeBytes"],
      properties: {
        ref: { type: "string" },
        digest: { type: "string" },
        sizeBytes: { type: "integer" },
      },
      additionalProperties: false,
    },
    ServiceDataBackupPointer: {
      type: "object",
      required: [
        "ref",
        "digest",
        "sizeBytes",
        "exportedCount",
        "unsupportedCount",
        "missingCount",
      ],
      properties: {
        ref: { type: "string" },
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
        "capsuleId",
        "environment",
        "stateGeneration",
        "stateVersionId",
      ],
      properties: {
        capsuleId: { type: "string" },
        environment: { type: "string" },
        stateGeneration: { type: "integer" },
        stateVersionId: { type: "string" },
      },
      additionalProperties: false,
    },
    BackupRecord: {
      type: "object",
      required: [
        "id",
        "workspaceId",
        "ref",
        "digest",
        "sizeBytes",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        workspaceId: { type: "string" },
        capsuleId: { type: "string" },
        environment: { type: "string" },
        restoreTarget: ref("BackupRestoreTarget"),
        ref: { type: "string" },
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
        capsuleId: { type: "string" },
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
    StateVersionResponse: {
      type: "object",
      required: ["stateVersion"],
      properties: { stateVersion: ref("StateVersion") },
      additionalProperties: false,
    },
  };
}

/** Cross-Workspace OutputShare shapes plus the ApproveRun request body. */
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
        "fromWorkspaceId",
        "toWorkspaceId",
        "producerCapsuleId",
        "outputs",
        "status",
        "createdAt",
      ],
      properties: {
        id: { type: "string" },
        fromWorkspaceId: { type: "string" },
        toWorkspaceId: { type: "string" },
        producerCapsuleId: { type: "string" },
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
        "fromWorkspaceId",
        "toWorkspaceId",
        "producerCapsuleId",
        "outputs",
      ],
      properties: {
        fromWorkspaceId: { type: "string" },
        toWorkspaceId: { type: "string" },
        producerCapsuleId: { type: "string" },
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
