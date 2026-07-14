import { expect, test } from "bun:test";
import { createApiApp } from "../../../core/api/app.ts";
import { createInMemoryAppContext } from "../../../core/app_context.ts";
import { createTakosumiService } from "../../../core/bootstrap.ts";
import { declaredDurableTestOpenTofuStore } from "../../helpers/deploy-control/durable_test_store.ts";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
} from "../../../core/domains/interfaces/mod.ts";

async function app() {
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-13T12:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
  });
  return await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      getInterfaceBearerToken: () => "interface-token",
    },
    requestCorrelation: false,
  });
}

const headers = {
  "content-type": "application/json",
  authorization: "Bearer interface-token",
};

test("Interface CRUD is bearer protected and desired writes use ETag", async () => {
  const api = await app();
  expect((await api.request("/v1/interfaces?workspaceId=ws_1")).status).toBe(
    401,
  );

  const created = await api.request("/v1/interfaces", {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspaceId: "ws_1",
      name: "mcp",
      ownerRef: { kind: "Workspace", id: "ws_1" },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: { transport: "streamable-http" },
        inputs: {
          endpoint: {
            source: "literal",
            value: "https://mcp.example.test/mcp",
          },
        },
        access: { visibility: "workspace" },
      },
    }),
  });
  expect(created.status).toBe(201);
  const record = await created.json();
  const etag = created.headers.get("etag");
  expect(etag).toBe('"if-1-1"');

  const stale = await api.request(`/v1/interfaces/${record.metadata.id}`, {
    method: "PATCH",
    headers: { ...headers, "if-match": '"if-0-0"' },
    body: JSON.stringify({ labels: { protocol: "mcp" } }),
  });
  expect(stale.status).toBe(412);

  const updated = await api.request(`/v1/interfaces/${record.metadata.id}`, {
    method: "PATCH",
    headers: { ...headers, "if-match": etag! },
    body: JSON.stringify({ labels: { protocol: "mcp" } }),
  });
  expect(updated.status).toBe(200);
  expect(updated.headers.get("etag")).toBe('"if-2-2"');

  const listed = await api.request(
    "/v1/interfaces?workspaceId=ws_1&type=mcp.server&phase=Resolved",
    { headers },
  );
  expect(listed.status).toBe(200);
  expect((await listed.json()).interfaces).toHaveLength(1);
});

test("Interface API rejects malformed records as 400 instead of throwing", async () => {
  const api = await app();
  for (const body of [
    {},
    {
      workspaceId: "ws_1",
      name: "broken",
      ownerRef: null,
      spec: null,
    },
    {
      workspaceId: "ws_1",
      name: "broken-input",
      ownerRef: { kind: "Workspace", id: "ws_1" },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: {},
        inputs: { endpoint: null },
        access: { visibility: "workspace" },
      },
    },
  ]) {
    const response = await api.request("/v1/interfaces", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(400);
  }
});

test("Interface API scoped bearer cannot cross Workspace boundaries", async () => {
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-13T12:00:00.000Z",
  });
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) =>
        token === "workspace-a-token"
          ? {
              actorAccountId: "principal_a",
              roles: ["member"],
              requestId: "req_a",
              workspaceId: "workspace_a",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  const response = await api.request("/v1/interfaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer workspace-a-token",
    },
    body: JSON.stringify({
      workspaceId: "workspace_b",
      name: "cross-tenant",
      ownerRef: { kind: "Workspace", id: "workspace_b" },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: {},
        access: { visibility: "workspace" },
      },
    }),
  });
  expect(response.status).toBe(403);
});

