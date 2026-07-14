import { test } from "bun:test";
import assert from "node:assert/strict";
import { TAKOSUMI_API_VERSION } from "../../../contract/capabilities.ts";
import {
  TAKOSUMI_PRODUCT_CAPABILITIES_PATH,
  TAKOSUMI_WELL_KNOWN_PATH,
} from "../../../contract/api-surface.ts";
import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuController } from "../../../core/domains/deploy-control/mod.ts";

test("createApiApp exposes /openapi.json when enabled", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
    getOpenApiBearerToken: () => "openapi-token",
  });

  const missing = await app.request("/openapi.json");
  assert.equal(missing.status, 401);

  const response = await app.request("/openapi.json", {
    headers: { authorization: "Bearer openapi-token" },
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openapi, "3.1.0");
  assert.equal(body.info.title, "Takosumi process route inventory");
  assert.ok(body.paths["/capabilities"]);
  // `/health` was removed in favor of worker-level `/healthz` liveness; the
  // in-process API app no longer exposes a process health route.
  assert.equal(body.paths["/health"], undefined);
});

test("createApiApp hides /openapi.json when no operator bearer is configured", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
  });

  const response = await app.request("/openapi.json");

  assert.equal(response.status, 404);
});

test("createApiApp gates /capabilities with the inventory bearer", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
    getOpenApiBearerToken: () => "openapi-token",
  });

  assert.equal((await app.request("/capabilities")).status, 401);
  assert.equal(
    (
      await app.request("/capabilities", {
        headers: { authorization: "Bearer wrong" },
      })
    ).status,
    401,
  );

  const response = await app.request("/capabilities", {
    headers: { authorization: "Bearer openapi-token" },
  });
  assert.equal(response.status, 200);
});

test("createApiApp hides /capabilities when no inventory bearer is configured", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
  });

  assert.equal((await app.request("/capabilities")).status, 404);
});

test("createApiApp exposes product discovery without inventory auth", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
  });

  const response = await app.request(
    `https://takosumi.example.test${TAKOSUMI_WELL_KNOWN_PATH}`,
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.api_versions, [TAKOSUMI_API_VERSION]);
  assert.equal(
    body.endpoints.capabilities,
    `https://takosumi.example.test${TAKOSUMI_PRODUCT_CAPABILITIES_PATH}`,
  );
});

test("createApiApp exposes product capabilities without inventory auth", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
  });

  const response = await app.request(TAKOSUMI_PRODUCT_CAPABILITIES_PATH);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.apiVersion, TAKOSUMI_API_VERSION);
  assert.equal(body.resources.Stack, true);
  assert.equal(body.compat.framework, true);
  assert.equal(body.operator.runner_pools, false);
  assert.equal(body.operator.cli_api_operations, false);
});

test("createApiApp can advertise Operator operations without an admin UI capability", async () => {
  const app = await createApiApp({
    operatorCapabilities: {
      runner_pools: true,
      operator_connections: true,
      db_backed_configuration: true,
      cli_api_operations: true,
      audit_evidence: true,
    },
  });

  const response = await app.request(TAKOSUMI_PRODUCT_CAPABILITIES_PATH);

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.operator.runner_pools, true);
  assert.equal(body.operator.operator_connections, true);
  assert.equal(body.operator.db_backed_configuration, true);
  assert.equal(body.operator.cli_api_operations, true);
  assert.equal(body.operator.audit_evidence, true);
  assert.equal(Object.hasOwn(body.operator, "operator_console"), false);
});

