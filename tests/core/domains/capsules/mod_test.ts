import { expect, test } from "bun:test";

import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  OpenTofuControlStore,
  StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import {
  CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  type InstallConfig,
} from "takosumi-contract/install-configs";
import type { Workspace } from "takosumi-contract/workspaces";

const NOW = "2026-06-06T00:00:00.000Z";

function build() {
  const store = new InMemoryOpenTofuControlStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const service = new CapsulesService({
    store,
    newId,
    now: () => new Date(NOW),
  });
  return { store, service };
}

async function seedWorkspace(
  store: OpenTofuControlStore,
  over: Partial<Workspace> = {},
): Promise<Workspace> {
  const workspace: Workspace = {
    id: "ws_1",
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  await store.putWorkspace(workspace);
  return workspace;
}

async function seedSource(
  store: OpenTofuControlStore,
  over: Partial<StoredSource> = {},
): Promise<StoredSource> {
  const source: StoredSource = {
    id: "src_1",
    workspaceId: "ws_1",
    name: "repo",
    url: "https://example.com/acme/repo.git",
    defaultRef: "release",
    defaultPath: "infra",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    hookSecretHash: "hash",
    autoSync: false,
    ...over,
  };
  await store.putSource(source);
  return source;
}

async function seedConfig(
  store: OpenTofuControlStore,
  over: Partial<InstallConfig> = {},
): Promise<InstallConfig> {
  const config: InstallConfig = {
    id: "cfg_1",
    name: "config",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
  await store.putInstallConfig(config);
  return config;
}

async function seedAll(store: OpenTofuControlStore): Promise<void> {
  await seedWorkspace(store);
  await seedSource(store);
  await seedConfig(store);
}

async function createCapsule(
  service: CapsulesService,
  over: Partial<Parameters<CapsulesService["createCapsule"]>[0]> = {},
) {
  return await service.createCapsule({
    workspaceId: "ws_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
    ...over,
  });
}

test("createCapsule persists the canonical Workspace, Project, and Capsule fields", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);

  expect(capsule.id).toBe("cap_test00000001");
  expect(capsule.workspaceId).toBe("ws_1");
  expect(capsule.projectId).toStartWith("prj_");
  expect(capsule.slug).toBe("shop");
  expect(capsule.currentStateGeneration).toBe(0);
  expect(capsule.status).toBe("pending");
  expect(capsule.createdAt).toBe(NOW);
  expect((await store.getCapsule(capsule.id))?.name).toBe("shop");
});

test("createCapsule rejects an invalid name", async () => {
  const { store, service } = build();
  await seedAll(store);
  await expect(createCapsule(service, { name: "Shop Name" })).rejects.toMatchObject(
    { code: "invalid_argument" },
  );
});

