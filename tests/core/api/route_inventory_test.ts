import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiCapabilitiesDescription } from "../../../core/api/capabilities.ts";
import {
  createTakosumiOpenApiDocument,
  resourceFormPinSchemas,
  TAKOSUMI_OPENAPI_VERSION,
} from "../../../core/api/openapi.ts";
import { DEPLOY_CONTROL_ACTIVITY_ENDPOINTS } from "../../../core/api/deploy_control_activity_routes.ts";
import { DEPLOY_CONTROL_RESOURCE_FORM_PIN_ENDPOINTS } from "../../../core/api/deploy_control_resource_form_pin_routes.ts";
import { RESOURCE_SHAPE_KINDS } from "../../../contract/resource-shape.ts";
import {
  ALWAYS_MOUNTED_ENDPOINTS,
  type ApiEndpoint,
  mountedEndpoints,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "../../../core/api/route_families.ts";

const ALL_MOUNTED: RouteFamilyMountedFlags = {
  openApiRouteMounted: true,
  readinessRoutesMounted: true,
  deployControlInternalRoutesMounted: true,
  metricsRoutesMounted: true,
  resourceShapeRoutesMounted: true,
  formActivationRoutesMounted: true,
  offeringCatalogRoutesMounted: true,
  interfaceRoutesMounted: true,
};

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

/**
 * The all-mounted process /capabilities inventory and /openapi.json paths must
 * be derived from the SAME route-family endpoint descriptors. This is a
 * customer-safe process inventory: optional non-internal families such as
 * metrics can be mounted here, while `/internal/v1/*` seams are omitted even
 * when their handlers are mounted.
 * Before item [17] these were hand-maintained enumerations that had drifted.
 */
test("all-mounted capabilities and openapi cover the same endpoint set", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);

  const capabilityKeys = new Set(
    capabilities.endpoints.map((e) => `${e.method} ${toOpenApiPath(e.path)}`),
  );
  const openapiKeys = new Set<string>();
  for (const [path, item] of Object.entries(openapi.paths)) {
    for (const method of Object.keys(item)) {
      openapiKeys.add(`${method.toUpperCase()} ${path}`);
    }
  }

  assert.deepEqual(
    [...capabilityKeys].sort(),
    [...openapiKeys].sort(),
    "capabilities and openapi must enumerate the identical endpoint set",
  );
});

test("Resource Shape OpenAPI publishes fail-closed TargetPool deletion", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const operation = openapi.paths["/v1/target-pools/{name}"]?.delete;
  assert.ok(operation);
  assert.ok(operation.responses["204"]);
  assert.ok(operation.responses["409"]);
  assert.ok(operation.responses["502"]);
  assert.deepEqual(
    operation.parameters?.map((parameter) => parameter.name),
    ["name", "space"],
  );
});

test("Resource Shape OpenAPI publishes the canonical bundled shape set", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const resource = openapi.components.schemas.ResourceShapeResponse;
  const capabilities = openapi.components.schemas.TakosumiResourceCapabilities;
  assert.ok(resource);
  assert.ok(capabilities);

  assert.deepEqual(resource.properties.kind.examples, RESOURCE_SHAPE_KINDS);
  assert.deepEqual(capabilities.required, ["Stack", ...RESOURCE_SHAPE_KINDS]);
  assert.deepEqual(Object.keys(capabilities.properties), [
    "Stack",
    ...RESOURCE_SHAPE_KINDS,
  ]);
});

test("public OpenAPI does not publish internal Resource Run recovery evidence", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  // The unified Run routes are host-internal and therefore filtered from this
  // customer-safe process inventory. In particular, the internal CAS/result/
  // outbox evidence must never become standalone public schemas.
  assert.equal(openapi.components.schemas.Run, undefined);
  assert.equal(
    openapi.components.schemas.ResourceOperationResultEvidence,
    undefined,
  );
  assert.equal(
    openapi.components.schemas.ResourceOperationAuditEvidence,
    undefined,
  );
});

test("Resource Shape OpenAPI publishes bounded list pagination", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  for (const path of [
    "/v1/resources",
    "/v1/target-pools",
    "/v1/space-policies",
  ] as const) {
    const operation = openapi.paths[path]?.get;
    assert.ok(operation, path);
    assert.deepEqual(
      operation.parameters?.map((parameter) => parameter.name),
      ["space", "limit", "cursor"],
      path,
    );
  }
  for (const schemaName of [
    "ListResourceShapesResponse",
    "ListTargetPoolsResponse",
    "ListSpacePoliciesResponse",
    "ListResourceEventsResponse",
  ] as const) {
    const schema = openapi.components.schemas[schemaName];
    assert.ok(schema, schemaName);
    assert.deepEqual(schema.properties.nextCursor, { type: "string" });
  }

  const events = openapi.paths["/v1/resources/{kind}/{name}/events"]?.get;
  assert.ok(events);
  assert.deepEqual(
    events.parameters?.map((parameter) => parameter.name),
    ["kind", "name", "space", "limit", "cursor"],
  );
  assert.deepEqual(
    openapi.components.schemas.ListResourceEventsResponse.properties.events,
    {
      type: "array",
      items: { $ref: "#/components/schemas/ResourceEvent" },
    },
  );
});

