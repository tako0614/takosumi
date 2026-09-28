import { expect, spyOn, test } from "bun:test";
import type { Capsule } from "../../../contract/capsules.ts";
import { resolveTargetConnection } from "../../../core/adapters/vault/run_issued_operator_reconciliation.ts";
import { StaticSecretConnectionVault } from "../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../helpers/deploy-control/model_fixture.ts";
import type {
  OpenTofuControlStore,
  UpdateCapsuleLifecycleCommand,
  UpdateCapsuleLifecycleResult,
} from "../../../core/domains/deploy-control/store.ts";
import {
  createPlatformExtensionCapsulePublicOriginLedger,
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
      renewableEnv: {
        sourceEnvName: "TAKOFORM_TOKEN",
        fileEnvName: "TAKOFORM_TOKEN_FILE",
        minimumProviderVersion: "4.1.0",
      },
      runCredentialSettings: { requiredAvailableMinor: 2300 },
    },
  },
]);

const PAIRED_ROUTES = JSON.stringify(
  (JSON.parse(ROUTES) as Array<Record<string, unknown>>).map((route) => ({
    ...route,
    providerCredentialBroker: {
      ...(route.providerCredentialBroker as Record<string, unknown>),
      renewableConnectionId: "conn_takoserverTakoformRenew01",
    },
  })),
);

