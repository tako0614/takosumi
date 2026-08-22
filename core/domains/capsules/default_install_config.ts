/** Service-owned default for installing a plain Git OpenTofu Capsule. */
import type {
  InstallConfig,
  OutputAllowlistEntry,
} from "takosumi-contract/install-configs";
import {
  MCP_SERVER_INVOKE_PERMISSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";

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
        // A repository may propose an installer-scoped launcher or MCP binding,
        // but the proposal is still compiled into the reviewed InstallConfig;
        // it never grants a Workspace-wide or operator credential.
        allowedInterfacePermissions: [
          UI_SURFACE_OPEN_PERMISSION,
          MCP_SERVER_INVOKE_PERMISSION,
        ],
        allowedInterfaceDeliveryTypes: ["none", "oauth2"],
        allowedInterfaceBindingProfiles: [
          { permissions: [UI_SURFACE_OPEN_PERMISSION], deliveryType: "none" },
          {
            permissions: [MCP_SERVER_INVOKE_PERMISSION],
            deliveryType: "oauth2",
          },
        ],
      },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
