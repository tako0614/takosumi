import assert from "node:assert/strict";
import {
  TAKOS_AGENT_CONTROL_INTERNAL_PATHS,
  TAKOS_AGENT_CONTROL_INTERNAL_PREFIX,
  type TakosActorContext,
} from "takosumi-contract";
import {
  signTakosInternalRequest,
  TAKOS_INTERNAL_AUDIENCE_HEADER,
  TAKOS_INTERNAL_CALLER_HEADER,
  TAKOS_INTERNAL_CAPABILITIES_HEADER,
} from "takosumi-contract/internal-rpc";
import { createApiApp } from "./app.ts";
import { TAKOS_AGENT_CONTROL_INVOKE_CAPABILITY } from "./agent_control_routes.ts";
import type { InternalRouteServices } from "./internal_routes.ts";

const actor: TakosActorContext = {
  actorAccountId: "takos-app",
  roles: ["service"],
  requestId: "req_agent_control",
  principalKind: "service",
  serviceId: "takos-app",
  spaceId: "space_1",
};

Deno.test("agent control route forwards canonical RPC to app backend with signed internal auth", async () => {
  const secret = "agent-control-secret";
  const backendRequests: Request[] = [];
  const app = await createApiApp({
    getInternalServiceSecret: () => secret,
    internalRouteServices: minimalInternalRouteServices(),
    agentControlRouteOptions: {
      backend: {
        forward(input) {
          const request = new Request(
            `https://app.internal/api/internal/v1/agent-control-backend/${input.endpoint}`,
            {
              method: "POST",
              headers: {
                "content-type": input.contentType ?? "application/json",
              },
              body: input.body,
            },
          );
          backendRequests.push(request);
          return Promise.resolve(Response.json({ ok: true }));
        },
      },
    },
  });
  const body = JSON.stringify({ runId: "run_1", spaceId: "space_1" });

  const response = await app.request(
    TAKOS_AGENT_CONTROL_INTERNAL_PATHS.heartbeat,
    {
      method: "POST",
      headers: await signedHeaders({
        secret,
        path: TAKOS_AGENT_CONTROL_INTERNAL_PATHS.heartbeat,
        body,
      }),
      body,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(backendRequests.length, 1);
  assert.equal(
    backendRequests[0].url,
    "https://app.internal/api/internal/v1/agent-control-backend/heartbeat",
  );
});

Deno.test("agent control route rejects unsigned canonical RPC", async () => {
  const app = await createApiApp({
    getInternalServiceSecret: () => "agent-control-secret",
    internalRouteServices: minimalInternalRouteServices(),
    agentControlRouteOptions: {
      backend: {
        forward: () => Promise.resolve(Response.json({ ok: true })),
      },
    },
  });

  const response = await app.request(
    TAKOS_AGENT_CONTROL_INTERNAL_PATHS.heartbeat,
    {
      method: "POST",
      body: JSON.stringify({ runId: "run_1" }),
    },
  );

  assert.equal(response.status, 401);
});

Deno.test("agent control route family is advertised in PaaS capabilities and OpenAPI", async () => {
  const app = await createApiApp({
    getInternalServiceSecret: () => "agent-control-secret",
    internalRouteServices: minimalInternalRouteServices(),
    agentControlRouteOptions: {
      backend: {
        forward: () => Promise.resolve(Response.json({ ok: true })),
      },
    },
  });

  const capabilities = await app.request("/capabilities");
  assert.equal(capabilities.status, 200);
  const capabilitiesBody = await capabilities.json();
  assert.ok(
    capabilitiesBody.endpoints.some((endpoint: {
      method: string;
      path: string;
    }) =>
      endpoint.method === "POST" &&
      endpoint.path === TAKOS_AGENT_CONTROL_INTERNAL_PATHS.heartbeat
    ),
  );

  const openapi = await app.request("/openapi.json");
  assert.equal(openapi.status, 200);
  const openapiBody = await openapi.json();
  assert.ok(openapiBody.paths[TAKOS_AGENT_CONTROL_INTERNAL_PATHS.heartbeat]);
  assert.ok(
    openapiBody["x-takos-mounted-route-families"].includes("agent-control"),
  );
  assert.equal(
    openapiBody.paths[`${TAKOS_AGENT_CONTROL_INTERNAL_PREFIX}/unknown`],
    undefined,
  );
});

async function signedHeaders(input: {
  readonly secret: string;
  readonly path: string;
  readonly body: string;
  readonly capabilities?: readonly string[];
}): Promise<Headers> {
  const signed = await signTakosInternalRequest({
    method: "POST",
    path: input.path,
    body: input.body,
    timestamp: new Date().toISOString(),
    actor,
    caller: "takos-app",
    audience: "takosumi",
    capabilities: input.capabilities ?? [TAKOS_AGENT_CONTROL_INVOKE_CAPABILITY],
    secret: input.secret,
  });
  const headers = new Headers({
    ...signed.headers,
    "content-type": "application/json",
  });
  assert.equal(headers.get(TAKOS_INTERNAL_CALLER_HEADER), "takos-app");
  assert.equal(headers.get(TAKOS_INTERNAL_AUDIENCE_HEADER), "takosumi");
  assert.equal(
    headers.get(TAKOS_INTERNAL_CAPABILITIES_HEADER),
    TAKOS_AGENT_CONTROL_INVOKE_CAPABILITY,
  );
  return headers;
}

function minimalInternalRouteServices() {
  return {
    core: {
      spaceQueries: { listInternalSpaceSummaries: () => Promise.resolve([]) },
      spaces: { createSpace: () => Promise.resolve({ ok: true, value: {} }) },
      groupQueries: { listGroups: () => Promise.resolve([]) },
      groups: { createGroup: () => Promise.resolve({ ok: true, value: {} }) },
    },
    planService: { createPlan: () => Promise.resolve({ id: "plan_unused" }) },
    applyService: {
      applyManifest: () => Promise.resolve({ id: "apply_unused" }),
    },
  } as unknown as InternalRouteServices;
}
