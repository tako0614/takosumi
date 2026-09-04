/** ProviderConnection binding resolution. */
import { expect, test } from "bun:test";

import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { ProviderConnectionMaterialization } from "takosumi-contract/connections";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import {
  seedCapsuleModel,
  transitionProviderBindingSetForFixture,
} from "../../../helpers/deploy-control/model_fixture.ts";
import {
  ConnectionsService,
  mintableConnectionIds,
  resolvedProviderBindingsDigest,
  type RequiredProviderBindingIdentity,
} from "../../../../core/domains/connections/mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";

function requiredBinding(
  over: Partial<RequiredProviderBindingIdentity> = {},
): RequiredProviderBindingIdentity {
  return {
    source: CLOUDFLARE,
    moduleLocalName: "cloudflare",
    credentialRequired: true,
    allowed: true,
    ...over,
  };
}

function connection(input: {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider?: string;
  readonly providerSource?: string;
  readonly status?: ProviderConnection["status"];
  readonly materialization?: ProviderConnectionMaterialization;
  readonly scopeHints?: ProviderConnection["scopeHints"];
  readonly credentialRecipe?: ProviderConnection["credentialRecipe"];
  readonly runCredentialSettings?: ProviderConnection["runCredentialSettings"];
}): ProviderConnection {
  return {
    id: input.id,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    provider: input.provider ?? CLOUDFLARE,
    providerSource: input.providerSource ?? CLOUDFLARE,
    kind: "cloudflare_api_token",
    scope: input.workspaceId ? "workspace" : "operator",
    status: input.status ?? "verified",
    materialization: input.materialization ?? "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    ...(input.credentialRecipe
      ? { credentialRecipe: input.credentialRecipe }
      : {}),
    ...(input.runCredentialSettings
      ? { runCredentialSettings: input.runCredentialSettings }
      : {}),
    ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const store = new InMemoryOpenTofuControlStore();
  const model = await seedCapsuleModel(store);
  const service = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => NOW,
  });
  return { store, model, service };
}

test("secret ProviderConnection binding resolves to its credential row", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_space_cf", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        alias: "main",
        connectionId: "conn_space_cf",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.materialization).toBe("secret");
  expect(resolved[0]?.connection.id).toBe("conn_space_cf");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_space_cf"]);
});

test("legacy stored builtin ProviderBinding fails before connection or credential resolution", async () => {
  const { store, model, service } = await setup();
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_legacy_builtin",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: "terraform.io/builtin/terraform",
        connectionId: "conn_legacy_builtin",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /stored ProviderBinding cannot target OpenTofu builtin runtime capability terraform\.io\/builtin\/terraform/,
  );
  await expect(
    service.resolveProviderBindingsForRun(model.capsule, []),
  ).rejects.toThrow(
    /stored ProviderBinding cannot target OpenTofu builtin runtime capability terraform\.io\/builtin\/terraform/,
  );
});

test("legacy full configuration aliases normalize into explicit child and root identity", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_alias_cf", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_alias",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        alias: "cloudflare.main",
        connectionId: "conn_alias_cf",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved[0]).toMatchObject({
    provider: CLOUDFLARE,
    moduleLocalName: "cloudflare",
    childAlias: "main",
    rootAlias: "main",
  });
  expect(resolved[0]).not.toHaveProperty("alias");
});

test("hyphenated provider identifiers resolve as exact child and root identity", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_hyphenated_cf",
      workspaceId: model.workspace.id,
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_hyphenated",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare-v02",
        childAlias: "aws-edge",
        rootAlias: "aws-edge",
        connectionId: "conn_hyphenated_cf",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved[0]).toMatchObject({
    provider: CLOUDFLARE,
    moduleLocalName: "cloudflare-v02",
    childAlias: "aws-edge",
    rootAlias: "aws-edge",
  });
  const runResolved = await service.resolveProviderBindingsForRun(
    model.capsule,
    [
      {
        source: CLOUDFLARE,
        moduleLocalName: "cloudflare-v02",
        childAlias: "aws-edge",
        allowed: true,
      },
    ],
  );
  expect(runResolved.map((entry) => entry.connection.id)).toEqual([
    "conn_hyphenated_cf",
  ]);
});

