import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createAccountsHandler,
  InMemoryAccountsStore,
  PostgresAccountsStore,
  type PostgresQueryClient,
} from "@takosjp/takosumi-accounts-service";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { Run } from "takosumi-contract/runs";
import type { CredentialRecipe } from "takosumi-contract/credential-recipes";
import {
  credentialRecipeDriverKey,
  type CredentialRecipeRuntimeDriver,
  type FixedOperatorProviderConnectionDeclaration,
} from "takosumi-contract/credential-recipe-host";
import type { ComposedAppInput } from "../../../../deploy/node-postgres/src/composed-app.ts";
import type { NodeAccountsServerConfig } from "../../../../deploy/node-postgres/src/handler.ts";
import type { OpenTofuRunner } from "../../../../core/domains/deploy-control/mod.ts";
import {
  defaultCapsuleInstallConfig,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { createPlatformExtensionCapsulePublicOriginLedger } from "../../../../deploy/platform/platform_extension_provider_credentials.ts";
import type {
  RuntimeInputOidcClientSource,
  RuntimeInputOidcRequest,
} from "../../../../core/domains/deploy-control/runtime_input_materializer.ts";
import type {
  RuntimeInputOidcClientSourceFactoryInput,
} from "../../../../deploy/node-postgres/src/composed-app.ts";
import {
  InMemoryCapsuleCoordination,
  type CapsuleCoordination,
} from "../../../../core/domains/deploy-control/capsule_lease.ts";

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

test("composed app forwards one explicit OpenTofu store and operator config set", async () => {
  const opentofuControlStore = new InMemoryOpenTofuControlStore();
  const operatorInstallConfig = {
    ...defaultCapsuleInstallConfig(new Date("2026-08-18T00:00:00.000Z")),
    id: "cfg_node_operator",
    name: "node-operator",
  };
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: accountsHandlerSpy().handler,
    opentofuControlStore,
    operatorInstallConfigs: [operatorInstallConfig],
  });

  const workspace = await created.operations.workspaces.createWorkspace({
    handle: "node-store-forwarding",
    displayName: "Node store forwarding",
    type: "personal",
    ownerUserId: "principal_node_store",
  });
  assert.equal(
    (await opentofuControlStore.getWorkspace(workspace.id))?.id,
    workspace.id,
  );
  assert.deepEqual(
    (await created.operations.capsules.listSharedInstallConfigs()).map(
      (config) => config.id,
    ),
    ["cfg-default-opentofu-capsule", operatorInstallConfig.id],
  );
  const { source } = await created.operations.createSource({
    workspaceId: workspace.id,
    name: "node-shared-ledger",
    url: "https://example.test/node-shared-ledger.git",
  });
  const { capsule } =
    await created.operations.capsules.createCapsuleInitialAuthority({
      capsuleId: "cap_node_shared_ledger",
      providerBindingSetId: "binding_node_shared_ledger",
      workspaceId: workspace.id,
      name: "node-shared-ledger",
      environment: "test",
      sourceId: source.id,
      installingPrincipalId: "principal_node_store",
      installConfig: { ...operatorInstallConfig, workspaceId: workspace.id },
      providerBindings: [],
    });
  const reservation = {
    reservationRef: "reservation_node_shared_ledger",
    origin: "https://node-shared-ledger.example.test",
    requestedLabel: "node-shared-ledger",
    reservedAt: new Date().toISOString(),
  };
  const ledger =
    createPlatformExtensionCapsulePublicOriginLedger(opentofuControlStore);
  await ledger.write(capsule.id, reservation);
  assert.deepEqual(await ledger.read(capsule.id), reservation);
  assert.deepEqual(
    (await created.operations.capsules.getCapsule(capsule.id))
      .publicOriginReservation,
    reservation,
  );
});

test("Bun composition forwards one shared coordinator to ordered Capsule abandonment", async () => {
  const inner = new InMemoryCapsuleCoordination();
  const acquiredScopes: string[] = [];
  const capsuleCoordination: CapsuleCoordination = {
    acquireLease: async (input) => {
      acquiredScopes.push(input.scope);
      return await inner.acquireLease(input);
    },
    renewLease: (input) => inner.renewLease(input),
    releaseLease: (input) => inner.releaseLease(input),
  };
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    accountsHandler: accountsHandlerSpy().handler,
    capsuleCoordination,
  });
  const workspace = await created.operations.workspaces.createWorkspace({
    handle: "bun-abandon-coordination",
    displayName: "Bun abandon coordination",
    type: "personal",
    ownerUserId: "principal_bun_abandon",
  });
  const now = new Date().toISOString();
  await created.operations.capsules.putInstallConfig({
    id: "cfg_bun_abandon",
    workspaceId: workspace.id,
    name: "bun-abandon",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: now,
    updatedAt: now,
  });
  const { source } = await created.operations.createSource({
    workspaceId: workspace.id,
    name: "bun-abandon-source",
    url: "https://example.test/bun-abandon.git",
  });
  const capsule = await created.operations.capsules.createCapsule({
    workspaceId: workspace.id,
    name: "bun-abandon",
    environment: "production",
    sourceId: source.id,
    installConfigId: "cfg_bun_abandon",
    installingPrincipalId: "principal_bun_abandon",
  });

  const abandoned = await created.operations.capsules.abandonUnappliedCapsule(
    capsule.id,
    "test",
  );

  assert.equal(abandoned.status, "destroyed");
  assert.deepEqual(acquiredScopes, [
    `capsule:${capsule.id}:${capsule.environment}`,
  ]);
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

