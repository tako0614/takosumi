import { expect, test } from "bun:test";

import { createAccountsHandler } from "../../../../accounts/service/src/mod.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import {
  createTakosumiRuntimeProjectionMaterialResolver,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVE_PATH,
  type RuntimeProjectionMaterial,
} from "../../../../accounts/service/src/runtime-projection-material-resolver.ts";

test("Accounts runtime projection material resolver materializes OIDC public clients by default", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "cap_oidc",
      workspaceId: "ws_1",
      appId: "app.example",
      componentName: "web",
      bindingName: "oidc",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      component: {
        kind: "worker",
        spec: {
          redirectPaths: ["/auth/callback"],
          scopes: ["profile", "openid"],
        },
      },
    }),
  );

  expect(material).toBeDefined();
  expect(material.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(material.issuerUrl).toEqual("https://cloud.example.test");
  expect(material.discoveryUrl).toEqual(
    "https://cloud.example.test/.well-known/openid-configuration",
  );
  expect(material.url).toEqual("https://cloud.example.test");
  expect(material.internalUrl).toEqual(undefined);
  expect(material.redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);
  expect(material.allowedScopes).toEqual(["profile", "openid"]);
  expect(material.tokenEndpointAuthMethod).toEqual("none");
  expect(material.clientSecretRef).toEqual(undefined);

  const client = store.findOidcClientForCapsule("cap_oidc");
  expect(client?.namespacePath).toEqual(
    TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  );
  expect(client?.tokenEndpointAuthMethod).toEqual("none");
  expect(client?.clientSecretHash).toEqual(undefined);
});

test("Accounts runtime projection material resolver materializes yurucommu-style OIDC client context", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://app.takosumi.test",
    allowDeployControlCapsules: true,
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "cap_yurucommu",
      workspaceId: "ws_social",
      appId: "yurucommu",
      componentName: "web",
      bindingName: "identity.oidc",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      component: {
        kind: "worker",
        spec: {
          redirectPaths: ["/api/auth/callback/takos"],
          scopes: ["openid", "profile", "email"],
        },
      },
    }),
  );

  expect(material.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(material.issuerUrl).toEqual("https://app.takosumi.test");
  expect(material.redirectUris).toEqual([
    "https://app.takosumi.test/api/auth/callback/takos",
  ]);
  expect(material.allowedScopes).toEqual(["openid", "profile", "email"]);
  expect(material.tokenEndpointAuthMethod).toEqual("none");

  const client = store.findOidcClientForCapsule("cap_yurucommu");
  expect(client?.namespacePath).toEqual(
    TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  );
  expect(store.findAppCapsule("cap_yurucommu")?.appId).toEqual(
    "yurucommu",
  );
});

test("Accounts runtime projection material resolver rejects network-path redirectPaths", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "inst_oidc_network_path",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      component: {
        kind: "worker",
        spec: {
          redirectPaths: ["//evil.example.test/callback"],
        },
      },
    }),
  );

  expect(material.redirectUris).toEqual([
    "https://cloud.example.test/oauth/callback/inst_oidc_network_path",
  ]);
  expect(material.redirectUris.join(" ")).not.toContain("evil.example.test");
  expect(
    store.findOidcClientForCapsule("inst_oidc_network_path")?.redirectUris,
  ).toEqual([
    "https://cloud.example.test/oauth/callback/inst_oidc_network_path",
  ]);
});

test("Accounts runtime projection material resolver can include an operator-internal OIDC URL", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    internalUrl: "http://accounts:8787/",
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "inst_oidc_internal",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(material.issuerUrl).toEqual("https://cloud.example.test");
  expect(material.url).toEqual("https://cloud.example.test");
  expect(material.internalUrl).toEqual("http://accounts:8787");
});

test("Accounts runtime projection material resolver never mints confidential clients (no unbacked secretRef)", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  // Even when the component requests a confidential auth method, the resolve
  // path cannot deliver a plaintext client secret (no secret store keyed by a
  // secretRef exists here), so it must materialize a public `none` client and
  // must not advertise a clientSecretRef pointing at material that was never
  // stored. Confidential clients are issued only via the create/import path,
  // which returns the plaintext once.
  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "inst_oidc_secret",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
      component: {
        kind: "worker",
        spec: {
          tokenEndpointAuthMethod: "client_secret_post",
        },
      },
    }),
  );

  expect(material).toBeDefined();
  expect(material.tokenEndpointAuthMethod).toEqual("none");
  expect(material.clientSecretRef).toEqual(undefined);

  const client = store.findOidcClientForCapsule("inst_oidc_secret");
  expect(client?.tokenEndpointAuthMethod).toEqual("none");
  expect(client?.clientSecretHash).toEqual(undefined);
});

