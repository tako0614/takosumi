import { expect, test } from "bun:test";

import { createAccountsHandler } from "./mod.ts";
import { InMemoryAccountsStore } from "./store.ts";
import {
  createTakosumiWorkloadPlatformServiceResolver,
  TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1,
  TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
  TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
  TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVE_PATH,
  type WorkloadPlatformServiceMaterial,
} from "./workload-platform-services.ts";

test("Accounts workload platform service resolver materializes OIDC public clients by default", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "inst_oidc",
      spaceId: "space_1",
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
  expect(material.materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1);
  expect(material.issuerUrl).toEqual("https://cloud.example.test");
  expect(material.discoveryUrl).toEqual("https://cloud.example.test/.well-known/openid-configuration");
  expect(material.url).toEqual("https://cloud.example.test");
  expect(material.internalUrl).toEqual(undefined);
  expect(material.redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);
  expect(material.allowedScopes).toEqual(["profile", "openid"]);
  expect(material.tokenEndpointAuthMethod).toEqual("none");
  expect(material.clientSecretRef).toEqual(undefined);

  const client = store.findOidcClientForInstallation("inst_oidc");
  expect(client?.namespacePath).toEqual(TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC);
  expect(client?.tokenEndpointAuthMethod).toEqual("none");
  expect(client?.clientSecretHash).toEqual(undefined);
});

test("Accounts workload platform service resolver can include an operator-internal OIDC URL", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    internalUrl: "http://accounts:8787/",
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "inst_oidc_internal",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(material.issuerUrl).toEqual("https://cloud.example.test");
  expect(material.url).toEqual("https://cloud.example.test");
  expect(material.internalUrl).toEqual("http://accounts:8787");
});

test("Accounts workload platform service resolver never mints confidential clients (no unbacked secretRef)", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
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
      installationId: "inst_oidc_secret",
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

  const client = store.findOidcClientForInstallation("inst_oidc_secret");
  expect(client?.tokenEndpointAuthMethod).toEqual("none");
  expect(client?.clientSecretHash).toEqual(undefined);
});

test("Accounts workload platform service resolver reuses existing OIDC client", async () => {
  const store = new InMemoryAccountsStore();
  store.saveOidcClient({
    clientId: "toc_existing",
    installationId: "inst_existing",
    namespacePath: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    issuerUrl: "https://cloud.example.test",
    redirectUris: ["https://app.example.test/callback"],
    allowedScopes: ["openid", "email"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: 1,
    updatedAt: 1,
  });
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "inst_existing",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(material.clientId).toEqual("toc_existing");
  expect(material.redirectOrigin).toEqual("https://app.example.test");
  expect(material.tokenEndpointAuthMethod).toEqual("none");
  expect(material.clientSecretRef).toEqual(undefined);
});

test("Accounts workload platform service resolver reconciles existing OIDC client to current redirect paths and scopes", async () => {
  const store = new InMemoryAccountsStore();
  store.saveOidcClient({
    clientId: "toc_existing_reconcile",
    installationId: "inst_reconcile",
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
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => now,
  });

  const context = {
    installationId: "inst_reconcile",
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

  const client = store.findOidcClientForInstallation("inst_reconcile");
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
  expect(store.findOidcClientForInstallation("inst_reconcile")?.updatedAt).toEqual(1_700_000_000_999);
});

test("Accounts workload platform service resolver can project deploy-control installations", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    allowDeployControlInstallations: true,
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "ins_direct",
      spaceId: "space_direct",
      appId: "app.direct",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material).toBeDefined();
  expect(store.findAppInstallation("ins_direct")).toBeDefined();
  expect(store.findAppInstallation("ins_direct")?.spaceId).toEqual("space_direct");
  expect(store.findOidcClientForInstallation("ins_direct")?.namespacePath).toEqual(TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC);
});

test("Accounts workload platform service resolver does not reassign existing spaces for deploy control projections", async () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_existing",
    legalOwnerSubject: "tsub_existing",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveSpace({
    spaceId: "space_existing",
    accountId: "acct_existing",
    kind: "personal",
    createdAt: 1,
    updatedAt: 1,
  });
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    allowDeployControlInstallations: true,
    now: () => 1_700_000_000_000,
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "ins_direct_existing_space",
      spaceId: "space_existing",
      appId: "app.direct",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
    }),
  );

  expect(material.materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1);
  expect(store.findSpace("space_existing")?.accountId).toEqual("acct_existing");
  expect(store.findAppInstallation("ins_direct_existing_space")?.accountId).toEqual("acct_existing");
});

