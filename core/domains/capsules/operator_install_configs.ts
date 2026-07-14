import type { InstallConfig } from "takosumi-contract/install-configs";
import type { CapsulesService } from "./mod.ts";
import { DEFAULT_CAPSULE_INSTALL_CONFIG_ID } from "./default_install_config.ts";

type InstallConfigSink = Pick<CapsulesService, "putInstallConfig">;

/**
 * Install the complete host-contributed, Workspace-neutral config set.
 *
 * Core deliberately ships no app names or Git addresses. A Worker/Bun
 * composition may provide ordinary InstallConfigs here; operators may replace
 * the reference set with their own host-code state. Values and secrets remain
 * normal per-install variables or ProviderConnection material and are never
 * accepted through this bootstrap port.
 */
export async function bootstrapOperatorInstallConfigs(
  sink: InstallConfigSink,
  configs: readonly InstallConfig[] | undefined,
): Promise<void> {
  if (configs === undefined) return;
  const ids = new Set<string>();
  for (const config of configs) {
    if (config.workspaceId !== undefined) {
      throw new TypeError(
        `operator InstallConfig ${config.id} must be Workspace-neutral`,
      );
    }
    if (config.internal !== undefined) {
      throw new TypeError(
        `operator InstallConfig ${config.id} must not be an internal per-install clone`,
      );
    }
    if (config.id === DEFAULT_CAPSULE_INSTALL_CONFIG_ID) {
      throw new TypeError(
        `operator InstallConfig must not replace ${DEFAULT_CAPSULE_INSTALL_CONFIG_ID}`,
      );
    }
    if (ids.has(config.id)) {
      throw new TypeError(`duplicate operator InstallConfig id: ${config.id}`);
    }
    ids.add(config.id);
  }
  for (const config of configs) {
    await sink.putInstallConfig(config);
  }
}