test("FormActivation OpenAPI publishes exact noncommercial operator contracts", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const collection = openapi.paths["/v1/form-activations"];
  const member = openapi.paths["/v1/form-activations/{id}"];
  assert.ok(collection?.post);
  assert.ok(collection.get);
  assert.ok(member?.get);
  assert.ok(member.patch);
  assert.deepEqual(
    collection.get.parameters?.map((parameter) => parameter.name),
    ["limit", "cursor"],
  );
  assert.deepEqual(member.patch.security, [{ deployControlBearer: [] }]);

  const activation = openapi.components.schemas.FormActivation;
  assert.ok(activation);
  assert.deepEqual(activation.properties.identity, {
    $ref: "#/components/schemas/InstalledFormReference",
  });
  for (const commercialField of [
    "price",
    "sku",
    "billing",
    "capacity",
    "sla",
  ]) {
    assert.equal(activation.properties[commercialField], undefined);
  }
  assert.equal(
    openapi.components.schemas.CreateFormActivationRequest.additionalProperties,
    false,
  );
});

test("Offering OpenAPI is generic, immutable, and commercially neutral", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  assert.ok(openapi.paths["/v1/offering-catalogs"]?.post);
  assert.ok(openapi.paths["/v1/offering-catalogs"]?.get);
  assert.ok(openapi.paths["/v1/offering-availability/query"]?.post);
  assert.ok(openapi.paths["/v1/offering-selections/resolve"]?.post);
  const offering = openapi.components.schemas.Offering;
  const selection = openapi.components.schemas.OfferingSelection;
  assert.ok(offering);
  assert.ok(selection);
  assert.deepEqual(offering.properties.subject.required, [
    "type",
    "ref",
    "version",
    "digest",
  ]);
  for (const field of [
    "formRef",
    "price",
    "sku",
    "billing",
    "capacity",
    "managerId",
    "sla",
    "support",
  ]) {
    assert.equal(offering.properties[field], undefined, field);
    assert.equal(selection.properties[field], undefined, field);
  }
});

test("all-mounted inventories suppress internal seams and still publish process routes", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const capPaths = capabilities.endpoints.map((e) => e.path);

  assert.ok(capPaths.includes("/capabilities"));
  assert.ok(openapi.paths["/capabilities"]?.get);
  assert.ok(capPaths.includes("/openapi.json"));
  assert.ok(openapi.paths["/openapi.json"]?.get);
  assert.ok(capPaths.includes("/readyz"));
  assert.ok(openapi.paths["/readyz"]?.get);
  assert.ok(capPaths.includes("/livez"));
  assert.ok(openapi.paths["/livez"]?.get);
  assert.ok(capPaths.includes("/metrics"));
  assert.ok(openapi.paths["/metrics"]?.get);

  for (const path of capPaths) {
    assert.equal(path.startsWith("/internal/v1"), false, path);
  }
  for (const path of Object.keys(openapi.paths)) {
    assert.equal(path.startsWith("/internal/v1"), false, path);
  }
  assert.equal(
    openapi["x-takos-mounted-route-families"].includes(
      "deployControl-internal",
    ),
    false,
  );
});

test("capabilities and openapi agree on summary and auth per endpoint", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);

  for (const endpoint of capabilities.endpoints) {
    const path = toOpenApiPath(endpoint.path);
    const item = openapi.paths[path] as Record<string, { summary?: string }>;
    const op = item[endpoint.method.toLowerCase()];
    assert.ok(op, `openapi missing ${endpoint.method} ${path}`);
    assert.equal(
      op.summary,
      endpoint.summary,
      `summary drift for ${endpoint.method} ${path}`,
    );
  }

  // BUG FIX: the metrics endpoint must use the unified `metrics-scrape` auth,
  // not the invented capabilities-only `metrics-token` value.
  const metrics = capabilities.endpoints.find((e) => e.path === "/metrics");
  assert.equal(metrics?.auth, "metrics-scrape");
});

test("openapi endpoint auth enum matches mounted capabilities auth values", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);

  assert.deepEqual(
    [
      ...openapi.components.schemas.ApiEndpointDescription.properties.auth.enum,
    ].sort(),
    [...new Set(capabilities.endpoints.map((e) => e.auth))].sort(),
  );
});