test("Accounts runtime projection material resolver reuses existing OIDC client", async () => {
  const store = new InMemoryAccountsStore();
  store.saveOidcClient({
    clientId: "toc_existing",
    capsuleId: "inst_existing",
    namespacePath: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    issuerUrl: "https://cloud.example.test",
    redirectUris: ["https://app.example.test/callback"],
    allowedScopes: ["openid", "email"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: 1,
    updatedAt: 1,
  });
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "inst_existing",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(material.clientId).toEqual("toc_existing");
  expect(material.redirectOrigin).toEqual("https://app.example.test");
  expect(material.tokenEndpointAuthMethod).toEqual("none");
  expect(material.clientSecretRef).toEqual(undefined);
});

test("Accounts runtime projection material resolver reconciles existing OIDC client to current redirect paths and scopes", async () => {
  const store = new InMemoryAccountsStore();
  store.saveOidcClient({
    clientId: "toc_existing_reconcile",
    capsuleId: "inst_reconcile",
    namespacePath: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    issuerUrl: "https://cloud.example.test",
    redirectUris: ["https://app.example.test/callback"],
    allowedScopes: ["openid", "email"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "client_secret_post",
    clientSecretHash: "sha256:existing-client-secret",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
  });
  let now = 1_700_000_000_999;
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => now,
  });

  const context = {
    capsuleId: "inst_reconcile",
    componentName: "api",
    bindingName: "oidc",
    sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    component: {
      kind: "worker",
      spec: {
        redirectPaths: ["/auth/new-callback"],
        scopes: ["profile", "openid"],
      },
    },
  };
  const material = singleMaterial(await resolver.resolve(context));

  expect(material).toBeDefined();
  expect(material.clientId).toEqual("toc_existing_reconcile");
  expect(material.redirectUris).toEqual([
    "https://cloud.example.test/auth/new-callback",
  ]);
  expect(material.allowedScopes).toEqual(["profile", "openid"]);
  expect(material.tokenEndpointAuthMethod).toEqual("client_secret_post");
  expect(material.clientSecretRef).toEqual(undefined);

  const client = store.findOidcClientForCapsule("inst_reconcile");
  expect(client).toBeDefined();
  expect(client.clientId).toEqual("toc_existing_reconcile");
  expect(client.redirectUris).toEqual([
    "https://cloud.example.test/auth/new-callback",
  ]);
  expect(client.allowedScopes).toEqual(["profile", "openid"]);
  expect(client.createdAt).toEqual(1_700_000_000_000);
  expect(client.updatedAt).toEqual(1_700_000_000_999);
  expect(client.tokenEndpointAuthMethod).toEqual("client_secret_post");
  expect(client.clientSecretHash).toEqual("sha256:existing-client-secret");

  now = 1_700_000_001_111;
  await resolver.resolve(context);
  expect(
    store.findOidcClientForCapsule("inst_reconcile")?.updatedAt,
  ).toEqual(1_700_000_000_999);
});

test("Accounts runtime projection material resolver can project deploy-control installations", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    allowDeployControlCapsules: true,
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "ins_direct",
      workspaceId: "space_direct",
      appId: "app.direct",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(store.findAppCapsule("ins_direct")).toBeDefined();
  expect(store.findAppCapsule("ins_direct")?.workspaceId).toEqual(
    "space_direct",
  );
  expect(
    store.findOidcClientForCapsule("ins_direct")?.namespacePath,
  ).toEqual(TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC);
});

test("Accounts runtime projection material resolver does not reassign existing spaces for deploy control projections", async () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_existing",
    legalOwnerSubject: "tsub_existing",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveWorkspace({
    workspaceId: "space_existing",
    accountId: "acct_existing",
    kind: "personal",
    createdAt: 1,
    updatedAt: 1,
  });
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    allowDeployControlCapsules: true,
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "ins_direct_existing_space",
      workspaceId: "space_existing",
      appId: "app.direct",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(store.findWorkspace("space_existing")?.accountId).toEqual("acct_existing");
  expect(
    store.findAppCapsule("ins_direct_existing_space")?.accountId,
  ).toEqual("acct_existing");
});

test("Accounts runtime projection material resolver supports pathless capability discovery", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  const materials = materialCollection(
    await resolver.resolve({
      capsuleId: "inst_discovery",
      kind: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
      many: true,
      component: {
        kind: "worker",
        spec: { redirectPaths: ["/auth/callback"] },
      },
    }),
  );

  expect(materials[0]?.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(materials[0]?.redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);
});

