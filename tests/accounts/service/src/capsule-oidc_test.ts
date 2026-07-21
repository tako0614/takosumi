import { expect, test } from "bun:test";

import { ensureTakosumiAccountsOidcForCapsule } from "../../../../accounts/service/src/control/capsule-oidc.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { InstallConfig } from "../../../../contract/install-configs.ts";
import { scopeIsAllowed } from "../../../../accounts/service/src/oidc-routes.ts";
import { TAKOSUMI_ACCOUNTS_CAPSULE_DELEGATION_SCOPES } from "../../../../accounts/contract/src/mod.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../../../deploy/reference-app-install-configs.ts";

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
