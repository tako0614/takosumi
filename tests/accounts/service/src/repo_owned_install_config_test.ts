import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  adoptRepoOwnedInstallConfig,
  type RepoOwnedInstallConfigAdoptionInput,
} from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";

const NOW = "2026-08-02T00:00:00.000Z";
const MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;

const repositoryDocument = {
  apiVersion: "takosumi.com/v2",
  kind: "Repository",
  install: {
    modules: {
      ".": {
        inputs: [],
        interfaces: [
          {
            key: "launcher",
            name: "app.launcher",
            spec: {
              type: "interface.ui.surface",
              version: "1",
              document: {
                display: { title: "Open app" },
                launcher: true,
              },
              inputs: {
                url: {
                  source: "output",
                  outputName: "launch_url",
                  outputType: "url",
                },
              },
              access: {
                visibility: "workspace",
                resourceUriInput: "url",
              },
            },
            bindingRequests: [
              {
                key: "installer",
                subject: { source: "installing_principal" },
                permissions: ["ui.open", "ui.inspect"],
                delivery: { type: "none" },
              },
            ],
          },
        ],
      },
    },
  },
} satisfies RepositoryManifestDocument;

const source: Source = {
  id: "src_repo_interface",
  workspaceId: "ws_repo_interface",
  name: "repo-interface",
  url: "https://git.example.test/repo-interface.git",
  defaultRef: "main",
  defaultPath: ".",
  status: "active",
  autoSync: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const sourceSnapshot: SourceSnapshot = {
  id: "snap_repo_interface",
  origin: "git",
  workspaceId: source.workspaceId,
  sourceId: source.id,
  url: source.url,
  ref: source.defaultRef,
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  path: ".",
  archiveRef: "test://repo-interface.tar.zst",
  archiveDigest: `sha256:${"a".repeat(64)}`,
  archiveSizeBytes: 1,
  repositoryManifest: {
    status: "present",
    digest: MANIFEST_DIGEST,
    document: repositoryDocument,
  },
  fetchedByRunId: "run_repo_interface_sync",
  fetchedAt: NOW,
};

const compatibilityReport: CapsuleCompatibilityReport = {
  id: "caprep_repo_interface",
  sourceId: source.id,
  sourceSnapshotId: sourceSnapshot.id,
  modulePath: ".",
  level: "ready",
  findings: [],
  providers: [],
  resources: [],
  dataSources: [],
  provisioners: [],
  rootModuleVariables: [],
  rootModuleVariableDeclarations: [],
  rootModuleOutputs: [
    { name: "launch_url", sensitive: false, ephemeral: false },
  ],
  createdAt: NOW,
};

const compiledLauncher = {
  key: "launcher",
  name: "app.launcher",
  spec: {
    access: { resourceUriInput: "url", visibility: "workspace" as const },
    inputs: {
      url: { outputName: "launch_url", source: "capsule_output" as const },
    },
    document: { launcher: true, display: { title: "Open app" } },
    version: "1",
    type: "interface.ui.surface",
  },
  bindings: [
    {
      delivery: { type: "none" },
      permissions: ["ui.open", "ui.inspect"],
      subject: { source: "installing_principal" as const },
      key: "installer",
    },
  ],
};

const operatorHealthBlueprint = {
  key: "operator-health",
  name: "operator.health",
  spec: {
    type: "example.health",
    version: "1",
    document: { source: "operator" },
    access: { visibility: "private" as const },
  },
};

function baseConfig(overrides: Partial<InstallConfig> = {}): InstallConfig {
  return {
    id: "icfg_repo_interface_base",
    name: "repo-interface-base",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      repositoryInstallUx: {
        allowedInterfacePermissions: ["ui.open", "ui.inspect"],
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function adopt(
  config: InstallConfig,
  overrides: Partial<RepoOwnedInstallConfigAdoptionInput> = {},
) {
  return await adoptRepoOwnedInstallConfig({
    operations: {} as ControlPlaneOperations,
    source,
    sourceSnapshot,
    baseConfig: config,
    modulePath: ".",
    capsuleName: "repo-interface",
    workspaceId: source.workspaceId,
    compatibilityReport,
    ...overrides,
  });
}

function snapshotWithManifest(
  repositoryManifest: SourceSnapshot["repositoryManifest"],
): SourceSnapshot {
  return { ...sourceSnapshot, repositoryManifest };
}

function reportForModule(modulePath: string): CapsuleCompatibilityReport {
  return {
    ...compatibilityReport,
    modulePath,
    rootModuleOutputs: [],
  };
}

describe("repository-owned default module selection", () => {
  test("infers the only declared module without consulting Source or base InstallConfig paths", async () => {
    const document = {
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: { modules: { "deploy/only": { inputs: [] } } },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig({ modulePath: "host/base" }), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document,
      }),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/only"),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe("deploy/only");
  });

  test("uses the v2.1 exact default for multiple modules and ignores the base InstallConfig path", async () => {
    const document = {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
        defaultModule: "deploy/selected",
        modules: {
          ".": { inputs: [] },
          "deploy/selected": { inputs: [] },
        },
      },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig({ modulePath: "." }), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document,
      }),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/selected"),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe("deploy/selected");
  });

  test("fails closed when multiple modules have no v2.1 exact default", async () => {
    const document = {
      apiVersion: "takosumi.com/v2",
      kind: "Repository",
      install: {
        modules: {
          "deploy/first": { inputs: [] },
          "deploy/second": { inputs: [] },
        },
      },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig({ modulePath: "deploy/first" }), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document,
      }),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/first"),
    });

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_default_module_missing",
        message:
          "Repository install UX declares multiple modules; takosumi.com/v2.1 install.defaultModule is required.",
      },
    });
  });

  test("returns the typed default diagnostic for an invalid captured declaration", async () => {
    const result = await adopt(baseConfig(), {
      sourceSnapshot: snapshotWithManifest({
        status: "invalid",
        reason: "invalid_document",
        digest: MANIFEST_DIGEST,
        diagnostic:
          "install.defaultModule must name an exact install.modules key",
      }),
      modulePath: undefined,
    });

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_default_module_invalid",
        message:
          "The repository install UX default module declaration is invalid; update the pinned repository metadata and sync the Source again.",
      },
    });
  });
});

