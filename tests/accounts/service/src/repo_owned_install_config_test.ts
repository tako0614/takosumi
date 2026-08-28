import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type {
  RepositoryModuleRootProviderRequirement,
  Source,
  SourceSnapshot,
} from "takosumi-contract/sources";
import {
  adoptRepoOwnedInstallConfig,
  previewRepoOwnedInstallConfig,
  resolveRepoOwnedInstallModulePath,
  type RepoOwnedInstallConfigAdoptionInput,
} from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { DEFAULT_REPOSITORY_INSTALL_UX_ALLOWED_REQUIREMENT_KINDS } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";
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
  repositoryModules: {
    status: "ready",
    scopePath: ".",
    modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
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

const runtimeProfile = {
  contract: "takosumi.runtime-binding-profile/v2" as const,
  generatedSecrets: [
    { binding: "APP_SESSION_SECRET", bytes: 32 as const, encoding: "hex" as const },
  ],
  oidcClient: {
    issuerBinding: "OIDC_ISSUER_URL",
    clientIdBinding: "OIDC_CLIENT_ID",
    ownerSubjectBinding: "OIDC_OWNER_SUBJECT",
    redirectUriBinding: "OIDC_REDIRECT_URI",
    callbackPath: "/auth/oidc/callback",
    scopes: ["openid", "profile"],
  },
} satisfies NonNullable<InstallConfig["runtimeBindingMaterialization"]>;

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
  const overrideRepositoryPolicy = overrides.policy?.repositoryInstallUx;
  const repositoryInstallUx = {
    allowedRequirementKinds:
      DEFAULT_REPOSITORY_INSTALL_UX_ALLOWED_REQUIREMENT_KINDS,
    ...(overrides.policy === undefined
      ? { allowedInterfacePermissions: ["ui.open", "ui.inspect"] }
      : {}),
    ...overrideRepositoryPolicy,
  };
  return {
    id: "icfg_repo_interface_base",
    name: "repo-interface-base",
    variableMapping: {},
    outputAllowlist: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
    policy: {
      ...overrides.policy,
      repositoryInstallUx,
    },
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

test("invalid optional manifest disables assistance but an explicit host requirement still fails closed", async () => {
  const invalidSnapshot: SourceSnapshot = {
    ...sourceSnapshot,
    repositoryManifest: {
      status: "invalid",
      reason: "invalid_document",
      diagnostic: "never expose parser details",
    },
  };
  const optional = await adopt(baseConfig(), {
    sourceSnapshot: invalidSnapshot,
  });
  expect(optional).toEqual({ status: "absent" });

  const required = await adopt(
    baseConfig({
      policy: {
        repositoryInstallUx: {
          requiredManifestApiVersion: "takosumi.com/v2.2",
        },
      },
    }),
    { sourceSnapshot: invalidSnapshot },
  );
  expect(required).toMatchObject({
    status: "invalid",
    diagnostic: {
      code: "repository_install_ux_manifest_api_version_required",
    },
  });
  expect(JSON.stringify(required)).not.toContain("never expose parser details");
});

function snapshotWithManifest(
  repositoryManifest: SourceSnapshot["repositoryManifest"],
  repositoryModules: SourceSnapshot["repositoryModules"] =
    sourceSnapshot.repositoryModules,
): SourceSnapshot {
  return { ...sourceSnapshot, repositoryManifest, repositoryModules };
}

function repositoryModules(
  paths: readonly string[],
  rootProviderRequirements: readonly RepositoryModuleRootProviderRequirement[] = [],
): NonNullable<SourceSnapshot["repositoryModules"]> {
  return {
    status: "ready",
    scopePath: ".",
    modules: paths.map((path) => ({
      path,
      providerPackages: [
        ...new Map(
          rootProviderRequirements.map((requirement) => [
            requirement.source,
            {
              source: requirement.source,
              ...(requirement.version !== undefined
                ? { version: requirement.version }
                : {}),
            },
          ]),
        ).values(),
      ],
      rootProviderRequirements,
    })),
  };
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

test("repository runtime profile is carried into the deterministic preview", async () => {
  const runtimeDocument = {
    apiVersion: "takosumi.com/v2.4",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: [],
          requires: [
            {
              kind: "secret.generated" as const,
              bytes: 32,
              encoding: "hex" as const,
              deliver: { bindings: { value: "APP_SESSION_SECRET" } },
            },
            {
              kind: "identity.oidc" as const,
              callbackPath: "/auth/oidc/callback",
              scopes: ["openid", "profile"],
              deliver: {
                bindings: {
                  issuerUrl: "OIDC_ISSUER_URL",
                  clientId: "OIDC_CLIENT_ID",
                  ownerSubject: "OIDC_OWNER_SUBJECT",
                  redirectUri: "OIDC_REDIRECT_URI",
                },
              },
            },
          ],
        },
      },
    },
  } satisfies RepositoryManifestDocument;
  const runtimeSnapshot = snapshotWithManifest({
    status: "present",
    digest: MANIFEST_DIGEST,
    document: runtimeDocument,
  });
  const base = baseConfig({
    id: "cfg_runtime_profile_base",
    policy: {
      repositoryInstallUx: {
        allowedRequirementKinds: ["secret.generated", "identity.oidc"],
        allowedInterfacePermissions: [],
        allowedOidcScopes: ["openid", "profile"],
      },
    },
  });
  const input = {
    operations: {
      capsules: {
        getInstallConfig: async () => {
          throw new OpenTofuControllerError("not_found", "missing");
        },
        putInstallConfig: async (config: InstallConfig) => config,
      },
    } as unknown as ControlPlaneOperations,
    source,
    sourceSnapshot: runtimeSnapshot,
    baseConfig: base,
    modulePath: ".",
    capsuleName: "runtime-profile",
    workspaceId: source.workspaceId,
    installingPrincipalId: "tsub_runtime_profile",
    compatibilityReport,
  } as const;

  const adopted = await adoptRepoOwnedInstallConfig(input);
  expect(adopted.status).toBe("accepted");
  if (adopted.status !== "accepted") return;
  expect(adopted.runtimeBindingMaterialization).toEqual(runtimeProfile);

  const preview = await previewRepoOwnedInstallConfig(input);
  expect(preview.status).toBe("accepted");
  if (preview.status !== "accepted") return;
  expect(preview.installConfig.runtimeBindingMaterialization).toEqual(
    runtimeProfile,
  );
});

