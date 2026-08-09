import { describe, expect, test } from "bun:test";
import {
  credentialRecipeDriverKey,
  resolveCredentialRecipeHostComposition,
  type CredentialRecipeHostComposition,
} from "takosumi-contract/credential-recipe-host";

const BASE: CredentialRecipeHostComposition = {
  credentialRecipes: [
    {
      id: "generic-env",
      displayName: "Generic env",
      terraformSource: "*",
      envNames: ["GENERIC_TOKEN"],
      authModes: { env: { env: { GENERIC_TOKEN: { from: "secret" } } } },
    },
  ],
  credentialRecipeDrivers: {},
};

function contribution(): CredentialRecipeHostComposition {
  const key = credentialRecipeDriverKey({
    id: "operator-run-credential",
    authMode: "broker",
  });
  return {
    credentialRecipes: [
      {
        id: "operator-run-credential",
        displayName: "Operator Run credential",
        terraformSource: "*",
        envNames: ["RUN_CREDENTIAL_TOKEN"],
        authModes: {
          broker: {
            preRun: { type: "issue_run_credential" },
            runIssuance: {
              context: "capsule-run.v1",
              operatorConnection: "workspace-bindable",
              storedMaterial: "none",
              audience: "extension.example.v1",
              scopes: ["extension:invoke"],
            },
          },
        },
      },
    ],
    credentialRecipeDrivers: {
      [key]: {
        evidenceIssuer: "operator_run_credential",
        verify: async () => ({ ok: true }),
        mint: async ({ connection }) => ({
          env: { RUN_CREDENTIAL_TOKEN: "synthetic" },
          evidence: {
            connectionId: connection.id,
            provider: connection.provider,
            temporary: true,
            ttlEnforced: true,
            issuer: "test",
            secretValueStored: false,
          },
        }),
      },
    },
    operatorProviderConnections: [
      {
        id: "conn_operatorRun01",
        providerSource: "registry.example/operator/extension",
        displayName: "Operator run credential",
        credentialRecipe: {
          id: "operator-run-credential",
          authMode: "broker",
        },
      },
    ],
  };
}

describe("Credential Recipe host composition", () => {
  test("adds a trusted in-process recipe and exact driver without replacing OSS recipes", () => {
    const host = contribution();
    const resolved = resolveCredentialRecipeHostComposition(host, BASE);
    expect(resolved.credentialRecipes.map(({ id }) => id)).toEqual([
      "generic-env",
      "operator-run-credential",
    ]);
    const driver = resolved.credentialRecipeDrivers[
      "operator-run-credential/broker"
    ];
    expect(typeof driver?.verify).toBe("function");
    expect(typeof driver?.mint).toBe("function");
    expect(resolved.operatorProviderConnections).toEqual([
      {
        id: "conn_operatorRun01",
        providerSource: "registry.example/operator/extension",
        displayName: "Operator run credential",
        credentialRecipe: {
          id: "operator-run-credential",
          authMode: "broker",
        },
      },
    ]);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.credentialRecipes)).toBe(true);
    expect(Object.isFrozen(resolved.credentialRecipeDrivers)).toBe(true);
  });

  test("fails closed on recipe/driver collisions", () => {
    const duplicateRecipe = {
      ...contribution(),
      credentialRecipes: [BASE.credentialRecipes[0]!],
    };
    expect(() =>
      resolveCredentialRecipeHostComposition(duplicateRecipe, BASE),
    ).toThrow(/must have one host owner/);

    const key = "operator-run-credential/broker";
    expect(() =>
      resolveCredentialRecipeHostComposition(contribution(), {
        ...BASE,
        credentialRecipeDrivers: {
          [key]: contribution().credentialRecipeDrivers[key]!,
        },
      }),
    ).toThrow(/driver .* must have one host owner/);
  });

  test("requires the exact descriptor plus preRun verify and mint", () => {
    const valid = contribution();
    expect(() =>
      resolveCredentialRecipeHostComposition(
        { ...valid, credentialRecipeDrivers: {} },
        BASE,
      ),
    ).toThrow(/verify plus mint/);
    expect(() =>
      resolveCredentialRecipeHostComposition(
        {
          ...valid,
          credentialRecipes: valid.credentialRecipes.map((recipe) => ({
            ...recipe,
            authModes: {
              broker: {
                ...recipe.authModes.broker,
                runIssuance: {
                  ...recipe.authModes.broker?.runIssuance,
                  context: "caller-metadata.v1",
                },
              },
            },
          })) as never,
        },
        BASE,
      ),
    ).toThrow(/exact descriptor/);

    for (const runIssuance of [
      {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "",
        scopes: ["extension:invoke"],
      },
      {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["admin"],
      },
      {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["extension:invoke", "extension:invoke"],
      },
    ]) {
      expect(() =>
        resolveCredentialRecipeHostComposition(
          {
            ...valid,
            credentialRecipes: valid.credentialRecipes.map((recipe) => ({
              ...recipe,
              authModes: {
                broker: {
                  ...recipe.authModes.broker,
                  runIssuance,
                },
              },
            })) as never,
          },
          BASE,
        ),
      ).toThrow(/exact descriptor/);
    }
  });

  test("rejects serialized-looking or incomplete values instead of decoding them", () => {
    expect(() =>
      resolveCredentialRecipeHostComposition("{}" as never, BASE),
    ).toThrow(/code-only recipe and driver object/);
    expect(() =>
      resolveCredentialRecipeHostComposition(
        { credentialRecipes: [], credentialRecipeDrivers: "{}" } as never,
        BASE,
      ),
    ).toThrow(/code-only recipe and driver object/);
  });

  test("rejects duplicate or overbroad fixed-id operator declarations", () => {
    const valid = contribution();
    expect(() =>
      resolveCredentialRecipeHostComposition(
        {
          ...valid,
          operatorProviderConnections: [
            ...valid.operatorProviderConnections!,
            { ...valid.operatorProviderConnections![0]! },
          ],
        },
        BASE,
      ),
    ).toThrow(/must be unique/);

    expect(() =>
      resolveCredentialRecipeHostComposition(
        {
          ...valid,
          operatorProviderConnections: [
            {
              ...valid.operatorProviderConnections![0]!,
              providerSource: "registry.example/other/provider",
              credentialRecipe: {
                ...valid.operatorProviderConnections![0]!.credentialRecipe,
                unknown: "authority",
              },
            } as never,
          ],
        },
        BASE,
      ),
    ).toThrow(/unknown fields/);
  });

  test("requires a bounded control-free driver evidence issuer", () => {
    const valid = contribution();
    expect(() =>
      resolveCredentialRecipeHostComposition(
        {
          ...valid,
          credentialRecipeDrivers: {
            ...valid.credentialRecipeDrivers,
            [credentialRecipeDriverKey({
              id: "operator-run-credential",
              authMode: "broker",
            })]: {
              ...valid.credentialRecipeDrivers[
                "operator-run-credential/broker"
              ],
              evidenceIssuer: "bad\nissuer",
            },
          },
        },
        BASE,
      ),
    ).toThrow(/evidenceIssuer/);
  });
});
