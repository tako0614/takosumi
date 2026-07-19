/** ProviderConnection binding resolution. */
import { expect, test } from "bun:test";

import type { ProviderConnection } from "@takosumi/internal/deploy-control-api";
import type { ProviderConnectionMaterialization } from "takosumi-contract/connections";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { seedCapsuleModel } from "../../../helpers/deploy-control/model_fixture.ts";
import {
  ConnectionsService,
  mintableConnectionIds,
  resolvedProviderBindingsDigest,
} from "../../../../core/domains/connections/mod.ts";

const NOW = "2026-06-06T00:00:00.000Z";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";

function connection(input: {
  readonly id: string;
  readonly workspaceId?: string;
  readonly provider?: string;
  readonly providerSource?: string;
  readonly status?: ProviderConnection["status"];
  readonly materialization?: ProviderConnectionMaterialization;
  readonly scopeHints?: ProviderConnection["scopeHints"];
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
  await store.putProviderBindingSet({
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

test("operator-scoped ProviderConnection is Cloud-only and resolves only when enabled", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(connection({ id: "conn_operator_cf" }));
  await store.putProviderBindingSet({
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
  const resolved = await cloudService.resolveProviderBindings(model.capsule);
  expect(resolved[0]?.connection.id).toBe("conn_operator_cf");
  expect(resolved[0]?.connection.scope).toBe("operator");
});

test("Cloud mode resolves a pending public managed operator connection", async () => {
  const { store, model } = await setup();
  await store.putConnection(
    connection({
      id: "conn_operator_pending",
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
  await store.putProviderBindingSet({
    id: "dp_operator_pending",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [
      { provider: CLOUDFLARE, connectionId: "conn_operator_pending" },
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
  expect(resolved[0]?.connection.id).toBe("conn_operator_pending");
  expect(mintableConnectionIds(resolved)).toEqual(["conn_operator_pending"]);
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
  await store.putProviderBindingSet({
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
  ).rejects.toThrow(/requires an explicit managedProviderProfile/);
});

test("binding digest ignores verification progress but detects connection replacement", async () => {
  const { store, model } = await setup();
  const managed = connection({
    id: "conn_operator_compat",
    status: "pending",
    scopeHints: {
      managedProvider: true,
      managedProviderProfile: "compat.example.v1",
      providerConfig: {
        base_url: "https://operator.example.test/compat/example/v1",
      },
    },
  });
  await store.putConnection(managed);
  await store.putProviderBindingSet({
    id: "dp_operator_digest",
    workspaceId: model.workspace.id,
    capsuleId: model.capsule.id,
    environment: model.capsule.environment,
    bindings: [{ provider: CLOUDFLARE, connectionId: managed.id }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  const cloudService = new ConnectionsService({
    store,
    allowOperatorScopedProviderConnections: true,
  });
  const pending = await cloudService.resolveProviderBindings(model.capsule);
  const pendingDigest = await resolvedProviderBindingsDigest(pending);

  await store.putConnection({
    ...managed,
    status: "verified",
    verifiedAt: NOW,
  });
  const verified = await cloudService.resolveProviderBindings(model.capsule);
  expect(await resolvedProviderBindingsDigest(verified)).toBe(pendingDigest);

  const replacement = verified.map((entry) => ({
    ...entry,
    connection: { ...entry.connection, id: "conn_operator_replacement" },
  }));
  expect(await resolvedProviderBindingsDigest(replacement)).not.toBe(
    pendingDigest,
  );

  const authorityChanged = verified.map((entry) => ({
    ...entry,
    connection: {
      ...entry.connection,
      scopeHints: {
        ...entry.connection.scopeHints,
        managedProviderProfile: "compat.example.v2",
      },
    },
  }));
  expect(await resolvedProviderBindingsDigest(authorityChanged)).not.toBe(
    pendingDigest,
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
    pendingDigest,
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
    pendingDigest,
  );
});

test("provider connection listing exposes only public managed operator connections in Cloud mode", async () => {
  const { store, model, service } = await setup();
  await store.putConnection(
    connection({ id: "conn_space_cf", workspaceId: model.workspace.id }),
  );
  await store.putConnection(connection({ id: "conn_operator_secret" }));
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
  ).toEqual(["conn_space_cf", "conn_operator_compat"]);
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
  await store.putProviderBindingSet({
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
  await store.putProviderBindingSet({
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
    service.resolveProviderBindingsForRun(model.capsule, [CLOUDFLARE]),
  ).rejects.toThrow(/provider connection is required/);
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
    cloudService.resolveProviderBindingsForRun(model.capsule, [CLOUDFLARE]),
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
    cloudService.resolveProviderBindingsForRun(model.capsule, [CLOUDFLARE]),
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
    cloudService.resolveProviderBindingsForRun(model.capsule, [CLOUDFLARE]),
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
  await store.putProviderBindingSet({
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
  await store.putProviderBindingSet({
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
  ).rejects.toThrow(/status pending is not verified/);
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
  await store.putProviderBindingSet({
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
  await store.putProviderBindingSet({
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
