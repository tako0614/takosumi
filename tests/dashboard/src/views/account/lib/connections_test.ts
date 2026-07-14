import { expect, test } from "bun:test";

import { providerSetupOptionsFromCredentialRecipes } from "../../../../../../dashboard/src/views/account/lib/connections.ts";

test("service-installed CredentialRecipe presentation becomes the complete guided form", () => {
  const options = providerSetupOptionsFromCredentialRecipes(
    [
      {
        id: "example",
        displayName: "Example Cloud",
        secretPartition: "provider:example",
        terraformSource: [
          "example/example",
          "registry.opentofu.org/example/example",
        ],
        authModes: {
          token: {
            env: {
              EXAMPLE_ACCOUNT: { from: "value", name: "account" },
              EXAMPLE_TOKEN: { from: "secret", name: "token" },
              EXAMPLE_ALIAS: { from: "value", name: "account" },
              EXAMPLE_EPHEMERAL: {
                from: "generated",
                name: "ephemeral",
              },
            },
            inputHints: {
              EXAMPLE_ACCOUNT: {
                label: { en: "Account", ja: "アカウント" },
                placeholder: { en: "acct_123", ja: "アカウント ID" },
              },
              // A false hint must never expose recipe-declared secret material.
              EXAMPLE_TOKEN: { label: "Token", secret: false },
              EXAMPLE_ALIAS: { hidden: true },
            },
            presentation: {
              showInConnectionSetup: true,
              displayName: { en: "Access token", ja: "アクセストークン" },
              description: {
                en: "Use a scoped token.",
                ja: "限定トークンを使います。",
              },
              setupGuide: {
                url: "https://example.test/tokens",
                steps: [
                  { en: "Create a token.", ja: "トークンを作成します。" },
                ],
              },
            },
          },
          api_only: {
            env: { EXAMPLE_OTHER: { from: "secret" } },
          },
        },
      },
    ],
    "ja-JP",
  );

  expect(options).toEqual([
    {
      id: "recipe:example:token",
      providerSource: "example/example",
      providerAliases: ["registry.opentofu.org/example/example"],
      credentialRecipe: {
        id: "example",
        authMode: "token",
        secretPartition: "provider:example",
      },
      label: "Example Cloud — アクセストークン",
      description: "限定トークンを使います。",
      setupGuide: {
        url: "https://example.test/tokens",
        steps: ["トークンを作成します。"],
      },
      fields: [
        {
          envName: "EXAMPLE_ACCOUNT",
          label: "アカウント",
          placeholder: "アカウント ID",
          required: true,
          secret: false,
        },
        {
          envName: "EXAMPLE_TOKEN",
          label: "Token",
          required: true,
          secret: true,
        },
      ],
    },
  ]);
});

test("recipes without explicit setup presentation are not UI options or execution denials", () => {
  expect(
    providerSetupOptionsFromCredentialRecipes(
      [
        {
          id: "api-only",
          displayName: "API only",
          secretPartition: "provider:api-only",
          terraformSource: ["example/api-only"],
          authModes: {
            token: { env: { API_TOKEN: { from: "secret" } } },
          },
        },
        {
          id: "generic-env",
          displayName: "Generic env",
          secretPartition: "provider-credentials",
          terraformSource: "*",
          authModes: {
            env: {
              env: { "*": { from: "user_defined" } },
              presentation: { showInConnectionSetup: true },
            },
          },
        },
      ],
      "en",
    ),
  ).toEqual([]);
});
