import { expect, test } from "bun:test";

import { ensureTakosumiAccountsOidcForCapsule } from "../../../../accounts/service/src/control/capsule-oidc.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import type { InstallConfig } from "../../../../contract/install-configs.ts";

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
