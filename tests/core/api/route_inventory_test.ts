import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApiCapabilitiesDescription } from "../../../core/api/capabilities.ts";
import {
  capsuleAndInstallConfigSchemas,
  capsuleSchemas,
  createTakosumiOpenApiDocument,
  sourceSchemas,
  TAKOSUMI_OPENAPI_VERSION,
  workspaceProjectAndCapsuleRequestSchemas,
} from "../../../core/api/openapi.ts";
import { DEPLOY_CONTROL_ACTIVITY_ENDPOINTS } from "../../../core/api/deploy_control_activity_routes.ts";
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

test("legacy Resource Shape and FormActivation paths are not published", () => {
  assert.equal(
    ROUTE_FAMILIES.some((family) => (family.id as string) === "form-activations"),
    false,
  );
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  for (const path of [
    "/v1/resources",
    "/v1/resources/{kind}/{name}",
    "/v1/target-pools/{name}",
    "/v1/space-policies/{name}",
    "/v1/form-availability",
    "/v1/form-activations",
    "/v1/form-activations/{id}",
  ]) {
    assert.equal(openapi.paths[path], undefined, path);
  }
  assert.equal(openapi.paths["/api/v1/interfaces"]?.get !== undefined, true);
  assert.equal(openapi.paths["/v1/interfaces"], undefined);
});

