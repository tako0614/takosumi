import { expect, test } from "bun:test";

import type { CloudflareWorkerEnv } from "../../../worker/src/bindings.ts";
import { createWorkerServiceApp } from "../../../worker/src/worker_service.ts";
import { SqliteFakeD1 } from "../../helpers/deploy-control/sqlite_fake_d1.ts";

function baseEnv(
  extra: Record<string, unknown> = {},
): CloudflareWorkerEnv {
  return {
    TAKOSUMI_CONTROL_DB: new SqliteFakeD1(),
    TAKOSUMI_ENVIRONMENT: "test",
    TAKOSUMI_DEV_MODE: "1",
    ...extra,
  } as unknown as CloudflareWorkerEnv;
}

test("worker service overlays explicit host sources onto the generic default", async () => {
  const created = await createWorkerServiceApp(
    baseEnv({
      TAKOSUMI_CREDENTIAL_RECIPE_HOST_COMPOSITION: {
        credentialRecipes: [],
        credentialRecipeDrivers: {},
        credentialRequiredProviderSources: [
          "registry.example.com/acme/provider",
        ],
      },
    }),
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );

  const configs = await created.operations.capsules.listSharedInstallConfigs();
  expect(configs).toHaveLength(1);
  expect(configs[0]?.policy.providerCredentials).toEqual({
    requiredProviders: [
      "registry.example.com/acme/provider",
      "registry.opentofu.org/cloudflare/cloudflare",
    ],
  });
});

test("worker service does not infer requirements from a custom recipe catalog", async () => {
  const created = await createWorkerServiceApp(
    baseEnv(),
    "takosumi-api",
    {
      operatorInstallConfigs: [],
      credentialRecipes: [
        {
          id: "custom-provider",
          displayName: "Custom provider",
          terraformSource: ["registry.example.com/acme/provider"],
          envNames: ["CUSTOM_PROVIDER_TOKEN"],
          authModes: {
            env: {
              env: {
                CUSTOM_PROVIDER_TOKEN: { from: "secret" },
              },
            },
          },
        },
      ],
    },
  );

  const configs = await created.operations.capsules.listSharedInstallConfigs();
  expect(configs).toHaveLength(1);
  expect(configs[0]?.policy.providerCredentials).toBeUndefined();
});

test("worker service unions reference and platform broker sources without provider inference", async () => {
  const created = await createWorkerServiceApp(
    baseEnv({
      TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
      TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
        {
          basePath: "/extensions/provider",
          handlerKey: "PROVIDER",
          authDelivery: "context",
          runCredential: {
            audience: "operator.provider.v1",
            requiredScopes: ["provider.invoke"],
          },
          providerCredentialBroker: {
            connectionId: "conn_providerBroker01",
            recipeId: "provider-broker-run",
            providerSource: "registry.example.com/acme/provider",
            displayName: "Provider Broker",
            exchangePath: "/credentials/provider",
            envNames: ["PROVIDER_TOKEN"],
          },
        },
      ]),
    }),
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );

  const configs = await created.operations.capsules.listSharedInstallConfigs();
  expect(configs[0]?.policy.providerCredentials?.requiredProviders).toEqual([
    "registry.example.com/acme/provider",
    "registry.opentofu.org/cloudflare/cloudflare",
  ]);
  expect(
    configs[0]?.policy.providerCredentials?.requiredProviders,
  ).not.toContain("registry.opentofu.org/acme/provider");
});

test("worker service fails closed when the extension route parser rejects a broker", async () => {
  await expect(
    createWorkerServiceApp(
      baseEnv({
        TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
          {
            basePath: "/extensions/provider",
            handlerKey: "PROVIDER",
            authDelivery: "context",
            runCredential: {
              audience: "operator.provider.v1",
              requiredScopes: ["provider.invoke"],
            },
            providerCredentialBroker: {
              connectionId: "conn_providerBroker01",
              recipeId: "provider-broker-run",
              providerSource: "*",
              displayName: "Provider Broker",
              exchangePath: "/credentials/provider",
              envNames: ["PROVIDER_TOKEN"],
            },
          },
        ]),
      }),
      "takosumi-api",
      { operatorInstallConfigs: [] },
    ),
  ).rejects.toThrow("providerSource must be canonical");
});