test("all-mounted route inventory keeps retired internal ledger routes hidden", () => {
  const capabilities = createApiCapabilitiesDescription(
    "takosumi-api",
    ALL_MOUNTED,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  // Every `/internal/v1` seam is mounted outside the customer-safe inventory.
  // The `/api/public/v1/*` and bare `/v1/deployments` entries are pre-v1 retired
  // names that must also never reappear.
  const retiredPaths = [
    "/api/public/v1/capabilities",
    "/api/public/v1/deployments",
    "/v1/deployments",
    "/internal/v1/state-versions/:deploymentId",
    "/internal/v1/state-versions/{deploymentId}",
    "/internal/v1/state-versions/:deploymentId/rollback-plan",
    "/internal/v1/state-versions/{deploymentId}/rollback-plan",
    "/internal/v1/workspaces/:spaceId/uploads",
    "/internal/v1/workspaces/{spaceId}/uploads",
    "/internal/v1/workspaces/:spaceId/artifact-snapshots",
    "/internal/v1/workspaces/{spaceId}/artifact-snapshots",
    "/internal/v1/deploy",
    "/internal/v1/runs/:runId/cost",
    "/internal/v1/runs/{runId}/cost",
    "/internal/v1/artifacts/kinds",
    "/internal/v1/plan-runs",
    "/internal/v1/apply-runs",
    "/internal/v1/runner-profiles",
    "/internal/v1/capsules/:installationId/outputs",
    "/internal/v1/capsules/{installationId}/outputs",
  ] as const;

  const capabilityPaths = new Set(capabilities.endpoints.map((e) => e.path));
  for (const path of retiredPaths) {
    assert.equal(capabilityPaths.has(path), false, path);
    assert.equal(openapi.paths[toOpenApiPath(path)], undefined, path);
  }

  for (const schemaName of [
    "DeployControlAuditEvent",
    "PlanRun",
    "ApplyRun",
    "RunnerProfile",
    "ProjectedOutput",
    "StatusSummaryResponse",
  ] as const) {
    assert.equal(openapi.components.schemas[schemaName], undefined, schemaName);
  }
});

test("openapi version follows package version", () => {
  const pkg = JSON.parse(
    readFileSync(join(import.meta.dir, "../../../package.json"), "utf8"),
  ) as { version: string };

  assert.equal(TAKOSUMI_OPENAPI_VERSION, pkg.version);
  assert.equal(
    createTakosumiOpenApiDocument(ALL_MOUNTED).info.version,
    pkg.version,
  );
});

test("public openapi component names do not expose internal deploy-control seams", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const forbidden = [
    "DeployControl",
    "PlanRun",
    "ApplyRun",
    "RunnerProfile",
    "ProjectedOutput",
  ];

  for (const schemaName of Object.keys(openapi.components.schemas)) {
    for (const term of forbidden) {
      assert.equal(
        schemaName.includes(term),
        false,
        `${schemaName} must not expose internal ${term} vocabulary`,
      );
    }
  }
});

test("openapi component schema refs are resolved", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const refs = new Set<string>();
  collectSchemaRefs(openapi, refs);

  for (const schemaName of refs) {
    assert.ok(
      openapi.components.schemas[schemaName],
      `openapi schema ref ${schemaName} is not defined`,
    );
  }
});

test("deployment quote OpenAPI preserves exact versioned price evidence", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const quote = openapi.components.schemas.ResourceDeploymentQuote;
  const line = quote.properties.lineItems.items;

  for (const field of [
    "catalogId",
    "catalogVersion",
    "offeringId",
    "offeringVersion",
    "offeringSelection",
    "region",
  ]) {
    assert.ok(quote.properties[field], `quote ${field} missing`);
  }
  for (const field of [
    "sku",
    "skuVersion",
    "taxTreatment",
    "invoiceDescription",
    "meterId",
    "meterIdPrefix",
    "meterKind",
    "unit",
    "billingUnit",
    "minimumChargeUsdMicros",
    "unitPriceUsdMicros",
    "amountUsdMicros",
  ]) {
    assert.ok(line.properties[field], `quote line ${field} missing`);
  }
  assert.equal(line.additionalProperties, false);
});