test("legacy dotted aliases normalize hyphenated provider identifiers", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_hyphenated_legacy",
      workspaceId: model.workspace.id,
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_hyphenated_legacy",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        alias: "cloudflare-v02.aws-edge",
        connectionId: "conn_hyphenated_legacy",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved[0]).toMatchObject({
    provider: CLOUDFLARE,
    moduleLocalName: "cloudflare-v02",
    childAlias: "aws-edge",
    rootAlias: "aws-edge",
  });
  expect(resolved[0]).not.toHaveProperty("alias");
});

test("raw operator-scoped ProviderConnection never resolves into a generic Capsule runner", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_operator_cf" }));
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_operator_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /operator-scoped/,
  );

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });
  await expect(
    cloudService.resolveProviderBindings(model.capsule),
  ).rejects.toThrow(/generic provider binding/);
});

test("a user-managed Resource Target cannot select an operator-scoped connection", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({
      id: "conn_operator_managed",
      status: "pending",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "operator.example.v1",
      },
    }),
  );
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });
  await expect(
    cloudService.resolveResourceProviderBinding({
      workspaceId: model.workspace.id,
      provider: CLOUDFLARE,
      connectionId: "conn_operator_managed",
      required: true,
    }),
  ).rejects.toThrow(/generic provider binding/);
});

test("operator mode resolves a verified workspace-bindable run-issued connection", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({
      id: "conn_operator_run_issued",
      status: "verified",
      materialization: "run-issued",
      credentialRecipe: {
        id: "operator-run-credential",
        authMode: "broker",
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "extension.example.v1",
          scopes: ["extension:invoke"],
        },
      },
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_run_issued",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      { provider: CLOUDFLARE, connectionId: "conn_operator_run_issued" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });
  const resolved = await cloudService.resolveProviderBindings(model.capsule);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.connection.id).toBe("conn_operator_run_issued");
  expect(mintableConnectionIds(resolved)).toEqual([
    "conn_operator_run_issued",
  ]);
});

test("Capsule binding resolution enforces InstallConfig connection scope and recipe policy", async () => {
  const { store, model } = await setup();
  const workspaceConnection = connection({
    id: "conn_workspace_wrong_recipe",
    workspaceId: model.workspace.id,
    credentialRecipe: { id: "cloudflare", authMode: "oauth" },
  });
  await store.putConnection(workspaceConnection);
  await store.putInstallConfig({
    ...model.installConfig,
    policy: {
      providerCredentials: {
        allowedConnectionScopes: ["workspace"],
        allowedCredentialRecipes: [
          { id: "cloudflare", authMode: "api_token" },
        ],
      },
    },
  });
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_policy_wrong_recipe",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: workspaceConnection.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const service = new ConnectionsService({ store });
  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /credential recipe cloudflare:oauth/,
  );

  const operatorConnection = connection({
    id: "conn_operator_api_token",
    credentialRecipe: { id: "cloudflare", authMode: "api_token" },
  });
  const operatorRunIssuedConnection = {
    ...operatorConnection,
    materialization: "run-issued" as const,
    credentialRecipe: {
      id: "cloudflare",
      authMode: "api_token",
      runIssuance: {
        context: "capsule-run.v1" as const,
        operatorConnection: "workspace-bindable" as const,
        storedMaterial: "none" as const,
        audience: "cloudflare.v1",
        scopes: ["cloudflare:deploy"],
      },
    },
  };
  const operatorStore = new InMemoryOpenTofuControlStore();
  const operatorModel = await seedCapsuleModel(operatorStore);
  await operatorStore.putInstallConfig({
    ...operatorModel.installConfig,
    policy: {
      providerCredentials: { allowedConnectionScopes: ["workspace"] },
    },
  });
  await operatorStore.putConnection(operatorRunIssuedConnection);
  await transitionProviderBindingSetForFixture(operatorStore, {
    id: "dp_policy_operator",
    workspaceId: operatorModel.workspace.id,
    capsuleId: operatorModel.capsule.id,
    environment: operatorModel.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: operatorConnection.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const operatorService = new ConnectionsService({
    store: operatorStore,
    allowOperatorScopedProviderConnections: true,
  });
  await expect(
    operatorService.resolveProviderBindings(operatorModel.capsule),
  ).rejects.toThrow(/scope operator/);
});

test("release-owned run settings replace a stale stored binding before the Run digest", async () => {
  const { store, model } = await setup();
  const fixed = connection({
    id: "conn_operator_run_policy",
    status: "verified",
    materialization: "run-issued",
    runCredentialSettings: { requiredAvailableMinor: 2300 },
    credentialRecipe: {
      id: "operator-run-credential",
      authMode: "broker",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["extension:invoke"],
      },
    },
  });
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_run_policy",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        connectionId: fixed.id,
        runCredentialSettings: { requiredAvailableMinor: 100 },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const service = new ConnectionsService({
    store,
    operatorProviderConnections: [fixed],
    allowOperatorScopedProviderConnections: true,
  });
  const resolved = await service.resolveProviderBindings(model.capsule);

  expect(resolved[0]?.runCredentialSettings).toEqual({
    requiredAvailableMinor: 2300,
  });
  expect(await resolvedProviderBindingsDigest(resolved)).not.toBe(
    await resolvedProviderBindingsDigest(
      resolved.map((entry) => ({
        ...entry,
        runCredentialSettings: { requiredAvailableMinor: 100 },
      })),
    ),
  );
});

