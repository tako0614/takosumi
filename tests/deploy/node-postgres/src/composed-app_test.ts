import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import { handleUserInfo } from "../../../../accounts/service/src/oidc-routes.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { ComposedAppInput } from "../../../../deploy/node-postgres/src/composed-app.ts";
import type { NodeAccountsServerConfig } from "../../../../deploy/node-postgres/src/handler.ts";

const globalWithRequire = globalThis as {
  require?: (specifier: string) => unknown;
};
globalWithRequire.require ??= createRequire(import.meta.url);

const TEST_DEPLOY_CONTROL_TOKEN = "test-deploy-control-token";

// The embedded service's in-memory secret store refuses to start in the default
// `local` environment without an encryption key or an explicit dev opt-in. These
// route tests never exercise the secret store, so opt into dev mode so
// `createTakosumiService` boots the in-memory adapters.
process.env.TAKOSUMI_DEV_MODE = "1";

/** Regression coverage for canonical control-plane + Accounts composition. */

function stubQueryClient(): PostgresQueryClient {
  return {
    // A throwing query surfaces an accidental DB dependency in construction
    // and route-classification tests rather than silently passing.
    queryObject: () => {
      throw new Error("unexpected DB query in composed-app route test");
    },
  };
}

function testConfig(): NodeAccountsServerConfig {
  return {
    bindHost: "127.0.0.1",
    port: 8787,
    issuer: "http://localhost:8787",
    managedPublicBaseDomain: undefined,
    databaseUrl: "postgres://unused",
    clients: undefined,
    loginEmailAllowlist: undefined,
    passkeys: undefined,
    upstreamOAuth: undefined,
    stableOidc: undefined,
    privacyOperationsToken: undefined,
    privacyRetentionPolicyRef: undefined,
    subject: undefined,
  };
}

interface AccountsHandlerSpy {
  readonly handler: NonNullable<ComposedAppInput["accountsHandler"]>;
  readonly calls: { method: string; pathname: string }[];
}

function accountsHandlerSpy(): AccountsHandlerSpy {
  const calls: { method: string; pathname: string }[] = [];
  return {
    calls,
    handler: (req: Request) => {
      const url = new URL(req.url);
      calls.push({ method: req.method, pathname: url.pathname });
      // A sentinel body + header the service never emits, so a test can prove the
      // account-plane handler — not the embedded service — produced the response.
      return Promise.resolve(
        new Response(JSON.stringify({ handledBy: "accounts" }), {
          status: 299,
          headers: {
            "content-type": "application/json",
            "x-handled-by": "accounts",
          },
        }),
      );
    },
  };
}

async function buildTestApp() {
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: spy.handler,
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
    },
    // This test exercises the account/token composition rather than hostname
    // reservation; the host authority seam is covered in Interface tests.
    interfaceOAuth2ResourceAuthorizer: () => true,
  });
  return { app: created.app, spy };
}

test("composed app builds Accounts with the canonical control operations facade", async () => {
  const spy = accountsHandlerSpy();
  let controlPlaneOperationsWired = false;
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    createAccountsHandler: async (controlPlaneOperations) => {
      controlPlaneOperationsWired =
        typeof controlPlaneOperations.workspaces.listWorkspacesForAccount ===
          "function" &&
        typeof controlPlaneOperations.projects.listProjects === "function" &&
        typeof controlPlaneOperations.capsules.getCapsule === "function";
      return spy.handler;
    },
  });

  assert.equal(controlPlaneOperationsWired, true);
  const res = await created.app.fetch(
    new Request("http://localhost/dashboard"),
  );
  assert.equal(res.headers.get("x-handled-by"), "accounts");
});

test("composed app still serves an embedded service process route", async () => {
  const { app, spy } = await buildTestApp();
  // `/health` was removed in the health-dedup stage. `/capabilities` is the
  // always-mounted service process route, but it is operator-inventory gated;
  // an unauthenticated 401 proves the embedded service app saw the request and
  // the account-plane fallback did not shadow it.
  const unauthenticated = await app.fetch(
    new Request("http://localhost/capabilities"),
  );
  assert.equal(unauthenticated.status, 401);

  const res = await app.fetch(
    new Request("http://localhost/capabilities", {
      headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
    }),
  );
  assert.equal(res.status, 200);
  // Service-owned route, not the account-plane sentinel.
  assert.equal(res.headers.get("x-handled-by"), null);
  const body = await res.json();
  assert.equal(body.service, "takosumi");
  // The account-plane handler must NOT have seen the service process probe.
  assert.equal(spy.calls.length, 0);
});

