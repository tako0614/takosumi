import assert from "node:assert/strict";
import type { TakosumiActorContext } from "takosumi-contract";
import { signTakosumiInternalRequest } from "takosumi-contract/internal-rpc";
import { InMemoryRuntimeAgentRegistry } from "../agents/mod.ts";
import { createInMemoryAppContext } from "../app_context.ts";
import { createApiApp } from "./app.ts";
import { TAKOS_PAAS_RUNTIME_AGENT_PATHS } from "./runtime_agent_routes.ts";

Deno.test("createApiApp exposes /openapi.json when enabled", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerOpenApiRoute: true,
  });

  const response = await app.request("/openapi.json");

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openapi, "3.1.0");
  assert.equal(body.info.title, "Takosumi API");
  assert.ok(body.paths["/health"]);
});

Deno.test("createApiApp mounts runtime-agent routes fail-closed when enabled", async () => {
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
  });

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    body: JSON.stringify({ agentId: "agent_1", provider: "local" }),
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "unauthenticated");
});

Deno.test("createApiApp accepts signed v1 runtime-agent routes when enabled", async () => {
  const secret = "runtime-agent-secret";
  const app = await createApiApp({
    registerInternalRoutes: false,
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
    getInternalServiceSecret: () => secret,
  });
  const body = JSON.stringify({ agentId: "agent_1", provider: "local" });

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll,
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

Deno.test("createApiApp uses context runtime-agent registry for mounted routes", async () => {
  const secret = "runtime-agent-secret";
  const registry = new InMemoryRuntimeAgentRegistry();
  const context = createInMemoryAppContext({
    adapters: { runtimeAgent: registry },
  });
  const app = await createApiApp({
    context,
    registerInternalRoutes: false,
    registerRuntimeAgentRoutes: true,
    role: "takosumi-runtime-agent",
    getInternalServiceSecret: () => secret,
  });
  const body = JSON.stringify({ agentId: "agent_context", provider: "local" });

  const response = await app.request(TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll, {
    method: "POST",
    headers: await signedHeaders({
      secret,
      method: "POST",
      path: TAKOS_PAAS_RUNTIME_AGENT_PATHS.enroll,
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