test("run-issued binding settings are canonical, digest-bound, and reject credential material", async () => {
  const { store, model } = await setup();
  const runIssued = connection({
    id: "conn_operator_run_settings",
    status: "verified",
    materialization: "run-issued",
    credentialRecipe: {
      id: "operator-run-credential",
      authMode: "broker",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["extension:invoke"],
      },
    },
  });
  await store.putConnection(runIssued);
  const service = new ConnectionsService({
    store,
    allowOperatorScopedProviderConnections: true,
  });
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_run_settings",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        connectionId: runIssued.id,
        runCredentialSettings: {
          resourceName: "bucket-main",
          reservationId: "res_123",
        },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved[0]?.runCredentialSettings).toEqual({
    reservationId: "res_123",
    resourceName: "bucket-main",
  });
  const digest = await resolvedProviderBindingsDigest(resolved);
  expect(
    await resolvedProviderBindingsDigest(
      resolved.map((entry) => ({
        ...entry,
        runCredentialSettings: {
          reservationId: "res_456",
          resourceName: "bucket-main",
        },
      })),
    ),
  ).not.toBe(digest);

  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_run_settings",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        connectionId: runIssued.id,
        runCredentialSettings: { authToken: "must-not-persist" },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /credential-shaped|secret-like/,
  );
});

test("providerConfig base_url alone never authorizes an operator managed connection", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({
      id: "conn_operator_unprofiled",
      status: "verified",
      scopeHints: {
        managedProvider: true,
        providerConfig: { base_url: "https://provider.example.test/api" },
      },
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_unprofiled",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      { provider: CLOUDFLARE, connectionId: "conn_operator_unprofiled" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const cloudService = new ConnectionsService({
    store,
    allowOperatorScopedProviderConnections: true,
  });
  await expect(
    cloudService.resolveProviderBindings(model.capsule),
  ).rejects.toThrow(/generic provider binding/);
});