describe("repository-owned sourceBuild adoption", () => {
  const sourceBuildDocument = {
    ...repositoryDocument,
    apiVersion: "takosumi.com/v2.3",
    install: {
      ...repositoryDocument.install,
      defaultModule: ".",
      modules: {
        ".": {
          ...repositoryDocument.install.modules["."]!,
          sourceBuild: {
            commands: [
              { argv: ["bun", "install", "--frozen-lockfile"] },
              { argv: ["bun", "run", "build"], workingDirectory: "web" },
            ],
            outputs: ["web/dist/index.js"],
          },
        },
      },
    },
  } satisfies RepositoryManifestDocument;

  test("pins the repository proposal into adoption when the base has none", async () => {
    const result = await adopt(baseConfig(), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: sourceBuildDocument,
      }),
      installingPrincipalId: undefined,
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.sourceBuild).toEqual(
      sourceBuildDocument.install.modules["."].sourceBuild,
    );
  });

  test("keeps a differing service base sourceBuild as the final authority", async () => {
    const baseSourceBuild = {
      commands: [{ argv: ["npm", "run", "build"] }],
      outputs: ["dist/operator.js"],
    };
    const result = await adopt(baseConfig({ sourceBuild: baseSourceBuild }), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: sourceBuildDocument,
      }),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.sourceBuild).toEqual(baseSourceBuild);
    expect(result.sourceBuild).not.toEqual(
      sourceBuildDocument.install.modules["."].sourceBuild,
    );
  });
});

