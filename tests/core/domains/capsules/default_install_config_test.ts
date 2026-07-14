import { expect, test } from "bun:test";

import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  bootstrapDefaultInstallConfig,
  defaultCapsuleInstallConfig,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = new Date("2026-06-06T00:00:00.000Z");

test("the default InstallConfig is generic service-side DB configuration", () => {
  const config = defaultCapsuleInstallConfig(NOW);

  expect(config).toEqual({
    id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  expect(config).not.toHaveProperty("sourceKind");
  expect(config).not.toHaveProperty("installType");
  expect(config).not.toHaveProperty("templateBinding");
  expect(config).not.toHaveProperty("store");
  expect(defaultCapsuleOutputAllowlist()).toEqual({});
});

test("bootstrap persists only the generic default and remains idempotent", async () => {
  const store = new InMemoryOpenTofuControlStore();

  await bootstrapDefaultInstallConfig(store, NOW);
  await bootstrapDefaultInstallConfig(store, NOW);

  expect(await store.listInstallConfigs()).toEqual([
    defaultCapsuleInstallConfig(NOW),
  ]);
});
