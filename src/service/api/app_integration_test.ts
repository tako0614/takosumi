import { test } from "bun:test";
import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract/reference/compat";
import { signTakosumiInternalRequest } from "takosumi-contract/internal/rpc";
import { InMemoryRuntimeAgentRegistry } from "../agents/mod.ts";
import { createInMemoryAppContext } from "../app_context.ts";
import { createApiApp } from "./app.ts";
import { TAKOSUMI_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

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
      getDeployControlToken: () => "deploy-control-token",
    },
  });

  for (
    const path of [
      "/api/public/v1/capabilities",
      "/api/public/v1/deployments",
      "/v1/deployments",
    ]
  ) {
    const response = await app.request(path, { method: "POST" });
    assert.equal(response.status, 404, path);
  }

  const capabilities = await (await app.request("/capabilities")).json();
  const endpointPaths = capabilities.endpoints.map((
    endpoint: { path: string },
  ) => endpoint.path);
  assert.ok(endpointPaths.includes("/v1/plan-runs"));
  assert.ok(endpointPaths.includes("/v1/apply-runs"));
  assert.equal(
    endpointPaths.some((path: string) => path.includes("/api/public/v1")),
    false,
  );
  assert.equal(endpointPaths.includes("/v1/deployments"), false);

  const openapi = await (await app.request("/openapi.json")).json();
  assert.ok(openapi.paths["/v1/plan-runs"]);
  assert.ok(openapi.paths["/v1/apply-runs"]);
  assert.ok(openapi.paths["/v1/installations/{installationId}"]);
  assert.ok(openapi.paths["/v1/installations/{installationId}/deployments"]);
  assert.equal(openapi.paths["/v1/installations"], undefined);
  assert.equal(
    openapi.paths["/v1/installations/:installationId/deployments"],
    undefined,
  );
  assert.equal(openapi.paths["/api/public/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/deployments"], undefined);
  assert.equal(openapi.paths["/v1/artifacts/kinds"], undefined);
  assert.equal(openapi.components.schemas.StatusSummaryResponse, undefined);
  assert.equal(
    openapi.paths["/v1/plan-runs"].post.requestBody.content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/CreatePlanRunRequest",
  );
  assert.equal(
    openapi.components.schemas.ErrorResponse.properties.error.required
      .includes("requestId"),
    true,
  );
  assert.ok(
    openapi.components.schemas.RunnerProfile.properties
      .cloudflareWorkersForPlatforms,
  );
  assert.ok(
    openapi.components.schemas.RunnerProfile.properties.secretExposurePolicy,
  );
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