test("unscoped Interface actors require current Workspace authorization", async () => {
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-13T12:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const seeded = await service.create({
    workspaceId: "workspace_a",
    name: "seeded",
    ownerRef: { kind: "Workspace", id: "workspace_a" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      access: { visibility: "private" },
    },
  });
  const actorFor = (token: string) =>
    token === "owner-a" || token === "owner-b"
      ? {
          actorAccountId: token,
          roles: ["editor"],
          requestId: `req_${token}`,
          principalKind: "account" as const,
        }
      : undefined;
  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => actorFor(token),
      authorizeInterfaceWorkspace: ({ actor, workspaceId }) =>
        actor.actorAccountId === "owner-a" && workspaceId === "workspace_a",
    },
    requestCorrelation: false,
  });
  const ownerHeaders = {
    authorization: "Bearer owner-a",
    "content-type": "application/json",
  };
  const deniedHeaders = {
    authorization: "Bearer owner-b",
    "content-type": "application/json",
  };
  const createBody = JSON.stringify({
    workspaceId: "workspace_a",
    name: "created-by-owner",
    ownerRef: { kind: "Workspace", id: "workspace_a" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: {},
      access: { visibility: "private" },
    },
  });

  expect(
    (
      await api.request("/v1/interfaces", {
        method: "POST",
        headers: deniedHeaders,
        body: createBody,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api.request("/v1/interfaces?workspaceId=workspace_a", {
        headers: deniedHeaders,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await api.request(`/v1/interfaces/${seeded.metadata.id}/bindings`, {
        method: "POST",
        headers: deniedHeaders,
        body: JSON.stringify({
          subjectRef: { kind: "Principal", id: "principal_b" },
          permissions: ["mcp.invoke"],
          delivery: { type: "none" },
        }),
      })
    ).status,
  ).toBe(403);

  expect(
    (
      await api.request("/v1/interfaces", {
        method: "POST",
        headers: ownerHeaders,
        body: createBody,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await api.request("/v1/interfaces?workspaceId=workspace_a", {
        headers: ownerHeaders,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await api.request(`/v1/interfaces/${seeded.metadata.id}/bindings`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({
          subjectRef: { kind: "Principal", id: "principal_a" },
          permissions: ["mcp.invoke"],
          delivery: { type: "none" },
        }),
      })
    ).status,
  ).toBe(201);

  const failClosed = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => actorFor(token),
    },
    requestCorrelation: false,
  });
  expect(
    (
      await failClosed.request("/v1/interfaces?workspaceId=workspace_a", {
        headers: ownerHeaders,
      })
    ).status,
  ).toBe(403);
});

test("runtime OAuth principals only discover currently bound Interfaces", async () => {
  let id = 0;
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-13T12:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
  });
  const createInterface = (name: string) =>
    service.create({
      workspaceId: "workspace_a",
      name,
      ownerRef: { kind: "Workspace", id: "workspace_a" },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: { transport: "streamable-http" },
        inputs: {
          endpoint: {
            source: "literal" as const,
            value: `https://${name}.example.test/mcp`,
          },
        },
        access: { visibility: "private" },
      },
    });
  const allowed = await createInterface("allowed");
  const hidden = await createInterface("hidden");
  await service.createBinding(allowed.metadata.id, {
    subjectRef: { kind: "Principal", id: "pairwise_a" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });
  await service.createBinding(hidden.metadata.id, {
    subjectRef: { kind: "Principal", id: "pairwise_b" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });

  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) =>
        token === "runtime-a"
          ? {
              actorAccountId: "pairwise_a",
              roles: ["runtime-principal"],
              requestId: "req_runtime_a",
              workspaceId: "workspace_a",
              principalKind: "account",
            }
          : undefined,
    },
    requestCorrelation: false,
  });
  const runtimeHeaders = { authorization: "Bearer runtime-a" };

  const missingPermission = await api.request(
    "/v1/interfaces?workspaceId=workspace_a&type=mcp.server",
    { headers: runtimeHeaders },
  );
  expect(missingPermission.status).toBe(400);

  const listed = await api.request(
    "/v1/interfaces?workspaceId=workspace_a&type=mcp.server&permission=mcp.invoke",
    { headers: runtimeHeaders },
  );
  expect(listed.status).toBe(200);
  expect(
    (await listed.json()).interfaces.map(
      (entry: { metadata: { id: string } }) => entry.metadata.id,
    ),
  ).toEqual([allowed.metadata.id]);

  const hiddenRead = await api.request(
    `/v1/interfaces/${hidden.metadata.id}?permission=mcp.invoke`,
    { headers: runtimeHeaders },
  );
  expect(hiddenRead.status).toBe(404);

  const bindings = await api.request(
    `/v1/interfaces/${allowed.metadata.id}/bindings?permission=mcp.invoke`,
    { headers: runtimeHeaders },
  );
  expect(bindings.status).toBe(200);
  expect((await bindings.json()).bindings).toHaveLength(1);

  const mutation = await api.request("/v1/interfaces", {
    method: "POST",
    headers: { ...runtimeHeaders, "content-type": "application/json" },
    body: "{}",
  });
  expect(mutation.status).toBe(403);
});