test("createCapsule rejects an unknown Workspace", async () => {
  const { store, service } = build();
  await seedSource(store);
  await seedConfig(store);
  await expect(
    createCapsule(service, { workspaceId: "ws_missing" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule rejects a Source owned by another Workspace", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store, { id: "src_other", workspaceId: "ws_other" });
  await seedConfig(store);
  await expect(
    createCapsule(service, { sourceId: "src_other" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule rejects an unknown InstallConfig", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  await expect(
    createCapsule(service, { installConfigId: "cfg_missing" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createCapsule enforces Workspace ownership for InstallConfig", async () => {
  const { store, service } = build();
  await seedWorkspace(store);
  await seedSource(store);
  await seedConfig(store, { id: "cfg_other", workspaceId: "ws_other" });
  await expect(
    createCapsule(service, { installConfigId: "cfg_other" }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  await seedConfig(store, { id: "cfg_workspace", workspaceId: "ws_1" });
  const capsule = await createCapsule(service, {
    installConfigId: "cfg_workspace",
  });
  expect(capsule.installConfigId).toBe("cfg_workspace");
});

test("createCapsule enforces unique Project, name, and environment", async () => {
  const { store, service } = build();
  await seedAll(store);
  await createCapsule(service);
  await expect(createCapsule(service)).rejects.toMatchObject({
    code: "failed_precondition",
  });
});

test("a destroyed Capsule does not reserve its former name", async () => {
  const { store, service } = build();
  await seedAll(store);
  const destroyed = await createCapsule(service);
  await store.putCapsule({ ...destroyed, status: "destroyed" });

  const replacement = await createCapsule(service);
  expect(replacement.id).not.toBe(destroyed.id);
  expect(replacement.status).toBe("pending");
});

test("abandonUnappliedCapsule closes the ledger row and releases owned bindings and hostnames", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);
  await store.reservePublicHost({
    hostname: "shop.app.example",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    capsuleName: capsule.name,
    allocationKind: "scoped",
    now: NOW,
  });
  await store.putProviderBindingSet({
    id: "pbind_1",
    workspaceId: capsule.workspaceId,
    capsuleId: capsule.id,
    environment: capsule.environment,
    bindings: [
      {
        provider: "registry.opentofu.org/examplecorp/example",
        alias: "main",
        connectionId: "conn_example",
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  });

  const abandoned = await service.abandonUnappliedCapsule(
    capsule.id,
    "test abandon",
  );

  expect(abandoned.status).toBe("destroyed");
  expect((await store.getCapsule(capsule.id))?.status).toBe("destroyed");
  expect(
    (await store.getPublicHostReservation("shop.app.example"))?.status,
  ).toBe("released");
  expect(
    await service.getProviderBindingSetByCapsule(
      capsule.id,
      capsule.environment,
    ),
  ).toBeUndefined();
  expect((await createCapsule(service)).id).not.toBe(capsule.id);
});

test("abandonUnappliedCapsule refuses a Capsule with applied state", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);
  await store.patchCapsule(capsule.id, {
    currentStateGeneration: 1,
    updatedAt: "2026-06-06T00:01:00.000Z",
  });

  await expect(
    service.abandonUnappliedCapsule(capsule.id, "test abandon"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("the same Capsule name can be used in another environment", async () => {
  const { store, service } = build();
  await seedAll(store);
  await createCapsule(service);
  const preview = await createCapsule(service, { environment: "preview" });
  expect(preview.environment).toBe("preview");
});

test("getCapsule, listCapsules, and patchCapsuleStatus use canonical ids", async () => {
  const { store, service } = build();
  await seedAll(store);
  await seedWorkspace(store, { id: "ws_2", handle: "other" });
  const capsule = await createCapsule(service);

  expect((await service.getCapsule(capsule.id)).id).toBe(capsule.id);
  expect((await service.listCapsules("ws_1")).map((row) => row.id)).toEqual([
    capsule.id,
  ]);
  expect(await service.listCapsules("ws_2")).toEqual([]);
  expect((await service.patchCapsuleStatus(capsule.id, "active")).status).toBe(
    "active",
  );
  await expect(service.getCapsule("cap_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putInstallConfig requires an existing owning Workspace", async () => {
  const { service } = build();
  await expect(
    service.putInstallConfig({
      id: "cfg_x",
      workspaceId: "ws_missing",
      name: "x",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: NOW,
      updatedAt: NOW,
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("putInstallConfig accepts explicit lifecycle actions and rejects missing policy", async () => {
  const { service } = build();
  const action = {
    apiVersion: "takosumi.dev/v1alpha1" as const,
    kind: "command" as const,
    id: "publish",
    phase: "post_apply" as const,
    executor: "runner" as const,
    command: ["bun", "run", "publish"],
    runnerCapability: CAPSULE_LIFECYCLE_COMMAND_CAPABILITY,
  };
  const base = {
    id: "cfg_actions",
    name: "actions",
    variableMapping: {},
    outputAllowlist: {},
    lifecycleActions: [action],
    createdAt: NOW,
    updatedAt: NOW,
  };

  await expect(
    service.putInstallConfig({ ...base, policy: {} }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("policy.lifecycleActions"),
  });

  const config = await service.putInstallConfig({
    ...base,
    policy: {
      lifecycleActions: {
        allowedExecutors: ["runner"],
        allowedRunnerCapabilities: [CAPSULE_LIFECYCLE_COMMAND_CAPABILITY],
      },
    },
  });
  expect(config.lifecycleActions?.[0]?.id).toBe("publish");
});

test("InstallConfig reads list only selectable service-side configuration", async () => {
  const { store, service } = build();
  await seedConfig(store);
  await seedConfig(store, {
    id: "icfg_0123456789abcdef",
    workspaceId: "ws_1",
    internal: { reason: "per_install_overrides" },
  });

  expect((await service.getInstallConfig("cfg_1")).name).toBe("config");
  expect((await service.listInstallConfigs()).map((row) => row.id)).toEqual([
    "cfg_1",
  ]);
  await expect(service.getInstallConfig("cfg_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("putProviderBindingSet validates the Capsule Workspace", async () => {
  const { store, service } = build();
  await seedAll(store);
  const capsule = await createCapsule(service);
  const bindingSet = await service.putProviderBindingSet({
    id: "pbind_1",
    workspaceId: "ws_1",
    capsuleId: capsule.id,
    environment: "production",
    bindings: [],
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(bindingSet.id).toBe("pbind_1");
  expect(
    await service.getProviderBindingSetByCapsule(capsule.id, "production"),
  ).toEqual(bindingSet);

  await expect(
    service.putProviderBindingSet({
      ...bindingSet,
      id: "pbind_bad",
      workspaceId: "ws_other",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