test("composed app 404s retired Form HTTP paths even with the operator bearer", async () => {
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: new PostgresAccountsStore(stubQueryClient()),
    // The real Accounts handler returns the same JSON 404 for unknown paths.
    // Keep that fallback here so a mounted legacy service route cannot be
    // mistaken for an Accounts response.
    accountsHandler: async () =>
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
      // Retired host/resource/package knobs must be inert in the composed
      // reference app. Keep these set so a future accidental opt-in cannot
      // reintroduce a second API lane.
      TAKOSUMI_RESOURCE_SHAPES: "1",
      TAKOSUMI_RESOURCE_ADAPTERS: "1",
      TAKOSUMI_TAKOFORM_V1ALPHA1_COMPATIBILITY_HOST: "1",
      TAKOSUMI_RESOURCE_FORM_TRANSITION_HOST: "1",
      TAKOSUMI_RESOURCE_FORM_TRANSITION_EVIDENCE: "1",
      R2_FORM_PACKAGES: "retired",
      TAKOSUMI_FORM_PACKAGE_TRUST_POLICY: "retired",
      TAKOSUMI_FORM_PACKAGE_HOST_COMPOSITION: "retired",
    },
  });

  for (const retired of [
    { method: "GET", path: "/.well-known/takoform" },
    { method: "GET", path: "/.well-known/takoform/v1alpha1" },
    { method: "GET", path: "/.well-known/takoform/v1alpha2" },
    { method: "GET", path: "/.well-known/takoform/v1alpha3" },
    { method: "GET", path: "/apis/forms.takoform.com/v1alpha1" },
    { method: "GET", path: "/apis/forms.takoform.com/v1alpha1/forms" },
    {
      method: "GET",
      path: "/apis/forms.takoform.com/v1alpha1/form-definitions",
    },
    { method: "GET", path: "/apis/forms.takoform.com/v1alpha1/interfaces" },
    { method: "GET", path: "/apis/forms.takoform.com/v1alpha1/resources" },
    {
      method: "POST",
      path: "/apis/forms.takoform.com/v1alpha1/resources/preview",
      body: "{}",
    },
    {
      method: "POST",
      path: "/apis/forms.takoform.com/v1alpha1/resources/observe",
      body: "{}",
    },
    {
      method: "POST",
      path: "/apis/forms.takoform.com/v1alpha1/resources/a/form-transitions",
      body: "{}",
    },
    {
      method: "POST",
      path: "/internal/v1/form-packages/install",
      body: "{}",
    },
    {
      method: "POST",
      path: "/internal/v1/form-packages/reverify",
      body: "{}",
    },
    { method: "GET", path: "/v1/form-activations" },
    {
      method: "POST",
      path: "/v1/form-activations",
      body: "{}",
    },
    {
      method: "PATCH",
      path: "/v1/form-activations/activation_1",
      body: "{}",
    },
    { method: "GET", path: "/v1/form-availability?space=space_1" },
    { method: "GET", path: "/v1/resources?space=space_1" },
    { method: "POST", path: "/v1/resources/preview", body: "{}" },
    { method: "GET", path: "/v1/resources/EdgeWorker/api?space=space_1" },
    { method: "GET", path: "/v1/target-pools?space=space_1" },
    { method: "GET", path: "/v1/target-pools/default?space=space_1" },
    { method: "GET", path: "/v1/space-policies?space=space_1" },
    { method: "GET", path: "/v1/space-policies/default?space=space_1" },
  ]) {
    for (const authorization of [undefined, `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}`]) {
      const response = await created.app.fetch(
        new Request(`http://localhost${retired.path}`, {
          method: retired.method,
          headers: {
            ...(authorization ? { authorization } : {}),
            ...(retired.body ? { "content-type": "application/json" } : {}),
          },
          ...(retired.body ? { body: retired.body } : {}),
        }),
      );
      assert.equal(response.status, 404, `${retired.path} (${authorization ?? "anonymous"})`);
    }
  }

  const inventoryHeaders = {
    authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}`,
  };
  const capabilities = await created.app.fetch(
    new Request("http://localhost/capabilities", {
      headers: inventoryHeaders,
    }),
  );
  assert.equal(capabilities.status, 200);
  const capabilityPaths = (await capabilities.json()).endpoints.map(
    (endpoint: { path: string }) => endpoint.path,
  );
  assert.equal(capabilityPaths.includes("/v1/form-availability"), false);
  assert.equal(capabilityPaths.includes("/v1/form-activations"), false);
  for (const path of [
    "/v1/resources",
    "/v1/resources/:kind/:name",
    "/v1/target-pools",
    "/v1/target-pools/:name",
    "/v1/space-policies",
    "/v1/space-policies/:name",
  ]) {
    assert.equal(capabilityPaths.includes(path), false, path);
  }

  const openapi = await created.app.fetch(
    new Request("http://localhost/openapi.json", {
      headers: inventoryHeaders,
    }),
  );
  assert.equal(openapi.status, 200);
  const openapiPaths = Object.keys((await openapi.json()).paths);
  assert.equal(openapiPaths.includes("/v1/form-availability"), false);
  assert.equal(openapiPaths.includes("/v1/form-activations"), false);
  for (const path of [
    "/v1/resources",
    "/v1/resources/{kind}/{name}",
    "/v1/target-pools",
    "/v1/target-pools/{name}",
    "/v1/space-policies",
    "/v1/space-policies/{name}",
  ]) {
    assert.equal(openapiPaths.includes(path), false, path);
  }
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
    new Request("http://localhost/api/v1/interfaces", {
      method: "POST",
      headers: internal,
      body: interfaceBody(workspaceB.id, "foreign-seed"),
    }),
  );
  assert.equal(foreignSeed.status, 201);
  const foreignInterfaceId = (await foreignSeed.json()).metadata.id as string;

  const crossCreate = await app.fetch(
    new Request("http://localhost/api/v1/interfaces", {
      method: "POST",
      headers: session,
      body: interfaceBody(workspaceB.id, "cross-create"),
    }),
  );
  assert.equal(crossCreate.status, 403);
  const crossList = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces?workspaceId=${workspaceB.id}`, {
      headers: pat,
    }),
  );
  assert.equal(crossList.status, 403);
  const crossBinding = await app.fetch(
    new Request(
      `http://localhost/api/v1/interfaces/${foreignInterfaceId}/bindings`,
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
    new Request("http://localhost/api/v1/interfaces", {
      method: "POST",
      headers: session,
      body: interfaceBody(workspaceA.id, "owned"),
    }),
  );
  assert.equal(ownedCreate.status, 201);
  const ownedInterfaceId = (await ownedCreate.json()).metadata.id as string;
  const ownedList = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces?workspaceId=${workspaceA.id}`, {
      headers: pat,
    }),
  );
  assert.equal(ownedList.status, 200);
  const ownedBinding = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces/${ownedInterfaceId}/bindings`, {
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

test("composed Interface API refuses Interface writes from read-only Workspace members", async () => {
  const now = Date.now();
  const store = new InMemoryAccountsStore();
  for (const subject of [
    "tsub_ws_owner",
    "tsub_ws_viewer",
    "tsub_ws_member",
  ] as const) {
    store.saveAccount({ subject, createdAt: now, updatedAt: now });
    store.saveAccountSession({
      sessionId: `sess_${subject}`,
      subject,
      createdAt: now,
      expiresAt: now + 60_000,
    });
  }
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
  const workspace = await created.operations.workspaces.createWorkspace({
    handle: "role-gate",
    displayName: "Role Gate",
    type: "organization",
    ownerUserId: "tsub_ws_owner",
  });
  const ownerActor = {
    actorAccountId: "tsub_ws_owner",
    roles: ["owner"],
    requestId: "req_role_gate",
  };
  await created.operations.members.upsertMember({
    workspaceId: workspace.id,
    accountId: "tsub_ws_viewer",
    roles: ["viewer"],
    status: "active",
    actor: ownerActor,
  });
  await created.operations.members.upsertMember({
    workspaceId: workspace.id,
    accountId: "tsub_ws_member",
    roles: ["member"],
    status: "active",
    actor: ownerActor,
  });
  const headersFor = (subject: string) => ({
    authorization: `Bearer sess_${subject}`,
    "content-type": "application/json",
  });
  const interfaceBody = (name: string) =>
    JSON.stringify({
      workspaceId: workspace.id,
      name,
      ownerRef: { kind: "Workspace", id: workspace.id },
      spec: {
        type: "mcp.server",
        version: "2025-11-25",
        document: {},
        access: { visibility: "private" },
      },
    });
  const bindingBody = JSON.stringify({
    subjectRef: { kind: "Principal", id: "principal_role_gate" },
    permissions: ["mcp.invoke"],
    delivery: { type: "none" },
  });

  // A read-only member keeps read authority over the Workspace.
  const viewerList = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces?workspaceId=${workspace.id}`, {
      headers: headersFor("tsub_ws_viewer"),
    }),
  );
  assert.equal(viewerList.status, 200);

  const viewerCreate = await app.fetch(
    new Request("http://localhost/api/v1/interfaces", {
      method: "POST",
      headers: headersFor("tsub_ws_viewer"),
      body: interfaceBody("viewer-create"),
    }),
  );
  assert.equal(viewerCreate.status, 403);

  // A non-viewer member keeps Interface write authority.
  const memberCreate = await app.fetch(
    new Request("http://localhost/api/v1/interfaces", {
      method: "POST",
      headers: headersFor("tsub_ws_member"),
      body: interfaceBody("member-create"),
    }),
  );
  assert.equal(memberCreate.status, 201);
  const interfaceId = (await memberCreate.json()).metadata.id as string;
  const memberBinding = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces/${interfaceId}/bindings`, {
      method: "POST",
      headers: headersFor("tsub_ws_member"),
      body: bindingBody,
    }),
  );
  assert.equal(memberBinding.status, 201);
  const bindingId = (await memberBinding.json()).metadata.id as string;

  // The read-only member can neither mint nor revoke bindings.
  const viewerBinding = await app.fetch(
    new Request(`http://localhost/api/v1/interfaces/${interfaceId}/bindings`, {
      method: "POST",
      headers: headersFor("tsub_ws_viewer"),
      body: bindingBody,
    }),
  );
  assert.equal(viewerBinding.status, 403);
  const viewerRevoke = await app.fetch(
    new Request(
      `http://localhost/api/v1/interfaces/${interfaceId}/bindings/${bindingId}`,
      { method: "DELETE", headers: headersFor("tsub_ws_viewer") },
    ),
  );
  assert.equal(viewerRevoke.status, 403);
});