test("runtime Principal can exchange an exact oauth2 InterfaceBinding for a no-store token", async () => {
  let id = 0;
  const issuerInputs: Array<Record<string, unknown>> = [];
  const service = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    now: () => "2026-07-13T12:00:00.000Z",
    newId: (prefix) => `${prefix}_${++id}`,
    oauth2ResourceAuthorizer: () => true,
    credentialIssuer: {
      issuePrincipalOAuth2Token: (input) => {
        issuerInputs.push(input as unknown as Record<string, unknown>);
        return Promise.resolve({
          accessToken: "taksrv_route_token",
          expiresAt: "2026-07-13T12:01:00.000Z",
        });
      },
    },
  });
  const iface = await service.create({
    workspaceId: "workspace_a",
    name: "token-mcp",
    ownerRef: { kind: "Capsule", id: "capsule_a" },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: {
          source: "literal",
          value: "https://mcp.example.test/mcp?request=ignored#fragment",
        },
      },
      access: { visibility: "private", resourceUriInput: "endpoint" },
    },
  });
  const binding = await service.createBinding(iface.metadata.id, {
    subjectRef: { kind: "Principal", id: "pairwise_a" },
    permissions: ["mcp.invoke"],
    delivery: { type: "oauth2" },
  });
  expect(binding.status.phase).toBe("Ready");

  const api = await createApiApp({
    role: "takosumi-api",
    registerOpenApiRoute: false,
    registerDeployControlInternalRoutes: false,
    registerInterfaceRoutes: true,
    interfaceRouteOptions: {
      service,
      authorizeInterfaceBearer: ({ token }) => {
        if (token === "runtime-a" || token === "runtime-cross-workspace") {
          return {
            actorAccountId: "pairwise_a",
            roles: ["runtime-principal"],
            requestId: `req_${token}`,
            workspaceId:
              token === "runtime-a" ? "workspace_a" : "workspace_b",
            principalKind: "account",
          };
        }
        if (token === "runtime-other") {
          return {
            actorAccountId: "pairwise_b",
            roles: ["runtime-principal"],
            requestId: "req_runtime_other",
            workspaceId: "workspace_a",
            principalKind: "account",
          };
        }
        if (token === "workspace-owner") {
          return {
            actorAccountId: "owner_a",
            roles: ["editor"],
            requestId: "req_owner",
            workspaceId: "workspace_a",
            principalKind: "account",
          };
        }
        return undefined;
      },
    },
    requestCorrelation: false,
  });
  const post = (token: string, body: Record<string, unknown>) =>
    api.request(`/v1/interfaces/${iface.metadata.id}/token`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  const response = await post("runtime-a", { permission: "mcp.invoke" });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(await response.json()).toEqual({
    access_token: "taksrv_route_token",
    token_type: "Bearer",
    expires_in: 60,
    expires_at: "2026-07-13T12:01:00.000Z",
    scope: "mcp.invoke",
    resource: "https://mcp.example.test/mcp",
  });
  expect(issuerInputs).toEqual([
    expect.objectContaining({
      bindingId: binding.metadata.id,
      subjectId: "pairwise_a",
      permission: "mcp.invoke",
      resource: "https://mcp.example.test/mcp",
    }),
  ]);

  expect((await post("runtime-a", { permission: "mcp.other" })).status).toBe(
    404,
  );
  expect(
    (
      await post("runtime-a", {
        permission: "mcp.invoke",
        credential: "must-not-be-accepted",
      })
    ).status,
  ).toBe(400);
  expect(
    (await post("runtime-other", { permission: "mcp.invoke" })).status,
  ).toBe(404);
  expect(
    (await post("runtime-cross-workspace", { permission: "mcp.invoke" }))
      .status,
  ).toBe(403);
  expect(
    (await post("workspace-owner", { permission: "mcp.invoke" })).status,
  ).toBe(403);
  expect(issuerInputs).toHaveLength(1);
});

test("strict bootstrap refuses to expose Interface API without auth", async () => {
  const context = createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: { environment: "production" },
      context,
    }),
  ).rejects.toThrow(
    "production runtime exposes the Interface API but no TAKOSUMI_DEPLOY_CONTROL_TOKEN or scoped Interface authorizer is configured",
  );
});

test("strict bootstrap refuses an ephemeral Interface store", async () => {
  const context = createInMemoryAppContext({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
  });
  await expect(
    createTakosumiService({
      role: "takosumi-api",
      runtimeConfig: { environment: "production" },
      runtimeEnv: { TAKOSUMI_DEPLOY_CONTROL_TOKEN: "control-token" },
      context,
      opentofuControlStore: declaredDurableTestOpenTofuStore(),
    }),
  ).rejects.toThrow(
    "production runtime exposes the Interface API but no durable Interface/InterfaceBinding store is configured",
  );
});
