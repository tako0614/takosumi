import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import { compileRepositoryInstallUx } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";

const document: RepositoryManifestDocument = {
  apiVersion: "takosumi.com/v1",
  kind: "Repository",
  install: {
    modules: {
      ".": {
      inputs: [
        {
          name: "project_name",
          role: "service_name" as const,
          source: { kind: "capsule_name" },
          type: "string",
          label: { ja: "サービス名", en: "Service name" },
        },
        {
          name: "app_url",
          source: { kind: "user" },
          type: "string",
          required: false,
          label: { ja: "公開 URL", en: "Public URL" },
        },
        {
          name: "push_token",
          source: { kind: "user" },
          type: "string",
          required: true,
          secret: true,
          label: { ja: "通知トークン", en: "Push token" },
        },
      ],
      requires: [
        {
          kind: "http.endpoint" as const,
          deliver: { variables: { url: "app_url", subdomain: "project_name" } },
        },
      ],
      features: [
        {
          id: "notification-push",
          optional: true,
          label: { ja: "通知", en: "Notifications" },
          inputs: ["push_token"],
        },
      ],
      },
      "deploy/takoform": {
        inputs: [],
      },
    },
  },
};

function report(
  overrides: Partial<CapsuleCompatibilityReport> = {},
): CapsuleCompatibilityReport {
  return {
    id: "caprep_1",
    sourceId: "src_1",
    sourceSnapshotId: "snap_1",
    modulePath: ".",
    level: "ready",
    findings: [],
    providers: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: ["app_url", "project_name", "push_token"],
    rootModuleVariableDeclarations: [
      { name: "app_url", type: "string", hasDefault: true },
      { name: "project_name", type: "string", hasDefault: false },
      { name: "push_token", type: "string", hasDefault: false },
    ],
    rootModuleOutputs: [],
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function compile(
  overrides: Partial<Parameters<typeof compileRepositoryInstallUx>[0]> = {},
) {
  return compileRepositoryInstallUx({
    document,
    sourceSnapshotId: "snap_1",
    modulePath: ".",
    compatibilityReport: report(),
    capsuleName: "Yuru Commu",
    workspaceId: "workspace_abcdef123456",
    ...overrides,
  });
}

describe("repository install UX compiler", () => {
  test("compiles reviewed generic Accounts OIDC delivery into existing InstallConfig projections", () => {
    const oidcDocument = {
      apiVersion: "takosumi.com/v2.2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [
              {
                name: "public_url",
                source: { kind: "user" },
                type: "string",
                required: true,
                label: { ja: "公開 URL", en: "Public URL" },
              },
              ...[
                "takosumi_accounts_url",
                "takosumi_accounts_issuer_url",
                "takosumi_accounts_client_id",
                "takosumi_accounts_redirect_uri",
              ].map((name) => ({
                name,
                source: { kind: "module_default" as const },
                type: "string" as const,
                label: { ja: name, en: name },
              })),
            ],
            requires: [
              {
                kind: "http.endpoint" as const,
                deliver: { variables: { url: "public_url" } },
              },
              {
                kind: "identity.oidc" as const,
                callbackPath: "/auth/oidc/callback",
                scopes: ["openid", "profile", "email"],
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
    const variableNames = oidcDocument.install.modules["."].inputs.map(
      (input) => input.name,
    );
    const result = compile({
      document: oidcDocument,
      reviewedVariables: { public_url: "https://staging.example.test" },
      compatibilityReport: report({
        rootModuleVariables: variableNames,
        rootModuleVariableDeclarations: variableNames.map((name) => ({
          name,
          type: "string" as const,
          hasDefault: name !== "public_url",
        })),
      }),
      policy: {
        allowedOidcScopes: ["openid", "profile", "email"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.installExperience).toEqual({
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
          callbackPath: "/auth/oidc/callback",
          scopes: ["openid", "profile", "email"],
        },
      ],
      repositoryInstallUx: { status: "accepted" },
    });
  });

  test("rejects generic Accounts OIDC without a same-module public URL delivery", () => {
    const names = [
      "takosumi_accounts_url",
      "takosumi_accounts_issuer_url",
      "takosumi_accounts_client_id",
      "takosumi_accounts_redirect_uri",
    ];
    const result = compile({
      document: {
        apiVersion: "takosumi.com/v2.2",
        kind: "Repository",
        install: {
          modules: {
            ".": {
              inputs: names.map((name) => ({
                name,
                source: { kind: "module_default" as const },
                type: "string" as const,
                label: { ja: name, en: name },
              })),
              requires: [{
                kind: "identity.oidc",
                callbackPath: "/auth/oidc/callback",
                scopes: ["openid"],
                deliver: {
                  variables: {
                    accountsUrl: names[0]!,
                    issuerUrl: names[1]!,
                    clientId: names[2]!,
                    redirectUri: names[3]!,
                  },
                },
              }],
            },
          },
        },
      },
      compatibilityReport: report({
        rootModuleVariables: names,
        rootModuleVariableDeclarations: names.map((name) => ({
          name,
          type: "string",
          hasDefault: true,
        })),
      }),
      policy: { allowedOidcScopes: ["openid"] },
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_requirement_target_invalid" },
    });
  });

  test.each(["identity.oidc", "http.endpoint"] as const)(
    "rejects duplicate %s requirements before generic Accounts OIDC materialization",
    (duplicateKind) => {
      const names = [
        "public_url",
        "takosumi_accounts_url",
        "takosumi_accounts_issuer_url",
        "takosumi_accounts_client_id",
        "takosumi_accounts_redirect_uri",
      ];
      const endpoint = {
        kind: "http.endpoint" as const,
        deliver: { variables: { url: "public_url" } },
      };
      const oidc = {
        kind: "identity.oidc" as const,
        callbackPath: "/auth/oidc/callback",
        scopes: ["openid"],
        deliver: {
          variables: {
            accountsUrl: "takosumi_accounts_url",
            issuerUrl: "takosumi_accounts_issuer_url",
            clientId: "takosumi_accounts_client_id",
            redirectUri: "takosumi_accounts_redirect_uri",
          },
        },
      };
      const requirements = duplicateKind === "identity.oidc"
        ? [endpoint, oidc, oidc]
        : [endpoint, endpoint, oidc];
      const result = compile({
        document: {
          apiVersion: "takosumi.com/v2.2",
          kind: "Repository",
          install: {
            modules: {
              ".": {
                inputs: names.map((name) => ({
                  name,
                  source: { kind: "module_default" as const },
                  type: "string" as const,
                  label: { ja: name, en: name },
                })),
                requires: requirements,
              },
            },
          },
        },
        compatibilityReport: report({
          rootModuleVariables: names,
          rootModuleVariableDeclarations: names.map((name) => ({
            name,
            type: "string",
            hasDefault: true,
          })),
        }),
        policy: { allowedOidcScopes: ["openid"] },
      });

      expect(result).toMatchObject({
        ok: false,
        diagnostic: {
          code: "repository_install_ux_requirement_target_invalid",
        },
      });
    },
  );

  test("compiles the exact module into DB-owned presentation, mappings, projections, and features", () => {
    const result = compile({ reviewedVariables: { app_url: "" } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.compiled.variableMapping).toEqual({
      project_name: "yuru-commu",
      app_url: "",
    });
    expect(
      result.compiled.variablePresentation.map((input) => input.name),
    ).toEqual(["project_name", "app_url", "push_token"]);
    expect(result.compiled.variablePresentation[0]?.defaultValue).toEqual({
      source: "capsule_name",
    });
    expect(result.compiled.installExperience).toEqual({
      projections: [
        { kind: "service_name", variable: "project_name" },
        {
          kind: "public_endpoint",
          variables: { url: "app_url", subdomain: "project_name" },
        },
      ],
      features: [
        {
          id: "notification-push",
          optional: true,
          label: { ja: "通知", en: "Notifications" },
          inputs: ["push_token"],
        },
      ],
      repositoryInstallUx: { status: "accepted" },
    });
    expect(result.compiled.userVariableNames).toEqual([
      "app_url",
      "push_token",
    ]);
  });

  test("compiles a v2.3 sourceBuild proposal into the DB-owned result", () => {
    const sourceBuildDocument = {
      apiVersion: "takosumi.com/v2.3",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
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
    const result = compile({
      document: sourceBuildDocument,
      compatibilityReport: report({
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.sourceBuild).toEqual(
      sourceBuildDocument.install.modules["."].sourceBuild,
    );
  });

  test("rejects a manually constructed sourceBuild on an earlier manifest version", () => {
    const legacyDocument = {
      apiVersion: "takosumi.com/v2.2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            sourceBuild: {
              commands: [{ argv: ["bun", "run", "build"] }],
              outputs: ["dist/index.js"],
            },
          },
        },
      },
    } as unknown as RepositoryManifestDocument;
    const result = compile({
      document: legacyDocument,
      compatibilityReport: report({
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
      }),
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_source_build_version_unsupported" },
    });
  });

  test("rejects binding-delivered repository OIDC materialization", () => {
    const runtimeDocument = {
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            requires: [
              {
                kind: "identity.oidc",
                callbackPath: "/api/auth/callback/takos",
                scopes: ["openid", "profile", "email", "profile"],
                deliver: {
                  bindings: {
                    accountsUrl: "TAKOSUMI_ACCOUNTS_URL",
                    issuerUrl: "OIDC_ISSUER_URL",
                    clientId: "OIDC_CLIENT_ID",
                    redirectUri: "OIDC_REDIRECT_URI",
                  },
                },
              },
            ],
          },
        },
      },
    } satisfies RepositoryManifestDocument;
    const result = compile({
      document: runtimeDocument,
      compatibilityReport: report({
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostic: {
        code: "repository_install_ux_requirement_target_invalid",
      },
    });
  });

  test("compiles a consumed Interface into DB-owned requiredInterfaces", () => {
    const consumedDocument = {
      apiVersion: "takosumi.com/v2.2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            requires: [
              {
                kind: "interface.consume",
                key: "ai",
                interface: { type: "takosumi.ai.gateway", version: "1" },
                permissions: ["ai.chat"],
                delivery: { type: "oauth2" },
              },
            ],
          },
        },
      },
    } satisfies RepositoryManifestDocument;
    const result = compile({
      document: consumedDocument,
      compatibilityReport: report({
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
      }),
      policy: {
        allowedInterfacePermissions: ["ai.chat"],
        allowedInterfaceDeliveryTypes: ["oauth2"],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.requiredInterfaces).toEqual([
      {
        key: "ai",
        interface: { type: "takosumi.ai.gateway", version: "1" },
        permissions: ["ai.chat"],
        delivery: { type: "oauth2" },
      },
    ]);
  });

  test("does not recombine independently allowed Interface permissions and delivery types", () => {
    const document = {
      apiVersion: "takosumi.com/v2.2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            requires: [
              {
                kind: "interface.consume",
                key: "control",
                interface: { type: "mcp.server", version: "2025-11-25" },
                permissions: ["mcp.invoke"],
                delivery: { type: "none" },
              },
            ],
          },
        },
      },
    } satisfies RepositoryManifestDocument;
    const result = compile({
      document,
      compatibilityReport: report({
        rootModuleVariables: [],
        rootModuleVariableDeclarations: [],
      }),
      policy: {
        allowedInterfacePermissions: ["ui.open", "mcp.invoke"],
        allowedInterfaceDeliveryTypes: ["none", "oauth2"],
        allowedInterfaceBindingProfiles: [
          { permissions: ["ui.open"], deliveryType: "none" },
          { permissions: ["mcp.invoke"], deliveryType: "oauth2" },
        ],
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_interface_binding_profile_disallowed",
      );
    }
  });

  test("requires an exact snapshot and module compatibility report", () => {
    const snapshotMismatch = compile({ sourceSnapshotId: "snap_other" });
    expect(snapshotMismatch).toEqual({
      ok: false,
      diagnostic: {
        code: "repository_install_ux_compatibility_report_mismatch",
        message:
          "The compatibility report does not describe the selected source snapshot module.",
      },
    });

    const moduleMismatch = compile({
      modulePath: "deploy/takoform",
      compatibilityReport: report({ modulePath: "." }),
    });
    expect(moduleMismatch).toEqual({
      ok: false,
      diagnostic: {
        code: "repository_install_ux_compatibility_report_mismatch",
        message:
          "The compatibility report does not describe the selected source snapshot module.",
      },
    });
  });

  test("fails closed for legacy reports without type/default metadata", () => {
    const result = compile({
      compatibilityReport: report({
        rootModuleVariableDeclarations: undefined,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe(
      "repository_install_ux_variable_metadata_unavailable",
    );
  });

  test("rejects type and default contradictions", () => {
    const typeMismatch = compile({
      compatibilityReport: report({
        rootModuleVariableDeclarations: [
          { name: "app_url", type: "boolean", hasDefault: true },
          { name: "project_name", type: "string", hasDefault: false },
          { name: "push_token", type: "string", hasDefault: false },
        ],
      }),
    });
    expect(typeMismatch.ok).toBe(false);
    if (!typeMismatch.ok) {
      expect(typeMismatch.diagnostic.code).toBe(
        "repository_install_ux_variable_type_mismatch",
      );
    }

    const defaultMismatch = compile({
      compatibilityReport: report({
        rootModuleVariableDeclarations: [
          { name: "app_url", type: "string", hasDefault: false },
          { name: "project_name", type: "string", hasDefault: false },
          { name: "push_token", type: "string", hasDefault: false },
        ],
      }),
    });
    expect(defaultMismatch.ok).toBe(false);
    if (!defaultMismatch.ok) {
      expect(defaultMismatch.diagnostic.code).toBe(
        "repository_install_ux_variable_default_mismatch",
      );
    }
  });

  test("does not place reviewed secrets in config or diagnostics", () => {
    const secret = "do-not-persist-this-token";
    const result = compile({
      reviewedVariables: { push_token: secret },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostic.code).toBe(
      "repository_install_ux_secret_materialization_required",
    );
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("rejects incomplete OIDC delivery and still validates ordinary targets", () => {
    const oidcDocument: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [
              {
                name: "oidc_issuer",
                source: { kind: "module_default" },
                type: "string",
                label: { ja: "OIDC issuer", en: "OIDC issuer" },
              },
            ],
            requires: [
              {
                kind: "identity.oidc",
                callbackPath: "/api/auth/callback/takos",
                scopes: ["openid", "profile"],
                deliver: { variables: { issuerUrl: "oidc_issuer" } },
              },
            ],
          },
        },
      },
    };
    const oidc = compile({
      document: oidcDocument,
      compatibilityReport: report({
        rootModuleVariables: ["oidc_issuer"],
        rootModuleVariableDeclarations: [
          { name: "oidc_issuer", type: "string", hasDefault: true },
        ],
      }),
    });
    expect(oidc).toMatchObject({
      ok: false,
      diagnostic: { code: "repository_install_ux_requirement_target_invalid" },
    });

    const projection = compile({
      compatibilityReport: report({
        rootModuleVariableDeclarations: [
          { name: "app_url", type: "number", hasDefault: true },
          { name: "project_name", type: "string", hasDefault: false },
          { name: "push_token", type: "string", hasDefault: false },
        ],
      }),
    });
    expect(projection.ok).toBe(false);
    if (!projection.ok) {
      // Input type validation happens before projection validation.
      expect(projection.diagnostic.code).toBe(
        "repository_install_ux_variable_type_mismatch",
      );
    }
  });

  test("enforces operator source/requirement policy and never exposes the plain env map", () => {
    const source = compile({
      policy: {
        allowedSourceKinds: ["user", "module_default"],
      },
    });
    expect(source.ok).toBe(false);
    if (!source.ok) {
      expect(source.diagnostic.code).toBe(
        "repository_install_ux_source_disallowed",
      );
    }

    const requirement = compile({
      policy: {
        allowedRequirementKinds: [],
      },
    });
    expect(requirement.ok).toBe(false);
    if (!requirement.ok) {
      expect(requirement.diagnostic.code).toBe(
        "repository_install_ux_requirement_disallowed",
      );
    }

    const envDocument: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [
              {
                name: "env",
                source: { kind: "user" },
                type: "json",
                label: { ja: "環境", en: "Environment" },
              },
            ],
          },
        },
      },
    };
    const env = compile({
      document: envDocument,
      compatibilityReport: report({
        rootModuleVariables: ["env"],
        rootModuleVariableDeclarations: [
          { name: "env", type: "json", hasDefault: true },
        ],
      }),
    });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.diagnostic.code).toBe(
        "repository_install_ux_plain_env_unsupported",
      );
    }
  });

  test("compiles a generic v2 launcher declaration into existing blueprint and Output shapes", () => {
    const v2Document: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "launcher",
                name: "example.launcher",
                spec: {
                  type: "interface.ui.surface",
                  version: "1",
                  document: {
                    launcher: true,
                    display: { title: "Example", icon: "/icons/example.svg" },
                  },
                  inputs: {
                    url: {
                      source: "output",
                      outputName: "launch_url",
                      outputType: "url",
                    },
                    mode: { source: "literal", value: "web" },
                  },
                  access: { visibility: "workspace" },
                },
                bindingRequests: [
                  {
                    key: "installer",
                    subject: { source: "installing_principal" },
                    permissions: ["ui.open"],
                    delivery: { type: "none" },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const result = compile({
      document: v2Document,
      compatibilityReport: report({
        rootModuleOutputs: [
          { name: "launch_url", sensitive: false, ephemeral: false },
        ],
      }),
      policy: {
        allowedInterfacePermissions: ["ui.open"],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.interfaceBlueprints).toEqual([
      {
        key: "launcher",
        name: "example.launcher",
        spec: {
          type: "interface.ui.surface",
          version: "1",
          document: {
            launcher: true,
            display: { title: "Example", icon: "/icons/example.svg" },
          },
          inputs: {
            mode: { source: "literal", value: "web" },
            url: { source: "capsule_output", outputName: "launch_url" },
          },
          access: { visibility: "workspace" },
        },
        bindings: [
          {
            key: "installer",
            subject: { source: "installing_principal" },
            permissions: ["ui.open"],
            delivery: { type: "none" },
          },
        ],
      },
    ]);
    expect(result.compiled.outputAllowlist).toEqual({
      launch_url: { from: "launch_url", type: "url", required: true },
    });
  });

  test("v2.1 preserves the v2 Interface compiler vocabulary", () => {
    const v2_1: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v2.1",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "status",
                name: "example.status",
                spec: {
                  type: "example.status",
                  version: "1",
                  document: { title: "Status" },
                  access: { visibility: "workspace" },
                },
              },
            ],
          },
        },
      },
    };

    const result = compile({ document: v2_1 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.interfaceBlueprints).toEqual([
      {
        key: "status",
        name: "example.status",
        spec: {
          type: "example.status",
          version: "1",
          document: { title: "Status" },
          access: { visibility: "workspace" },
        },
      },
    ]);
  });

  test("rejects v2 Interface Outputs that are missing or not provably public", () => {
    const v2: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "launcher",
                name: "example.launcher",
                spec: {
                  type: "interface.ui.surface",
                  version: "1",
                  document: { launcher: true },
                  inputs: {
                    url: {
                      source: "output",
                      outputName: "launch_url",
                      outputType: "url",
                    },
                  },
                  access: { visibility: "workspace" },
                },
              },
            ],
          },
        },
      },
    };
    const missing = compile({
      document: v2,
      compatibilityReport: report({ rootModuleOutputs: [] }),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostic.code).toBe(
        "repository_install_ux_interface_output_missing",
      );
    }
    const metadataUnavailable = compile({
      document: v2,
      compatibilityReport: report({ rootModuleOutputs: undefined }),
    });
    expect(metadataUnavailable.ok).toBe(false);
    if (!metadataUnavailable.ok) {
      expect(metadataUnavailable.diagnostic.code).toBe(
        "repository_install_ux_interface_output_metadata_unavailable",
      );
    }
    for (const [field, expected] of [
      ["sensitive", "repository_install_ux_interface_output_sensitive"],
      ["ephemeral", "repository_install_ux_interface_output_ephemeral"],
      ["unknown", "repository_install_ux_interface_output_secrecy_unknown"],
      ["unknown-ephemeral", "repository_install_ux_interface_output_secrecy_unknown"],
    ] as const) {
      const output =
        field === "sensitive"
          ? { name: "launch_url", sensitive: true, ephemeral: false }
          : field === "ephemeral"
            ? { name: "launch_url", sensitive: false, ephemeral: true }
            : field === "unknown-ephemeral"
              ? { name: "launch_url", sensitive: false, ephemeral: null }
              : { name: "launch_url", sensitive: null, ephemeral: false };
      const result = compile({
        document: v2,
        compatibilityReport: report({ rootModuleOutputs: [output] }),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.diagnostic.code).toBe(expected);
    }
  });

  test("rejects duplicate output types, forbidden subjects, and unapproved delivery", () => {
    const base: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "a",
                name: "example.a",
                spec: {
                  type: "example",
                  version: "1",
                  document: {},
                  inputs: {
                    endpoint: {
                      source: "output",
                      outputName: "launch_url",
                      outputType: "url",
                    },
                  },
                  access: { visibility: "workspace" },
                },
                bindingRequests: [
                  {
                    key: "installer",
                    subject: { source: "installing_principal" },
                    permissions: ["ui.open"],
                    delivery: { type: "none" },
                  },
                ],
              },
              {
                key: "b",
                name: "example.b",
                spec: {
                  type: "example",
                  version: "1",
                  document: {},
                  inputs: {
                    endpoint: {
                      source: "output",
                      outputName: "launch_url",
                      outputType: "string",
                    },
                  },
                  access: { visibility: "workspace" },
                },
              },
            ],
          },
        },
      },
    };
    const conflict = compile({
      document: base,
      compatibilityReport: report({
        rootModuleOutputs: [
          { name: "launch_url", sensitive: false, ephemeral: false },
        ],
      }),
      policy: {
        allowedInterfacePermissions: ["ui.open"],
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.diagnostic.code).toBe(
        "repository_install_ux_interface_output_type_conflict",
      );
    }

    const forbidden = structuredClone(base) as RepositoryManifestDocument;
    const request = forbidden.install.modules["."]!.interfaces![0]!
      .bindingRequests![0]!;
    (request as unknown as { subject: unknown }).subject = {
      source: "other_subject",
    };
    const forbiddenResult = compile({
      document: forbidden,
      compatibilityReport: report({
        rootModuleOutputs: [
          { name: "launch_url", sensitive: false, ephemeral: false },
        ],
      }),
      policy: {
        allowedInterfacePermissions: ["ui.open"],
      },
    });
    expect(forbiddenResult.ok).toBe(false);
    if (!forbiddenResult.ok) {
      expect(forbiddenResult.diagnostic.code).toBe(
        "repository_install_ux_interface_binding_invalid",
      );
    }

    const policyResult = compile({
      document: base,
      compatibilityReport: report({
        rootModuleOutputs: [
          { name: "launch_url", sensitive: false, ephemeral: false },
        ],
      }),
      policy: {
        allowedInterfacePermissions: ["ui.open"],
        allowedInterfaceDeliveryTypes: ["oauth2"],
      },
    });
    expect(policyResult.ok).toBe(false);
    if (!policyResult.ok) {
      expect(policyResult.diagnostic.code).toBe(
        "repository_install_ux_interface_delivery_disallowed",
      );
    }
  });

  test("requires an explicit non-empty permission policy for repository bindings", () => {
    const v2: RepositoryManifestDocument = {
      apiVersion: "takosumi.com/v2",
      kind: "Repository",
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "launcher",
                name: "example.launcher",
                spec: {
                  type: "interface.ui.surface",
                  version: "1",
                  document: {},
                  access: { visibility: "workspace" },
                },
                bindingRequests: [
                  {
                    key: "installer",
                    subject: { source: "installing_principal" },
                    permissions: ["ui.open"],
                    delivery: { type: "none" },
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const baseInput = {
      document: v2,
      compatibilityReport: report(),
    };
    for (const policy of [undefined, { allowedInterfacePermissions: [] }]) {
      const result = compile({ ...baseInput, policy });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.code).toBe(
          "repository_install_ux_interface_permission_disallowed",
        );
      }
    }
    const disallowed = compile({
      ...baseInput,
      policy: { allowedInterfacePermissions: ["mcp.invoke"] },
    });
    expect(disallowed.ok).toBe(false);
    if (!disallowed.ok) {
      expect(disallowed.diagnostic.code).toBe(
        "repository_install_ux_interface_permission_disallowed",
      );
    }
    const allowed = compile({
      ...baseInput,
      policy: { allowedInterfacePermissions: ["ui.open"] },
    });
    expect(allowed.ok).toBe(true);
  });

  test("keeps repository Interface access host-owned and bounds one binding", () => {
    const base = {
      apiVersion: "takosumi.com/v2" as const,
      kind: "Repository" as const,
      install: {
        modules: {
          ".": {
            inputs: [],
            interfaces: [
              {
                key: "launcher",
                name: "example.launcher",
                spec: {
                  type: "interface.ui.surface",
                  version: "1",
                  document: {},
                  access: { visibility: "workspace" as const },
                },
                bindingRequests: [
                  {
                    key: "installer",
                    subject: { source: "installing_principal" as const },
                    permissions: ["ui.open"],
                    delivery: { type: "none" },
                  },
                ],
              },
            ],
          },
        },
      },
    } as RepositoryManifestDocument;
    const compileWith = (document: RepositoryManifestDocument) =>
      compile({
        document,
        compatibilityReport: report(),
        policy: { allowedInterfacePermissions: ["ui.open"] },
      });
    const publicAccess = structuredClone(base) as RepositoryManifestDocument;
    (publicAccess.install.modules["."]!.interfaces![0]!.spec.access as {
      visibility: string;
    }).visibility = "public";
    const publicResult = compileWith(publicAccess);
    expect(publicResult.ok).toBe(false);
    if (!publicResult.ok) {
      expect(publicResult.diagnostic.code).toBe(
        "repository_install_ux_interface_access_invalid",
      );
    }

    const policyRef = structuredClone(base) as RepositoryManifestDocument;
    (policyRef.install.modules["."]!.interfaces![0]!.spec.access as {
      policyRef?: string;
    }).policyRef = "host-policy";
    const policyRefResult = compileWith(policyRef);
    expect(policyRefResult.ok).toBe(false);
    if (!policyRefResult.ok) {
      expect(policyRefResult.diagnostic.code).toBe(
        "repository_install_ux_interface_access_invalid",
      );
    }

    const duplicate = structuredClone(base) as RepositoryManifestDocument;
    duplicate.install.modules["."]!.interfaces![0]!.bindingRequests!.push(
      {
        key: "second",
        subject: { source: "installing_principal" },
        permissions: ["ui.open"],
        delivery: { type: "none" },
      },
    );
    const duplicateResult = compileWith(duplicate);
    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) {
      expect(duplicateResult.diagnostic.code).toBe(
        "repository_install_ux_interface_binding_invalid",
      );
    }
  });
});
