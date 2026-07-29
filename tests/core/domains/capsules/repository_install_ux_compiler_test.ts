import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { RepositoryInstallUxDocument } from "takosumi-contract/install-ux";
import { compileRepositoryInstallUx } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";

const document: RepositoryInstallUxDocument = {
  schemaVersion: "takosumi.install-ux/v1",
  modules: {
    ".": {
      inputs: [
        {
          name: "project_name",
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
          name: "oidc_issuer",
          source: { kind: "module_default" },
          type: "string",
          label: { ja: "OIDC issuer", en: "OIDC issuer" },
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
      installExperience: {
        projections: [
          { kind: "service_name", variable: "project_name" },
          {
            kind: "public_endpoint",
            variables: { url: "app_url", subdomain: "project_name" },
          },
          {
            kind: "oidc_client",
            variables: { issuerUrl: "oidc_issuer" },
            callbackPath: "/api/auth/callback/takos",
            scopes: ["openid", "profile", "email"],
          },
        ],
      },
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
    rootModuleVariables: [
      "app_url",
      "oidc_issuer",
      "project_name",
      "push_token",
    ],
    rootModuleVariableDeclarations: [
      { name: "app_url", type: "string", hasDefault: true },
      { name: "oidc_issuer", type: "string", hasDefault: true },
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
    policy: {
      allowedOidcScopes: ["openid", "profile", "email", "offline_access"],
    },
    ...overrides,
  });
}

describe("repository install UX compiler", () => {
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
      projections: document.modules["."]!.installExperience!.projections,
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
          { name: "oidc_issuer", type: "string", hasDefault: true },
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
          { name: "app_url", type: "string", hasDefault: true },
          { name: "oidc_issuer", type: "string", hasDefault: false },
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

  test("enforces OIDC scope and projection variable policy", () => {
    const scope = compile({
      policy: { allowedOidcScopes: ["openid", "profile"] },
    });
    expect(scope.ok).toBe(false);
    if (!scope.ok) {
      expect(scope.diagnostic.code).toBe(
        "repository_install_ux_oidc_scope_disallowed",
      );
    }

    const projection = compile({
      compatibilityReport: report({
        rootModuleVariableDeclarations: [
          { name: "app_url", type: "number", hasDefault: true },
          { name: "oidc_issuer", type: "string", hasDefault: true },
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

  test("enforces operator source/projection policy and never exposes the plain env map", () => {
    const source = compile({
      policy: {
        allowedSourceKinds: ["user", "module_default"],
        allowedOidcScopes: ["openid", "profile", "email"],
      },
    });
    expect(source.ok).toBe(false);
    if (!source.ok) {
      expect(source.diagnostic.code).toBe(
        "repository_install_ux_source_disallowed",
      );
    }

    const projection = compile({
      policy: {
        allowedProjectionKinds: ["service_name"],
        allowedOidcScopes: ["openid", "profile", "email"],
      },
    });
    expect(projection.ok).toBe(false);
    if (!projection.ok) {
      expect(projection.diagnostic.code).toBe(
        "repository_install_ux_projection_disallowed",
      );
    }

    const envDocument: RepositoryInstallUxDocument = {
      schemaVersion: "takosumi.install-ux/v1",
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
});