test("customer-safe process openapi schemas are concrete", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  for (const schemaName of [
    "CapabilitiesResponse",
    "HealthProbeResponse",
  ] as const) {
    assert.ok(openapi.components.schemas[schemaName], `${schemaName} missing`);
    assert.notEqual(
      openapi.components.schemas[schemaName].additionalProperties,
      true,
      `${schemaName} must not regress to a generic jsonObject placeholder`,
    );
  }
  for (const schemaName of [
    "CreateSpaceRequest",
    "SpaceResponse",
    "ListSpacesResponse",
    "DeploymentResponse",
    "CreateOutputShareRequest",
    "OutputShareResponse",
    "ListOutputSharesResponse",
    "ProviderRequirement",
    "ProviderResolution",
    "ProviderResolutionStatus",
    "CapsuleCompatibilityReport",
    "Run",
  ] as const) {
    assert.equal(
      openapi.components.schemas[schemaName],
      undefined,
      `${schemaName} must stay out of the process inventory schema set`,
    );
  }
  assert.equal(openapi.components.schemas.PutProviderEnvRequest, undefined);
  assert.equal(openapi.components.schemas.ProviderEnvResponse, undefined);
  assert.equal(openapi.components.schemas.ListProviderEnvsResponse, undefined);
  assert.equal(
    openapi.components.schemas.ProviderEnvMaterialization,
    undefined,
  );
  assert.equal(
    openapi.components.schemas.RunEnvironment,
    undefined,
    "RunEnvironment is an internal dispatch object and must not become a public OpenAPI component until a redacted API shape exists",
  );
});

test("openapi request and response components are not generic placeholders", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const generic: string[] = [];
  for (const [schemaName, schema] of Object.entries(
    openapi.components.schemas,
  )) {
    if (!/(Request|Response)$/.test(schemaName)) continue;
    if (schema.additionalProperties === true) generic.push(schemaName);
  }
  assert.deepEqual(
    generic.sort(),
    [],
    "request/response schemas must be concrete enough for generated clients",
  );
});

test("restore endpoint descriptor carries a concrete restore request schema", () => {
  const endpoint = DEPLOY_CONTROL_ACTIVITY_ENDPOINTS.find(
    (item) => item.operationId === "createBackupRestore",
  );
  assert.equal(endpoint?.openapi.requestSchema, "CreateRestoreRequest");
});

test("authoritative Form pin inventory has one token-only concrete descriptor", () => {
  const endpoint = DEPLOY_CONTROL_RESOURCE_FORM_PIN_ENDPOINTS.find(
    (item) => item.operationId === "captureResourceFormPinInventory",
  );
  assert.deepEqual(endpoint, {
    method: "GET",
    path: "/internal/v1/migrations/resource-form-pins/inventory",
    summary:
      "Captures a complete, authoritative all-Workspace exact FormRef pin inventory.",
    auth: "deploy-control-token",
    operationId: "captureResourceFormPinInventory",
    openapi: { okSchema: "ResourceFormPinInventoryReceipt" },
    notImplementedMessage: "exact FormRef pin inventory is not wired",
  });
});

test("authoritative Form pin inventory schema exposes identity only", () => {
  const schemas = resourceFormPinSchemas();
  const receipt = schemas.ResourceFormPinInventoryReceipt as
    { readonly properties: Record<string, unknown> } | undefined;
  const row = schemas.ResourceFormPinInventoryRow as
    | {
        readonly properties: Record<string, unknown>;
        readonly additionalProperties: boolean;
      }
    | undefined;
  assert.ok(receipt);
  assert.ok(row);
  assert.deepEqual(Object.keys(row.properties), [
    "workspaceId",
    "space",
    "resourceId",
    "name",
    "kind",
    "form",
  ]);
  assert.equal(row.additionalProperties, false);
  for (const sensitive of [
    "spec",
    "outputs",
    "nativeResources",
    "target",
    "credentials",
  ]) {
    assert.equal(row.properties[sensitive], undefined, sensitive);
  }
  assert.deepEqual(receipt.properties.complete, { const: true });
  assert.deepEqual(receipt.properties.matrixDigest, {
    type: "string",
    pattern: "^sha256:[0-9a-f]{64}$",
  });
});

test("mountedEndpoints with no families includes process endpoints", () => {
  const none = mountedEndpoints({});
  assert.deepEqual(
    none.map((e) => e.path),
    ALWAYS_MOUNTED_ENDPOINTS.map((e) => e.path),
  );
});

test("every endpoint descriptor has a unique operationId", () => {
  const all: ApiEndpoint[] = [
    ...ALWAYS_MOUNTED_ENDPOINTS,
    ...ROUTE_FAMILIES.flatMap((f) => f.endpoints),
  ];
  const ids = all.map((e) => e.operationId);
  assert.equal(
    new Set(ids).size,
    ids.length,
    "operationIds must be unique across all families",
  );
});

function collectSchemaRefs(value: unknown, output: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaRefs(item, output);
    return;
  }
  const record = value as Record<string, unknown>;
  const maybeRef = record["$ref"];
  if (
    typeof maybeRef === "string" &&
    maybeRef.startsWith("#/components/schemas/")
  ) {
    output.add(maybeRef.slice("#/components/schemas/".length));
  }
  for (const item of Object.values(record)) collectSchemaRefs(item, output);
}