test("an opt-in renewable broker preserves the static Connection and mints both through the canonical Run", async () => {
  let exchanges = 0;
  const composition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: PAIRED_ROUTES,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
    HOSTED: {
      exchangeProviderCredential: async () => {
        exchanges += 1;
        return {
          status: 200,
          body: JSON.stringify({
            kind: "takosumi.provider-run-credential@v1",
            env: {
              TAKOFORM_ENDPOINT: "https://api.takoserver.test",
              TAKOFORM_SPACE: "tenant:test",
              TAKOFORM_TOKEN: "runner-only-token",
            },
            expiresAt: "2026-08-18T00:05:00.000Z",
          }),
        };
      },
    },
  });
  expect(composition).toBeDefined();
  const recipe = composition!.credentialRecipes[0]!;
  const staticRoutes = JSON.stringify(
    (JSON.parse(ROUTES) as Array<Record<string, unknown>>).map((route) => {
      const { renewableEnv: _renewableEnv, ...staticBroker } =
        route.providerCredentialBroker as Record<string, unknown>;
      return { ...route, providerCredentialBroker: staticBroker };
    }),
  );
  const staticComposition = platformExtensionProviderCredentialComposition({
    TAKOSUMI_PLATFORM_EXTENSIONS: staticRoutes,
    TAKOSUMI_ACCOUNTS_ISSUER: "https://app-staging.takosumi.com",
  })!;
  expect(recipe.authModes.broker).toEqual(
    staticComposition.credentialRecipes[0]!.authModes.broker,
  );
  expect(composition!.operatorProviderConnections[0]).toEqual(
    staticComposition.operatorProviderConnections[0],
  );
  expect(recipe.authModes.broker?.renewableEnv).toBeUndefined();
  expect(recipe.authModes["broker-renewable"]?.renewableEnv).toEqual({
    sourceEnvName: "TAKOFORM_TOKEN",
    fileEnvName: "TAKOFORM_TOKEN_FILE",
    minimumProviderVersion: "4.1.0",
  });
  expect(Object.keys(composition!.credentialRecipeDrivers).sort()).toEqual([
    "takosumi-hosted-takoform-run/broker",
    "takosumi-hosted-takoform-run/broker-renewable",
  ]);
  expect(composition!.operatorProviderConnections.map((entry) => [
    entry.id,
    entry.credentialRecipe.authMode,
  ])).toEqual([
    ["conn_takosumiHostedTakoform01", "broker"],
    ["conn_takoserverTakoformRenew01", "broker-renewable"],
  ]);

  const recipes = new Map(composition!.credentialRecipes.map((entry) => [entry.id, entry]));
  const connections = composition!.operatorProviderConnections.map((entry) =>
    resolveTargetConnection(
      entry,
      (id) => recipes.get(id),
      composition!.credentialRecipeDrivers,
      "1970-01-01T00:00:00.000Z",
    )
  );
  expect(connections[0]!.credentialRecipe?.renewableEnv).toBeUndefined();
  expect(connections[1]!.credentialRecipe?.renewableEnv).toEqual(
    recipe.authModes["broker-renewable"]?.renewableEnv,
  );
  const store = new InMemoryOpenTofuControlStore();
  const vault = new StaticSecretConnectionVault({
    store,
    crypto: new PartitionedSecretBoundaryCrypto({
      globalPassphrase: "test-passphrase-0123456789-abcdef-0123456789",
    }),
    now: () => new Date("2026-08-18T00:00:00.000Z"),
    credentialRecipeResolver: (id) => recipes.get(id),
    credentialDrivers: composition!.credentialRecipeDrivers,
    operatorProviderConnections: connections,
    runCredentialIssuer: async ({ request }) => ({
      token: "run-only-token",
      expiresAt: "2026-08-18T00:10:00.000Z",
      ttlSeconds: request.ttlSeconds ?? 600,
    }),
  });
  const { capsule } = await seedCapsuleModel(store, {
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    installConfig: { workspaceId: "workspace_1" },
  });
  await store.putCapsule({
    ...capsule,
    status: "active",
    installingPrincipalId: "principal_installer",
  });
  await store.putPlanRun({
    id: "plan_1",
    workspaceId: "workspace_1",
    capsuleId: "capsule_1",
    capsuleContext: {
      workspaceId: "workspace_1",
      capsuleId: "capsule_1",
      environment: "production",
    },
    source: { kind: "git", url: "https://example.test/app.git", ref: "main" },
    sourceDigest: "sha256:source",
    operation: "update",
    runnerProfileId: "opentofu-default",
    variablesDigest: "sha256:variables",
    requiredProviders: ["registry.terraform.io/tako0614/takoform"],
    status: "running",
    policy: { status: "passed", reasons: [], checkedAt: 1 },
    policyDecisionDigest: "sha256:policy",
    auditEvents: [],
    createdAt: 1,
    updatedAt: 1,
  });
  for (const connection of connections) {
    const bundle = await vault.mintForCapsuleProviderBindings(
      "workspace_1",
      [{ provider: connection.providerSource, connectionId: connection.id }],
      { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
    );
    expect(bundle.env.TAKOFORM_TOKEN).toBe("runner-only-token");
    expect(bundle.providerCredentialEvidence[0]?.connectionId).toBe(connection.id);
  }
  expect(await store.getConnection(connections[0]!.id)).toBeUndefined();
  expect(await store.getConnection(connections[1]!.id)).toBeUndefined();
  expect(exchanges).toBe(2);
  const stopped = (await store.getPlanRun("plan_1"))!;
  await store.putPlanRun({ ...stopped, status: "failed" });
  for (const connection of connections) {
    await expect(vault.mintForCapsuleProviderBindings(
      "workspace_1",
      [{ provider: connection.providerSource, connectionId: connection.id }],
      { phase: "plan", capsuleId: "capsule_1", runId: "plan_1" },
    )).rejects.toThrow();
  }
  expect(exchanges).toBe(2);
});

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
    authModes: {
      broker: {
        renewableEnv: {
          sourceEnvName: "TAKOFORM_TOKEN",
          fileEnvName: "TAKOFORM_TOKEN_FILE",
          minimumProviderVersion: "4.1.0",
        },
      },
    },
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

