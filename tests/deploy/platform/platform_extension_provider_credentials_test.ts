import { expect, spyOn, test } from "bun:test";
import { platformExtensionProviderCredentialComposition } from "../../../deploy/platform/platform_extension_provider_credentials.ts";

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
      publicInputPath: "/public-inputs/http-endpoint",
      publicInputCapabilities: ["http_endpoint_url"],
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
      exchangeProviderCredential: async (input: unknown) => {
        calls.push(input);
        return {
          status: 200,
          body: JSON.stringify({
            kind: "takosumi.provider-run-credential@v1",
            env: {
              TAKOFORM_ENDPOINT: "https://api.takoserver.com",
              TAKOFORM_SPACE: "tenant:tsh_opaque",
              TAKOFORM_TOKEN: "tfr_runner_only",
            },
            expiresAt: "2026-08-18T00:05:00.000Z",
          }),
        };
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
  expect(composition?.credentialRequiredProviderSources).toEqual([
    "registry.terraform.io/tako0614/takoform",
  ]);
  const recipe = composition?.credentialRecipes[0];
  expect(recipe).toMatchObject({
    id: "takosumi-hosted-takoform-run",
    terraformSource: ["registry.terraform.io/tako0614/takoform"],
    envNames: ["TAKOFORM_ENDPOINT", "TAKOFORM_SPACE", "TAKOFORM_TOKEN"],
  });
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
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
  const call = calls[0] as {
    url: string;
    request: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  expect(call.url).toBe(
    "https://app-staging.takosumi.com/extensions/hosted/marketplace/provider-credentials/takoform?workspaceId=ws_1",
  );
  expect(call.request).toEqual({
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
  });
});

test("trusted platform broker uses a distinct identity-free public-input route", async () => {
  const publicCalls: unknown[] = [];
  const credentialCalls: unknown[] = [];
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      exchangeProviderCredential: async (input: unknown) => {
        credentialCalls.push(input);
        throw new Error("credential exchange must not serve public inputs");
      },
      exchangeProviderPublicInput: async (input: unknown) => {
        publicCalls.push(input);
        return {
          status: 200,
          body: JSON.stringify({
            kind: "takosumi.provider-public-input-reservation@v1",
            publicInputs: {
              httpEndpointUrl: "https://echo-a1b2.takoserver.net",
              reservationRef: "reservation/provider-owned/a1b2",
            },
          }),
        };
      },
    },
  });
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
  const resolved = await driver!.resolvePublicInputs!({
    ...publicInputContext(),
    publicInputRequest: {
      httpEndpointUrl: {
        clientIdempotencyKey: `endpoint_request_${"a".repeat(64)}`,
        requestedSubdomain: "echo-a1b2",
      },
    },
  });

  expect(resolved).toEqual({
    httpEndpointUrl: "https://echo-a1b2.takoserver.net",
    reservationRef: "reservation/provider-owned/a1b2",
  });
  expect(credentialCalls).toEqual([]);
  expect(publicCalls).toHaveLength(1);
  const call = publicCalls[0] as {
    url: string;
    request: Record<string, unknown>;
    context: Record<string, unknown>;
  };
  expect(call.url).toBe(
    "https://app-staging.takosumi.com/extensions/hosted/marketplace/public-inputs/http-endpoint",
  );
  const request = call.request;
  expect(request).toEqual({
    kind: "takosumi.provider-public-input-reservation-request@v1",
    providerSource: "registry.terraform.io/tako0614/takoform",
    settings: { requiredAvailableMinor: 2300 },
    publicInputs: {
      httpEndpointUrl: {
        clientIdempotencyKey: `endpoint_request_${"a".repeat(64)}`,
        requestedSubdomain: "echo-a1b2",
      },
    },
  });
  expect(call.context).toEqual({
    authKind: "provider-public-input",
    providerSource: "registry.terraform.io/tako0614/takoform",
    workspaceId: "ws_1",
  });
  expect(JSON.stringify(call)).not.toContain("acct_1");
  expect(JSON.stringify(call)).not.toContain("run_1");
});

test("trusted platform broker rejects arbitrary public input keys", async () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      exchangeProviderPublicInput: async () => ({
        status: 200,
        body: JSON.stringify({
          kind: "takosumi.provider-public-input-reservation@v1",
          publicInputs: {
            httpEndpointUrl: "https://echo-a1b2.takoserver.net",
            reservationRef: "reservation/provider-owned/a1b2",
            TF_VAR_app_url: "https://attacker.example",
          },
        }),
      }),
    },
  });
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
  await expect(
    driver!.resolvePublicInputs!({
      ...publicInputContext(),
      publicInputRequest: {
        httpEndpointUrl: {
          clientIdempotencyKey: `endpoint_request_${"b".repeat(64)}`,
          requestedSubdomain: "echo-a1b2",
        },
      },
    }),
  ).rejects.toThrow("provider public input response is malformed");
});