test("binding digest ignores verification progress but pins run-issuance authority", async () => {
  const { store, model } = await setup();
  const runIssued = connection({
    id: "conn_operator_run_issued",
    status: "verified",
    materialization: "run-issued",
    credentialRecipe: {
      id: "operator-run-credential",
      authMode: "broker",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["extension:invoke"],
      },
    },
    scopeHints: {
      providerConfig: {
        base_url: "https://operator.example.test/compat/example/v1",
      },
    },
  });
  await store.putConnection(runIssued);
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_digest",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: runIssued.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const cloudService = new ConnectionsService({
    store,
    allowOperatorScopedProviderConnections: true,
  });
  const verified = await cloudService.resolveProviderBindings(model.capsule);
  const verifiedDigest = await resolvedProviderBindingsDigest(verified);
  const pendingProjection = verified.map((entry) => ({
    ...entry,
    connection: { ...entry.connection, status: "pending" as const },
  }));
  expect(await resolvedProviderBindingsDigest(pendingProjection)).toBe(
    verifiedDigest,
  );

  const replacement = verified.map((entry) => ({
    ...entry,
    connection: { ...entry.connection, id: "conn_operator_replacement" },
  }));
  expect(await resolvedProviderBindingsDigest(replacement)).not.toBe(
    verifiedDigest,
  );

  const authorityChanged = verified.map((entry) => ({
    ...entry,
    connection: {
      ...entry.connection,
      credentialRecipe: {
        ...entry.connection.credentialRecipe!,
        runIssuance: undefined,
      },
    },
  }));
  expect(await resolvedProviderBindingsDigest(authorityChanged)).not.toBe(
    verifiedDigest,
  );

  const reorderedProviderConfig = verified.map((entry) => ({
    ...entry,
    connection: {
      ...entry.connection,
      scopeHints: {
        ...entry.connection.scopeHints,
        providerConfig: {
          base_url: "https://operator.example.test/compat/example/v1",
        },
      },
    },
  }));
  expect(await resolvedProviderBindingsDigest(reorderedProviderConfig)).toBe(
    verifiedDigest,
  );

  const providerConfigChanged = verified.map((entry) => ({
    ...entry,
    connection: {
      ...entry.connection,
      scopeHints: {
        ...entry.connection.scopeHints,
        providerConfig: {
          base_url: "https://operator.example.test/compat/client/v4",
        },
      },
    },
  }));
  expect(await resolvedProviderBindingsDigest(providerConfigChanged)).not.toBe(
    verifiedDigest,
  );
});

test("binding digest pins materialization and verified scope metadata", async () => {
  const base = [
    {
      provider: CLOUDFLARE,
      connection: connection({
        id: "conn_digest_scope_hints",
        materialization: "secret",
        scopeHints: {
          providerSettings: {
            accountId: "acct_digest",
            workersSubdomain: "team-workers",
          },
          moduleInputDefaults: {
            cloudflare_account_id: "acct_digest",
            cloudflare_workers_subdomain: "team-workers",
          },
        },
      }),
      materialization: "secret" as const,
    },
  ];
  const digest = await resolvedProviderBindingsDigest(base);

  expect(
    await resolvedProviderBindingsDigest(
      base.map((entry) => ({
        ...entry,
        connection: {
          ...entry.connection,
          materialization: "oauth" as const,
        },
      })),
    ),
  ).not.toBe(digest);
  expect(
    await resolvedProviderBindingsDigest(
      base.map((entry) => ({
        ...entry,
        connection: {
          ...entry.connection,
          scopeHints: {
            ...entry.connection.scopeHints,
            providerSettings: {
              accountId: "acct_changed",
              workersSubdomain: "team-workers",
            },
          },
        },
      })),
    ),
  ).not.toBe(digest);
  expect(
    await resolvedProviderBindingsDigest(
      base.map((entry) => ({
        ...entry,
        connection: {
          ...entry.connection,
          scopeHints: {
            ...entry.connection.scopeHints,
            moduleInputDefaults: {
              cloudflare_account_id: "acct_digest",
              cloudflare_workers_subdomain: "other-workers",
            },
          },
        },
      })),
    ),
  ).not.toBe(digest);
  expect(
    await resolvedProviderBindingsDigest(
      base.map((entry) => ({
        ...entry,
        connection: {
          ...entry.connection,
          credentialVerification: {
            kind: "takosumi.credential-verification@v1" as const,
            verifierId: "cloudflare/account-workers-subdomain@v1",
          },
        },
      })),
    ),
  ).not.toBe(digest);
});

test("provider connection listing ignores durable operator rows in favor of release-owned projections", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_space_cf", workspaceId: model.workspace.id }),
  );
  await store.putConnection(connection({ id: "conn_operator_secret" }));
  await store.putConnection(
    connection({
      id: "conn_operator_compat",
      materialization: "run-issued",
      credentialRecipe: {
        id: "operator-run-credential",
        authMode: "broker",
        runIssuance: {
          context: "capsule-run.v1",
          operatorConnection: "workspace-bindable",
          storedMaterial: "none",
          audience: "extension.example.v1",
          scopes: ["extension:invoke"],
        },
      },
    }),
  );
  await store.putConnection(
    connection({
      id: "conn_operator_base_url_only",
      scopeHints: {
        managedProvider: true,
        providerConfig: {
          base_url: "https://provider.example.test/api",
        },
      },
    }),
  );

  expect(
    (await service.listProviderConnections(model.workspace.id)).map(
      (row) => row.id,
    ),
  ).toEqual(["conn_space_cf"]);

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });
  expect(
    (await cloudService.listProviderConnections(model.workspace.id)).map(
      (row) => row.id,
    ),
  ).toEqual(["conn_space_cf"]);
});

