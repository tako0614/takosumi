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
        // Runtime requirements are opt-in: repository metadata is rejected
        // unless the operator names every generic kind this config accepts.
        allowedRequirementKinds: [
          "secret.generated",
          "http.endpoint",
          "identity.oidc",
          "interface.consume",
        ],
        allowedOidcScopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "capsules:read",
          "capsules:write",
        ],
        // A repository may propose an installer-scoped launcher, MCP binding,
        // or explicit app-shared storage requirement. These profiles admit
        // metadata compiled into the reviewed InstallConfig; current Link
        // approval and runtime authority remain required. Admission never
        // grants a Workspace-wide or operator credential.
        allowedInterfacePermissions: [
          UI_SURFACE_OPEN_PERMISSION,
          MCP_SERVER_INVOKE_PERMISSION,
          "storage.object.list",
          "storage.object.read",
          "storage.object.write",
          "storage.object.delete",
        ],
        allowedInterfaceDeliveryTypes: ["none", "oauth2", "oauth2.app-data.v1"],
        allowedInterfaceBindingProfiles: [
          { permissions: [UI_SURFACE_OPEN_PERMISSION], deliveryType: "none" },
          {
            permissions: [
              "storage.object.list",
              "storage.object.read",
              "storage.object.write",
              "storage.object.delete",
            ],
            deliveryType: "oauth2.app-data.v1",
          },
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
