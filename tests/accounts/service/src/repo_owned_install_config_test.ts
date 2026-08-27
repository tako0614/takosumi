import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  adoptRepoOwnedInstallConfig,
  previewRepoOwnedInstallConfig,
  resolveRepoOwnedDeploymentProfile,
  resolveRepoOwnedInstallModulePath,
  type RepoOwnedInstallConfigAdoptionInput,
} from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";

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

test("repository adoption carries an explicitly allowed generic OIDC capability", async () => {
  const variableNames = [
    "public_url",
    "takosumi_accounts_url",
    "takosumi_accounts_issuer_url",
    "takosumi_accounts_client_id",
    "takosumi_accounts_redirect_uri",
  ];
  const oidcDocument = {
    apiVersion: "takosumi.com/v2.2",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: variableNames.map((name) => ({
            name,
            source: {
              kind: name === "public_url" ? "user" as const : "module_default" as const,
            },
            type: "string" as const,
            ...(name === "public_url" ? { required: true } : {}),
            label: { ja: name, en: name },
          })),
          requires: [
            {
              kind: "http.endpoint" as const,
              deliver: { variables: { url: "public_url" } },
            },
            {
              kind: "identity.oidc" as const,
              callbackPath: "/auth/oidc/callback",
              scopes: ["openid", "profile"],
              deliver: {
                variables: {
                  accountsUrl: "takosumi_accounts_url",
                  issuerUrl: "takosumi_accounts_issuer_url",
                  clientId: "takosumi_accounts_client_id",
                  redirectUri: "takosumi_accounts_redirect_uri",
                },
              },
            },
          ],
        },
      },
    },
  } satisfies RepositoryManifestDocument;
  const result = await adopt(
    baseConfig({
      policy: {
        repositoryInstallUx: {
          allowedInterfacePermissions: [],
          allowedOidcScopes: ["openid", "profile"],
        },
      },
    }),
    {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: oidcDocument,
      }),
      compatibilityReport: {
        ...compatibilityReport,
        rootModuleVariables: variableNames,
        rootModuleVariableDeclarations: variableNames.map((name) => ({
          name,
          type: "string",
          hasDefault: name !== "public_url",
        })),
        rootModuleOutputs: [],
      },
      reviewedVariables: { public_url: "https://staging.example.test" },
    },
  );

  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(result.installExperience?.projections).toEqual([
    { kind: "public_endpoint", variables: { url: "public_url" } },
    {
      kind: "oidc_client",
      variables: {
        accountsUrl: "takosumi_accounts_url",
        issuerUrl: "takosumi_accounts_issuer_url",
        clientId: "takosumi_accounts_client_id",
        redirectUri: "takosumi_accounts_redirect_uri",
      },
      callbackPath: "/auth/oidc/callback",
      scopes: ["openid", "profile"],
    },
  ]);
});

test("repository OIDC rejects a base public endpoint collision instead of splitting manifest provenance", async () => {
  const variableNames = [
    "public_url",
    "takosumi_accounts_url",
    "takosumi_accounts_issuer_url",
    "takosumi_accounts_client_id",
    "takosumi_accounts_redirect_uri",
  ];
  const oidcDocument = {
    apiVersion: "takosumi.com/v2.2",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: variableNames.map((name) => ({
            name,
            source: {
              kind: name === "public_url"
                ? "user" as const
                : "module_default" as const,
            },
            type: "string" as const,
            ...(name === "public_url" ? { required: true } : {}),
            label: { ja: name, en: name },
          })),
          requires: [
            {
              kind: "http.endpoint" as const,
              deliver: { variables: { url: "public_url" } },
            },
            {
              kind: "identity.oidc" as const,
              callbackPath: "/auth/oidc/callback",
              scopes: ["openid", "profile"],
              deliver: {
                variables: {
                  accountsUrl: "takosumi_accounts_url",
                  issuerUrl: "takosumi_accounts_issuer_url",
                  clientId: "takosumi_accounts_client_id",
                  redirectUri: "takosumi_accounts_redirect_uri",
                },
              },
            },
          ],
        },
      },
    },
  } satisfies RepositoryManifestDocument;
  const result = await adopt(
    baseConfig({
      installExperience: {
        projections: [{
          kind: "public_endpoint",
          variables: { url: "operator_public_url" },
        }],
      },
      policy: {
        repositoryInstallUx: {
          allowedInterfacePermissions: [],
          allowedOidcScopes: ["openid", "profile"],
        },
      },
    }),
    {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: oidcDocument,
      }),
      compatibilityReport: {
        ...compatibilityReport,
        rootModuleVariables: variableNames,
        rootModuleVariableDeclarations: variableNames.map((name) => ({
          name,
          type: "string",
          hasDefault: name !== "public_url",
        })),
        rootModuleOutputs: [],
      },
      reviewedVariables: { public_url: "https://staging.example.test" },
    },
  );

  expect(result).toMatchObject({
    status: "invalid",
    diagnostic: {
      code: "repository_install_ux_oidc_endpoint_conflict",
    },
  });
});