test("Accounts runtime projection material resolver returns empty discovery collection for nonmatching labels", async () => {
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store: new InMemoryAccountsStore(),
    issuer: "https://cloud.example.test",
  });

  expect(
    await resolver.resolve({
      capsuleId: "inst_discovery_labels",
      kind: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
      labels: { capability: "docs" },
      many: true,
    }),
  ).toEqual([]);
});

test("Accounts runtime projection material resolver projects BillingPort material", async () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_owner",
    billingAccountId: "billing_1",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveWorkspace({
    workspaceId: "space_1",
    accountId: "acct_1",
    kind: "personal",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveBillingAccount({
    billingAccountId: "billing_1",
    subject: "tsub_owner",
    provider: "manual",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveAppCapsule({
    capsuleId: "inst_billing",
    accountId: "acct_1",
    workspaceId: "space_1",
    appId: "app.example",
    sourceGitUrl: "https://github.com/example/app",
    sourceRef: "main",
    sourceCommit: "commit_1",
    planDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    mode: "shared-cell",
    billingAccountId: "billing_1",
    status: "ready",
    createdBySubject: "tsub_owner",
    createdAt: 1,
    updatedAt: 1,
  });
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store,
    issuer: "https://cloud.example.test",
    billingPortalUrl: "https://dashboard.example.test/account/billing",
  });

  const material = singleMaterial(
    await resolver.resolve({
      capsuleId: "inst_billing",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
    }),
  );

  expect(material.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_BILLING_USAGE,
  );
  expect(material.usageReportEndpoint).toEqual(
    "https://cloud.example.test/v1/capsule-projections/inst_billing/billing/usage-reports",
  );
  expect(material.billingSubjectRef).toEqual(
    "takosumi-accounts://billing-accounts/billing_1",
  );
  expect(material.portalUrl).toEqual(
    "https://dashboard.example.test/account/billing",
  );
  expect(material.meteringCredentialRef).toEqual(undefined);
});

test("Accounts runtime projection material resolver ignores unknown paths", async () => {
  const resolver = createTakosumiRuntimeProjectionMaterialResolver({
    store: new InMemoryAccountsStore(),
    issuer: "https://cloud.example.test",
  });

  expect(
    await resolver.resolve({
      capsuleId: "inst_unknown",
      sourceRef: "unknown.primary.service",
    }),
  ).toEqual(undefined);
});

test("Accounts handler exposes token-gated runtime projection material resolver route", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://cloud.example.test",
    store,
    runtimeProjectionMaterialResolver: { token: "resolver-token" },
  });

  const unauthorized = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capsuleId: "cap_route",
          sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
        }),
      },
    ),
  );
  expect(unauthorized.status).toEqual(401);

  const response = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          capsuleId: "cap_route",
          sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
        }),
      },
    ),
  );
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.material.capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(store.findOidcClientForCapsule("cap_route")).toBeDefined();
});

test("Accounts handler resolver route supports pathless discovery collections", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://cloud.example.test",
    store,
    runtimeProjectionMaterialResolver: { token: "resolver-token" },
  });

  const response = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          capsuleId: "inst_route_discovery",
          kind: TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
          many: true,
          component: {
            kind: "worker",
            spec: { redirectPaths: ["/auth/callback"] },
          },
        }),
      },
    ),
  );

  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.materials[0].capability).toEqual(
    TAKOSUMI_ACCOUNTS_SERVICE_CAPABILITY_IDENTITY_OIDC,
  );
  expect(body.materials[0].redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);

  const empty = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_RUNTIME_PROJECTION_MATERIAL_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          capsuleId: "inst_route_discovery_empty",
          kind: "unknown.material@v1",
          many: true,
        }),
      },
    ),
  );
  expect(empty.status).toEqual(200);
  expect(await empty.json()).toEqual({ materials: [] });
});

function singleMaterial(
  value: RuntimeProjectionMaterial | readonly RuntimeProjectionMaterial[] | undefined,
): RuntimeProjectionMaterial {
  expect(value).toBeDefined();
  if (Array.isArray(value)) {
    throw new Error("expected a single platform service material");
  }
  return value as RuntimeProjectionMaterial;
}

function materialCollection(
  value: RuntimeProjectionMaterial | readonly RuntimeProjectionMaterial[] | undefined,
): readonly RuntimeProjectionMaterial[] {
  expect(value).toBeDefined();
  if (!Array.isArray(value)) {
    throw new Error("expected a platform service material collection");
  }
  return value as readonly RuntimeProjectionMaterial[];
}
