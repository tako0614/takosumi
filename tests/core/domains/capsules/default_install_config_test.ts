import { expect, test } from "bun:test";

import { createTakosumiService } from "../../../../core/bootstrap.ts";
import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  defaultCapsuleInstallConfig,
  defaultCapsuleOutputAllowlist,
} from "../../../../core/domains/capsules/default_install_config.ts";
import { withHostInstallConfigs } from "../../../../core/domains/capsules/host_install_config_store.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = new Date("2026-06-06T00:00:00.000Z");

test("the default InstallConfig is generic service-side DB configuration", () => {
  const config = defaultCapsuleInstallConfig(NOW);

  expect(config).toEqual({
    id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      repositoryInstallUx: {
        allowedInterfacePermissions: ["ui.open", "mcp.invoke"],
        allowedInterfaceDeliveryTypes: ["none", "oauth2"],
        allowedInterfaceBindingProfiles: [
          { permissions: ["ui.open"], deliveryType: "none" },
          { permissions: ["mcp.invoke"], deliveryType: "oauth2" },
        ],
      },
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  });
  expect(config).not.toHaveProperty("sourceKind");
  expect(config).not.toHaveProperty("installType");
  expect(config).not.toHaveProperty("templateBinding");
  expect(config).not.toHaveProperty("store");
  expect(defaultCapsuleOutputAllowlist()).toEqual({});
});

test("host InstallConfigs are readable without request-time persistence", async () => {
  const durable = new InMemoryOpenTofuControlStore();
  const host = defaultCapsuleInstallConfig(NOW);
  const historical = { ...host, id: "cfg-retired-shared" };
  await durable.putInstallConfig(historical);
  const store = withHostInstallConfigs(durable, [host]);

  expect(await durable.listInstallConfigs()).toEqual([historical]);
  expect(await store.getInstallConfig(host.id)).toEqual(host);
  expect(await store.getInstallConfig(historical.id)).toEqual(historical);
  expect(await store.getInstallConfigsByIds(["missing", host.id])).toEqual([
    host,
  ]);
  expect(await store.listSharedInstallConfigs()).toEqual([host]);
  expect(await store.listSharedInstallConfigsPage({ limit: 10 })).toEqual({
    items: [host],
  });
});

test("host InstallConfigs are immutable and cannot be shadowed by durable rows", async () => {
  const durable = new InMemoryOpenTofuControlStore();
  const host = defaultCapsuleInstallConfig(NOW);
  const store = withHostInstallConfigs(durable, [host]);

  await expect(store.putInstallConfig({ ...host, name: "shadow" })).rejects
    .toThrow(`host InstallConfig ${host.id} is immutable`);
  expect(await durable.getInstallConfig(host.id)).toBeUndefined();
});

test("service creation exposes host configs without durable InstallConfig writes", async () => {
  const durable = new InMemoryOpenTofuControlStore();
  let writes = 0;
  const originalPut = durable.putInstallConfig.bind(durable);
  durable.putInstallConfig = async (config) => {
    writes += 1;
    return await originalPut(config);
  };
  const operator = {
    ...defaultCapsuleInstallConfig(NOW),
    id: "cfg-operator-example",
    name: "operator-example",
  };

  const { operations } = await createTakosumiService({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: durable,
    operatorInstallConfigs: [operator],
  });

  expect(writes).toBe(0);
  expect(
    (await operations.capsules.listSharedInstallConfigs()).map((row) => row.id),
  ).toEqual([DEFAULT_CAPSULE_INSTALL_CONFIG_ID, operator.id]);
  expect(await durable.listInstallConfigs()).toEqual([]);
});

test("a host can replace the generic default policy without adding an app catalog", async () => {
  const durable = new InMemoryOpenTofuControlStore();
  const hostDefault = {
    ...defaultCapsuleInstallConfig(NOW),
    policy: {
      ...defaultCapsuleInstallConfig(NOW).policy,
      providerCredentials: {
        requiredProviders: ["registry.opentofu.org/example/platform-provider"],
      },
    },
  };

  const { operations } = await createTakosumiService({
    runtimeEnv: { TAKOSUMI_DEV_MODE: "1" },
    opentofuControlStore: durable,
    operatorInstallConfigs: [hostDefault],
  });

  expect(
    await operations.capsules.getInstallConfig(
      DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    ),
  ).toEqual(hostDefault);
  expect(await operations.capsules.listSharedInstallConfigs()).toEqual([
    hostDefault,
  ]);
  expect(await durable.listInstallConfigs()).toEqual([]);
});