describe("repository-owned Interface InstallConfig adoption", () => {
  test("v2.1 preserves v2 Interface proposal merging and installing Principal resolution", async () => {
    const v2_1Document = {
      ...repositoryDocument,
      apiVersion: "takosumi.com/v2.1",
      install: { ...repositoryDocument.install, defaultModule: "." },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig(), {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: v2_1Document,
      }),
      modulePath: undefined,
      installingPrincipalId: "principal_v2_1_installer",
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.interfaceBlueprints?.[0]?.bindings).toEqual([
      {
        key: "installer",
        subjectRef: { kind: "Principal", id: "principal_v2_1_installer" },
        permissions: ["ui.inspect", "ui.open"],
        delivery: { type: "none" },
      },
    ]);
    expect(result.outputAllowlist).toEqual({
      launch_url: { from: "launch_url", type: "url", required: true },
    });
  });

  test.each([
    ["an absent", {}],
    ["an empty", { repositoryInstallUx: { allowedInterfacePermissions: [] } }],
  ])(
    "rejects binding requests when the base config has %s permission allowlist",
    async (_label, policy) => {
      const result = await adopt(baseConfig({ policy }));

      expect(result).toEqual({
        status: "invalid",
        diagnostic: {
          code: "repository_install_ux_interface_permission_disallowed",
          message:
            "Repository-owned Interface bindings require an explicit non-empty operator permission allowlist.",
        },
      });
    },
  );

  test("rejects any requested permission outside the exact base config allowlist", async () => {
    const result = await adopt(
      baseConfig({
        policy: {
          repositoryInstallUx: {
            allowedInterfacePermissions: ["ui.open"],
          },
        },
      }),
    );

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_interface_permission_disallowed",
        message:
          'Interface permission "ui.inspect" is not allowed by operator policy.',
      },
    });
  });

  test("accepts the exact permission allowlist, deduplicates normalized declarations, and retains unrelated operator outputs", async () => {
    const result = await adopt(
      baseConfig({
        interfaceBlueprints: [compiledLauncher, operatorHealthBlueprint],
        outputAllowlist: {
          health_url: { from: "health_url", type: "url" },
          launch_url: {
            required: true,
            type: "url",
            from: "launch_url",
          },
        },
      }),
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.interfaceBlueprints).toEqual([
      compiledLauncher,
      operatorHealthBlueprint,
    ]);
    expect(result.outputAllowlist).toEqual({
      health_url: { from: "health_url", type: "url" },
      launch_url: { from: "launch_url", type: "url", required: true },
    });
  });

  test("rejects a central Interface declaration with the same stable key and different normalized content", async () => {
    const result = await adopt(
      baseConfig({
        interfaceBlueprints: [
          {
            ...compiledLauncher,
            spec: {
              ...compiledLauncher.spec,
              document: { launcher: false },
            },
          },
        ],
      }),
    );

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_interface_blueprint_conflict",
        message:
          'Interface blueprint key "launcher" conflicts with the reviewed service declaration.',
      },
    });
  });

  test("rejects an output key whose central projection differs from the repository proposal", async () => {
    const result = await adopt(
      baseConfig({
        outputAllowlist: {
          launch_url: { from: "legacy_launch_url", type: "string" },
        },
      }),
    );

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_output_allowlist_conflict",
        message:
          'Output allowlist key "launch_url" conflicts with the reviewed service declaration.',
      },
    });
  });

  test("resolves repository binding requests to the exact authenticated installing Principal before merge", async () => {
    const result = await adopt(baseConfig(), {
      installingPrincipalId: " principal_installer ",
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.interfaceBlueprints?.[0]?.bindings).toEqual([
      {
        key: "installer",
        subjectRef: { kind: "Principal", id: "principal_installer" },
        permissions: ["ui.inspect", "ui.open"],
        delivery: { type: "none" },
      },
    ]);
  });

  test("rejects an empty installing Principal at the adoption boundary", async () => {
    const result = await adopt(baseConfig(), {
      installingPrincipalId: "   ",
    });

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_installing_principal_invalid",
        message:
          "Repository install UX review requires an exact authenticated installing Principal.",
      },
    });
  });

  test("rejects reuse of an exact-Principal preview by a different installing Principal", async () => {
    const exactPreviewBlueprint = {
      ...compiledLauncher,
      bindings: [
        {
          key: "installer",
          subjectRef: { kind: "Principal" as const, id: "principal_reviewer" },
          permissions: ["ui.inspect", "ui.open"],
          delivery: { type: "none" },
        },
      ],
    };
    const result = await adopt(
      baseConfig({ interfaceBlueprints: [exactPreviewBlueprint] }),
      { installingPrincipalId: "principal_other" },
    );

    expect(result).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_interface_blueprint_conflict",
        message:
          'Interface blueprint key "launcher" conflicts with the reviewed service declaration.',
      },
    });
  });
});
