import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract/reference/compat";
import { signTakosumiInternalRequest } from "takosumi-contract/internal/rpc";
import { InMemoryRuntimeAgentRegistry } from "../agents/mod.ts";
import { createInMemoryAppContext } from "../app_context.ts";
import { createApiApp } from "./app.ts";
import { TAKOSUMI_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";
import { OpenTofuDeploymentController } from "../domains/deploy-control/mod.ts";

test("createApiApp exposes /openapi.json when enabled", async () => {
  const app = await createApiApp({
    registerOpenApiRoute: true,
  });

  const response = await app.request("/openapi.json");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openapi, "3.1.0");
  assert.equal(body.info.title, "Takosumi API");
  assert.ok(body.paths["/health"]);
});

test("createApiApp does not mount retired public deployment routes", async () => {
  const app = await createApiApp({
    registerDeployControlPublicRoutes: true,
    registerOpenApiRoute: true,
    deployControlPublicRouteOptions: {
      controller: new OpenTofuDeploymentController(),
      getDeployControlToken: () => "deploy-control-token",
    },
  });

  for (const [method, path] of [
    ["POST", "/api/public/v1/capabilities"],
    ["POST", "/api/public/v1/deployments"],
    ["POST", "/v1/deployments"],
    ["POST", "/v1/plan-runs"],
    ["POST", "/v1/apply-runs"],
    ["GET", "/v1/runner-profiles"],
    ["GET", "/v1/installations/inst_abcdef12/deployment-outputs"],
  ] as const) {
    const response = await app.request(path, { method });
    assert.equal(response.status, 404, path);
  }

  const capabilities = await (await app.request("/capabilities")).json();
  const endpointPaths = capabilities.endpoints.map(
    (endpoint: { path: string }) => endpoint.path,
  );
  assert.equal(endpointPaths.includes("/v1/plan-runs"), false);
  assert.equal(endpointPaths.includes("/v1/apply-runs"), false);
  assert.equal(endpointPaths.includes("/v1/runner-profiles"), false);
  assert.equal(
    endpointPaths.includes("/v1/installations/:installationId/deployments"),
    false,
  );
  assert.equal(
    endpointPaths.some((path: string) => path.includes("/api/public/v1")),
    false,
  );
  assert.equal(endpointPaths.includes("/v1/deployments"), false);

  const openapi = await (await app.request("/openapi.json")).json();
  assert.equal(openapi.paths["/v1/plan-runs"], undefined);
  assert.equal(openapi.paths["/v1/apply-runs"], undefined);
  assert.equal(openapi.paths["/v1/runner-profiles"], undefined);
  assert.equal(openapi.paths["/v1/installations/{installationId}"], undefined);
  assert.equal(
    openapi.paths["/v1/installations/{installationId}/deployments"],
    undefined,
  );
  assert.equal(openapi.paths["/v1/installations"], undefined);
  assert.equal(
    openapi.paths["/v1/installations/:installationId/deployments"],
    undefined,
  );
  assert.equal(openapi.paths["/api/public/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/artifacts/kinds"], undefined);
  assert.equal(
    openapi.paths["/api/operator-connection-defaults"]?.get?.operationId,
    "listOperatorConnectionDefaults",
  );
  assert.equal(
    openapi.paths["/api/operator-connection-defaults"]?.put?.operationId,
    "putOperatorConnectionDefault",
  );
  assert.equal(
    openapi.components.schemas.ErrorResponse.properties.error.required.includes(
      "requestId",
    ),
    true,
  );
  assert.equal(openapi.components.schemas.RunnerProfile, undefined);
  assert.equal(
    openapi.components.schemas.Installation.properties.installType,
    undefined,
  );
  assert.equal(
    openapi.components.schemas.InstallConfig.properties.installType,
    undefined,
  );
  assert.equal(
    openapi.components.schemas.InstallConfig.properties.templateBinding,
    undefined,
  );
  assert.equal(openapi.components.schemas.PlanRun, undefined);
  assert.equal(openapi.components.schemas.ApplyRun, undefined);
  assert.equal(openapi.components.schemas.DeploymentOutput, undefined);
  assert.equal(
    openapi.components.schemas.OutputSnapshot.properties.publicOutputs.type,
    "object",
  );
  assert.equal(
    openapi.components.schemas.OutputSnapshot.properties.spaceOutputs.type,
    "object",
  );
  assert.deepEqual(
    openapi.components.schemas.Dependency.required,
    [
      "id",
      "spaceId",
      "producerInstallationId",
      "consumerInstallationId",
      "mode",
      "outputs",
      "visibility",
      "createdAt",
    ],
  );
  assert.equal(
    openapi.components.schemas.DependencyResponse.properties.dependency.$ref,
    "#/components/schemas/Dependency",
  );
  assert.equal(
    openapi.components.schemas.ListActivityResponse.properties.events.items.$ref,
    "#/components/schemas/ActivityEvent",
  );
  assert.equal(
    openapi.components.schemas.CreateBackupResponse.properties.backup.$ref,
    "#/components/schemas/BackupRecord",
  );
  assert.equal(
    openapi.components.schemas.ListBackupsResponse.properties.backups.items.$ref,
    "#/components/schemas/BackupRecord",
  );
  assert.deepEqual(
    openapi.components.schemas.CreateInstallationRequest.required,
    ["name", "environment", "sourceId", "installConfigId"],
  );
  assert.deepEqual(
    openapi.components.schemas.PatchInstallationRequest.required,
    ["status"],
  );
  assert.deepEqual(
    openapi.components.schemas.PatchInstallationRequest.properties.status.enum,
    ["active", "stale", "error"],
  );
  assert.deepEqual(
    openapi.components.schemas.CreateSpaceRequest.required,
    ["handle", "displayName", "type", "ownerUserId"],
  );
  assert.equal(
    openapi.components.schemas.SpaceResponse.properties.space.$ref,
    "#/components/schemas/Space",
  );
  assert.equal(
    openapi.components.schemas.ListSpacesResponse.properties.spaces.items.$ref,
    "#/components/schemas/Space",
  );
  assert.equal(
    openapi.components.schemas.DeploymentResponse.properties.deployment.$ref,
    "#/components/schemas/Deployment",
  );
  assert.equal(
    openapi.components.schemas.CreateOutputShareRequest.properties.outputs.items
      .$ref,
    "#/components/schemas/CreateOutputShareEntry",
  );
  assert.equal(
    openapi.components.schemas.OutputShareResponse.properties.share.$ref,
    "#/components/schemas/OutputShare",
  );
  assert.equal(
    openapi.components.schemas.ListOutputSharesResponse.properties.shares.items
      .$ref,
    "#/components/schemas/OutputShare",
  );
  assert.equal(
    openapi.components.schemas.CapabilitiesResponse.properties.endpoints.items
      .$ref,
    "#/components/schemas/ApiEndpointDescription",
  );
  assert.equal(
    openapi.components.schemas.OperatorConnectionDefaultResponse.properties
      .operatorConnectionDefault.$ref,
    "#/components/schemas/OperatorConnectionDefault",
  );
  assert.equal(
    openapi.components.schemas.ListOperatorConnectionDefaultsResponse.properties
      .operatorConnectionDefaults.items.$ref,
    "#/components/schemas/OperatorConnectionDefault",
  );
  for (const schemaName of [
    "CreateSpaceRequest",
    "SpaceResponse",
    "ListSpacesResponse",
    "OperatorConnectionDefaultResponse",
    "ListOperatorConnectionDefaultsResponse",
    "DeploymentResponse",
    "PatchInstallationRequest",
    "CreateOutputShareRequest",
    "OutputShareResponse",
    "ListOutputSharesResponse",
    "CapabilitiesResponse",
  ] as const) {
    assert.notEqual(
      openapi.components.schemas[schemaName].additionalProperties,
      true,
      `${schemaName} must not regress to the generic jsonObject placeholder`,
    );
  }
});

