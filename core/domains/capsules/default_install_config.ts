/** Service-owned default for installing a plain Git OpenTofu Capsule. */
import type {
  InstallConfig,
  OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import { UI_SURFACE_OPEN_PERMISSION } from "takosumi-contract";

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
  now: Date = new Date("2026-01-01T00:00:00.000Z"),
): InstallConfig {
  const timestamp = now.toISOString();
  return {
    id: DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: defaultCapsuleOutputAllowlist(),
    policy: {
      repositoryInstallUx: {
        allowedInterfacePermissions: [UI_SURFACE_OPEN_PERMISSION],
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