test("composed Interface API scopes sessions and PATs to current Workspace ownership", async () => {
  const now = Date.now();
  const store = new InMemoryAccountsStore();
  for (const subject of ["tsub_owner_a", "tsub_owner_b"] as const) {
    store.saveAccount({ subject, createdAt: now, updatedAt: now });
  }
  store.saveAccountSession({
    sessionId: "sess_owner_a",
    subject: "tsub_owner_a",
    createdAt: now,
    expiresAt: now + 60_000,
  });
  store.savePersonalAccessToken("takpat_owner_a", {
    tokenId: "pat_owner_a",
    tokenPrefix: "takpat_own",
    subject: "tsub_owner_a",
    name: "Interface test",
    scopes: ["read", "write"],
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: store as unknown as PostgresAccountsStore,
    accountsHandler: spy.handler,
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
    },
    interfaceOAuth2ResourceAuthorizer: () => true,
  });
  const app = created.app;
  const workspaceA = await created.operations.workspaces.createWorkspace({
    handle: "owner-a",
    displayName: "Owner A",
    type: "personal",
    ownerUserId: "tsub_owner_a",
  });
  const workspaceB = await created.operations.workspaces.createWorkspace({
    handle: "owner-b",
    displayName: "Owner B",
    type: "personal",
    ownerUserId: "tsub_owner_b",
  });
  const interfaceBody = (workspaceId: string, name: string) =>
    JSON.stringify({
      workspaceId,
      name,
      ownerRef: { kind: "Workspace", id: workspaceId },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: {},
        access: { visibility: "private" },
      },
    });
  const internal = {
    authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}`,
    "content-type": "application/json",
  };
  const session = {
    authorization: "Bearer sess_owner_a",
    "content-type": "application/json",
  };
  const pat = {
    authorization: "Bearer takpat_owner_a",
    "content-type": "application/json",
  };

  const foreignSeed = await app.fetch(
    new Request("http://localhost/v1/interfaces", {
      method: "POST",
      headers: internal,
      body: interfaceBody(workspaceB.id, "foreign-seed"),
    }),
  );
  assert.equal(foreignSeed.status, 201);
  const foreignInterfaceId = (await foreignSeed.json()).metadata.id as string;

  const crossCreate = await app.fetch(
    new Request("http://localhost/v1/interfaces", {
      method: "POST",
      headers: session,
      body: interfaceBody(workspaceB.id, "cross-create"),
    }),
  );
  assert.equal(crossCreate.status, 403);
  const crossList = await app.fetch(
    new Request(`http://localhost/v1/interfaces?workspaceId=${workspaceB.id}`, {
      headers: pat,
    }),
  );
  assert.equal(crossList.status, 403);
  const crossBinding = await app.fetch(
    new Request(
      `http://localhost/v1/interfaces/${foreignInterfaceId}/bindings`,
      {
        method: "POST",
        headers: pat,
        body: JSON.stringify({
          subjectRef: { kind: "Principal", id: "principal_a" },
          permissions: ["mcp.invoke"],
          delivery: { type: "none" },
        }),
      },
    ),
  );
  assert.equal(crossBinding.status, 403);

  const ownedCreate = await app.fetch(
    new Request("http://localhost/v1/interfaces", {
      method: "POST",
      headers: session,
      body: interfaceBody(workspaceA.id, "owned"),
    }),
  );
  assert.equal(ownedCreate.status, 201);
  const ownedInterfaceId = (await ownedCreate.json()).metadata.id as string;
  const ownedList = await app.fetch(
    new Request(`http://localhost/v1/interfaces?workspaceId=${workspaceA.id}`, {
      headers: pat,
    }),
  );
  assert.equal(ownedList.status, 200);
  const ownedBinding = await app.fetch(
    new Request(`http://localhost/v1/interfaces/${ownedInterfaceId}/bindings`, {
      method: "POST",
      headers: pat,
      body: JSON.stringify({
        subjectRef: { kind: "Principal", id: "principal_a" },
        permissions: ["mcp.invoke"],
        delivery: { type: "none" },
      }),
    }),
  );
  assert.equal(ownedBinding.status, 201);
});