test("createApiApp does not mount retired public deployment routes", async () => {
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    registerOpenApiRoute: true,
    getOpenApiBearerToken: () => "openapi-token",
    deployControlInternalRouteOptions: {
      controller: new OpenTofuController(),
      getDeployControlToken: () => "deploy-control-token",
    },
  });

  for (const [method, path] of [
    ["POST", "/api/public/v1/capabilities"],
    ["POST", "/api/public/v1/deployments"],
    ["POST", "/v1/deployments"],
    ["POST", "/internal/v1/plan-runs"],
    ["POST", "/internal/v1/apply-runs"],
    ["GET", "/internal/v1/runner-profiles"],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 404, path);
  }

  // The canonical Capsule Output route is mounted. A retired Installation-
  // shaped id reaches the authenticated route family but fails canonical
  // Capsule id validation rather than being interpreted as an alias.
  const retiredOutputId = await app.request(
    "/internal/v1/capsules/inst_abcdef12/outputs",
    {
      headers: { authorization: "Bearer deploy-control-token" },
    },
  );
  assert.equal(retiredOutputId.status, 400);

  const capabilities = await (
    await app.request("/capabilities", {
      headers: { authorization: "Bearer openapi-token" },
    })
  ).json();
  const endpointPaths = capabilities.endpoints.map(
    (endpoint: { path: string }) => endpoint.path,
  );
  // The internal ledger seam (plan-runs / apply-runs / runner-profiles /
  // deployment-outputs) must never surface in the public inventory.
  assert.equal(endpointPaths.includes("/internal/v1/plan-runs"), false);
  assert.equal(endpointPaths.includes("/internal/v1/apply-runs"), false);
  assert.equal(endpointPaths.includes("/internal/v1/runner-profiles"), false);
  assert.equal(
    endpointPaths.includes("/internal/v1/capsules/:installationId/outputs"),
    false,
  );
  assert.equal(
    endpointPaths.some((path: string) => path.includes("/api/public/v1")),
    false,
  );
  assert.equal(endpointPaths.includes("/v1/deployments"), false);

  const openapi = await (
    await app.request("/openapi.json", {
      headers: { authorization: "Bearer openapi-token" },
    })
  ).json();
  assert.equal(openapi.paths["/internal/v1/plan-runs"], undefined);
  assert.equal(openapi.paths["/internal/v1/apply-runs"], undefined);
  assert.equal(openapi.paths["/internal/v1/runner-profiles"], undefined);
  assert.equal(
    openapi.paths["/internal/v1/capsules/{installationId}/outputs"],
    undefined,
  );
  assert.equal(openapi.paths["/api/public/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/deployments"], undefined);
  assert.equal(openapi.paths["/internal/v1/artifacts/kinds"], undefined);
  assert.equal(openapi.paths["/internal/v1/provider-envs"], undefined);
  assert.equal(
    openapi.paths["/internal/v1/provider-envs/{providerEnvId}"],
    undefined,
  );
  assert.equal(
    openapi.components.schemas.ErrorResponse.properties.error.required.includes(
      "requestId",
    ),
    true,
  );
  assert.equal(openapi.components.schemas.RunnerProfile, undefined);
  assert.equal(
    openapi.components.schemas.Installation,
    undefined,
    "Installation is owned by the public /api/v1 session inventory, not the process inventory",
  );
  assert.equal(
    openapi.components.schemas.InstallConfig,
    undefined,
    "InstallConfig is owned by the public /api/v1 session inventory, not the process inventory",
  );
  assert.equal(openapi.components.schemas.PlanRun, undefined);
  assert.equal(openapi.components.schemas.ApplyRun, undefined);
  assert.equal(openapi.components.schemas.ProjectedOutput, undefined);
  for (const schemaName of [
    "Output",
    "Deployment",
    "Dependency",
    "DependencyResponse",
    "ListActivityResponse",
    "CreateBackupResponse",
    "ListBackupsResponse",
    "CreateInstallationRequest",
    "PatchInstallationRequest",
    "CreateSpaceRequest",
    "SpaceResponse",
    "ListSpacesResponse",
    "DeploymentResponse",
    "CreateOutputShareRequest",
    "OutputShareResponse",
    "ListOutputSharesResponse",
  ] as const) {
    assert.equal(
      openapi.components.schemas[schemaName],
      undefined,
      `${schemaName} is owned by the public /api/v1 session inventory, not the process inventory`,
    );
  }
  assert.equal(
    openapi.components.schemas.CapabilitiesResponse.properties.endpoints.items
      .$ref,
    "#/components/schemas/ApiEndpointDescription",
  );
  assert.equal(openapi.components.schemas.ProviderEnv, undefined);
  assert.equal(openapi.components.schemas.ProviderEnvResponse, undefined);
  assert.equal(openapi.components.schemas.ListProviderEnvsResponse, undefined);
  assert.equal(openapi.components.schemas.PutProviderEnvRequest, undefined);
  assert.equal(openapi.components.schemas.ServiceGrant, undefined);
  assert.equal(openapi.components.schemas.CreateServiceGrantRequest, undefined);
  for (const schemaName of ["CapabilitiesResponse"] as const) {
    assert.notEqual(
      openapi.components.schemas[schemaName].additionalProperties,
      true,
      `${schemaName} must not regress to the generic jsonObject placeholder`,
    );
  }
});
