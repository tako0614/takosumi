/** Service-owned default for installing a plain Git OpenTofu Capsule. */
import type {
  InstallConfig,
  OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import type { OpenTofuControlStore } from "../deploy-control/store.ts";

export const DEFAULT_CAPSULE_INSTALL_CONFIG_ID = "cfg-default-opentofu-capsule";

/**
 * The default config does not guess public semantics. The runner still captures
 * every ordinary root Output; public and Interface exposure is configured
 * explicitly after installation.
 */
export function defaultCapsuleOutputAllowlist(): Readonly<
  Record<string, OutputAllowlistEntry>
> {
  return {};
}

export function defaultCapsuleInstallConfig(
  now: Date = new Date(),
): InstallConfig {
  const timestamp = now.toISOString();
  return {
    id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: defaultCapsuleOutputAllowlist(),
    policy: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function bootstrapDefaultInstallConfig(
  store: OpenTofuControlStore,
  now: Date = new Date(),
): Promise<void> {
  await store.putInstallConfig(defaultCapsuleInstallConfig(now));
}