test("composed Capsule Interface OAuth uses canonical Capsule authority without an Accounts projection", async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const store = new InMemoryAccountsStore();
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: store as unknown as PostgresAccountsStore,
    accountsHandler: spy.handler,
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
    },
    // This E2E focuses on Accounts issuance/UserInfo evidence. The default
    // reservation-backed authority is covered by the Core host seam tests.
    interfaceOAuth2ResourceAuthorizer: () => true,
  });

  const workspace = await created.operations.workspaces.createWorkspace({
    handle: "interface-oauth-e2e",
    displayName: "Interface OAuth E2E",
    type: "personal",
    ownerUserId: "tsub_interface_owner",
  });
  const installConfig: InstallConfig = {
    id: "cfg_interfaceoauth1",
    workspaceId: workspace.id,
    name: "interface-oauth-capsule",
    sourceKind: "generic_capsule",
    installType: "opentofu_module",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  await created.operations.capsules.putInstallConfig(installConfig);
  const { source } = await created.operations.createSource({
    workspaceId: workspace.id,
    name: "interface-oauth-source",
    url: "https://github.com/takosjp/takos-office.git",
  });
  const capsule = await created.operations.capsules.createCapsule({
    workspaceId: workspace.id,
    name: "office",
    environment: "test",
    installConfigId: installConfig.id,
    sourceId: source.id,
  });
  await created.operations.capsules.patchCapsuleStatus(
    capsule.id,
    "active",
  );

  const delegatedToken = "takat_interface_oauth_e2e";
  const principalSubject = "pairwise_takos_interface_e2e";
  await store.saveAccessToken(delegatedToken, {
    clientId: "takos-interface-client",
    scope: "openid capsules:read",
    subject: principalSubject,
    takosumiSubject: "tsub_interface_owner",
    workspaceId: workspace.id,
    role: "owner",
    expiresAt: now + 60_000,
  });

  const audience = "https://office.example.test/mcp";
  const iface = await created.operations.interfaces.create({
    workspaceId: workspace.id,
    name: "office-mcp",
    ownerRef: { kind: "Capsule", id: capsule.id },
    spec: {
      type: "mcp.server",
      version: "2025-11-25",
      document: { transport: "streamable-http" },
      inputs: {
        endpoint: { source: "literal", value: audience },
      },
      access: {
        visibility: "private",
        resourceUriInput: "endpoint",
      },
    },
  });
  const binding = await created.operations.interfaces.createBinding(
    iface.metadata.id,
    {
      subjectRef: { kind: "Principal", id: principalSubject },
      permissions: ["mcp.invoke"],
      delivery: { type: "oauth2" },
    },
  );
  assert.equal(iface.status.phase, "Resolved");
  assert.equal(binding.status.phase, "Ready");

  const tokenResponse = await created.app.fetch(
    new Request(
      `http://localhost/v1/interfaces/${encodeURIComponent(iface.metadata.id)}/token`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${delegatedToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ permission: "mcp.invoke" }),
      },
    ),
  );
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  const issued = (await tokenResponse.json()) as {
    access_token: string;
    resource: string;
    scope: string;
  };
  assert.match(issued.access_token, /^taksrv_/u);
  assert.notEqual(issued.access_token, delegatedToken);
  assert.equal(issued.resource, audience);
  assert.equal(issued.scope, "mcp.invoke");

  const userInfo = await handleUserInfo({
    request: new Request("http://localhost/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
    store,
    expectedAudience: audience,
  });
  assert.equal(userInfo.status, 200);
  assert.deepEqual(await userInfo.json(), {
    sub: principalSubject,
    aud: audience,
    scope: "mcp.invoke",
    token_use: "interface_oauth",
    takosumi: {
      workspace_id: workspace.id,
      capsule_id: capsule.id,
      interface_id: iface.metadata.id,
      interface_binding_id: binding.metadata.id,
      interface_resolved_revision: iface.status.resolvedRevision,
    },
  });

});

test("composed app owns Takosumi product discovery before account fallback", async () => {
  const { app, spy } = await buildTestApp();
  const wellKnown = await app.fetch(
    new Request("https://app.takosumi.test/.well-known/takosumi"),
  );
  assert.equal(wellKnown.status, 200);
  assert.equal(wellKnown.headers.get("x-handled-by"), null);
  const wellKnownBody = await wellKnown.json();
  assert.equal(
    wellKnownBody.endpoints.capabilities,
    "https://app.takosumi.test/v1/capabilities",
  );

  const capabilities = await app.fetch(
    new Request("https://app.takosumi.test/v1/capabilities"),
  );
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers.get("x-handled-by"), null);
  const capabilitiesBody = await capabilities.json();
  assert.equal(capabilitiesBody.resources.Stack, true);
  assert.equal(capabilitiesBody.adapters.opentofu, true);

  assert.equal(spy.calls.length, 0);
});

test("composed app product discovery uses forwarded public origin", async () => {
  const { app, spy } = await buildTestApp();
  const res = await app.fetch(
    new Request("http://cloud:8787/.well-known/takosumi", {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.takosumi.test",
      },
    }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.endpoints.api, "https://app.takosumi.test/api");
  assert.equal(
    body.endpoints.capabilities,
    "https://app.takosumi.test/v1/capabilities",
  );
  assert.equal(body.endpoints.oidc_issuer, "https://app.takosumi.test");
  assert.equal(spy.calls.length, 0);
});

test("composed app delegates dashboard paths to the Accounts fallback", async () => {
  const { app, spy } = await buildTestApp();
  // `/dashboard` is an account-plane surface the service never registers; it
  // reaches the accounts handler via the service app's catch-all fallback.
  const res = await app.fetch(new Request("http://localhost/dashboard"));
  assert.equal(res.headers.get("x-handled-by"), "accounts");
  assert.deepEqual(spy.calls, [{ method: "GET", pathname: "/dashboard" }]);
});

test("composed app runs preHandle ahead of composed routing", async () => {
  const spy = accountsHandlerSpy();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: spy.handler,
    preHandle: (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/healthz") {
        return Promise.resolve(
          new Response("ok", { status: 200, headers: { "x-pre": "1" } }),
        );
      }
      return Promise.resolve(undefined);
    },
  });
  const res = await created.app.fetch(new Request("http://localhost/healthz"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-pre"), "1");
  assert.equal(spy.calls.length, 0);
});