test("release-owned operator connections are listed and resolved without durable operator rows", async () => {
  const { store, model } = await setup();
  const fixed = connection({
    id: "conn_release_owned",
    status: "verified",
    materialization: "run-issued",
    credentialRecipe: {
      id: "operator-run-credential",
      authMode: "broker",
      runIssuance: {
        context: "capsule-run.v1",
        operatorConnection: "workspace-bindable",
        storedMaterial: "none",
        audience: "extension.example.v1",
        scopes: ["extension:invoke"],
      },
    },
  });
  let durableOperatorListReads = 0;
  let durableWorkspaceListReads = 0;
  const originalList = store.listOperatorConnections.bind(store);
  const originalWorkspaceList = store.listConnections.bind(store);
  store.listOperatorConnections = async () => {
    durableOperatorListReads += 1;
    return await originalList();
  };
  store.listConnections = async (workspaceId) => {
    durableWorkspaceListReads += 1;
    return await originalWorkspaceList(workspaceId);
  };
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_release_owned",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: fixed.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const service = new ConnectionsService({
    store,
    operatorProviderConnections: [fixed],
    allowOperatorScopedProviderConnections: true,
  });
  expect(
    (await service.listReleaseOwnedProviderConnections(model.workspace.id)).map(
      (row) => row.id,
    ),
  ).toEqual([fixed.id]);
  expect(durableWorkspaceListReads).toBe(0);
  expect(
    (await service.listProviderConnections(model.workspace.id)).map(
      (row) => row.id,
    ),
  ).toEqual([fixed.id]);
  expect(durableWorkspaceListReads).toBe(1);
  expect((await service.getProviderConnection(fixed.id)).id).toBe(fixed.id);
  expect((await service.resolveProviderBindings(model.capsule))[0]?.connection)
    .toEqual(fixed);
  expect(await store.getConnection(fixed.id)).toBeUndefined();
  expect(durableOperatorListReads).toBe(0);
});

test("oauth ProviderConnection binding carries the oauth materialization", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_oauth_cf",
      workspaceId: model.workspace.id,
      materialization: "oauth",
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_oauth_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindings(model.capsule);
  expect(resolved[0]?.materialization).toBe("oauth");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_oauth_cf"]);
});

test("a ProviderConnection from another Workspace is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_other", workspaceId: "workspace_other" }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_other" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /belongs to another Workspace/,
  );
});

test("required providers must have explicit ProviderConnection bindings", async () => {
  const { model, service } = await setup();
  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [requiredBinding()]),
  ).rejects.toThrow(/provider connection is required/);
});

test("an explicit empty requirement list resolves zero bindings", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_cf_ignored", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_ignored",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        connectionId: "conn_cf_ignored",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  expect(
    await service.resolveProviderBindingsForRun(model.capsule, []),
  ).toEqual([]);
});

test("run binding resolution selects the exact child alias tuple", async () => {
  const { store, model, service } = await setup();
  for (const [id, childAlias] of [
    ["conn_cf_account", "account"],
    ["conn_cf_zone", "zone"],
  ] as const) {
    await store.putConnection(
      connection({ id, workspaceId: model.workspace.id }),
    );
  }
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_aliases",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "edge",
        childAlias: "account",
        rootAlias: "root_account",
        connectionId: "conn_cf_account",
      },
      {
        provider: CLOUDFLARE,
        moduleLocalName: "edge",
        childAlias: "zone",
        rootAlias: "root_zone",
        connectionId: "conn_cf_zone",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindingsForRun(model.capsule, [
    {
      source: CLOUDFLARE,
      moduleLocalName: "edge",
      childAlias: "zone",
      allowed: true,
    },
  ]);

  expect(resolved.map((entry) => entry.connection.id)).toEqual([
    "conn_cf_zone",
  ]);
});

