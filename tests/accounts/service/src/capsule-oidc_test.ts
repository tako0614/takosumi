import { expect, test } from "bun:test";

import { ensureTakosumiAccountsOidcForCapsule } from "../../../../accounts/service/src/control/capsule-oidc.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { InstallConfig } from "../../../../contract/install-configs.ts";
import { scopeIsAllowed } from "../../../../accounts/service/src/oidc-routes.ts";
import { TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES } from "../../../../accounts/contract/src/mod.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../../fixtures/reference-app-install-configs.ts";

test("Capsule OIDC registration never invents module variable names", async () => {
  const store = new InMemoryAccountsStore();
  const installConfig = {
    id: "cfg_1",
    variableMapping: { application_url: "https://app.example.test" },
    installExperience: {
      projections: [
        {
          kind: "public_endpoint",
          variables: { url: "application_url" },
        },
        {
          kind: "oidc_client",
          variables: {},
          callbackPath: "/auth/callback",
        },
      ],
    },
  } as unknown as InstallConfig;
  let persistedConfig: InstallConfig | undefined;
  const operations = {
    workspaces: {
      getWorkspace: async () => ({ id: "ws_1", handle: "main" }),
    },
    capsules: {
      putInstallConfig: async (config: InstallConfig) => {
        persistedConfig = config;
        return config;
      },
    },
  } as unknown as ControlPlaneOperations;

  await ensureTakosumiAccountsOidcForCapsule({
    operations,
    store,
    issuer: "https://accounts.example.test",
    capsule: {
      id: "cap_1",
      workspaceId: "ws_1",
      installConfigId: "cfg_1",
    } as never,
    installConfig,
  });

  expect(await store.findOidcClientForCapsule("cap_1")).toBeDefined();
  expect(persistedConfig?.variableMapping).toEqual({
    application_url: "https://app.example.test",
  });
  expect(persistedConfig?.variableMapping).not.toHaveProperty(
    "takosumi_accounts_issuer_url",
  );
  expect(persistedConfig?.variableMapping).not.toHaveProperty(
    "takosumi_accounts_client_id",
  );
});

test("managed Capsule OIDC provisioning materializes the projected public URL", async () => {
  const store = new InMemoryAccountsStore();
  const installConfig = {
    id: "cfg_managed_staging",
    variableMapping: { public_subdomain: "dashboard" },
    installExperience: {
      projections: [
        {
          kind: "public_endpoint",
          variables: { subdomain: "public_subdomain", url: "public_url" },
          baseDomain: "apps.example.test",
        },
        {
          kind: "oidc_client",
          variables: { redirectUri: "redirect_uri" },
          callbackPath: "/auth/callback",
        },
      ],
    },
  } as unknown as InstallConfig;
  let persistedConfig: InstallConfig | undefined;
  let managedHostnameClaim:
    | {
        readonly workspaceId: string;
        readonly capsuleId: string;
        readonly requestedLabel: string;
        readonly managedPublicBaseDomain: string;
        readonly expectedHostname: string;
      }
    | undefined;
  const operations = {
    claimManagedPublicHostname: async (
      claim: NonNullable<typeof managedHostnameClaim>,
    ) => {
      managedHostnameClaim = claim;
      return {
        ok: true,
        hostname: "main-dashboard.apps-staging.example.test",
        mode: "scoped",
      } as const;
    },
    workspaces: {
      getWorkspace: async () => ({ id: "ws_1", handle: "main" }),
    },
    capsules: {
      putInstallConfig: async (config: InstallConfig) => {
        persistedConfig = config;
        return config;
      },
    },
  } as unknown as ControlPlaneOperations;

  await ensureTakosumiAccountsOidcForCapsule({
    operations,
    store,
    issuer: "https://accounts.example.test",
    capsule: {
      id: "cap_managed_staging",
      workspaceId: "ws_1",
      installConfigId: "cfg_managed_staging",
    } as never,
    installConfig,
    managedPublicBaseDomain: "apps-staging.example.test",
  });

  const client = await store.findOidcClientForCapsule("cap_managed_staging");
  expect(client?.redirectUris).toEqual([
    "https://main-dashboard.apps-staging.example.test/auth/callback",
  ]);
  expect(managedHostnameClaim).toEqual({
    workspaceId: "ws_1",
    capsuleId: "cap_managed_staging",
    requestedLabel: "main-dashboard",
    managedPublicBaseDomain: "apps-staging.example.test",
    expectedHostname: "main-dashboard.apps-staging.example.test",
  });
  expect(persistedConfig?.variableMapping).toMatchObject({
    public_url: "https://main-dashboard.apps-staging.example.test",
    redirect_uri:
      "https://main-dashboard.apps-staging.example.test/auth/callback",
  });
});

