import { expect, test } from "bun:test";

import { CapsulesService } from "../../../../core/domains/capsules/mod.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/install_config_bootstrap.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";
import type {
  OpenTofuDeploymentStore,
  StoredSource,
} from "../../../../core/domains/deploy-control/store.ts";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { Workspace as Space } from "takosumi-contract/workspaces";

function build() {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const service = new CapsulesService({
    store,
    newId,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  return { store, service };
}

async function seedSpace(
  store: OpenTofuDeploymentStore,
  over: Partial<Space> = {},
): Promise<Space> {
  const space: Space = {
    id: "space_1",
    handle: "shota",
    displayName: "Shota",
    type: "personal",
    ownerUserId: "user_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
  await store.putSpace(space);
  return space;
}

async function seedSource(
  store: OpenTofuDeploymentStore,
  over: Partial<StoredSource> = {},
): Promise<StoredSource> {
  const source: StoredSource = {
    id: "src_1",
    spaceId: "space_1",
    name: "repo",
    url: "https://github.com/acme/repo.git",
    defaultRef: "release",
    defaultPath: "infra",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    hookSecretHash: "hash",
    autoSync: false,
    ...over,
  };
  await store.putSource(source);
  return source;
}

async function seedConfig(
  store: OpenTofuDeploymentStore,
  over: Partial<InstallConfig> = {},
): Promise<InstallConfig> {
  const config: InstallConfig = {
    id: "cfg_1",
    name: "config",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
    ...over,
  };
  await store.putInstallConfig(config);
  return config;
}

async function seedAll(store: OpenTofuDeploymentStore): Promise<void> {
  await seedSpace(store);
  await seedSource(store);
  await seedConfig(store);
}

test("createInstallation persists with derived slug, generation 0, status pending", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  expect(installation.id).toBe("inst_test00000001");
  expect(installation.slug).toBe("shop");
  expect(installation.installType).toBe("opentofu_module");
  expect(installation.currentStateGeneration).toBe(0);
  expect(installation.status).toBe("pending");
  expect(installation.createdAt).toBe("2026-06-06T00:00:00.000Z");
  expect((await store.getInstallation(installation.id))?.name).toBe("shop");
});

test("createInstallation rejects a non-slug name", async () => {
  const { store, service } = build();
  await seedAll(store);
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "Shop Name",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createInstallation rejects a missing space", async () => {
  const { store, service } = build();
  await seedSource(store);
  await seedConfig(store);
  await expect(
    service.createInstallation({
      spaceId: "space_missing",
      name: "shop",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createInstallation rejects a source from a different space", async () => {
  const { store, service } = build();
  await seedSpace(store);
  await seedSource(store, { id: "src_other", spaceId: "space_other" });
  await seedConfig(store);
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "shop",
      environment: "production",
      sourceId: "src_other",
      installConfigId: "cfg_1",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createInstallation rejects a missing install config", async () => {
  const { store, service } = build();
  await seedSpace(store);
  await seedSource(store);
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "shop",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_missing",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createInstallation rejects a space-scoped config owned by another space", async () => {
  const { store, service } = build();
  await seedSpace(store);
  await seedSource(store);
  await seedConfig(store, { id: "cfg_other", spaceId: "space_other" });
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "shop",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_other",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createInstallation accepts a space-scoped config owned by the same space", async () => {
  const { store, service } = build();
  await seedSpace(store);
  await seedSource(store);
  await seedConfig(store, { id: "cfg_space", spaceId: "space_1" });
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_space",
  });
  expect(installation.installConfigId).toBe("cfg_space");
});

test("createInstallation enforces unique(space_id, name, environment)", async () => {
  const { store, service } = build();
  await seedAll(store);
  await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "shop",
      environment: "production",
      sourceId: "src_1",
      installConfigId: "cfg_1",
    }),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createInstallation ignores destroyed Capsules when reusing a service name", async () => {
  const { store, service } = build();
  await seedAll(store);
  const destroyed = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  await store.putInstallation({ ...destroyed, status: "destroyed" });

  const next = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });

  expect(next.id).not.toBe(destroyed.id);
  expect(next.status).toBe("pending");
});

test("abandonUnappliedCapsule closes the ledger row, releases public hosts, and allows reinstall", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  await store.reservePublicHost({
    hostname: "shop.app.takos.jp",
    workspaceId: installation.workspaceId,
    installationId: installation.id,
    installationName: installation.name,
    now: "2026-06-06T00:00:00.000Z",
  });
  await store.putInstallationProviderEnvBindingSet({
    id: "dpf_1",
    workspaceId: installation.workspaceId,
    spaceId: installation.workspaceId,
    capsuleId: installation.id,
    installationId: installation.id,
    environment: installation.environment,
    bindings: [
      {
        provider: "cloudflare",
        alias: "main",
        connectionId: "conn_f42e2b50fe904311ad00",
      },
    ],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  const abandoned = await service.abandonUnappliedCapsule(
    installation.id,
    "test abandon",
  );

  expect(abandoned.status).toBe("destroyed");
  expect((await store.getInstallation(installation.id))?.status).toBe(
    "destroyed",
  );
  expect(
    (await store.getPublicHostReservation("shop.app.takos.jp"))?.status,
  ).toBe("released");
  expect(
    await store.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      installation.environment,
    ),
  ).toBeUndefined();
  expect(
    await service.getCapsuleProviderEnvBindingSetByCapsule(
      installation.id,
      installation.environment,
    ),
  ).toBeUndefined();
  const replacement = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  expect(replacement.id).not.toBe(installation.id);
});

test("abandonUnappliedCapsule refuses Capsules with applied state", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  await store.patchInstallation(installation.id, {
    currentStateGeneration: 1,
    updatedAt: "2026-06-06T00:01:00.000Z",
  });

  await expect(
    service.abandonUnappliedCapsule(installation.id, "test abandon"),
  ).rejects.toMatchObject({ code: "failed_precondition" });
});