test("run binding resolution keeps default, two aliases, and same-source local names distinct", async () => {
  const { store, model, service } = await setup();
  const identities = [
    { id: "conn_edge_default", moduleLocalName: "edge" },
    { id: "conn_edge_account", moduleLocalName: "edge", childAlias: "account" },
    { id: "conn_edge_zone", moduleLocalName: "edge", childAlias: "zone" },
    { id: "conn_gateway_default", moduleLocalName: "gateway" },
  ] as const;
  for (const identity of identities) {
    await store.putConnection(
      connection({ id: identity.id, workspaceId: model.workspace.id }),
    );
  }
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_exact_matrix",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: identities.map((identity) => ({
      provider: CLOUDFLARE,
      moduleLocalName: identity.moduleLocalName,
      ...("childAlias" in identity
        ? { childAlias: identity.childAlias }
        : {}),
      connectionId: identity.id,
    })),
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderBindingsForRun(
    model.capsule,
    identities.map((identity) =>
      requiredBinding({
        moduleLocalName: identity.moduleLocalName,
        ...("childAlias" in identity
          ? { childAlias: identity.childAlias }
          : {}),
      })
    ),
  );

  expect(resolved.map((entry) => entry.connection.id)).toEqual(
    identities.map((identity) => identity.id),
  );
});

test("one child alias binding cannot satisfy a missing sibling alias", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_cf_account", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_one_alias",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "edge",
        childAlias: "account",
        connectionId: "conn_cf_account",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [
      requiredBinding({ moduleLocalName: "edge", childAlias: "account" }),
      requiredBinding({ moduleLocalName: "edge", childAlias: "zone" }),
    ]),
  ).rejects.toThrow(/edge\.zone/);
});

test("a legacy source-only binding cannot satisfy an exact module-local name", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_cf_legacy_default", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_legacy_default",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        connectionId: "conn_cf_legacy_default",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [requiredBinding()]),
  ).rejects.toThrow(/provider connection is required/);

  const legacy = await service.resolveProviderBindingsForLegacyStoredRun(
    model.capsule,
    [requiredBinding()],
  );
  expect(legacy.map((entry) => entry.connection.id)).toEqual([
    "conn_cf_legacy_default",
  ]);
});

test("an ambiguous deprecated alias cannot satisfy an exact default tuple", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_cf_legacy", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_legacy_alias",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        alias: "legacy",
        connectionId: "conn_cf_legacy",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [requiredBinding()]),
  ).rejects.toThrow(/ambiguous.*alias/i);
});

test("run binding resolution rejects duplicate exact tuples", async () => {
  const { store, model, service } = await setup();
  for (const id of ["conn_cf_zone_a", "conn_cf_zone_b"]) {
    await store.putConnection(connection({ id, workspaceId: model.workspace.id }));
  }
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_duplicate_alias",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: ["conn_cf_zone_a", "conn_cf_zone_b"].map((connectionId) => ({
      provider: CLOUDFLARE,
      moduleLocalName: "edge",
      childAlias: "zone",
      connectionId,
    })),
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [
      {
        source: CLOUDFLARE,
        moduleLocalName: "edge",
        childAlias: "zone",
        allowed: true,
      },
    ]),
  ).rejects.toThrow(/duplicate provider binding identity/);
});

test("run binding resolution rejects duplicate required tuples", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_cf_default", workspaceId: model.workspace.id }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_cf_default",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      {
        provider: CLOUDFLARE,
        moduleLocalName: "cloudflare",
        connectionId: "conn_cf_default",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const requirement = {
    source: CLOUDFLARE,
    moduleLocalName: "cloudflare",
    allowed: true,
  } as const;

  await expect(
    service.resolveProviderBindingsForRun(model.capsule, [
      requirement,
      requirement,
    ]),
  ).rejects.toThrow(/duplicate required provider identity/);
});