test("repository runtime profile collisions fail closed and absent proposals preserve base", async () => {
  const base = baseConfig({ runtimeBindingMaterialization: runtimeProfile });
  const absent = await adopt(base);
  expect(absent.status).toBe("accepted");
  if (absent.status !== "accepted") return;
  expect(absent.runtimeBindingMaterialization).toEqual(runtimeProfile);

  const conflicting = await adopt(
    baseConfig({
      runtimeBindingMaterialization: {
        ...runtimeProfile,
        generatedSecrets: [
          { binding: "OTHER_SECRET", bytes: 32, encoding: "hex" },
        ],
      },
      policy: {
        repositoryInstallUx: {
          allowedRequirementKinds: ["secret.generated", "identity.oidc"],
          allowedInterfacePermissions: [],
          allowedOidcScopes: ["openid", "profile"],
        },
      },
    }),
    {
      sourceSnapshot: snapshotWithManifest({
        status: "present",
        digest: MANIFEST_DIGEST,
        document: {
          apiVersion: "takosumi.com/v2.4",
          kind: "Repository",
          install: {
            modules: {
              ".": {
                inputs: [],
                requires: [
                  {
                    kind: "secret.generated" as const,
                    bytes: 32,
                    encoding: "hex" as const,
                    deliver: { bindings: { value: "APP_SESSION_SECRET" } },
                  },
                ],
              },
            },
          },
        } satisfies RepositoryManifestDocument,
      }),
    },
  );
  expect(conflicting).toMatchObject({
    status: "invalid",
    diagnostic: {
      code: "repository_install_ux_runtime_binding_profile_conflict",
    },
  });
});

