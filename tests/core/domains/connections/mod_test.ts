/** Provider Connection binding resolution. */
import { expect, test } from "bun:test";

import type { Connection } from "@takosumi/internal/deploy-control-api";
import type { ProviderConnectionMaterialization } from "takosumi-contract/connections";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedInstallationModel } from "../../../helpers/deploy-control/model_fixture.ts";
import {
  ConnectionsService,
  mintableConnectionIds,
  resolvedProviderEnvBindingsDigest,
} from "../../../../core/domains/connections/mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";

function connection(input: {
  readonly id: string;
  readonly spaceId?: string;
  readonly provider?: string;
  readonly providerSource?: string;
  readonly status?: Connection["status"];
  readonly materialization?: ProviderConnectionMaterialization;
  readonly scopeHints?: Connection["scopeHints"];
}): Connection {
  return {
    id: input.id,
    ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    provider: input.provider ?? "cloudflare",
    providerSource: input.providerSource ?? CLOUDFLARE,
    kind: "cloudflare_api_token",
    scope: input.spaceId ? "space" : "operator",
    status: input.status ?? "verified",
    materialization: input.materialization ?? "secret",
    envNames: ["CLOUDFLARE_API_TOKEN"],
    ...(input.scopeHints ? { scopeHints: input.scopeHints } : {}),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function setup() {
  const store = new InMemoryOpenTofuDeploymentStore();
  const model = await seedInstallationModel(store);
  const service = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_1`,
    now: () => NOW,
  });
  return { store, model, service };
}

test("secret Provider Connection binding resolves to its credential row", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_space_cf", spaceId: model.space.id }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
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

  const resolved = await service.resolveProviderEnvBindings(model.installation);
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.materialization).toBe("secret");
  expect(resolved[0]?.connection.id).toBe("conn_space_cf");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_space_cf"]);
});

test("operator-scoped Provider Connection is Cloud-only and resolves only when enabled", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_operator_cf" }));
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_operator",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_operator_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/operator-scoped/);

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });
  const resolved = await cloudService.resolveProviderEnvBindings(
    model.installation,
  );
  expect(resolved[0]?.connection.id).toBe("conn_operator_cf");
  expect(resolved[0]?.connection.scope).toBe("operator");
});

test("Cloud mode resolves a pending public managed operator connection", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({
      id: "conn_operator_compat_pending",
      status: "pending",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: { base_url: "https://app.takosumi.com/compat/cloudflare/client/v4" },
        accountId: "ts_acc_takosumi_cloud",
      },
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_operator_pending",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [
      { provider: CLOUDFLARE, connectionId: "conn_operator_compat_pending" },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });
  const resolved = await cloudService.resolveProviderEnvBindings(
    model.installation,
  );
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.connection.id).toBe("conn_operator_compat_pending");
  expect(mintableConnectionIds(resolved)).toEqual([
    "conn_operator_compat_pending",
  ]);
});

test("binding digest ignores verification progress but detects connection replacement", async () => {
  const { store, model } = await setup();
  const managed = connection({
    id: "conn_operator_compat",
    status: "pending",
    scopeHints: {
      managedProvider: true,
      managedProviderProfile: "compat.cloudflare.workers.v1",
      providerConfig: { base_url: "https://app.takosumi.com/compat/cloudflare/client/v4" },
      accountId: "ts_acc_takosumi_cloud",
    },
  });
  await store.putConnection(managed);
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_operator_digest",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: managed.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const cloudService = new ConnectionsService({
    store,
    allowOperatorBackedProviderEnvs: true,
  });
  const pending = await cloudService.resolveProviderEnvBindings(
    model.installation,
  );
  const pendingDigest = await resolvedProviderEnvBindingsDigest(pending);

  await store.putConnection({
    ...managed,
    status: "verified",
    verifiedAt: NOW,
  });
  const verified = await cloudService.resolveProviderEnvBindings(
    model.installation,
  );
  expect(await resolvedProviderEnvBindingsDigest(verified)).toBe(pendingDigest);

  const replacement = verified.map((entry) => ({
    ...entry,
    connection: { ...entry.connection, id: "conn_operator_replacement" },
  }));
  expect(await resolvedProviderEnvBindingsDigest(replacement)).not.toBe(
    pendingDigest,
  );
});

test("provider connection listing exposes only public managed operator connections in Cloud mode", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_space_cf", spaceId: model.space.id }),
  );
  await store.putConnection(connection({ id: "conn_operator_secret" }));
  await store.putConnection(
    connection({
      id: "conn_operator_compat",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: { base_url: "https://app.takosumi.com/compat/cloudflare/client/v4" },
        accountId: "ts_acc_takosumi_cloud",
      },
    }),
  );

  expect(
    (await service.listProviderConnections(model.space.id)).map(
      (row) => row.id,
    ),
  ).toEqual(["conn_space_cf"]);

  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });
  expect(
    (await cloudService.listProviderConnections(model.space.id)).map(
      (row) => row.id,
    ),
  ).toEqual(["conn_space_cf", "conn_operator_compat"]);
});

test("oauth Provider Connection binding carries the oauth materialization", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_oauth_cf",
      spaceId: model.space.id,
      materialization: "oauth",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_oauth_cf" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderEnvBindings(model.installation);
  expect(resolved[0]?.materialization).toBe("oauth");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_oauth_cf"]);
});

test("a binding accepts the legacy envId field name", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_legacy_cf", spaceId: model.space.id }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_legacy",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    // Pre-collapse binding sets serialized `envId` (== the connection id).
    bindings: [{ provider: CLOUDFLARE, envId: "conn_legacy_cf" }] as never,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const resolved = await service.resolveProviderEnvBindings(model.installation);
  expect(resolved[0]?.connection.id).toBe("conn_legacy_cf");
});

test("a Provider Connection from another Space is rejected", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_other", spaceId: "space_other" }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_other" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/belongs to another Space/);
});

test("required providers must have explicit Provider Connection bindings", async () => {
  const { model, service } = await setup();
  await expect(
    service.resolveProviderEnvBindingsForRun(model.installation, [CLOUDFLARE]),
  ).rejects.toThrow(/provider connection is required/);
});

test("Cloud mode can satisfy required providers from a single public managed operator connection", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const model = await seedInstallationModel(store, {
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
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: { base_url: "https://app.takosumi.com/compat/cloudflare/client/v4" },
        accountId: "ts_acc_takosumi_cloud",
      },
    }),
  );
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });

  const resolved = await cloudService.resolveProviderEnvBindingsForRun(
    model.installation,
    [CLOUDFLARE],
  );

  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.provider).toBe(CLOUDFLARE);
  expect(resolved[0]?.connection.id).toBe("conn_operator_compat");
});

test("Cloud mode can satisfy required providers from a pending public managed operator connection", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  const model = await seedInstallationModel(store, {
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
      id: "conn_operator_compat_pending",
      status: "pending",
      scopeHints: {
        managedProvider: true,
        managedProviderProfile: "compat.cloudflare.workers.v1",
        providerConfig: { base_url: "https://app.takosumi.com/compat/cloudflare/client/v4" },
        accountId: "ts_acc_takosumi_cloud",
      },
    }),
  );
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });

  const resolved = await cloudService.resolveProviderEnvBindingsForRun(
    model.installation,
    [CLOUDFLARE],
  );

  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.connection.id).toBe("conn_operator_compat_pending");
});

test("Cloud mode does not guess when multiple managed operator connections match", async () => {
  const { store, model } = await setup();
  for (const id of ["conn_operator_compat_a", "conn_operator_compat_b"]) {
    await store.putConnection(
      connection({
        id,
        scopeHints: {
          managedProvider: true,
          managedProviderProfile: "compat.cloudflare.workers.v1",
          providerConfig: {
            base_url: "https://app.takosumi.com/compat/cloudflare/client/v4",
            },
          accountId: `ts_acc_${id}`,
        },
      }),
    );
  }
  const cloudService = new ConnectionsService({
    store,
    newId: (prefix) => `${prefix}_cloud`,
    now: () => NOW,
    allowOperatorBackedProviderEnvs: true,
  });

  await expect(
    cloudService.resolveProviderEnvBindingsForRun(model.installation, [
      CLOUDFLARE,
    ]),
  ).rejects.toThrow(/provider connection is required/);
});

test("a non-verified Provider Connection fails closed before runner dispatch", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_pending",
      spaceId: model.space.id,
      status: "pending",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_pending" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/status pending is not verified/);
});

test("Cloud mode still rejects pending non-managed operator connections", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({ id: "conn_operator_pending_secret", status: "pending" }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_operator_pending_secret",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
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
    allowOperatorBackedProviderEnvs: true,
  });
  await expect(
    cloudService.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/status pending is not verified/);
});

test("Provider Connection provider family must match the binding provider", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({
      id: "conn_aws",
      spaceId: model.space.id,
      provider: "aws",
      providerSource: "registry.opentofu.org/hashicorp/aws",
    }),
  );
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_aws" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/does not match binding provider/);
});

test("a git source Provider Connection cannot back a provider binding", async () => {
  const { store, model, service } = await setup();
  await store.putConnection({
    id: "conn_git",
    spaceId: model.space.id,
    provider: "source_git_https_token",
    providerSource: "source_git_https_token",
    kind: "source_git_https_token",
    scope: "space",
    status: "verified",
    materialization: "secret",
    envNames: ["GIT_HTTPS_TOKEN"],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "dp_1",
    spaceId: model.space.id,
    installationId: model.installation.id,
    environment: model.installation.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: "conn_git" }],
    createdAt: NOW,
    updatedAt: NOW,
  });

  await expect(
    service.resolveProviderEnvBindings(model.installation),
  ).rejects.toThrow(/git source connection/);
});
