import { expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { bootstrapOperatorInstallConfigs } from "../../../../core/domains/capsules/operator_install_configs.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "../../../../core/domains/capsules/default_install_config.ts";

const CONFIG: InstallConfig = {
  id: "cfg-reference-example-main",
  name: "example-main",
  variableMapping: {},
  outputAllowlist: {},
  policy: {},
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
};

test("operator InstallConfig bootstrap validates the complete contribution before writes", async () => {
  const written: InstallConfig[] = [];
  const sink = {
    putInstallConfig(config: InstallConfig) {
      written.push(config);
      return Promise.resolve(config);
    },
  };
  await bootstrapOperatorInstallConfigs(sink, [CONFIG]);
  expect(written).toEqual([CONFIG]);

  for (const invalid of [
    [{ ...CONFIG, workspaceId: "workspace_1" }],
    [{ ...CONFIG, internal: { reason: "per_install_overrides" as const } }],
    [{ ...CONFIG, id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID }],
    [CONFIG, CONFIG],
  ]) {
    written.length = 0;
    await expect(
      bootstrapOperatorInstallConfigs(sink, invalid),
    ).rejects.toThrow();
    expect(written).toHaveLength(0);
  }
});