test("Accounts workload platform service resolver supports pathless material-kind discovery", async () => {
  const store = new InMemoryAccountsStore();
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    now: () => 1_700_000_000_000,
  });

  const materials = materialCollection(
    await resolver.resolve({
      installationId: "inst_discovery",
      kind: TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
      many: true,
      component: {
        kind: "worker",
        spec: { redirectPaths: ["/auth/callback"] },
      },
    }),
  );

  expect(materials[0]?.materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1);
  expect(materials[0]?.redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);
});

test("Accounts workload platform service resolver returns empty discovery collection for nonmatching labels", async () => {
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store: new InMemoryAccountsStore(),
    issuer: "https://cloud.example.test",
  });

  expect(await resolver.resolve({
      installationId: "inst_discovery_labels",
      kind: TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
      labels: { capability: "docs" },
      many: true,
    })).toEqual([]);
});

test("Accounts workload platform service resolver projects BillingPort material", async () => {
  const store = new InMemoryAccountsStore();
  store.saveLedgerAccount({
    accountId: "acct_1",
    legalOwnerSubject: "tsub_owner",
    billingAccountId: "billing_1",
    createdAt: 1,
    updatedAt: 1,
  });
  store.saveSpace({
    spaceId: "space_1",
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
  store.saveAppInstallation({
    installationId: "inst_billing",
    accountId: "acct_1",
    spaceId: "space_1",
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
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store,
    issuer: "https://cloud.example.test",
    billingPortalUrl: "https://dashboard.example.test/account/billing",
  });

  const material = singleMaterial(
    await resolver.resolve({
      installationId: "inst_billing",
      sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_BILLING_DEFAULT,
    }),
  );

  expect(material.materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_BILLING_PORT_V1);
  expect(material.usageReportEndpoint).toEqual("https://cloud.example.test/v1/installations/inst_billing/billing/usage-reports");
  expect(material.billingSubjectRef).toEqual("takosumi-accounts://billing-accounts/billing_1");
  expect(material.portalUrl).toEqual("https://dashboard.example.test/account/billing");
  expect(material.meteringCredentialRef).toEqual(undefined);
});

test("Accounts workload platform service resolver ignores unknown paths", async () => {
  const resolver = createTakosumiWorkloadPlatformServiceResolver({
    store: new InMemoryAccountsStore(),
    issuer: "https://cloud.example.test",
  });

  expect(await resolver.resolve({
      installationId: "inst_unknown",
      sourceRef: "unknown.primary.service",
    })).toEqual(undefined);
});

test("Accounts handler exposes token-gated workload platform service resolver route", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://cloud.example.test",
    store,
    workloadPlatformServices: { token: "resolver-token" },
  });

  const unauthorized = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installationId: "inst_route",
          sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
        }),
      },
    ),
  );
  expect(unauthorized.status).toEqual(401);

  const response = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          "authorization": "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: "inst_route",
          sourceRef: TAKOSUMI_ACCOUNTS_PLATFORM_SERVICE_IDENTITY_OIDC,
        }),
      },
    ),
  );
  expect(response.status).toEqual(200);
  const body = await response.json();
  expect(body.material.materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1);
  expect(store.findOidcClientForInstallation("inst_route")).toBeDefined();
});

test("Accounts handler resolver route supports pathless discovery collections", async () => {
  const store = new InMemoryAccountsStore();
  const handler = createAccountsHandler({
    issuer: "https://cloud.example.test",
    store,
    workloadPlatformServices: { token: "resolver-token" },
  });

  const response = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          "authorization": "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: "inst_route_discovery",
          kind: TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1,
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
  expect(body.materials[0].materialKind).toEqual(TAKOSUMI_ACCOUNTS_MATERIAL_IDENTITY_OIDC_V1);
  expect(body.materials[0].redirectUris).toEqual([
    "https://cloud.example.test/auth/callback",
  ]);

  const empty = await handler(
    new Request(
      `https://cloud.example.test${TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVE_PATH}`,
      {
        method: "POST",
        headers: {
          "authorization": "Bearer resolver-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          installationId: "inst_route_discovery_empty",
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
  value:
    | WorkloadPlatformServiceMaterial
    | readonly WorkloadPlatformServiceMaterial[]
    | undefined,
): WorkloadPlatformServiceMaterial {
  expect(value).toBeDefined();
  if (Array.isArray(value)) {
    throw new Error("expected a single platform service material");
  }
  return value as WorkloadPlatformServiceMaterial;
}

function materialCollection(
  value:
    | WorkloadPlatformServiceMaterial
    | readonly WorkloadPlatformServiceMaterial[]
    | undefined,
): readonly WorkloadPlatformServiceMaterial[] {
  expect(value).toBeDefined();
  if (!Array.isArray(value)) {
    throw new Error("expected a platform service material collection");
  }
  return value as readonly WorkloadPlatformServiceMaterial[];
}