test("run binding resolution rejects malformed exact requirement rows", async () => {
  const { model, service } = await setup();
  for (const [requirement, message] of [
    [
      { ...requiredBinding(), source: "cloudflare/cloudflare" },
      /source must be canonical/,
    ],
    [
      { ...requiredBinding(), aliases: ["zone"] },
      /aliases is not allowed/,
    ],
    [
      { ...requiredBinding(), version: "~> 5.0" },
      /version must be an exact version literal/,
    ],
  ] as const) {
    await expect(
      service.resolveProviderBindingsForRun(model.capsule, [
        requirement as never,
      ]),
    ).rejects.toThrow(message);
  }
});

test("Cloud mode does not implicitly bind a single public managed operator connection", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const model = await seedCapsuleModel(store, {
    installConfig: {
      store: {
        source: {
          git: "https://github.com/tako0614/yurucommu.git",
          ref: "main",
          path: ".",
        },
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "test", en: "test" },
      },
    },
  });
  await store.putConnection(
    connection({
      id: "conn_operator_compat",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.example.v1",
        providerConfig: {
          base_url: "https://operator.example.test/compat/example/v1",
        },
      },
    }),
  );
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });

  await expect(
    cloudService.resolveProviderBindingsForRun(model.capsule, [
      requiredBinding(),
    ]),
  ).rejects.toThrow(/provider connection is required/);
});

test("Cloud mode does not implicitly bind a pending public managed operator connection", async () => {
  const store = new InMemoryOpenTofuControlStore();
  const model = await seedCapsuleModel(store, {
    installConfig: {
      store: {
        source: {
          git: "https://github.com/tako0614/yurucommu.git",
          ref: "main",
          path: ".",
        },
        surface: "service",
        kind: "worker",
        provider: "cloudflare",
        suggestedName: "yurucommu",
        name: { ja: "yurucommu", en: "yurucommu" },
        description: { ja: "test", en: "test" },
      },
    },
  });
  await store.putConnection(
    connection({
      id: "conn_operator_managed_pending",
      status: "pending",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.example.v1",
        providerConfig: {
          base_url: "https://operator.example.test/compat/example/v1",
        },
      },
    }),
  );
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });

  await expect(
    cloudService.resolveProviderBindingsForRun(model.capsule, [
      requiredBinding(),
    ]),
  ).rejects.toThrow(/provider connection is required/);
});

test("Cloud mode does not guess when multiple managed operator connections match", async () => {
  const { store, model } = await setup();
  for (const id of ["conn_operator_managed_a", "conn_operator_managed_b"]) {
    await store.putConnection(
      connection({
        id,
        scopeHints: {
          managedProvider: true,
          managedProviderProfile: "compat.example.v1",
          providerConfig: {
            base_url: "https://operator.example.test/compat/example/v1",
          },
        },
      }),
    );
  }
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });

  await expect(
    cloudService.resolveProviderBindingsForRun(model.capsule, [
      requiredBinding(),
    ]),
  ).rejects.toThrow(/provider connection is required/);
});

test("a non-verified ProviderConnection fails closed before runner dispatch", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_pending",
      workspaceId: model.workspace.id,
      status: "pending",
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_pending" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /status pending is not verified/,
  );
});

test("Cloud mode still rejects pending non-managed operator connections", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({ id: "conn_operator_pending_secret", status: "pending" }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_operator_pending_secret",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      { provider: CLOUDFLARE, connectionId: "conn_operator_pending_secret" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorScopedProviderConnections: true,
  });
  await expect(
    cloudService.resolveProviderBindings(model.capsule),
  ).rejects.toThrow(/generic provider binding/);
});

test("ProviderConnection provider family must match the binding provider", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_aws",
      workspaceId: model.workspace.id,
      provider: "aws",
      providerSource: "registry.opentofu.org/hashicorp/aws",
    }),
  );
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_aws" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /does not match binding provider/,
  );
});

test("a git source ProviderConnection cannot back a provider binding", async () => {
  const { store, model, service } = await setup();
  await store.putConnection({
    id: "conn_git",
    workspaceId: model.workspace.id,
    provider: "source_git_https_token",
    providerSource: "source_git_https_token",
    kind: "source_git_https_token",
    scope: "workspace",
    status: "verified",
    materialization: "secret",
    envNames: ["GIT_HTTPS_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await transitionProviderBindingSetForFixture(store, {
    id: "dp_1",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_git" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(service.resolveProviderBindings(model.capsule)).rejects.toThrow(
    /git source connection/,
  );
});