test("repository adoption does not promote an operator-only OIDC projection", async () => {
  const result = await adopt(baseConfig({
    installExperience: {
      projections: [
        { kind: "public_endpoint", variables: { url: "public_url" } },
        {
          kind: "oidc_client",
          variables: {
            accountsUrl: "takosumi_accounts_url",
            issuerUrl: "takosumi_accounts_issuer_url",
            clientId: "takosumi_accounts_client_id",
            redirectUri: "takosumi_accounts_redirect_uri",
          },
          callbackPath: "/operator/callback",
          scopes: ["openid"],
        },
      ],
    },
  }), { installingPrincipalId: "principal_operator_projection" });

  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(result.installExperience?.projections).toEqual([
    { kind: "public_endpoint", variables: { url: "public_url" } },
  ]);
});

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

test("repository install preview recovers only its full deterministic config identity", async () => {
  let stored: InstallConfig | undefined;
  const operations = {
    capsules: {
      getInstallConfig: async (id: string) => {
        if (!stored || stored.id !== id) {
          throw new OpenTofuControllerError("not_found", "missing");
        }
        return stored;
      },
      putInstallConfig: async (config: InstallConfig) => {
        stored = config;
        return config;
      },
    },
  } as unknown as ControlPlaneOperations;
  const input = {
    operations,
    source,
    sourceSnapshot,
    baseConfig: baseConfig(),
    modulePath: ".",
    capsuleName: "repo-interface",
    workspaceId: source.workspaceId,
    installingPrincipalId: "tsub_installer",
    compatibilityReport,
  } as const;

  const first = await previewRepoOwnedInstallConfig(input);
  expect(first.status).toBe("accepted");
  if (first.status !== "accepted") throw new Error("preview was not accepted");
  expect(stored).toEqual(first.installConfig);

  stored = { ...first.installConfig, modulePath: "different/module" };
  const conflicted = await previewRepoOwnedInstallConfig(input);
  expect(conflicted).toMatchObject({
    status: "invalid",
    diagnostic: {
      code: "repository_install_ux_compatibility_report_mismatch",
    },
  });
});

describe("repository-owned default module selection", () => {
  test("accepts explicit non-root and root paths only when they are exact manifest keys", () => {
    const document = {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
        defaultModule: "deploy/default",
        modules: {
          ".": { inputs: [] },
          "deploy/default": { inputs: [] },
          "deploy/selected": { inputs: [] },
        },
      },
    } satisfies RepositoryManifestDocument;
    const snapshot = snapshotWithManifest({
      status: "present",
      digest: MANIFEST_DIGEST,
      document,
    });

    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshot,
        modulePath: "deploy/selected",
      }),
    ).toEqual({ ok: true, modulePath: "deploy/selected" });
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshot,
        modulePath: ".",
      }),
    ).toEqual({ ok: true, modulePath: "." });
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshot,
        modulePath: "deploy/undeclared",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_module_missing" },
    });
    for (const alias of ["./deploy/selected", "deploy/selected/", " deploy/selected"]) {
      expect(
        resolveRepoOwnedInstallModulePath({
          sourceSnapshot: snapshot,
          modulePath: alias,
        }),
      ).toMatchObject({
        ok: false,
        diagnostic: { code: "repository_install_ux_module_path_invalid" },
      });
    }
  });

  test("does not grant explicit path authority when the manifest is absent or invalid", () => {
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshotWithManifest({ status: "absent" }),
        modulePath: "deploy/selected",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_default_module_missing" },
    });
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshotWithManifest({
          status: "invalid",
          reason: "invalid_document",
          digest: MANIFEST_DIGEST,
        }),
        modulePath: "deploy/selected",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_document_invalid" },
    });
  });

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

