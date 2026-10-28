import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type {
  RepositoryManifestDocument,
  RepositoryRuntimeRequirement,
} from "takosumi-contract/repository-manifest";
import { compileRepositoryInstallUx } from "../../../../core/domains/capsules/repository_install_ux_compiler.ts";

const label = { ja: "Workspace ID", en: "Workspace ID" };

function compileContextInput(options: {
  version?: string;
  input?: Record<string, unknown>;
  extraInputs?: readonly Record<string, unknown>[];
  scannerType?: "string" | "number" | "boolean" | "json" | "unknown";
  scannerName?: string;
  reviewedVariables?: Readonly<Record<string, string>>;
  allowedSourceKinds?: readonly ("user" | "workspace_id" | "capsule_id")[];
  allowedRequirementKinds?: readonly RepositoryRuntimeRequirement["kind"][];
  allowedOidcScopes?: readonly string[];
  requires?: readonly unknown[];
  features?: readonly unknown[];
  interfaces?: readonly unknown[];
  sourceBuild?: unknown;
}) {
  const input = options.input ?? {
    name: "owner_workspace_id",
    source: { kind: "workspace_id" },
    type: "string",
    label,
  };
  const document = {
    apiVersion: options.version ?? "takosumi.com/v2.5",
    kind: "Repository",
    install: {
      modules: {
        ".": {
          inputs: [input, ...(options.extraInputs ?? [])],
          ...(options.requires ? { requires: options.requires } : {}),
          ...(options.features ? { features: options.features } : {}),
          ...(options.interfaces ? { interfaces: options.interfaces } : {}),
          ...(options.sourceBuild ? { sourceBuild: options.sourceBuild } : {}),
        },
      },
    },
  } as unknown as RepositoryManifestDocument;
  const compatibilityReport: CapsuleCompatibilityReport = {
    id: "caprep_context",
    sourceId: "src_context",
    sourceSnapshotId: "snap_context",
    modulePath: ".",
    level: "ready",
    findings: [],
    providerPackages: [],
    rootProviderRequirements: [],
    resources: [],
    dataSources: [],
    provisioners: [],
    rootModuleVariables: [options.scannerName ?? "owner_workspace_id"],
    rootModuleVariableDeclarations: [
      {
        name: options.scannerName ?? "owner_workspace_id",
        type: options.scannerType ?? "string",
        hasDefault: false,
      },
    ],
    rootModuleOutputs: [],
    createdAt: "2026-10-28T00:00:00.000Z",
  };
  return compileRepositoryInstallUx({
    document,
    sourceSnapshotId: "snap_context",
    modulePath: ".",
    compatibilityReport,
    capsuleName: "Sample",
    workspaceId: "workspace_current",
    ...(options.reviewedVariables
      ? { reviewedVariables: options.reviewedVariables }
      : {}),
    ...(options.allowedSourceKinds || options.allowedRequirementKinds || options.allowedOidcScopes
      ? {
          policy: {
            ...(options.allowedSourceKinds
              ? { allowedSourceKinds: options.allowedSourceKinds }
              : {}),
            ...(options.allowedRequirementKinds
              ? { allowedRequirementKinds: options.allowedRequirementKinds }
              : {}),
            ...(options.allowedOidcScopes
              ? { allowedOidcScopes: options.allowedOidcScopes }
              : {}),
          },
        }
      : {}),
  });
}