test("createInstallation allows the same name in a different environment", async () => {
  const { store, service } = build();
  await seedAll(store);
  await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  const preview = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "preview",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  expect(preview.environment).toBe("preview");
});

test("getInstallation throws not_found when missing", async () => {
  const { service } = build();
  await expect(service.getInstallation("inst_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("listInstallations filters by space", async () => {
  const { store, service } = build();
  await seedAll(store);
  await seedSpace(store, { id: "space_2", handle: "other" });
  await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  expect((await service.listInstallations("space_1")).length).toBe(1);
  expect((await service.listInstallations("space_2")).length).toBe(0);
});

test("patchInstallationStatus updates status + timestamp", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  const updated = await service.patchInstallationStatus(
    installation.id,
    "active",
  );
  expect(updated.status).toBe("active");
});

test("putInstallConfig validates a referenced space exists", async () => {
  const { service } = build();
  await expect(
    service.putInstallConfig({
      id: "cfg_x",
      spaceId: "space_missing",
      name: "x",
      installType: "opentofu_module",
      trustLevel: "space",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("putInstallConfig rejects legacy opentofu_root configs for new writes", async () => {
  const { service } = build();
  await expect(
    service.putInstallConfig({
      id: "cfg_root",
      name: "legacy root",
      installType: "opentofu_root",
      trustLevel: "raw",
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("legacy direct-root"),
  });
});

test("putInstallConfig rejects new legacy artifact build fields", async () => {
  const { service } = build();
  await expect(
    service.putInstallConfig({
      id: "cfg_build",
      name: "build",
      installType: "opentofu_module",
      trustLevel: "trusted",
      build: {
        enabled: true,
        commands: ["bun run build"],
        artifactPath: "dist/worker.js",
      },
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("legacy artifact compatibility fields"),
  });

  await expect(
    service.putInstallConfig({
      id: "cfg_prebuilt",
      name: "prebuilt",
      installType: "opentofu_module",
      trustLevel: "trusted",
      prebuiltArtifact: { path: "dist/worker.js" },
      variableMapping: {},
      outputAllowlist: {},
      policy: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("legacy artifact compatibility fields"),
  });
});

test("getInstallConfig keeps pre-v1 official artifact compatibility rows readable", async () => {
  const { store, service } = build();
  await store.putInstallConfig({
    id: "cfg_legacy_official_build",
    name: "legacy official build",
    sourceKind: "official_template",
    installType: "app_source",
    trustLevel: "official",
    build: {
      enabled: true,
      commands: ["bun run build"],
      artifactPath: "dist/worker.js",
    },
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });

  const stored = await service.getInstallConfig("cfg_legacy_official_build");
  expect(stored.build?.artifactPath).toBe("dist/worker.js");
  await expect(
    service.putInstallConfig({
      ...stored,
      id: "cfg_new_official_build",
      name: "new official build",
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("legacy artifact compatibility fields"),
  });
});

test("retired built-in aliases are hidden and fail closed for new use", async () => {
  const { store, service } = build();
  await seedAll(store);
  const retired: InstallConfig = {
    id: "cfg-built-in-talk",
    name: "talk",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putInstallConfig(retired);

  await expect(service.getInstallConfig(retired.id)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await service.listInstallConfigs()).map((c) => c.id)).not.toContain(
    retired.id,
  );
  await expect(
    service.createInstallation({
      spaceId: "space_1",
      name: "talk",
      environment: "production",
      sourceId: "src_1",
      installConfigId: retired.id,
    }),
  ).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("retired built-in alias"),
  });
  await expect(service.putInstallConfig(retired)).rejects.toMatchObject({
    code: "invalid_argument",
    message: expect.stringContaining("retired built-in alias"),
  });
});

test("legacy catalog install-config ids are retired", async () => {
  const { store, service } = build();
  await seedConfig(store, {
    id: "cfg-catalog-yurucommu",
    name: "yurucommu",
  });

  await expect(
    service.getInstallConfig("cfg-catalog-yurucommu"),
  ).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await service.listInstallConfigs()).map((c) => c.id)).not.toContain(
    "cfg-catalog-yurucommu",
  );
});

test("getInstallConfig / listInstallConfigs passthroughs work", async () => {
  const { store, service } = build();
  await seedConfig(store);
  expect((await service.getInstallConfig("cfg_1")).name).toBe("config");
  expect((await service.listInstallConfigs()).map((c) => c.id)).toContain(
    "cfg_1",
  );
  await expect(service.getInstallConfig("cfg_missing")).rejects.toMatchObject({
    code: "not_found",
  });
});

test("built-in generic Capsule InstallConfig is available even before DB seed", async () => {
  const { store, service } = build();
  const configs = await service.listInstallConfigs();
  expect(configs.map((config) => config.id)).toContain(
    DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  );
  const fallback = await service.getInstallConfig(
    DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  );
  expect(fallback.sourceKind).toBe("generic_capsule");

  await seedSpace(store);
  await seedSource(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "takos",
    environment: "production",
    sourceId: "src_1",
    installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  });
  expect(installation.installType).toBe("opentofu_module");
  expect(installation.installConfigId).toBe(DEFAULT_CAPSULE_INSTALL_CONFIG_ID);
});

test("putInstallationProviderEnvBindingSet validates the installation + matching space", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  const profile = await service.putInstallationProviderEnvBindingSet({
    id: "dpf_1",
    spaceId: "space_1",
    installationId: installation.id,
    environment: "production",
    connections: [],
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  expect(profile.id).toBe("dpf_1");
  const fetched =
    await service.getInstallationProviderEnvBindingSetByInstallation(
      installation.id,
      "production",
    );
  expect(fetched?.id).toBe("dpf_1");
});

test("putInstallationProviderEnvBindingSet rejects a spaceId mismatching the installation", async () => {
  const { store, service } = build();
  await seedAll(store);
  const installation = await service.createInstallation({
    spaceId: "space_1",
    name: "shop",
    environment: "production",
    sourceId: "src_1",
    installConfigId: "cfg_1",
  });
  await expect(
    service.putInstallationProviderEnvBindingSet({
      id: "dpf_bad",
      spaceId: "space_other",
      installationId: installation.id,
      environment: "production",
      connections: [],
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