describe("DB-owned deployment profile resolution", () => {
  const profile = (input: {
    readonly id: string;
    readonly key: string;
    readonly modulePath: string;
    readonly recommended: boolean;
  }): InstallConfig =>
    baseConfig({
      id: input.id,
      sourceSelector: { url: source.url, path: "." },
      modulePath: input.modulePath,
      store: {
        source: { url: source.url, path: "." },
        order: 1,
        surface: "service",
        kind: "app",
        provider: "opaque-to-selection",
        suggestedName: "repo-interface",
        badge: { ja: "追加", en: "Install" },
        name: { ja: "App", en: "App" },
        description: { ja: "App", en: "App" },
        deploymentProfile: {
          key: input.key,
          label: { ja: input.key, en: input.key },
          description: { ja: input.key, en: input.key },
          order: 1,
          recommended: input.recommended,
        },
      },
    });

  const profiledSnapshot = snapshotWithManifest({
    status: "present",
    digest: MANIFEST_DIGEST,
    document: {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
        defaultModule: ".",
        modules: {
          ".": { inputs: [] },
          "deploy/managed": { inputs: [] },
          "deploy/byoc": { inputs: [] },
        },
      },
    },
  });

  test("does not resolve source-URL deployment profile keys", () => {
    const managed = profile({
      id: "icfg-managed",
      key: "managed-v1",
      modulePath: "deploy/managed",
      recommended: true,
    });
    const byoc = profile({
      id: "icfg-byoc",
      key: "byoc-v1",
      modulePath: "deploy/byoc",
      recommended: false,
    });

    expect(
      resolveRepoOwnedDeploymentProfile({
        source,
        sourceSnapshot: profiledSnapshot,
        candidates: [managed, byoc],
        deploymentProfileKey: "byoc-v1",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: {
        code: "repository_install_ux_deployment_profile_invalid",
      },
    });
    expect(
      resolveRepoOwnedDeploymentProfile({
        source,
        sourceSnapshot: profiledSnapshot,
        candidates: [managed, { ...byoc, modulePath: "deploy/missing" }],
      }),
    ).toEqual({ ok: true, kind: "none" });
  });

  test("returns no profile for every historical candidate group", () => {
    const managed = profile({
      id: "icfg-managed",
      key: "managed-v1",
      modulePath: "deploy/managed",
      recommended: true,
    });
    const byoc = profile({
      id: "icfg-byoc",
      key: "byoc-v1",
      modulePath: "deploy/byoc",
      recommended: false,
    });
    const legacy = baseConfig({
      id: "icfg-legacy",
      sourceSelector: { url: source.url, path: "." },
      store: { ...managed.store!, deploymentProfile: undefined },
    });

    for (const input of [
      { candidates: [managed, byoc], deploymentProfileKey: undefined },
      {
        candidates: [managed, byoc],
        deploymentProfileKey: "missing-v1",
      },
      {
        candidates: [managed, { ...byoc, store: { ...byoc.store!, deploymentProfile: {
          ...byoc.store!.deploymentProfile!,
          key: "managed-v1",
        } } }],
        deploymentProfileKey: "managed-v1",
      },
      {
        candidates: [managed, { ...byoc, store: { ...byoc.store!, deploymentProfile: {
          ...byoc.store!.deploymentProfile!,
          recommended: true,
        } } }],
        deploymentProfileKey: "managed-v1",
      },
      {
        candidates: [managed, legacy],
        deploymentProfileKey: "managed-v1",
      },
    ]) {
      const result = resolveRepoOwnedDeploymentProfile({
          source,
          sourceSnapshot: profiledSnapshot,
          candidates: input.candidates,
          ...(input.deploymentProfileKey === undefined
            ? {}
            : { deploymentProfileKey: input.deploymentProfileKey }),
        });
      if (input.deploymentProfileKey === undefined) {
        expect(result).toEqual({ ok: true, kind: "none" });
      } else {
        expect(result).toMatchObject({
          ok: false,
          diagnostic: {
            code: "repository_install_ux_deployment_profile_invalid",
          },
        });
      }
    }
  });

  test("does not select an unprofiled Store config either", () => {
    const legacy = baseConfig({
      id: "icfg-legacy",
      sourceSelector: { url: source.url, path: "." },
      store: {
        source: { url: source.url, path: "." },
        order: 1,
        surface: "service",
        kind: "app",
        provider: "legacy",
        suggestedName: "legacy",
        badge: { ja: "追加", en: "Install" },
        name: { ja: "Legacy", en: "Legacy" },
        description: { ja: "Legacy", en: "Legacy" },
      },
    });
    expect(
      resolveRepoOwnedDeploymentProfile({
        source,
        sourceSnapshot: profiledSnapshot,
        candidates: [legacy],
      }),
    ).toEqual({ ok: true, kind: "none" });
  });

  test("ignores scoped, internal, and independently URL-mismatched rows", () => {
    const selected = profile({
      id: "icfg-selected",
      key: "managed-v1",
      modulePath: "deploy/managed",
      recommended: true,
    });
    const candidates = [
      { ...selected, workspaceId: "workspace_other" },
      { ...selected, internal: { reason: "per_install_overrides" as const } },
      {
        ...selected,
        sourceSelector: { url: "https://example.test/other.git", path: "." },
      },
      {
        ...selected,
        store: {
          ...selected.store!,
          source: { url: "https://example.test/other.git", path: "." },
        },
      },
    ];

    expect(
      resolveRepoOwnedDeploymentProfile({
        source,
        sourceSnapshot: profiledSnapshot,
        candidates,
      }),
    ).toEqual({ ok: true, kind: "none" });
    expect(
      resolveRepoOwnedDeploymentProfile({
        source,
        sourceSnapshot: profiledSnapshot,
        candidates,
        deploymentProfileKey: "managed-v1",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_deployment_profile_invalid" },
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