test("managed Capsule OIDC provisioning falls back to the Capsule slug when the optional subdomain is omitted", async () => {
  const store = new InMemoryAccountsStore();
  const installConfig = {
    id: "cfg_managed_slug_fallback",
    variableMapping: { project_name: "takos-main" },
    managedPublicHostname: { mode: "scoped" },
    installExperience: {
      projections: [
        {
          kind: "public_endpoint",
          variables: { subdomain: "public_subdomain", url: "public_url" },
        },
        {
          kind: "oidc_client",
          variables: {
            accountsUrl: "accounts_url",
            issuerUrl: "issuer_url",
            clientId: "client_id",
            redirectUri: "redirect_uri",
          },
          callbackPath: "/auth/oidc/callback",
        },
      ],
    },
  } as unknown as InstallConfig;
  let persistedConfig: InstallConfig | undefined;
  const operations = {
    claimManagedPublicHostname: async (claim: {
      readonly expectedHostname: string;
    }) => ({
      ok: true,
      hostname: claim.expectedHostname,
      mode: "scoped",
    }),
    workspaces: {
      getWorkspace: async () => ({ id: "ws_1", handle: "main" }),
    },
    capsules: {
      putInstallConfig: async (config: InstallConfig) => {
        persistedConfig = config;
        return config;
      },
    },
  } as unknown as ControlPlaneOperations;

  await ensureTakosumiAccountsOidcForCapsule({
    operations,
    store,
    issuer: "https://accounts.example.test",
    capsule: {
      id: "cap_managed_slug_fallback",
      workspaceId: "ws_1",
      installConfigId: "cfg_managed_slug_fallback",
      name: "Takos Main",
      slug: "takos-main",
    } as never,
    installConfig,
    managedPublicBaseDomain: "apps-staging.example.test",
  });

  const client = await store.findOidcClientForCapsule(
    "cap_managed_slug_fallback",
  );
  expect(client?.redirectUris).toEqual([
    "https://main-takos-main.apps-staging.example.test/auth/oidc/callback",
  ]);
  expect(persistedConfig?.variableMapping).toMatchObject({
    public_url: "https://main-takos-main.apps-staging.example.test",
    accounts_url: "https://accounts.example.test",
    issuer_url: "https://accounts.example.test",
    client_id: client?.clientId,
    redirect_uri:
      "https://main-takos-main.apps-staging.example.test/auth/oidc/callback",
  });
});