const LEDGER_CAPSULE: Capsule = {
  id: "cap_ledger",
  workspaceId: "ws_ledger",
  projectId: "prj_ledger",
  name: "ledger",
  slug: "ledger",
  sourceId: "src_ledger",
  installConfigId: "cfg_ledger",
  environment: "production",
  currentStateGeneration: 0,
  status: "pending",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

const LEDGER_RESERVATION = {
  reservationRef: "reservation_ledger",
  origin: "https://ledger.example.test",
  requestedLabel: "ledger-ws",
  reservedAt: "2026-08-18T00:00:00.000Z",
} as const;

function ledgerStore(input: {
  readonly capsule?: Capsule;
  readonly epoch?: number;
  readonly results?: readonly UpdateCapsuleLifecycleResult["kind"][];
} = {}): {
  readonly store: Pick<
    OpenTofuControlStore,
    | "getCapsule"
    | "getCapsuleExecutionAuthorityEpoch"
    | "updateCapsuleLifecycle"
  >;
  readonly updates: UpdateCapsuleLifecycleCommand[];
} {
  let current = Object.prototype.hasOwnProperty.call(input, "capsule")
    ? input.capsule
    : LEDGER_CAPSULE;
  let resultIndex = 0;
  const updates: UpdateCapsuleLifecycleCommand[] = [];
  const store: Pick<
    OpenTofuControlStore,
    | "getCapsule"
    | "getCapsuleExecutionAuthorityEpoch"
    | "updateCapsuleLifecycle"
  > = {
    getCapsule: async () => current,
    getCapsuleExecutionAuthorityEpoch: async () =>
      Object.prototype.hasOwnProperty.call(input, "epoch")
        ? input.epoch
        : 7,
    updateCapsuleLifecycle: async (command) => {
      updates.push(command);
      if (command.mutation.kind !== "public-origin-reservation") {
        throw new TypeError(
          "unexpected Capsule lifecycle mutation in ledger test",
        );
      }
      const kind = input.results?.[resultIndex++] ?? "updated";
      if (kind === "not-found") return { kind };
      if (kind === "conflict") return { kind, current: current! };
      current = {
        ...current!,
        publicOriginReservation: command.mutation.reservation,
        updatedAt: command.updatedAt,
      };
      return { kind, capsule: current! };
    },
  };
  return { store, updates };
}

test("the public-origin ledger reads the injected Capsule record, including released evidence", async () => {
  const released = {
    ...LEDGER_RESERVATION,
    releasedAt: "2026-08-19T00:00:00.000Z",
  };
  const { store } = ledgerStore({
    capsule: { ...LEDGER_CAPSULE, publicOriginReservation: released },
  });
  const ledger = createPlatformExtensionCapsulePublicOriginLedger(store);

  expect(await ledger.read(LEDGER_CAPSULE.id)).toEqual(released);
});

test("the public-origin ledger writes through lifecycle CAS with a bounded retry", async () => {
  const { store, updates } = ledgerStore();
  const ledger = createPlatformExtensionCapsulePublicOriginLedger(
    store,
    () => new Date("2026-08-20T00:00:00.000Z"),
  );

  await ledger.write(LEDGER_CAPSULE.id, LEDGER_RESERVATION);

  expect(updates).toHaveLength(1);
  expect(updates[0]).toMatchObject({
    capsuleId: LEDGER_CAPSULE.id,
    expected: {
      executionAuthorityEpoch: 7,
      currentStateGeneration: 0,
      status: "pending",
    },
    mutation: {
      kind: "public-origin-reservation",
      reservation: LEDGER_RESERVATION,
    },
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
});

test("the public-origin ledger retries one lifecycle conflict and then succeeds", async () => {
  const { store, updates } = ledgerStore({ results: ["conflict", "updated"] });
  const ledger = createPlatformExtensionCapsulePublicOriginLedger(store);

  await ledger.write(LEDGER_CAPSULE.id, LEDGER_RESERVATION);

  expect(updates).toHaveLength(2);
});

test("the public-origin ledger fails after two lifecycle conflicts", async () => {
  const { store, updates } = ledgerStore({
    results: ["conflict", "conflict"],
  });
  const ledger = createPlatformExtensionCapsulePublicOriginLedger(store);

  await expect(
    ledger.write(LEDGER_CAPSULE.id, LEDGER_RESERVATION),
  ).rejects.toThrow("lost its Capsule revision twice");
  expect(updates).toHaveLength(2);
});

test("the public-origin ledger fails when the Capsule or execution epoch is missing", async () => {
  const missingCapsule = ledgerStore({ capsule: undefined });
  await expect(
    createPlatformExtensionCapsulePublicOriginLedger(
      missingCapsule.store,
    ).write(LEDGER_CAPSULE.id, LEDGER_RESERVATION),
  ).rejects.toThrow("has no current Capsule");

  const missingEpoch = ledgerStore({ epoch: undefined });
  await expect(
    createPlatformExtensionCapsulePublicOriginLedger(
      missingEpoch.store,
    ).write(LEDGER_CAPSULE.id, LEDGER_RESERVATION),
  ).rejects.toThrow("has no current Capsule");
});
