import { expect, test } from "bun:test";

import {
  installExperienceValue,
  installConfigStoreValue,
  variablePresentationValue,
} from "../../../../accounts/service/src/control/parse.ts";

test("OIDC install experience uses only explicit module variable mappings", () => {
  expect(
    installExperienceValue({
      projections: [
        {
          kind: "oidc_client",
          variables: {
            issuerUrl: "identity_issuer",
            clientId: "identity_client_id",
          },
          callbackPath: "/auth/callback",
        },
      ],
    }),
  ).toEqual({
    projections: [
      {
        kind: "oidc_client",
        variables: {
          issuerUrl: "identity_issuer",
          clientId: "identity_client_id",
        },
        callbackPath: "/auth/callback",
      },
    ],
  });

  // Registering a redirect without an explicit application callback would
  // otherwise force a Takos/Takosumi-specific path convention on the module.
  expect(
    installExperienceValue({
      projections: [{ kind: "oidc_client", variables: {} }],
    }),
  ).toBeUndefined();
});

test("InstallConfig accepts an operator-defined presentation hint", () => {
  expect(
    variablePresentationValue([
      {
        name: "region",
        format: "operator.region-picker.v1",
        label: { ja: "リージョン", en: "Region" },
      },
    ]),
  ).toEqual([
    {
      name: "region",
      format: "operator.region-picker.v1",
      label: { ja: "リージョン", en: "Region" },
    },
  ]);
});

test("Store icon metadata accepts only safe HTTPS or repository-relative paths", () => {
  const store = (iconUrl: string) =>
    installConfigStoreValue({
      source: { url: "https://github.com/example/app.git", path: "." },
      order: 1,
      surface: "apps",
      kind: "app",
      provider: "Example",
      suggestedName: "example",
      badge: { ja: "例", en: "Example" },
      name: { ja: "例", en: "Example" },
      description: { ja: "説明", en: "Description" },
      iconUrl,
    });
  expect(store("https://assets.example.test/icon.svg")?.iconUrl).toBe(
    "https://assets.example.test/icon.svg",
  );
  expect(store("public/icon.svg")?.iconUrl).toBe("public/icon.svg");
  for (const invalid of [
    "javascript:alert(1)",
    "data:image/svg+xml;base64,abc",
    "https://user:secret@assets.example.test/icon.svg",
    "https://assets.example.test/icon.svg?client_secret=abc",
    "public/icon.svg?token=abc",
    "../secret.svg",
    "//evil.example/icon.svg",
  ]) {
    expect(store(invalid)).toBeUndefined();
  }
});