describe("repository context input compilation", () => {
  test("v2.5 compiles a current-context selector without an ID value or editable field", () => {
    const result = compileContextInput({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.installContextVariableMapping).toEqual({
      owner_workspace_id: "workspace_id",
    });
    expect(result.compiled.variableMapping).toEqual({});
    expect(result.compiled.variablePresentation).toEqual([]);
    expect(result.compiled.userVariableNames).toEqual([]);
    expect(JSON.stringify(result.compiled)).not.toContain("workspace_current");
  });

  test("capsule_id uses the same value-free mapping", () => {
    const result = compileContextInput({
      input: {
        name: "owner_workspace_id",
        source: { kind: "capsule_id" },
        label,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.installContextVariableMapping).toEqual({
      owner_workspace_id: "capsule_id",
    });
    expect(result.compiled.variableMapping).toEqual({});
  });

  test("v2.5 refuses a fabricated workspace-scoped capsule name source", () => {
    const result = compileContextInput({
      input: {
        name: "owner_workspace_id",
        source: { kind: "workspace_scoped_capsule_name" },
        type: "string",
        label,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_context_input_invalid",
      );
    }
  });

  test("v2.4 keeps the prior workspace-scoped capsule name source", () => {
    const result = compileContextInput({
      version: "takosumi.com/v2.4",
      input: {
        name: "owner_workspace_id",
        source: { kind: "workspace_scoped_capsule_name" },
        type: "string",
        label,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.compiled.variableMapping.owner_workspace_id).toBe("string");
    expect(result.compiled.installContextVariableMapping).toBeUndefined();
  });

  test.each(["__proto__", "constructor", "prototype"])(
    "typed v2.5 context input refuses reserved root name %s",
    (name) => {
      const document: RepositoryManifestDocument = {
        apiVersion: "takosumi.com/v2.5",
        kind: "Repository",
        install: {
          modules: {
            ".": {
              inputs: [
                {
                  name,
                  source: { kind: "workspace_id" },
                  type: "string",
                  label,
                },
              ],
            },
          },
        },
      };
      const compatibilityReport: CapsuleCompatibilityReport = {
        id: "caprep_reserved",
        sourceId: "src_reserved",
        sourceSnapshotId: "snap_reserved",
        modulePath: ".",
        level: "ready",
        findings: [],
        providerPackages: [],
    rootProviderRequirements: [],
        resources: [],
        dataSources: [],
        provisioners: [],
        rootModuleVariables: [name],
        rootModuleVariableDeclarations: [
          { name, type: "string", hasDefault: false },
        ],
        rootModuleOutputs: [],
        createdAt: "2026-10-28T00:00:00.000Z",
      };
      const result = compileRepositoryInstallUx({
        document,
        sourceSnapshotId: "snap_reserved",
        modulePath: ".",
        compatibilityReport,
        capsuleName: "Sample",
        workspaceId: "workspace_current",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.code).toBe(
          "repository_install_ux_context_input_invalid",
        );
      }
    },
  );

  test.each(
    ["takosumi.com/v1", "takosumi.com/v2", "takosumi.com/v2.1", "takosumi.com/v2.2", "takosumi.com/v2.3", "takosumi.com/v2.4"].flatMap(
      (version) => (["workspace_id", "capsule_id"] as const).map((kind) => ({ version, kind })),
    ),
  )(
    "$version refuses a fabricated $kind even with an explicit source ceiling",
    ({ version, kind }) => {
      const result = compileContextInput({
        version,
        input: {
          name: "owner_workspace_id",
          source: { kind },
          type: "string",
          label,
        },
        allowedSourceKinds: [kind],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.code).toBe(
          "repository_install_ux_context_input_invalid",
        );
      }
    },
  );

  test.each(["unknown", "number", "boolean", "json"] as const)(
    "scanner %s cannot establish an exact string target",
    (scannerType) => {
      const result = compileContextInput({ scannerType });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.diagnostic.code).toBe(
          "repository_install_ux_context_input_invalid",
        );
      }
    },
  );

  test.each(["missing", "env", "env.APP_WORKSPACE_ID"])(
    "target %s cannot be a context root variable",
    (name) => {
      const result = compileContextInput({
        input: {
          name,
          source: { kind: "workspace_id" },
          label,
        },
      });
      expect(result.ok).toBe(false);
    },
  );

  test.each([
    { secret: true },
    { role: "service_name" },
    { role: "initial_secret" },
    { required: true },
    { format: "uuid" },
    { placeholder: "ID" },
    { advanced: true },
    { helper: label },
    { type: "number" },
  ])("current-context input rejects editable or authority knob %p", (knob) => {
    const result = compileContextInput({
      input: {
        name: "owner_workspace_id",
        source: { kind: "workspace_id" },
        label,
        ...knob,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_context_input_invalid",
      );
    }
  });

  test("reviewed values and features cannot claim a context input", () => {
    const reviewed = compileContextInput({
      reviewedVariables: { owner_workspace_id: "workspace_forged" },
    });
    expect(reviewed.ok).toBe(false);
    if (!reviewed.ok) {
      expect(reviewed.diagnostic.code).toBe(
        "repository_install_ux_variable_value_unsupported",
      );
    }
    const feature = compileContextInput({
      features: [
        {
          id: "owner",
          optional: true,
          label,
          inputs: ["owner_workspace_id"],
        },
      ],
    });
    expect(feature.ok).toBe(false);
    if (!feature.ok) {
      expect(feature.diagnostic.code).toBe(
        "repository_install_ux_feature_input_invalid",
      );
    }
  });

  test("a fabricated duplicate user input cannot make a context ID editable", () => {
    const result = compileContextInput({
      extraInputs: [
        {
          name: "owner_workspace_id",
          source: { kind: "user" },
          type: "string",
          label,
        },
      ],
      reviewedVariables: { owner_workspace_id: "workspace_forged" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_context_input_invalid",
      );
    }
  });

  test("explicit source ceiling and variable delivery cannot claim context input", () => {
    const denied = compileContextInput({ allowedSourceKinds: ["user"] });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.diagnostic.code).toBe(
        "repository_install_ux_source_disallowed",
      );
    }
    const delivered = compileContextInput({
      requires: [
        {
          kind: "http.endpoint",
          deliver: { variables: { url: "owner_workspace_id" } },
        },
      ],
      allowedRequirementKinds: ["http.endpoint"],
    });
    expect(delivered.ok).toBe(false);
    if (!delivered.ok) {
      expect(delivered.diagnostic.code).toBe(
        "repository_install_ux_context_input_invalid",
      );
    }
  });

  test("v2.5 retains sourceBuild and the exact v2.4 private runtime binding profile", () => {
    const sourceBuild = {
      commands: [{ argv: ["bun", "run", "build"] }],
      outputs: ["dist/index.js"],
    };
    const result = compileContextInput({
      sourceBuild,
      allowedRequirementKinds: ["secret.generated", "identity.oidc"],
      allowedOidcScopes: ["openid"],
      requires: [
        {
          kind: "secret.generated",
          bytes: 32,
          encoding: "hex",
          deliver: { bindings: { value: "APP_SESSION_SECRET" } },
        },
        {
          kind: "identity.oidc",
          callbackPath: "/callback",
          scopes: ["openid"],
          deliver: {
            bindings: {
              issuerUrl: "OIDC_ISSUER",
              clientId: "OIDC_CLIENT",
              ownerSubject: "OIDC_OWNER",
              redirectUri: "OIDC_REDIRECT",
            },
          },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.sourceBuild).toEqual(sourceBuild);
    expect(result.compiled.runtimeBindingMaterialization).toEqual({
      contract: "takosumi.runtime-binding-profile/v2",
      generatedSecrets: [
        { binding: "APP_SESSION_SECRET", bytes: 32, encoding: "hex" },
      ],
      oidcClient: {
        issuerBinding: "OIDC_ISSUER",
        clientIdBinding: "OIDC_CLIENT",
        ownerSubjectBinding: "OIDC_OWNER",
        redirectUriBinding: "OIDC_REDIRECT",
        callbackPath: "/callback",
        scopes: ["openid"],
      },
    });
  });

  test("v2.5 retains the existing Interface proposal compiler", () => {
    const result = compileContextInput({
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
    });
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
});
