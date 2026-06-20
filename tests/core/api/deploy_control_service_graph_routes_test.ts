import { expect, test } from "bun:test";

import { createApiApp } from "../../../core/api/app.ts";
import { OpenTofuDeploymentController } from "../../../core/domains/deploy-control/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../core/domains/deploy-control/store.ts";
import {
  InMemoryServiceBindingStore,
  InMemoryServiceExportStore,
  InMemoryServiceGraphGrantStore,
  ServiceGraphService,
} from "../../../core/domains/service-graph/mod.ts";

const SPACE_ID = "space_servicegraph";
const AUTH = {
  authorization: "Bearer deploy-control-token",
  "content-type": "application/json",
} as const;

async function makeApp() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const grants = new InMemoryServiceGraphGrantStore();
  const serviceGraphService = new ServiceGraphService({
    stores: {
      exports: new InMemoryServiceExportStore(),
      bindings: new InMemoryServiceBindingStore(),
      grants,
    },
    clock: () => "2026-06-17T00:00:00.000Z",
    idGenerator: (prefix) => `${prefix}_test`,
  });
  await store.putInstallation(installation("inst_producer", "producer"));
  await store.putInstallation(installation("inst_consumer", "consumer"));
  const app = await createApiApp({
    registerDeployControlInternalRoutes: true,
    deployControlInternalRouteOptions: {
      controller: new OpenTofuDeploymentController({ store }),
      serviceGraphService,
      authorizeDeployControlBearer: ({ token }) =>
        token === "deploy-control-token"
          ? {
              actor: "tester",
              spaceIds: [SPACE_ID],
              operations: "*",
              runnerProfileIds: "*",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  return { app, grants };
}

test("ServiceGrant issue route rejects caller secretRef and omits internal fields", async () => {
  const { app, grants } = await makeApp();

  const exportRes = await app.request(
    `/internal/v1/spaces/${SPACE_ID}/service-exports`,
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        id: "sexp_mcp",
        producerCapsuleId: "inst_producer",
        name: "tools",
        capabilities: ["protocol.mcp.server"],
        endpoints: [{ name: "mcp", url: "https://tools.example.test/mcp" }],
        auth: [{ scheme: "bearer", scopes: ["mcp.invoke"] }],
        visibility: "space",
      }),
    },
  );
  expect(exportRes.status).toBe(201);
  const exportPayloadText = await exportRes.clone().text();
  expect(exportPayloadText).toContain("producerCapsuleId");
  expect(exportPayloadText).not.toContain("producerInstallationId");

  const bindingRes = await app.request(
    "/internal/v1/installations/inst_consumer/service-bindings",
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        id: "sbind_agent",
        target: { kind: "workload", name: "agent-runtime" },
        selector: { capabilities: ["protocol.mcp.server"], name: "tools" },
        grantRequest: {
          scopes: ["mcp.invoke"],
          audience: ["inst_consumer"],
          env: ["MCP_BASE_URL", "MCP_TOKEN"],
        },
      }),
    },
  );
  expect(bindingRes.status).toBe(201);

  const resolveRes = await app.request(
    "/internal/v1/service-bindings/sbind_agent/resolve",
    {
      method: "POST",
      headers: AUTH,
    },
  );
  expect(resolveRes.status).toBe(200);

  const secretRefRes = await app.request(
    "/internal/v1/service-bindings/sbind_agent/grants",
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        id: "sgrant_agent",
        material: { baseUrlEnv: "MCP_BASE_URL", tokenEnv: "MCP_TOKEN" },
        secretRef: "vault://service-grants/sgrant_agent/token",
      }),
    },
  );
  expect(secretRefRes.status).toBe(400);

  const grantRes = await app.request(
    "/internal/v1/service-bindings/sbind_agent/grants",
    {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        id: "sgrant_agent",
        material: { baseUrlEnv: "MCP_BASE_URL", tokenEnv: "MCP_TOKEN" },
      }),
    },
  );
  expect(grantRes.status).toBe(201);
  const grantPayloadText = await grantRes.text();
  expect(grantPayloadText).not.toContain("secretRef");
  expect(grantPayloadText).not.toContain("vault://");

  const stored = await grants.get("sgrant_agent");
  expect(stored?.secretRef).toBeUndefined();
});

function installation(id: string, name: string) {
  return {
    id,
    spaceId: SPACE_ID,
    name,
    slug: name,
    sourceId: "src_service_graph",
    installType: "opentofu_module" as const,
    installConfigId: "icfg_service_graph",
    environment: "production",
    currentStateGeneration: 0,
    status: "active" as const,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };
}