test("a mapped OIDC client id can never rebind another Capsule's client", async () => {
  const store = new InMemoryAccountsStore();
  // The victim's Capsule already owns this registration.
  await store.saveOidcClient({
    clientId: "toc_victim",
    capsuleId: "cap_victim",
    namespacePath: "identity.oidc",
    issuerUrl: "https://accounts.example.test",
    redirectUris: ["https://victim.example.test/auth/callback"],
    allowedScopes: ["openid", "profile", "email"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: 1,
    updatedAt: 1,
  });
  const installConfig = {
    id: "cfg_attacker",
    // Both values are ordinary caller-supplied install variables.
    variableMapping: {
      application_url: "https://attacker.example.test",
      client_id: "toc_victim",
    },
    installExperience: {
      projections: [
        { kind: "public_endpoint", variables: { url: "application_url" } },
        {
          kind: "oidc_client",
          variables: { clientId: "client_id" },
          callbackPath: "/auth/callback",
        },
      ],
    },
  } as unknown as InstallConfig;
  const operations = {
    workspaces: {
      getWorkspace: async () => ({ id: "ws_attacker", handle: "attacker" }),
    },
    capsules: {
      putInstallConfig: async (config: InstallConfig) => config,
    },
  } as unknown as ControlPlaneOperations;

  await expect(
    ensureTakosumiAccountsOidcForCapsule({
      operations,
      store,
      issuer: "https://accounts.example.test",
      capsule: {
        id: "cap_attacker",
        workspaceId: "ws_attacker",
        installConfigId: "cfg_attacker",
      } as never,
      installConfig,
    }),
  ).rejects.toThrow("oidc_client_id_already_bound");

  // The victim registration is untouched: same Capsule, same redirect origin.
  const victim = await store.findOidcClient("toc_victim");
  expect(victim?.capsuleId).toBe("cap_victim");
  expect(victim?.redirectUris).toEqual([
    "https://victim.example.test/auth/callback",
  ]);
  expect(await store.findOidcClientForCapsule("cap_attacker")).toBeUndefined();
});

/**
 * The Takos distribution worker sends this scope set without negotiation
 * (`takos/src/worker/server/routes/auth/accounts-delegation.ts`
 * `TAKOS_ACCOUNTS_OAUTH_SCOPES`), and `takos/docs/operator/account-model.md`
 * documents it as the delegation contract. Takos is a separate repository, so
 * this literal is the pinned copy: if it and the shipped install config ever
 * disagree, the authorize gate answers `invalid_scope` on first sign-in.
 */
const TAKOS_REQUESTED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "capsules:read",
  "capsules:write",
] as const;

test("the Takos install config registers a client that grants every scope Takos sends", async () => {
  const installConfig = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-main",
  );
  expect(installConfig).toBeDefined();
  expect(TAKOS_REQUESTED_SCOPES).toEqual(
    TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES,
  );

  const store = new InMemoryAccountsStore();
  const operations = {
    workspaces: {
      getWorkspace: async () => ({ id: "ws_1", handle: "main" }),
    },
    capsules: {
      putInstallConfig: async (config: InstallConfig) => config,
    },
  } as unknown as ControlPlaneOperations;

  await ensureTakosumiAccountsOidcForCapsule({
    operations,
    store,
    issuer: "https://accounts.example.test",
    capsule: {
      id: "cap_takos",
      workspaceId: "ws_1",
      installConfigId: installConfig!.id,
    } as never,
    installConfig: {
      ...installConfig!,
      variableMapping: {
        ...installConfig!.variableMapping,
        public_url: "https://takos.example.test",
      },
    },
  });

  const client = await store.findOidcClientForCapsule("cap_takos");
  expect(client).toBeDefined();
  // The same gate handleAuthorize applies, so a drift here is a 400 in prod.
  expect(
    scopeIsAllowed(TAKOS_REQUESTED_SCOPES.join(" "), client!.allowedScopes!),
  ).toBe(true);
  expect(client!.capsuleId).toBe("cap_takos");
  expect(client!.redirectUris).toEqual([
    "https://takos.example.test/auth/oidc/callback",
  ]);
});

test("identity-only reference apps keep the narrow default grant", async () => {
  for (const config of REFERENCE_APP_INSTALL_CONFIGS) {
    if (config.name === "takos-main") continue;
    const projection = config.installExperience?.projections?.find(
      (candidate) => candidate.kind === "oidc_client",
    );
    if (projection?.kind !== "oidc_client") continue;
    expect(projection.scopes).toEqual(["openid", "profile", "email"]);
  }
});
