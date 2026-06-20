import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiCapabilitiesDescription } from "../../../core/api/capabilities.ts";
import {
  createTakosumiOpenApiDocument,
  TAKOSUMI_OPENAPI_VERSION,
} from "../../../core/api/openapi.ts";
import {
  ALWAYS_MOUNTED_ENDPOINTS,
  type ApiEndpoint,
  mountedEndpoints,
  ROUTE_FAMILIES,
  type RouteFamilyMountedFlags,
} from "../../../core/api/route_families.ts";

const ALL_MOUNTED: RouteFamilyMountedFlags = {
  runtimeAgentRoutesMounted: true,
  openApiRouteMounted: true,
  readinessRoutesMounted: true,
  artifactRoutesMounted: true,
  deployControlInternalRoutesMounted: true,
  metricsRoutesMounted: true,
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
  assert.equal(
    openapi["x-takos-mounted-route-families"].includes("artifact"),
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
    "/internal/v1/deployments/:deploymentId",
    "/internal/v1/deployments/{deploymentId}",
    "/internal/v1/deployments/:deploymentId/rollback-plan",
    "/internal/v1/deployments/{deploymentId}/rollback-plan",
    "/internal/v1/spaces/:spaceId/uploads",
    "/internal/v1/spaces/{spaceId}/uploads",
    "/internal/v1/deploy",
    "/internal/v1/runs/:runId/cost",
    "/internal/v1/runs/{runId}/cost",
    "/internal/v1/artifacts/kinds",
    "/internal/v1/plan-runs",
    "/internal/v1/apply-runs",
    "/internal/v1/runner-profiles",
    "/internal/v1/installations/:installationId/deployment-outputs",
    "/internal/v1/installations/{installationId}/deployment-outputs",
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
    "DeploymentOutput",
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
    "DeploymentOutput",
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
    "ArtifactGcResponse",
    "ProviderRequirement",
    "ProviderResolution",
    "ProviderResolutionStatus",
    "CapsuleCompatibilityReport",
    "DeployUploadSnapshotRequest",
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
    openapi.components.schemas.DeployRequest?.properties?.providerEnvBindings,
    undefined,
    "public DeployRequest must not expose internal provider resolver bindings",
  );
  assert.equal(
    openapi.components.schemas.DeployUploadSnapshotRequest,
    undefined,
  );
  assert.equal(openapi.components.schemas.RuntimeAgentEnrollRequest, undefined);
  assert.equal(openapi.components.schemas.RuntimeAgentResponse, undefined);
  assert.equal(openapi.components.schemas.GatewayManifestResponse, undefined);
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

test("mountedEndpoints gates families and always includes process endpoints", () => {
  const none = mountedEndpoints({});
  assert.deepEqual(
    none.map((e) => e.path),
    ALWAYS_MOUNTED_ENDPOINTS.map((e) => e.path),
  );

  const onlyRuntimeAgent = mountedEndpoints({
    runtimeAgentRoutesMounted: true,
  });
  assert.deepEqual(
    onlyRuntimeAgent.map((e) => e.path),
    ALWAYS_MOUNTED_ENDPOINTS.map((e) => e.path),
  );
  assert.ok(!onlyRuntimeAgent.some((e) => e.path === "/metrics"));
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