test("typed release replays the exact opaque ref and never treats HTTP 404 as absent", async () => {
  const calls: Array<{ request?: Record<string, unknown> }> = [];
  let releaseCount = 0;
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      exchangeProviderPublicInput: async (input: {
        request: Record<string, unknown>;
      }) => {
        calls.push(input);
        releaseCount += 1;
        return {
          status: releaseCount === 3 ? 404 : 200,
          body: JSON.stringify({
            kind: "takosumi.provider-public-input-release@v1",
            status: releaseCount === 1 ? "released" : "already_absent",
            reservationRef: "reservation/provider-owned/a1b2",
          }),
        };
      },
    },
  });
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
  const request = {
    publicInputRequest: {
      httpEndpointUrl: {
        clientIdempotencyKey: `endpoint_request_${"d".repeat(64)}`,
        requestedSubdomain: "echo-a1b2",
        reservationRef: "reservation/provider-owned/a1b2",
      },
    },
  };

  await expect(
    driver!.releasePublicInputs!({ ...publicInputContext(), ...request }),
  ).resolves.toEqual({
    status: "released",
    reservationRef: "reservation/provider-owned/a1b2",
  });
  await expect(
    driver!.releasePublicInputs!({ ...publicInputContext(), ...request }),
  ).resolves.toEqual({
    status: "already_absent",
    reservationRef: "reservation/provider-owned/a1b2",
  });
  await expect(
    driver!.releasePublicInputs!({ ...publicInputContext(), ...request }),
  ).rejects.toThrow("provider public input exchange failed");
  const releaseRequests = calls.map((call) => call.request);
  expect(releaseRequests).toEqual([
    {
      kind: "takosumi.provider-public-input-reservation-release@v1",
      providerSource: "registry.terraform.io/tako0614/takoform",
      settings: { requiredAvailableMinor: 2300 },
      publicInputs: request.publicInputRequest,
    },
    {
      kind: "takosumi.provider-public-input-reservation-release@v1",
      providerSource: "registry.terraform.io/tako0614/takoform",
      settings: { requiredAvailableMinor: 2300 },
      publicInputs: request.publicInputRequest,
    },
    {
      kind: "takosumi.provider-public-input-reservation-release@v1",
      providerSource: "registry.terraform.io/tako0614/takoform",
      settings: { requiredAvailableMinor: 2300 },
      publicInputs: request.publicInputRequest,
    },
  ]);
  expect(JSON.stringify(releaseRequests)).not.toContain("acct_1");
  expect(JSON.stringify(releaseRequests)).not.toContain("run_1");
});

test("provider broker sources contribute a sorted deduplicated exact-source authority", () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: JSON.stringify([
      {
        basePath: "/extensions/one",
        handlerKey: "ONE",
        authDelivery: "context",
        runCredential: {
          audience: "operator.one.v1",
          requiredScopes: ["one.invoke"],
        },
        providerCredentialBroker: {
          connectionId: "conn_providerOne01",
          recipeId: "provider-one-run",
          providerSource: "registry.example.com/acme/one",
          displayName: "Provider One",
          exchangePath: "/credentials/one",
          envNames: ["PROVIDER_ONE_TOKEN"],
        },
      },
      {
        basePath: "/extensions/two",
        handlerKey: "TWO",
        authDelivery: "context",
        runCredential: {
          audience: "operator.two.v1",
          requiredScopes: ["two.invoke"],
        },
        providerCredentialBroker: {
          connectionId: "conn_providerTwo01",
          recipeId: "provider-two-run",
          providerSource: "registry.example.com/acme/one",
          displayName: "Provider One duplicate",
          exchangePath: "/credentials/one",
          envNames: ["PROVIDER_TWO_TOKEN"],
        },
      },
      {
        basePath: "/extensions/three",
        handlerKey: "THREE",
        authDelivery: "context",
        runCredential: {
          audience: "operator.three.v1",
          requiredScopes: ["three.invoke"],
        },
        providerCredentialBroker: {
          connectionId: "conn_providerThree01",
          recipeId: "provider-three-run",
          providerSource: "registry.opentofu.org/acme/three",
          displayName: "Provider Three",
          exchangePath: "/credentials/three",
          envNames: ["PROVIDER_THREE_TOKEN"],
        },
      },
    ]),
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app.takosumi.test",
  });

  expect(composition?.credentialRequiredProviderSources).toEqual([
    "registry.example.com/acme/one",
    "registry.opentofu.org/acme/three",
  ]);
});

test("broker failures log only a stable status boundary", async () => {
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      fetchAuthenticated: async () =>
        Response.json({ error: "raw_response_secret_marker" }, { status: 401 }),
    },
  });
  const driver =
    composition?.credentialRecipeDrivers["takosumi-hosted-takoform-run/broker"];
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
          throw new Error(
            "credential broker must not use an external self-fetch",
          );
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

function driverContext() {
  return {
    connection: {
      id: "conn_takosumiHostedTakoform01",
      workspaceId: "operator",
      provider: "registry.terraform.io/tako0614/takoform",
      providerSource: "registry.terraform.io/tako0614/takoform",
      scope: { kind: "operator" as const },
      materialization: "run-issued" as const,
      status: "verified" as const,
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
      phase: "plan" as const,
      lifecycleIntent: "provision" as const,
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
  };
}

function publicInputContext() {
  const base = driverContext();
  return {
    workspaceId: "ws_1",
    connection: base.connection,
    runCredentialSettings: base.runCredentialSettings,
    values: base.values,
    files: base.files,
    fetch: base.fetch,
    now: base.now,
  };
}
