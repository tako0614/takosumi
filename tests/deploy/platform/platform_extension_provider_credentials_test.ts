import { expect, test } from "bun:test";
import {
  platformExtensionProviderCredentialComposition,
} from "../../../deploy/platform/platform_extension_provider_credentials.ts";

const ROUTES = JSON.stringify([
  {
    basePath: "/v1/hosted/marketplace",
    handlerKey: "HOSTED",
    authDelivery: "context",
    workspaceContext: "query-required",
    requiredScopes: [],
    runCredential: {
      audience: "takosumi-hosted.takoform.v1",
      requiredScopes: ["takoform.run"],
    },
    providerCredentialBroker: {
      connectionId: "conn_takosumiHostedTakoform01",
      recipeId: "takosumi-hosted-takoform-run",
      providerSource: "registry.terraform.io/tako0614/takoform",
      displayName: "Takosumi Hosted",
      exchangePath: "/provider-credentials/takoform",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
    },
  },
]);

test("a configured extension contributes one exact run-issued provider broker", async () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
  });
  expect(composition?.operatorProviderConnections).toEqual([
    {
      id: "conn_takosumiHostedTakoform01",
      providerSource: "registry.terraform.io/tako0614/takoform",
      displayName: "Takosumi Hosted",
      credentialRecipe: {
        id: "takosumi-hosted-takoform-run",
        authMode: "broker",
      },
    },
  ]);
  const recipe = composition?.credentialRecipes[0];
  expect(recipe).toMatchObject({
    id: "takosumi-hosted-takoform-run",
    terraformSource: ["registry.terraform.io/tako0614/takoform"],
    envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
  });
  const driver = composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
  expect(driver).toBeDefined();

  const calls: unknown[] = [];
  const minted = await driver!.mint!({
    connection: {
      id: "conn_takosumiHostedTakoform01",
      workspaceId: "operator",
      provider: "registry.terraform.io/tako0614/takoform",
      providerSource: "registry.terraform.io/tako0614/takoform",
      scope: { kind: "operator" },
      materialization: "run-issued",
      status: "verified",
      envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
      requiredEnvGroups: [
        ["TAKOFORM_ENDPOINT"],
        ["TAKOFORM_SPACE"],
        ["TAKOFORM_TOKEN"],
      ],
      credentialRecipe: {
        id: "takosumi-hosted-takoform-run",
        authMode: "broker",
      },
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    },
    runCredentialSettings: {
      reservationId: "rsv_hosted",
      resourceName: "media",
    },
    values: {},
    files: [],
    run: {
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      runId: "run_1",
      installingPrincipalId: "acct_1",
      phase: "apply",
    },
    issueRunCredential: async () => ({
      token: "platform_run_token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      ttlSeconds: 300,
    }),
    fetch: async (input, init) => {
      calls.push({ input, init });
      return Response.json({
        kind: "takosumi.provider-run-credential@v1",
        env: {
          TAKOFORM_ENDPOINT: "https://api.takoserver.com",
          TAKOFORM_SPACE: "tenant:tsh_opaque",
          TAKOFORM_TOKEN: "tfr_runner_only",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    },
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    staticEvidence: () => ({
      connectionId: "conn_takosumiHostedTakoform01",
      provider: "registry.terraform.io/tako0614/takoform",
      temporary: true,
      ttlEnforced: true,
      issuer: "platform_extension_provider_credential",
      secretValueStored: false,
    }),
  });

  expect(minted.env).toEqual({
    TAKOFORM_ENDPOINT: "https://api.takoserver.com",
    TAKOFORM_SPACE: "tenant:tsh_opaque",
    TAKOFORM_TOKEN: "tfr_runner_only",
  });
  expect(calls).toHaveLength(1);
  const call = calls[0] as { input: string; init: RequestInit };
  expect(call.input).toBe(
    "https://app-staging.takosumi.com/v1/hosted/marketplace/provider-credentials/takoform?workspaceId=ws_1",
  );
  expect(new Headers(call.init.headers).get("authorization")).toBe(
    "Bearer platform_run_token",
  );
  expect(JSON.parse(String(call.init.body))).toEqual({
    kind: "takosumi.provider-run-credential-request@v1",
    providerSource: "registry.terraform.io/tako0614/takoform",
    settings: { reservationId: "rsv_hosted", resourceName: "media" },
  });
});