test("composed Capsule Interface OAuth uses canonical Capsule authority without an Accounts projection", async () => {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const store = new InMemoryAccountsStore();
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const created = await buildComposedApp({
    config: testConfig(),
    store: store as unknown as PostgresAccountsStore,
    createAccountsHandler: (controlPlaneOperations) =>
      createAccountsHandler({
        issuer: testConfig().issuer,
        store,
        controlPlaneOperations,
      }),
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
    installingPrincipalId: "principal_interface_oauth_e2e",
  });
  await created.operations.capsules.patchCapsuleStatus(capsule.id, "active");

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
      `http://localhost/api/v1/interfaces/${encodeURIComponent(iface.metadata.id)}/token`,
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

  const userInfo = await created.app.fetch(
    new Request("http://localhost/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );
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
  await created.operations.interfaces.revokeBinding(
    iface.metadata.id,
    binding.metadata.id,
  );
  const staleUserInfo = await created.app.fetch(
    new Request("http://localhost/oauth/userinfo", {
      headers: { authorization: `Bearer ${issued.access_token}` },
    }),
  );
  assert.equal(staleUserInfo.status, 401);
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
    "https://app.takosumi.test/api/v1/capabilities",
  );

  const capabilities = await app.fetch(
    new Request("https://app.takosumi.test/api/v1/capabilities"),
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
  assert.equal(body.endpoints.api, "https://app.takosumi.test/api/v1");
  assert.equal(
    body.endpoints.capabilities,
    "https://app.takosumi.test/api/v1/capabilities",
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

const RUNTIME_INPUT_PROVIDER =
  "registry.terraform.io/tako0614/takoform" as const;
const RUNTIME_INPUT_PROFILE = {
  contract: "takosumi.runtime-binding-profile/v2",
  generatedSecrets: [
    { binding: "ENCRYPTION_KEY", bytes: 32, encoding: "hex" },
  ],
  oidcClient: {
    issuerBinding: "TAKOSUMI_ACCOUNTS_ISSUER_URL",
    clientIdBinding: "TAKOSUMI_ACCOUNTS_CLIENT_ID",
    ownerSubjectBinding: "TAKOSUMI_ACCOUNTS_OWNER_SUB",
    redirectUriBinding: "TAKOSUMI_ACCOUNTS_REDIRECT_URI",
    callbackPath: "/api/auth/callback/takos",
    scopes: ["openid", "profile", "email"],
  },
} as const;

const RUNTIME_INPUT_RUNNER_PROFILE = {
  id: "opentofu-default",
  name: "Composed App runtime-input test runner",
  substrate: "local",
  executorId: "opentofu.default",
  lifecycle: { state: "active" as const },
  availability: { state: "available" as const },
  stateBackend: {
    kind: "local",
    ref: "state://fixture/composed-app-runtime-input",
    lock: { kind: "operator", ref: "lock://fixture/composed-app-runtime-input" },
  },
  allowedProviders: [RUNTIME_INPUT_PROVIDER],
  requireProviderBindings: true,
  networkPolicy: { mode: "operator-managed" },
  createdAt: Date.now(),
} as const;

const COMPOSED_RUN_ISSUED_RECIPE = {
  id: "composed-run-credential",
  displayName: "Composed Run credential",
  terraformSource: "*",
  envNames: ["COMPOSED_RUN_CREDENTIAL"],
  authModes: {
    broker: {
      preRun: { type: "issue_run_credential" },
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "composed-app.example.v1",
        scopes: ["provider:invoke"],
      },
    },
  },
} as const satisfies CredentialRecipe;

const COMPOSED_OPERATOR_CONNECTION = {
  id: "conn_composedRun01",
  providerSource: RUNTIME_INPUT_PROVIDER,
  displayName: "Composed operator provider",
  runCredentialSettings: { requiredAvailableMinor: 2300 },
  credentialRecipe: {
    id: COMPOSED_RUN_ISSUED_RECIPE.id,
    authMode: "broker",
  },
} as const satisfies FixedOperatorProviderConnectionDeclaration;

const COMPOSED_RUN_DRIVER: CredentialRecipeRuntimeDriver = {
  evidenceIssuer: "composed-app-run-credential",
  verify: async () => ({ ok: true }),
  mint: async ({ connection, run, issueRunCredential }) => {
    if (!run || !issueRunCredential) {
      throw new Error("composed app run issuer was not wired");
    }
    const issued = await issueRunCredential({ ttlSeconds: 600 });
    return {
      env: { COMPOSED_RUN_CREDENTIAL: issued.token },
      evidence: {
        connectionId: connection.id,
        provider: connection.provider,
        temporary: true,
        ttlEnforced: true,
        expiresAt: issued.expiresAt,
        ttlSeconds: issued.ttlSeconds,
        issuer: "composed-app-run-credential",
        secretValueStored: false,
      },
    };
  },
};

function runtimeInputRunner(options: {
  readonly planJobs: unknown[];
  readonly sourceJobs: unknown[];
}): OpenTofuRunner {
  return {
    sourceSync: async (job) => {
      options.sourceJobs.push(job);
      return {
        resolvedCommit: "a".repeat(40),
        archiveDigest: `sha256:${"b".repeat(64)}`,
        archiveSizeBytes: 1024,
        repositoryInstallMetadata: { status: "absent" },
        repositoryManifest: { status: "absent" },
        repositoryModules: {
          status: "ready",
          scopePath: ".",
          modules: [
            {
              path: ".",
              providerPackages: [{ source: RUNTIME_INPUT_PROVIDER }],
              rootProviderRequirements: [
                {
                  source: RUNTIME_INPUT_PROVIDER,
                  moduleLocalName: "takoform",
                  version: "4.0.0",
                },
              ],
            },
          ],
        },
      };
    },
    readCapsuleSourceFiles: async () => [
      {
        path: "main.tf",
        text: `terraform {
  required_providers {
    takoform = {
      source = "${RUNTIME_INPUT_PROVIDER}"
      version = "= 4.0.0"
    }
  }
}

provider "takoform" {}

output "launch_url" {
  value = "https://example.test"
}
`,
      },
    ],
    plan: async (job) => {
      options.planJobs.push(job);
      return {
        planDigest: `sha256:${"c".repeat(64)}`,
        planArtifact: {
          kind: "runner-local",
          ref: "runner-local://runtime-input/plan",
          digest: `sha256:${"c".repeat(64)}`,
        },
        requiredProviders: [RUNTIME_INPUT_PROVIDER],
        requiredProviderRequirements: [
          {
            source: RUNTIME_INPUT_PROVIDER,
            moduleLocalName: "takoform",
            version: "4.0.0",
          },
        ],
        providerLockDigest: `sha256:${"d".repeat(64)}`,
        providerInstallation: [
          {
            provider: RUNTIME_INPUT_PROVIDER,
            mirrored: true,
            installationMethod: "filesystem_mirror",
            attested: true,
            attestationMethod: "forced_filesystem_mirror_init",
            mirrorPath: `/opt/opentofu/provider-mirror/${RUNTIME_INPUT_PROVIDER}`,
            installedDigest: `sha256:${"e".repeat(64)}`,
          },
        ],
      };
    },
  };
}

async function buildRuntimeInputPlanFixture(options: {
  readonly oidcSource?: RuntimeInputOidcClientSource;
  readonly onFactoryInput?: (
    input: RuntimeInputOidcClientSourceFactoryInput,
  ) => void;
  readonly operatorProviderConnections?: ComposedAppInput["operatorProviderConnections"];
  readonly credentialRecipes?: ComposedAppInput["credentialRecipes"];
  readonly credentialRecipeDrivers?: ComposedAppInput["credentialRecipeDrivers"];
  readonly runCredentialIssuer?: ComposedAppInput["runCredentialIssuer"];
  readonly allowOperatorScopedProviderConnections?: ComposedAppInput["allowOperatorScopedProviderConnections"];
} = {}) {
  const sourceJobs: unknown[] = [];
  const planJobs: unknown[] = [];
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  const store = new PostgresAccountsStore(stubQueryClient());
  const created = await buildComposedApp({
    config: testConfig(),
    store,
    accountsHandler: accountsHandlerSpy().handler,
    runtimeEnv: {
      TAKOSUMI_DEPLOY_CONTROL_TOKEN: TEST_DEPLOY_CONTROL_TOKEN,
    },
    opentofuRunner: runtimeInputRunner({ sourceJobs, planJobs }),
    runnerProfiles: [RUNTIME_INPUT_RUNNER_PROFILE],
    defaultRunnerProfileId: RUNTIME_INPUT_RUNNER_PROFILE.id,
    ...(options.operatorProviderConnections !== undefined
      ? { operatorProviderConnections: options.operatorProviderConnections }
      : {}),
    ...(options.credentialRecipes !== undefined
      ? { credentialRecipes: options.credentialRecipes }
      : {}),
    ...(options.credentialRecipeDrivers !== undefined
      ? { credentialRecipeDrivers: options.credentialRecipeDrivers }
      : {}),
    ...(options.runCredentialIssuer !== undefined
      ? { runCredentialIssuer: options.runCredentialIssuer }
      : {}),
    ...(options.allowOperatorScopedProviderConnections !== undefined
      ? {
          allowOperatorScopedProviderConnections:
            options.allowOperatorScopedProviderConnections,
        }
      : {}),
    ...(options.oidcSource
      ? {
          createRuntimeInputOidcClientSource: async (
            input: RuntimeInputOidcClientSourceFactoryInput,
          ) => {
            options.onFactoryInput?.(input);
            return options.oidcSource!;
          },
        }
      : {}),
    runtimeBindingDerivationKey: "runtime-binding-key-for-composed-app-tests",
  });
  const workspace = await created.operations.workspaces.createWorkspace({
    handle: `runtime-input-${crypto.randomUUID().slice(0, 8)}`,
    displayName: "Runtime Input Composition",
    type: "personal",
    ownerUserId: "tsub_runtime_input_owner",
  });
  const sourceResponse = await created.operations.createSource({
    workspaceId: workspace.id,
    name: "runtime-input-source",
    url: "https://github.com/acme/runtime-input.git",
  });
  await created.operations.createSourceSync(sourceResponse.source.id);
  let connectionId = options.operatorProviderConnections?.[0]?.id;
  if (!connectionId) {
    const connection = await created.operations.createConnection({
      workspaceId: workspace.id,
      provider: RUNTIME_INPUT_PROVIDER,
      credentialRecipe: {
        id: "takoform",
        authMode: "token",
        secretPartition: "provider-credentials",
      },
      values: {
        TAKOFORM_ENDPOINT: "https://forms.example.test",
        TAKOFORM_SPACE: "runtime-input",
        TAKOFORM_TOKEN: "runtime-input-token",
      },
    });
    await created.operations.testConnection(connection.connection.id);
    connectionId = connection.connection.id;
  }
  const now = new Date(0).toISOString();
  const installConfig: InstallConfig = {
    id: `cfg_runtimeinput${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    workspaceId: workspace.id,
    name: "runtime-input-install",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    runtimeBindingMaterialization: RUNTIME_INPUT_PROFILE,
    createdAt: now,
    updatedAt: now,
  };
  const capsule = await created.operations.capsules.createCapsuleInitialAuthority({
    capsuleId: `cap_runtimeinput${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    providerBindingSetId: `ipcset_runtimeinput${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
    workspaceId: workspace.id,
    name: "runtime-input",
    environment: "preview",
    sourceId: sourceResponse.source.id,
    installingPrincipalId: "tsub_runtime_input_owner",
    installConfig,
    providerBindings: [
      {
        provider: RUNTIME_INPUT_PROVIDER,
        moduleLocalName: "takoform",
        connectionId,
      },
    ],
  });
  return {
    created,
    capsule: capsule.capsule,
    installConfig,
    planJobs,
    sourceJobs,
    workspace,
    store,
    connectionId,
  };
}

test("composed app supplies its injected OIDC authority to a binding-delivered Capsule plan", async () => {
  const requests: RuntimeInputOidcRequest[] = [];
  let factoryInput: RuntimeInputOidcClientSourceFactoryInput | undefined;
  const oidcSource: RuntimeInputOidcClientSource = {
    generation: async (request) => {
      requests.push(request);
      return "sha256:composed-app-oidc-generation";
    },
    materialize: async (request) => {
      requests.push(request);
      return {
        generation: "sha256:composed-app-oidc-generation",
        values: {
          TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://app.takosumi.test",
          TAKOSUMI_ACCOUNTS_CLIENT_ID: "client_runtime_input",
          TAKOSUMI_ACCOUNTS_OWNER_SUB: "owner_runtime_input",
          TAKOSUMI_ACCOUNTS_REDIRECT_URI:
            "https://runtime-input.example.test/api/auth/callback/takos",
        },
      };
    },
  };
  const { created, capsule, installConfig, planJobs } =
    await buildRuntimeInputPlanFixture({
      oidcSource,
      onFactoryInput: (input) => {
        factoryInput = input;
      },
  });
  assert(factoryInput);
  assert.deepEqual(Object.keys(factoryInput), ["control", "accounts", "issuer"]);
  assert.deepEqual(Object.keys(factoryInput.control), [
    "getCapsule",
    "getInstallConfig",
    "getCapsuleExecutionAuthorityEpoch",
  ]);
  assert.deepEqual(Object.keys(factoryInput.accounts), [
    "findOidcClient",
    "findOidcClientForCapsule",
    "saveOidcClient",
  ]);
  assert.equal(factoryInput.issuer, testConfig().issuer);
  assert.equal(Object.isFrozen(factoryInput), true);
  assert.equal(Object.isFrozen(factoryInput.control), true);
  assert.equal(Object.isFrozen(factoryInput.accounts), true);
  assert.equal("controlPlaneOperations" in factoryInput, false);
  assert.equal("accountsStore" in factoryInput, false);
  assert.equal("config" in factoryInput, false);
  assert.equal("query" in factoryInput.accounts, false);
  assert.throws(() => {
    (factoryInput as unknown as { issuer: string }).issuer =
      "https://attacker.example.test";
  });
  assert.equal(factoryInput.issuer, testConfig().issuer);
  assert.equal(
    (await factoryInput.control.getCapsule(capsule.id))?.id,
    capsule.id,
  );
  assert.equal(
    (await factoryInput.control.getInstallConfig(installConfig.id))?.id,
    installConfig.id,
  );
  assert.equal(
    await factoryInput.control.getCapsuleExecutionAuthorityEpoch(capsule.id),
    1,
  );
  const response = await created.app.fetch(
    new Request(`http://localhost/internal/v1/capsules/${capsule.id}/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
    }),
  );
  if (response.status !== 201) {
    throw new Error(
      `unexpected plan response ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { run: Run };
  if (body.run.status !== "succeeded") {
    throw new Error(
      JSON.stringify(await created.operations.getPlanRun(body.run.id)),
    );
  }
  assert.equal(body.run.planDigest, `sha256:${"c".repeat(64)}`);
  assert.equal(requests.length > 0, true);
  assert.deepEqual(requests[0], {
    profileContract: RUNTIME_INPUT_PROFILE.contract,
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    installConfigId: installConfig.id,
    bindings: RUNTIME_INPUT_PROFILE.oidcClient,
  });
  assert.equal(planJobs.length, 1);
  assert.match(
    JSON.stringify(planJobs[0]),
    /runtime_input_nonce/u,
  );
});

test("composed app keeps binding-delivered OIDC plans fail-closed without an authority", async () => {
  const { created, capsule } = await buildRuntimeInputPlanFixture();
  const response = await created.app.fetch(
    new Request(`http://localhost/internal/v1/capsules/${capsule.id}/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
    }),
  );
  assert.equal(response.status, 409);
  const body = (await response.json()) as {
    error: { code: string; details?: { reason?: string } };
  };
  assert.equal(body.error.code, "failed_precondition");
  assert.equal(body.error.details?.reason, "runtime_inputs_material_unusable");
});

test("composed app refuses to boot when its runtime-input authority cannot initialize", async () => {
  const { buildComposedApp } =
    await import("../../../../deploy/node-postgres/src/composed-app.ts");
  await assert.rejects(
    buildComposedApp({
      config: testConfig(),
      store: new PostgresAccountsStore(stubQueryClient()),
      accountsHandler: accountsHandlerSpy().handler,
      createRuntimeInputOidcClientSource: async () => {
        throw new Error("operator OIDC authority unavailable");
      },
    }),
    /operator OIDC authority unavailable/u,
  );
});

test("composed app forwards operator recipe and Run issuer into Capsule materialization", async () => {
  const issued: Array<{
    readonly connectionId: string;
    readonly runId: string;
    readonly phase: string;
    readonly audience: string;
    readonly scopes: readonly string[];
  }> = [];
  const fixture = await buildRuntimeInputPlanFixture({
    oidcSource: {
      generation: async () => "sha256:composed-app-oidc-generation",
      materialize: async () => ({
        generation: "sha256:composed-app-oidc-generation",
        values: {
          TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://app.takosumi.test",
          TAKOSUMI_ACCOUNTS_CLIENT_ID: "client_runtime_input",
          TAKOSUMI_ACCOUNTS_OWNER_SUB: "owner_runtime_input",
          TAKOSUMI_ACCOUNTS_REDIRECT_URI:
            "https://runtime-input.example.test/api/auth/callback/takos",
        },
      }),
    },
    operatorProviderConnections: [COMPOSED_OPERATOR_CONNECTION],
    credentialRecipes: [COMPOSED_RUN_ISSUED_RECIPE],
    credentialRecipeDrivers: {
      [credentialRecipeDriverKey({
        id: COMPOSED_RUN_ISSUED_RECIPE.id,
        authMode: "broker",
      })]: COMPOSED_RUN_DRIVER,
    },
    runCredentialIssuer: async ({ connection, run, request }) => {
      issued.push({
        connectionId: connection.id,
        runId: run.runId,
        phase: run.phase,
        audience: request.audience,
        scopes: [...request.scopes],
      });
      return {
        token: `composed-issued:${run.runId}`,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        ttlSeconds: request.ttlSeconds ?? 900,
      };
    },
    allowOperatorScopedProviderConnections: true,
  });
  const response = await fixture.created.app.fetch(
    new Request(
      `http://localhost/internal/v1/capsules/${fixture.capsule.id}/plan`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
      },
    ),
  );
  if (response.status !== 201) {
    throw new Error(
      `operator plan failed ${response.status}: ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { run: Run };
  if (body.run.status !== "succeeded") {
    throw new Error(
      `operator plan run failed: ${JSON.stringify(
        await fixture.created.operations.getPlanRun(body.run.id),
      )}`,
    );
  }
  assert.equal(fixture.planJobs.length, 1);
  assert.equal(
    fixture.planJobs[0]?.credentials?.env.COMPOSED_RUN_CREDENTIAL,
    `composed-issued:${body.run.id}`,
  );
  assert.deepEqual(issued, [
    {
      connectionId: COMPOSED_OPERATOR_CONNECTION.id,
      runId: body.run.id,
      phase: "plan",
      audience: "composed-app.example.v1",
      scopes: ["provider:invoke"],
    },
  ]);
});

test("composed app keeps operator-scoped provider bindings denied by default", async () => {
  const fixtureOptions = {
    oidcSource: {
      generation: async () => "sha256:composed-app-oidc-generation",
      materialize: async () => ({
        generation: "sha256:composed-app-oidc-generation",
        values: {
          TAKOSUMI_ACCOUNTS_ISSUER_URL: "https://app.takosumi.test",
          TAKOSUMI_ACCOUNTS_CLIENT_ID: "client_runtime_input",
          TAKOSUMI_ACCOUNTS_OWNER_SUB: "owner_runtime_input",
          TAKOSUMI_ACCOUNTS_REDIRECT_URI:
            "https://runtime-input.example.test/api/auth/callback/takos",
        },
      }),
    },
    operatorProviderConnections: [COMPOSED_OPERATOR_CONNECTION],
    credentialRecipes: [COMPOSED_RUN_ISSUED_RECIPE],
    credentialRecipeDrivers: {
      [credentialRecipeDriverKey({
        id: COMPOSED_RUN_ISSUED_RECIPE.id,
        authMode: "broker",
      })]: COMPOSED_RUN_DRIVER,
    },
  } satisfies Parameters<typeof buildRuntimeInputPlanFixture>[0];
  for (const allow of [undefined, false] as const) {
    const fixture = await buildRuntimeInputPlanFixture({
      ...fixtureOptions,
      ...(allow === undefined
        ? {}
        : { allowOperatorScopedProviderConnections: allow }),
    });
    const response = await fixture.created.app.fetch(
      new Request(
        `http://localhost/internal/v1/capsules/${fixture.capsule.id}/plan`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${TEST_DEPLOY_CONTROL_TOKEN}` },
        },
      ),
    );
    if (response.status !== 403) {
      throw new Error(
        `operator denial returned ${response.status}: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      error: { code: string; details?: { reason?: string } };
    };
    assert.equal(body.error.code, "permission_denied");
    assert.equal(
      body.error.details?.reason,
      "provider_connection_setup_required",
    );
    assert.equal(fixture.planJobs.length, 0);
  }
});