describe("repository-owned source module selection", () => {
  test("accepts explicit paths only when they are exact scanned candidates", async () => {
    const document = {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
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
    }, repositoryModules([
      ".",
      "deploy/default",
      "deploy/selected",
    ]));

    const rootProviderRequirements = [
      {
        source: "registry.terraform.io/cloudflare/cloudflare",
        moduleLocalName: "cloudflare",
        childAlias: "primary",
        version: "4.0.0",
      },
    ] as const;
    const providerSnapshot = snapshotWithManifest(
      {
        status: "present",
        digest: MANIFEST_DIGEST,
        document,
      },
      repositoryModules(["deploy/selected"], rootProviderRequirements),
    );

    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: providerSnapshot,
        modulePath: "deploy/selected",
      }),
    ).toEqual({
      ok: true,
      modulePath: "deploy/selected",
      rootProviderRequirements,
    });
    const adopted = await adopt(baseConfig(), {
      sourceSnapshot: providerSnapshot,
      modulePath: "deploy/selected",
      compatibilityReport: reportForModule("deploy/selected"),
    });
    expect(adopted.status).toBe("accepted");
    if (adopted.status === "accepted") {
      expect(adopted.rootProviderRequirements).toEqual(rootProviderRequirements);
    }
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshot,
        modulePath: ".",
      }),
    ).toEqual({ ok: true, modulePath: ".", rootProviderRequirements: [] });
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

  test("fails closed when the source module index is missing or invalid", () => {
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: {
          ...sourceSnapshot,
          repositoryManifest: { status: "absent" },
          repositoryModules: undefined,
        },
        modulePath: "deploy/selected",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_module_index_unavailable" },
    });
    expect(
      resolveRepoOwnedInstallModulePath({
        sourceSnapshot: snapshotWithManifest(
          { status: "absent" },
          {
            status: "invalid",
            scopePath: ".",
            reason: "scan_failed",
          },
        ),
        modulePath: "deploy/selected",
      }),
    ).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_module_index_unavailable" },
    });
  });

  test("infers the only scanned module without consulting Source or base InstallConfig paths", async () => {
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
      }, repositoryModules(["deploy/only"])),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/only"),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe("deploy/only");
  });

  test("fails closed for multiple scanned modules and ignores the base InstallConfig path", async () => {
    const document = {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
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
      }, repositoryModules([".", "deploy/selected"])),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/selected"),
    });

    expect(result).toMatchObject({
      status: "invalid",
      diagnostic: { code: "repository_install_module_selection_required" },
    });
  });

  test("accepts an explicit candidate when multiple modules are discovered", async () => {
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
      }, repositoryModules(["deploy/first", "deploy/second"])),
      modulePath: "deploy/first",
      compatibilityReport: reportForModule("deploy/first"),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe("deploy/first");
  });

  test("does not let the legacy defaultModule hint override the scanned explicit selection", async () => {
    const sourceBuild = {
      commands: [{ argv: ["bun", "scripts/prepare.ts"] }],
      outputs: ["deploy/selected/.generated/migrations"],
    } as const;
    const document = {
      apiVersion: "takosumi.com/v2.3",
      kind: "Repository",
      install: {
        defaultModule: ".",
        modules: {
          ".": { inputs: [] },
          "deploy/selected": { inputs: [], sourceBuild },
        },
      },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig({ modulePath: "." }), {
      sourceSnapshot: snapshotWithManifest(
        {
          status: "present",
          digest: MANIFEST_DIGEST,
          document,
        },
        repositoryModules([".", "deploy/selected"]),
      ),
      modulePath: "deploy/selected",
      compatibilityReport: reportForModule("deploy/selected"),
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe("deploy/selected");
    expect(result.sourceBuild).toEqual(sourceBuild);
  });

  test("requires an explicit selection when a legacy defaultModule hint accompanies multiple scanned modules", async () => {
    const document = {
      apiVersion: "takosumi.com/v2.3",
      kind: "Repository",
      install: {
        defaultModule: ".",
        modules: {
          ".": { inputs: [] },
          "deploy/selected": { inputs: [] },
        },
      },
    } satisfies RepositoryManifestDocument;

    const result = await adopt(baseConfig({ modulePath: "." }), {
      sourceSnapshot: snapshotWithManifest(
        {
          status: "present",
          digest: MANIFEST_DIGEST,
          document,
        },
        repositoryModules([".", "deploy/selected"]),
      ),
      modulePath: undefined,
      compatibilityReport: reportForModule("deploy/selected"),
    });

    expect(result).toMatchObject({
      status: "invalid",
      diagnostic: { code: "repository_install_module_selection_required" },
    });
  });

  test("maps nested Source paths only for manifest assistance while keeping execution relative", async () => {
    const nestedSnapshot: SourceSnapshot = {
      ...sourceSnapshot,
      path: "infra",
      repositoryManifest: {
        status: "present",
        digest: MANIFEST_DIGEST,
        document: {
          apiVersion: "takosumi.com/v2",
          kind: "Repository",
          install: {
            modules: {
              infra: { inputs: [] },
            },
          },
        },
      },
      repositoryModules: {
      status: "ready",
      scopePath: "infra",
        modules: [
          { path: ".", providerPackages: [], rootProviderRequirements: [] },
        ],
      },
    };

    const result = await adopt(baseConfig(), {
      sourceSnapshot: nestedSnapshot,
      modulePath: ".",
      compatibilityReport: {
        ...compatibilityReport,
        sourceSnapshotId: nestedSnapshot.id,
        modulePath: ".",
      },
    });

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.modulePath).toBe(".");
  });
});

describe("repository-owned sourceBuild adoption", () => {
  const sourceBuildDocument = {
    ...repositoryDocument,
    apiVersion: "takosumi.com/v2.3",
    install: {
      ...repositoryDocument.install,
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
      install: { ...repositoryDocument.install },
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
