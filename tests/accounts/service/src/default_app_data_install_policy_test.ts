import { expect, test } from "bun:test";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import { parseRepositoryManifestText } from "takosumi-contract/repository-manifest";
import { adoptRepoOwnedInstallConfig } from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { defaultCapsuleInstallConfig } from "../../../../core/domains/capsules/default_install_config.ts";
import { analyzeOpenTofuCapsuleFiles } from "../../../../core/domains/sources/capsule_compatibility.ts";

const PERMISSIONS = ["storage.object.list", "storage.object.read", "storage.object.write", "storage.object.delete"];
const NOW = "2026-11-12T00:00:00.000Z";
const source: Source = {
  id: "src_app_data", workspaceId: "ws_app_data", name: "app-data",
  url: "https://git.example.test/app.git", defaultRef: "main", defaultPath: ".",
  status: "active", autoSync: false, createdAt: NOW, updatedAt: NOW,
};
const operations = new Proxy({}, {
  get() { throw new Error("metadata admission must not call runtime or persistence ports"); },
}) as ControlPlaneOperations;

function moduleDeclaration() {
  return {
    inputs: [],
    requires: [{
      kind: "interface.consume", key: "storage",
      interface: { type: "storage.object", version: "1" },
      permissions: [...PERMISSIONS], delivery: { type: "oauth2.app-data.v1" },
    }],
    interfaces: [
      { key: "launcher", name: "app.launcher", spec: {
        type: "interface.ui.surface", version: "1", document: { launcher: true },
        inputs: { url: { source: "output", outputName: "app_url", outputType: "url" } },
        access: { visibility: "workspace", resourceUriInput: "url" },
      }, bindingRequests: [{ key: "installer", subject: { source: "installing_principal" },
        permissions: ["ui.open"], delivery: { type: "none" } }] },
      { key: "mcp", name: "app.mcp", spec: {
        type: "mcp.server", version: "2025-11-25", document: {},
        inputs: { url: { source: "output", outputName: "mcp_url", outputType: "url" } },
        access: { visibility: "workspace", resourceUriInput: "url" },
      }, bindingRequests: [{ key: "installer", subject: { source: "installing_principal" },
        permissions: ["mcp.invoke"], delivery: { type: "oauth2" } }] },
    ],
  };
}

