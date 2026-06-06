import { expect, test } from "bun:test";

import { LanesService } from "./mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";
import { OpenTofuControllerError } from "../deploy-control/errors.ts";
import type { OpenTofuDeploymentStore } from "../deploy-control/store.ts";
import type { StoredSource } from "../deploy-control/store.ts";
import type { InstallProfile } from "takosumi-contract/lanes";

function build() {
  const store = new InMemoryOpenTofuDeploymentStore();
  let counter = 0;
  const newId = (prefix: string) =>
    `${prefix}_test${(counter += 1).toString().padStart(8, "0")}`;
  const service = new LanesService({
    store,
    newId,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
  });
  return { store, service };
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

async function seedProfile(
  store: OpenTofuDeploymentStore,
  id: string,
): Promise<InstallProfile> {
  const profile: InstallProfile = {
    id,
    name: "Profile",
    installType: "opentofu_module",
    trustLevel: "official",
    variableMapping: {},
    outputAllowlist: {},
    policyId: "policy_1",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
  await store.putInstallProfile(profile);
  return profile;
}

test("createApp validates the Source exists in the same space", async () => {
  const { service } = build();
  await expect(
    service.createApp({
      spaceId: "space_1",
      name: "shop",
      sourceId: "src_missing",
      installType: "opentofu_module",
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});

test("createApp persists with an InstallProfile binding", async () => {
  const { store, service } = build();
  await seedSource(store);
  await seedProfile(store, "profile_1");
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
    installProfileId: "profile_1",
  });
  expect(app.id).toBe("app_test00000001");
  expect(app.installProfileId).toBe("profile_1");
  expect((await store.getApp(app.id))?.name).toBe("shop");
});

test("createApp rejects an unknown InstallProfile", async () => {
  const { store, service } = build();
  await seedSource(store);
  await expect(
    service.createApp({
      spaceId: "space_1",
      name: "shop",
      sourceId: "src_1",
      installType: "opentofu_module",
      installProfileId: "profile_missing",
    }),
  ).rejects.toMatchObject({ code: "not_found" });
});

test("createEnvironment applies production defaults and inherits source ref/path", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  const env = await service.createEnvironment(app.id, { name: "production" });
  expect(env.ref).toBe("release");
  expect(env.path).toBe("infra");
  expect(env.autoApply).toBe(false);
  expect(env.requireApproval).toBe(true);
});

test("createEnvironment applies preview defaults (auto-apply, no approval)", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  const env = await service.createEnvironment(app.id, { name: "preview" });
  expect(env.autoApply).toBe(true);
  expect(env.requireApproval).toBe(false);
});

test("patchEnvironment toggles automation flags", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  const env = await service.createEnvironment(app.id, { name: "production" });
  const patched = await service.patchEnvironment(env.id, {
    autoApply: true,
    requireApproval: false,
  });
  expect(patched.autoApply).toBe(true);
  expect(patched.requireApproval).toBe(false);
});

test("deleteApp refuses while environments exist", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  await service.createEnvironment(app.id, { name: "production" });
  await expect(service.deleteApp(app.id)).rejects.toBeInstanceOf(
    OpenTofuControllerError,
  );
});

test("putDeploymentProfile upserts the per-environment binding", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  const env = await service.createEnvironment(app.id, { name: "production" });
  const first = await service.putDeploymentProfile(env.id, {
    bindings: { compute: { mode: "service", connectionId: "conn_cf" } },
  });
  const second = await service.putDeploymentProfile(env.id, {
    bindings: { dns: { mode: "customer", connectionId: "conn_dns" } },
  });
  // The profile id is stable across the upsert (keyed by environment).
  expect(second.id).toBe(first.id);
  const current = await service.getDeploymentProfile(env.id);
  expect(current?.bindings.dns?.connectionId).toBe("conn_dns");
});

test("putDeploymentProfile rejects service/customer binding without connectionId", async () => {
  const { store, service } = build();
  await seedSource(store);
  const app = await service.createApp({
    spaceId: "space_1",
    name: "shop",
    sourceId: "src_1",
    installType: "opentofu_module",
  });
  const env = await service.createEnvironment(app.id, { name: "production" });
  await expect(
    service.putDeploymentProfile(env.id, {
      bindings: { compute: { mode: "service" } },
    }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
});
