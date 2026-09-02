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

/**
 * The shipped Worker must COMPOSE the Capsule public-origin port, not merely
 * accept one: nothing in the repo ever passed `capsulePublicOrigin`, so every
 * Capsule whose manifest delivers `identity.oidc` by bindings failed closed at
 * plan on an otherwise correctly configured deployment.
 *
 * Composition is proved behaviorally rather than by reaching into the wiring:
 * the port refuses to exist when two routes claim the same question, so the
 * SAME pair of routes must fail this composition when they declare a
 * public-input path and succeed when they do not.
 */
function hostedBrokerRoutes(
  broker: Record<string, unknown>,
): Record<string, unknown>[] {
  return [
    ["hosted", "HOSTED", "conn_takosumiHostedTakoform01", "hosted-takoform-run"],
    ["other", "OTHER", "conn_otherHostedTakoform01", "other-takoform-run"],
  ].map(([slug, handlerKey, connectionId, recipeId]) => ({
    basePath: `/extensions/${slug}/marketplace`,
    handlerKey,
    authDelivery: "context",
    workspaceContext: "query-required",
    requiredScopes: [],
    runCredential: {
      audience: `${slug}.takoform.v1`,
      requiredScopes: ["takoform.run"],
    },
    providerCredentialBroker: {
      connectionId,
      recipeId,
      providerSource: "registry.terraform.io/tako0614/takoform",
      displayName: "Takoform broker",
      exchangePath: "/provider-credentials/takoform",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      ...broker,
    },
  }));
}

function originEnv(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
    TAKOSUMI_ACCOUNTS_DB: new SqliteFakeD1(),
    TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET:
      "pairwise-secret-with-at-least-32-bytes",
    TAKOSUMI_RUNTIME_BINDING_DERIVATION_KEY:
      "runtime-secret-with-at-least-32-bytes",
    ...extra,
  };
}

test("the shipped Worker composes a public-origin port from a declaring broker route", async () => {
  await expect(
    createWorkerServiceApp(
      baseEnv(
        originEnv({
          TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify(
            hostedBrokerRoutes({
              publicInputExchangePath: "/public-inputs/http-endpoint",
              publicInputCapabilities: ["http_endpoint_url"],
            }),
          ),
        }),
      ),
      "takosumi-api",
      { operatorInstallConfigs: [] },
    ),
  ).rejects.toThrow("a Capsule has one public origin");
});

test("a broker route that declares no public-input path composes no port", async () => {
  // The identical routes compose cleanly once neither claims to answer, which
  // is what proves the previous failure came from the composed port and not
  // from ordinary route validation.
  const created = await createWorkerServiceApp(
    baseEnv(
      originEnv({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify(hostedBrokerRoutes({})),
      }),
    ),
    "takosumi-api",
    { operatorInstallConfigs: [] },
  );
  const configs = await created.operations.capsules.listSharedInstallConfigs();
  expect(configs[0]?.policy.providerCredentials?.requiredProviders).toContain(
    "registry.terraform.io/tako0614/takoform",
  );
});

test("an explicit host origin port still wins over the composed one", async () => {
  // A self-hosting composition that supplies its own authority must not have it
  // silently replaced by whatever extension route happens to be installed.
  const created = await createWorkerServiceApp(
    baseEnv(
      originEnv({
        TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify(
          hostedBrokerRoutes({
            publicInputExchangePath: "/public-inputs/http-endpoint",
          }),
        ),
      }),
    ),
    "takosumi-api",
    {
      operatorInstallConfigs: [],
      capsulePublicOrigin: async () => "https://operator-owned.example.test",
    },
  );
  expect(created).toBeDefined();
});