test("legacy Resource Shape response schema is not published", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const resource = openapi.components.schemas.ResourceShapeResponse;
  assert.equal(resource, undefined);
  // The generic product-capability envelope remains part of the public
  // contract. Runtime discovery reports every legacy resource kind as false;
  // hiding this reusable schema would also remove the shape of that envelope.
  assert.ok(openapi.components.schemas.TakosumiResourceCapabilities);
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

test("public OpenAPI excludes retired managed-host and legacy source-less inputs", () => {
  const serialized = JSON.stringify(
    createTakosumiOpenApiDocument(ALL_MOUNTED),
  );
  assert.equal(serialized.includes("managedPublicHostname"), false);
  assert.equal(serialized.includes("managedPublicBaseDomain"), false);
  assert.equal(serialized.includes("operator_module"), false);
});

test("Interface OpenAPI schemas match current runtime and source-tree variants", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const schemas = openapi.components.schemas;

  assert.deepEqual(
    schemas.InterfaceOwnerRef.properties.kind.enum,
    ["Workspace", "Capsule"],
  );
  assert.deepEqual(
    schemas.InterfaceSubjectRef.properties.kind.enum,
    ["Principal", "ServiceAccount", "Capsule"],
  );

  assert.deepEqual(schemas.InterfaceInput.oneOf, [
    { $ref: "#/components/schemas/InterfaceLiteralInput" },
    { $ref: "#/components/schemas/InterfaceCapsuleOutputInput" },
  ]);
  assert.equal(schemas.CapsuleInterfaceBlueprintInput, undefined);
  assert.deepEqual(
    schemas.InterfaceMetadata.properties.materializedFrom.oneOf,
    [
      {
        type: "object",
        required: ["source", "key"],
        properties: {
          source: { const: "capsule_blueprint" },
          key: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      {
        type: "object",
        required: ["source", "descriptorName", "descriptorVersion"],
        properties: {
          source: { const: "portable_iac" },
          descriptorName: { type: "string", minLength: 1 },
          descriptorVersion: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    ],
  );

  const bindingMetadata = schemas.InterfaceBinding.properties.metadata;
  assert.deepEqual(bindingMetadata.properties.materializedFrom.oneOf, [
    {
      type: "object",
      required: ["source", "interfaceKey", "key"],
      properties: {
        source: { const: "capsule_blueprint" },
        interfaceKey: { type: "string", minLength: 1 },
        key: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      required: [
        "source",
        "capsuleId",
        "requirementKey",
        "interfaceType",
        "interfaceVersion",
      ],
      properties: {
        source: { const: "capsule_required_interface" },
        capsuleId: { type: "string", minLength: 1 },
        requirementKey: { type: "string", minLength: 1 },
        interfaceType: { type: "string", minLength: 1 },
        interfaceVersion: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
  ]);

  for (const retired of [
    "InterfaceResourceOutputInput",
    "resource_output",
    "capsule_resource",
    "compatibility_profile",
  ]) {
    assert.equal(schemas[retired], undefined, retired);
    assert.equal(JSON.stringify(schemas).includes(retired), false, retired);
    assert.equal(JSON.stringify(openapi).includes(retired), false, retired);
  }
  assert.equal(openapi.components.schemas.InterfaceResourceOutputInput, undefined);
});

test("legacy Resource Shape response schemas are not part of discovery", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  for (const schemaName of [
    "ListResourceShapesResponse",
    "ListTargetPoolsResponse",
    "ListSpacePoliciesResponse",
    "ListResourceEventsResponse",
  ] as const) {
    const schema = openapi.components.schemas[schemaName];
    assert.equal(schema, undefined, schemaName);
  }
});

test("FormActivation schemas and operator paths are hidden from discovery", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const collection = openapi.paths["/v1/form-activations"];
  const member = openapi.paths["/v1/form-activations/{id}"];
  assert.equal(collection, undefined);
  assert.equal(member, undefined);

  const activation = openapi.components.schemas.FormActivation;
  assert.equal(activation, undefined);
  assert.equal(
    openapi.components.schemas.CreateFormActivationRequest,
    undefined,
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

test("public Capsule schemas expose the closed sourceBuild contract", () => {
  const schemas = {
    ...capsuleAndInstallConfigSchemas(),
    ...workspaceProjectAndCapsuleRequestSchemas(),
  };
  assert.deepEqual(schemas.InstallConfig.properties.sourceBuild, {
    $ref: "#/components/schemas/SourceBuildConfig",
  });
  assert.deepEqual(schemas.CreateCapsuleRequest.properties.sourceBuild, {
    $ref: "#/components/schemas/SourceBuildConfig",
  });
  assert.equal(schemas.SourceBuildConfig.additionalProperties, false);
  assert.deepEqual(schemas.SourceBuildConfig.required, ["commands", "outputs"]);
});

test("compatibility providers separate reachable packages from root binding tuples", () => {
  const schemas = capsuleSchemas();
  const providerPackage = schemas.CapsuleProviderPackage;
  assert.ok(providerPackage);
  assert.deepEqual(providerPackage.required, ["source", "allowed"]);
  assert.deepEqual(Object.keys(providerPackage.properties).sort(), [
    "allowed",
    "source",
    "version",
  ]);
  assert.equal(providerPackage.additionalProperties, false);

  const rootRequirement = schemas.CapsuleRootProviderRequirement;
  assert.ok(rootRequirement);
  assert.deepEqual(rootRequirement.required, ["source", "moduleLocalName"]);
  assert.deepEqual(Object.keys(rootRequirement.properties).sort(), [
    "childAlias",
    "credentialRequired",
    "moduleLocalName",
    "source",
    "version",
  ]);
  assert.equal(rootRequirement.additionalProperties, false);
});

test("install module projection separates reachable packages from root binding tuples", () => {
  const schemas = sourceSchemas();
  const module = schemas.SourceSnapshotInstallModule;
  assert.ok(module);
  assert.deepEqual(module.required, [
    "path",
    "providerPackages",
    "rootProviderRequirements",
  ]);
  assert.deepEqual(Object.keys(module.properties).sort(), [
    "path",
    "providerPackages",
    "rootProviderRequirements",
  ]);
  assert.deepEqual(module.properties.providerPackages.items, {
    $ref: "#/components/schemas/RepositoryModuleProviderPackage",
  });
  assert.deepEqual(module.properties.rootProviderRequirements.items, {
    $ref: "#/components/schemas/RepositoryModuleRootProviderRequirement",
  });
  assert.equal(module.additionalProperties, false);
});

test("source OpenAPI keeps Git scope and archive-relative module coordinates distinct", () => {
  const schemas = sourceSchemas();
  const sourceDescription =
    schemas.Source.properties.defaultPath.description as string;
  const snapshotDescription =
    schemas.SourceSnapshot.properties.path.description as string;
  const response = schemas.SourceSnapshotInstallModulesResponse;
  const ready = response.oneOf[1];
  const scopeDescription = ready.properties.scopePath.description as string;
  const moduleDescription =
    schemas.SourceSnapshotInstallModule.properties.path.description as string;

  assert.match(sourceDescription, /Git repository subtree/u);
  assert.match(sourceDescription, /never selects an OpenTofu module/u);
  assert.match(snapshotDescription, /module paths are relative/u);
  assert.match(scopeDescription, /never joined/u);
  assert.match(moduleDescription, /relative to the SourceSnapshot archive/u);
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

test("legacy Resource deployment quote schema is not published", () => {
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  const quote = openapi.components.schemas.ResourceDeploymentQuote;
  assert.equal(quote, undefined);
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

test("backup restore is absent from the route inventory and OpenAPI schemas", () => {
  const endpoint = DEPLOY_CONTROL_ACTIVITY_ENDPOINTS.find(
    (item) => item.operationId === "createBackupRestore",
  );
  assert.equal(endpoint, undefined);
  const openapi = createTakosumiOpenApiDocument(ALL_MOUNTED);
  assert.equal(openapi.components.schemas.BackupRestoreTarget, undefined);
  assert.equal(openapi.components.schemas.CreateRestoreRequest, undefined);
  assert.equal(openapi.components.schemas.CreateRestoreResponse, undefined);
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
