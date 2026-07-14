import { expect, test } from "bun:test";

import {
  installExperienceValue,
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