for (const modulePath of [".", "deploy/takoform-v1"]) {
  async function adopt(
    module: unknown = moduleDeclaration(),
    baseConfig: InstallConfig = defaultCapsuleInstallConfig(),
  ) {
    const parsed = parseRepositoryManifestText(JSON.stringify({
      apiVersion: "takosumi.com/v2.5", kind: "Repository",
      install: { modules: { [modulePath]: module } },
    }));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const snapshot: SourceSnapshot = {
      id: "snap_app_data", sourceId: source.id, workspaceId: source.workspaceId,
      origin: "git", url: source.url, ref: "main", resolvedCommit: "a".repeat(40),
      path: ".", archiveRef: "test://app-data", archiveDigest: `sha256:${"b".repeat(64)}`,
      archiveSizeBytes: 1, fetchedByRunId: "run_sync", fetchedAt: NOW,
      repositoryManifest: { status: "present", digest: `sha256:${"c".repeat(64)}`, document: parsed.document },
      repositoryModules: { status: "ready", scopePath: ".", modules: [
        { path: modulePath, providerPackages: [], rootProviderRequirements: [] },
      ] },
    };
    const analysis = analyzeOpenTofuCapsuleFiles({ sourceId: source.id, sourceSnapshot: snapshot,
      files: [{ path: "outputs.tf", text: 'output "app_url" { value = "https://app.example.test" }\noutput "mcp_url" { value = "https://app.example.test/mcp" }\n' }],
    });
    expect(analysis.level).toBe("ready");
    return await adoptRepoOwnedInstallConfig({
      operations, source, sourceSnapshot: snapshot, baseConfig, modulePath,
      capsuleName: "fixture-app", workspaceId: source.workspaceId!, installingPrincipalId: "principal_fixture",
      compatibilityReport: { ...analysis, id: "report_app_data", sourceId: source.id,
        sourceSnapshotId: snapshot.id, modulePath, providers: analysis.providerPackages, createdAt: NOW },
      requireReviewedValues: false,
    });
  }

  test(`${modulePath}: default policy admits the exact shared-data requirement through Accounts`, async () => {
    const result = await adopt();
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.requiredInterfaces).toEqual([{
      key: "storage", interface: { type: "storage.object", version: "1" },
      permissions: [...PERMISSIONS].sort(), delivery: { type: "oauth2.app-data.v1" },
    }]);
    expect(result.interfaceBlueprints?.map((i) => i.bindings?.map((b) => ({ permissions: b.permissions, delivery: b.delivery })))).toEqual([
      [{ permissions: ["ui.open"], delivery: { type: "none" } }],
      [{ permissions: ["mcp.invoke"], delivery: { type: "oauth2" } }],
    ]);
    expect(defaultCapsuleInstallConfig().outputAllowlist).toEqual({});
  });

  for (const [field, code] of [
    ["allowedInterfacePermissions", "repository_install_ux_interface_permission_disallowed"],
    ["allowedInterfaceDeliveryTypes", "repository_install_ux_interface_delivery_disallowed"],
    ["allowedInterfaceBindingProfiles", "repository_install_ux_interface_binding_profile_disallowed"],
  ] as const) {
    test(`${modulePath}: an operator can independently narrow ${field}`, async () => {
      const config = defaultCapsuleInstallConfig();
      const policy = config.policy!.repositoryInstallUx!;
      const result = await adopt(moduleDeclaration(), { ...config, policy: {
        ...config.policy, repositoryInstallUx: { ...policy, [field]: [] },
      } });
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.diagnostic.code).toBe(code);
    });
  }

  test(`${modulePath}: unlisted permissions and recombined profiles stay denied`, async () => {
    for (const [permissions, delivery, code] of [
      [[...PERMISSIONS, "storage.object.admin"], "oauth2.app-data.v1", "repository_install_ux_interface_permission_disallowed"],
      [["storage.object.read"], "oauth2.app-data.v1", "repository_install_ux_interface_binding_profile_disallowed"],
      [PERMISSIONS, "oauth2", "repository_install_ux_interface_binding_profile_disallowed"],
      [PERMISSIONS, "none", "repository_install_ux_interface_binding_profile_disallowed"],
      [["mcp.invoke"], "oauth2.app-data.v1", "repository_install_ux_interface_binding_profile_disallowed"],
    ] as const) {
      const module = moduleDeclaration();
      module.requires[0]!.permissions = [...permissions];
      module.requires[0]!.delivery.type = delivery;
      const result = await adopt(module);
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") expect(result.diagnostic.code).toBe(code);
    }
  });

  test(`${modulePath}: storage permissions cannot widen an installer launcher`, async () => {
    const module = moduleDeclaration();
    module.interfaces[0]!.bindingRequests[0]!.permissions.push("storage.object.read");
    const result = await adopt(module);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.diagnostic.code).toBe("repository_install_ux_interface_binding_profile_disallowed");
  });

  test(`${modulePath}: app-data admission does not allow a new OIDC scope`, async () => {
    const module = moduleDeclaration();
    const result = await adopt({ ...module, requires: [...module.requires, {
      kind: "identity.oidc", callbackPath: "/auth/oidc/callback",
      scopes: ["openid", "wallet:write"], deliver: { bindings: {
        issuerUrl: "OIDC_ISSUER_URL", clientId: "OIDC_CLIENT_ID",
        ownerSubject: "OIDC_OWNER_SUBJECT", redirectUri: "OIDC_REDIRECT_URI",
      } },
    }] });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.diagnostic.code).toBe("repository_install_ux_requirement_disallowed");
  });
}
