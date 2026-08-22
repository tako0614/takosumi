import { expect, spyOn, test } from "bun:test";
import {
  platformExtensionProviderCredentialComposition,
} from "../../../deploy/platform/platform_extension_provider_credentials.ts";

const ROUTES = JSON.stringify([
  {
    basePath: "/extensions/hosted/marketplace",
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
      runCredentialSettings: { requiredAvailableMinor: 2300 },
    },
  },
]);

test("a configured extension contributes one exact run-issued provider broker", async () => {
  const calls: unknown[] = [];
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      fetchAuthenticated: async (input: Request, context: unknown) => {
        calls.push({ input, context });
        return Response.json({
          kind: "takosumi.provider-run-credential@v1",
          env: {
            TAKOFORM_ENDPOINT: "https://api.takoserver.com",
            TAKOFORM_SPACE: "tenant:tsh_opaque",
            TAKOFORM_TOKEN: "tfr_runner_only",
          },
          expiresAt: "2026-08-18T00:05:00.000Z",
        });
      },
    },
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
      runCredentialSettings: { requiredAvailableMinor: 2300 },
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
    runCredentialSettings: { requiredAvailableMinor: 2300 },
    values: {},
    files: [],
    run: {
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      runId: "run_1",
      installingPrincipalId: "acct_1",
      phase: "apply",
      lifecycleIntent: "provision",
      hostRuntimeMaterialization: {
        contract: "takosumi.host-runtime-materialization/v1",
        installConfigId: "icfg_1",
        workspaceId: "ws_1",
        capsuleId: "cap_1",
        installingPrincipalId: "acct_1",
        requirements: [
          {
            kind: "generated_secret",
            binding: "ENCRYPTION_KEY",
            secretRef: "secret:repository/encryption-key",
            bytes: 32,
            encoding: "base64url",
          },
        ],
      },
    },
    issueRunCredential: async () => ({
      token: "platform_run_token",
      expiresAt: "2026-08-18T00:10:00.000Z",
      ttlSeconds: 600,
    }),
    fetch: async () => {
      throw new Error("credential broker must not use an external self-fetch");
    },
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    staticEvidence: () => ({
      connectionId: "conn_takosumiHostedTakoform01",
      provider: "registry.terraform.io/tako0614/takoform",
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    }),
  });

  expect(minted.env).toEqual({
    TAKOFORM_ENDPOINT: "https://api.takoserver.com",
    TAKOFORM_SPACE: "tenant:tsh_opaque",
    TAKOFORM_TOKEN: "tfr_runner_only",
  });
  expect(minted.evidence).toEqual({
    connectionId: "conn_takosumiHostedTakoform01",
    provider: "registry.terraform.io/tako0614/takoform",
    temporary: true,
    ttlEnforced: true,
    expiresAt: "2026-08-18T00:05:00.000Z",
    ttlSeconds: 300,
    issuer: "platform_extension_provider_credential",
    secretValueStored: false,
  });
  expect(calls).toHaveLength(1);
  const call = calls[0] as { input: Request; context: Record<string, unknown> };
  expect(call.input.url).toBe(
    "https://app-staging.takosumi.com/extensions/hosted/marketplace/provider-credentials/takoform?workspaceId=ws_1",
  );
  expect(call.input.headers.get("authorization")).toBeNull();
  expect(await call.input.json()).toEqual({
    kind: "takosumi.provider-run-credential-request@v1",
    providerSource: "registry.terraform.io/tako0614/takoform",
    settings: { requiredAvailableMinor: 2300 },
  });
  expect(call.context).toEqual({
    authKind: "run-credential",
    subject: "acct_1",
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    runId: "run_1",
    installingPrincipalId: "acct_1",
    audience: "takosumi-hosted.takoform.v1",
    scopes: ["takoform.run"],
    phase: "apply",
    lifecycleIntent: "provision",
    hostRuntimeMaterialization: {
      contract: "takosumi.host-runtime-materialization/v1",
      installConfigId: "icfg_1",
      workspaceId: "ws_1",
      capsuleId: "cap_1",
      installingPrincipalId: "acct_1",
      requirements: [
        {
          kind: "generated_secret",
          binding: "ENCRYPTION_KEY",
          secretRef: "secret:repository/encryption-key",
          bytes: 32,
          encoding: "base64url",
        },
      ],
    },
  });
});

test("broker failures log only a stable status boundary", async () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      fetchAuthenticated: async () =>
        Response.json(
          { error: "raw_response_secret_marker" },
          { status: 401 },
        ),
    },
  });
  const driver = composition?.credentialRecipeDrivers[
    "takosumi-hosted-takoform-run/broker"
  ];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    await expect(
      driver!.mint!({
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
          reservationId: "rsv_secret_marker",
          resourceName: "media",
        },
        values: {},
        files: [],
        run: {
          workspaceId: "ws_secret_marker",
          capsuleId: "cap_secret_marker",
          runId: "run_secret_marker",
          installingPrincipalId: "acct_secret_marker",
          phase: "plan",
          lifecycleIntent: "provision",
        },
        issueRunCredential: async () => ({
          token: "platform_secret_marker",
          expiresAt: "2026-08-18T00:10:00.000Z",
          ttlSeconds: 600,
        }),
        fetch: async () => {
          throw new Error("credential broker must not use an external self-fetch");
        },
        now: () => new Date("2026-08-18T00:00:00.000Z"),
        staticEvidence: () => ({
          connectionId: "conn_takosumiHostedTakoform01",
          provider: "registry.terraform.io/tako0614/takoform",
          temporary: false,
          ttlEnforced: false,
          issuer: "static_secret",
        }),
      }),
    ).rejects.toThrow("provider credential exchange failed");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(logged)).toEqual({
      event: "platform_extension_provider_credential_exchange_failed",
      stage: "handler_response_failed",
      status: 401,
    });
    expect(logged).not.toContain("secret_marker");
  } finally {
    warn.mockRestore();
  }
});