test("createApiApp mounts runtime-agent routes fail-closed when enabled", async () => {
  const app = await createApiApp({
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
  });

  const response = await app.request(TAKOSUMI_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({ agentId: "agent_1", provider: "local" }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthenticated");
});

test("createApiApp accepts signed v1 runtime-agent routes when enabled", async () => {
  const secret = "runtime-agent-secret";
  const app = await createApiApp({
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
    getInternalServiceSecret: () => secret,
  });
  const body = JSON.stringify({ agentId: "agent_1", provider: "local" });

  const response = await app.request(TAKOSUMI_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOSUMI_RUNTIME_AGENT_PATHS.enroll,
      body,
      actor: {
        actorAccountId: "acct_runtime",
        roles: ["admin"],
        requestId: "req_runtime_enroll",
        principalKind: "agent",
        agentId: "wi_runtime_agent",
      },
    }),
    body,
  });

  assert.equal(response.status, 201);
  const responseBody = await response.json();
  assert.equal(responseBody.agent.id, "agent_1");
  assert.equal(responseBody.agent.provider, "local");
});

test("createApiApp uses context runtime-agent registry for mounted routes", async () => {
  const secret = "runtime-agent-secret";
  const registry = new InMemoryRuntimeAgentRegistry();
  const context = createInMemoryAppContext({
    adapters: { runtimeAgent: registry },
  });
  const app = await createApiApp({
    context,
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
    getInternalServiceSecret: () => secret,
  });
  const body = JSON.stringify({ agentId: "agent_context", provider: "local" });

  const response = await app.request(TAKOSUMI_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOSUMI_RUNTIME_AGENT_PATHS.enroll,
      body,
      actor: {
        actorAccountId: "acct_runtime",
        roles: ["admin"],
        requestId: "req_runtime_context",
        principalKind: "agent",
        agentId: "wi_runtime_agent",
      },
    }),
    body,
  });

  assert.equal(response.status, 201);
  assert.equal((await registry.getAgent("agent_context"))?.provider, "local");
});

async function signedHeaders(input: {
  readonly secret: string;
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly actor: TakosumiActorContext;
}): Promise<Headers> {
  const signed = await signTakosumiInternalRequest({
    ...input,
    timestamp: new Date().toISOString(),
    caller: input.actor.serviceId ?? input.actor.agentId ?? "takos-test",
    audience: "takosumi",
  });
  return new Headers({
    ...signed.headers,
    "content-type": "application/json",
  });
}
