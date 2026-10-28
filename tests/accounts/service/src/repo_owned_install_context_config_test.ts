import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  adoptRepoOwnedInstallConfig,
  previewRepoOwnedInstallConfig,
} from "../../../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../../../accounts/service/src/control-operations.ts";
import { mergeInstallContextVariables } from "../../../../core/domains/deploy-control/validation.ts";
import { OpenTofuControllerError } from "../../../../core/domains/deploy-control/errors.ts";

const NOW = "2026-10-28T00:00:00.000Z";
const MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;

const manifest = {
  apiVersion: "takosumi.com/v2.5",
  kind: "Repository",
  install: {
    modules: {
      ".": {
        inputs: [
          {
            name: "workspace_id",
            source: { kind: "workspace_id" },
            type: "string",
            label: { ja: "Workspace ID", en: "Workspace ID" },
          },
          {
            name: "capsule_id",
            source: { kind: "capsule_id" },
            type: "string",
            label: { ja: "Capsule ID", en: "Capsule ID" },
          },
          {
            name: "context",
            source: { kind: "workspace_id" },
            type: "string",
            label: { ja: "Context", en: "Context" },
          },
        ],
      },
    },
  },
} as unknown as RepositoryManifestDocument;

const source: Source = {
  id: "src_context_install",
  workspaceId: "ws_context_install",
  name: "context-install",
  url: "https://git.example.test/context-install.git",
  defaultRef: "main",
  defaultPath: ".",
  status: "active",
  autoSync: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const sourceSnapshot: SourceSnapshot = {
  id: "snap_context_install",
  origin: "git",
  workspaceId: source.workspaceId,
  sourceId: source.id,
  url: source.url,
  ref: source.defaultRef,
  resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
  path: ".",
  archiveRef: "test://context-install.tar.zst",
  archiveDigest: `sha256:${"a".repeat(64)}`,
  archiveSizeBytes: 1,
  repositoryManifest: {
    status: "present",
    digest: MANIFEST_DIGEST,
    document: manifest,
  },
  repositoryModules: {
    status: "ready",
    scopePath: ".",
    modules: [{ path: ".", providerPackages: [], rootProviderRequirements: [] }],
  },
  fetchedByRunId: "run_context_install_sync",
  fetchedAt: NOW,
};

const compatibilityReport: CapsuleCompatibilityReport = {
  id: "caprep_context_install",
  sourceId: source.id,
  sourceSnapshotId: sourceSnapshot.id,
  modulePath: ".",
  level: "ready",
  findings: [],
  providerPackages: [],
  rootProviderRequirements: [],
  resources: [],
  dataSources: [],
  provisioners: [],
  rootModuleVariables: ["workspace_id", "capsule_id", "context"],
  rootModuleVariableDeclarations: [
    { name: "workspace_id", type: "string", hasDefault: false },
    { name: "capsule_id", type: "string", hasDefault: false },
    { name: "context", type: "string", hasDefault: false },
  ],
  rootModuleOutputs: [],
  createdAt: NOW,
};

function baseConfig(overrides: Partial<InstallConfig> = {}): InstallConfig {
  return {
    id: "icfg_context_base",
    name: "context-base",
    variableMapping: {},
    outputAllowlist: {},
    policy: {
      repositoryInstallUx: {
        allowedRequirementKinds: [],
        allowedInterfacePermissions: [],
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function operations(): ControlPlaneOperations {
  const rows = new Map<string, InstallConfig>();
  return {
    capsules: {
      getInstallConfig: async (id: string) => {
        const row = rows.get(id);
        if (!row) throw new OpenTofuControllerError("not_found", "missing");
        return row;
      },
      createInstallConfigIfAbsent: async (row: InstallConfig) => {
        if (rows.has(row.id)) return false;
        rows.set(row.id, row);
        return true;
      },
    },
  } as unknown as ControlPlaneOperations;
}

function input(base: InstallConfig, ops = operations()) {
  return {
    operations: ops,
    source,
    sourceSnapshot,
    baseConfig: base,
    modulePath: ".",
    capsuleName: "context-install",
    workspaceId: source.workspaceId,
    installingPrincipalId: "tsub_context_installer",
    compatibilityReport,
  } as const;
}

describe("repository-owned install context mappings", () => {
  test("persists the accepted value-free map and binds it to preview identity", async () => {
    const ops = operations();
    const base = baseConfig({
      installContextVariableMapping: {
        legacy_workspace: "workspace_id",
      },
    });

    const adopted = await adoptRepoOwnedInstallConfig(input(base, ops));
    expect(adopted.status).toBe("accepted");
    if (adopted.status !== "accepted") return;
    expect(adopted.installContextVariableMapping).toEqual({
      workspace_id: "workspace_id",
      capsule_id: "capsule_id",
      context: "workspace_id",
      legacy_workspace: "workspace_id",
    });
    expect(JSON.stringify(adopted)).not.toContain(source.workspaceId);

    const preview = await previewRepoOwnedInstallConfig(input(base, ops));
    expect(preview.status).toBe("accepted");
    if (preview.status !== "accepted") return;
    expect(preview.installConfig.installContextVariableMapping).toEqual(
      adopted.installContextVariableMapping,
    );
    expect(preview.installConfig.internal?.sourceSnapshotId).toBe(
      sourceSnapshot.id,
    );
    expect(preview.installConfig.internal?.repositoryInstallUxDigest).toBe(
      MANIFEST_DIGEST,
    );
    expect(preview.installConfig.sourceSelector).toEqual({
      url: source.url,
      path: source.defaultPath,
    });
    expect(preview.installConfig.modulePath).toBe(".");
    expect(preview.installConfig.id).toMatch(/^icfg_[a-f0-9]{16}$/u);
    expect(
      JSON.stringify(preview.installConfig.installContextVariableMapping),
    ).not.toContain(source.workspaceId);
    expect(JSON.stringify(preview.installConfig.variableMapping)).not.toContain(
      source.workspaceId,
    );

    // Exercise the persisted map with the existing Run materializer. The same
    // config has no captured identity: each current ledger tuple supplies it.
    for (const context of [
      { workspaceId: "ws_current_first", capsuleId: "cap_current_first" },
      { workspaceId: "ws_current_second", capsuleId: "cap_current_second" },
    ]) {
      expect(mergeInstallContextVariables(
        { ordinary: "preserved", workspace_id: "caller-echo" },
        preview.installConfig.installContextVariableMapping,
        context,
      )).toEqual({
        ordinary: "preserved",
        workspace_id: context.workspaceId,
        capsule_id: context.capsuleId,
        context: context.workspaceId,
        legacy_workspace: context.workspaceId,
      });
    }

    const retry = await previewRepoOwnedInstallConfig(input(base, ops));
    expect(retry.status).toBe("accepted");
    if (retry.status !== "accepted") return;
    expect(retry.installConfig.id).toBe(preview.installConfig.id);

    const changedBaseMap = baseConfig({
      id: base.id,
      installContextVariableMapping: { legacy_capsule: "capsule_id" },
    });
    const changed = await previewRepoOwnedInstallConfig(
      input(changedBaseMap),
    );
    expect(changed.status).toBe("accepted");
    if (changed.status !== "accepted") return;
    expect(changed.installConfig.id).not.toBe(preview.installConfig.id);
  });

  test("keeps an identical proposed assignment idempotent and unrelated entries", async () => {
    const base = baseConfig({
      installContextVariableMapping: {
        workspace_id: "workspace_id",
        unrelated_capsule: "capsule_id",
      },
    });
    const result = await adoptRepoOwnedInstallConfig(input(base));

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.installContextVariableMapping).toEqual({
      workspace_id: "workspace_id",
      capsule_id: "capsule_id",
      context: "workspace_id",
      unrelated_capsule: "capsule_id",
    });
  });

  test("refuses conflicting base context, static, or presentation targets without echoing values", async () => {
    const cases: readonly [string, Partial<InstallConfig>][] = [
      [
        "different exact context source",
        { installContextVariableMapping: { workspace_id: "capsule_id" } },
      ],
      [
        "nested context target",
        { installContextVariableMapping: { "context.child": "capsule_id" } },
      ],
      [
        "static variable target",
        { variableMapping: { workspace_id: "private-static-value" } },
      ],
      [
        "nested static variable target",
        { variableMapping: { "context.child": "private-static-value" } },
      ],
      [
        "editable presentation target",
        {
          variablePresentation: [
            {
              name: "workspace_id",
              type: "string",
              label: { ja: "Editable", en: "Editable" },
            },
          ],
        },
      ],
      [
        "nested editable presentation target",
        {
          variablePresentation: [
            {
              name: "context.child",
              type: "string",
              label: { ja: "Editable child", en: "Editable child" },
            },
          ],
        },
      ],
    ];

    for (const [label, overrides] of cases) {
      const result = await adoptRepoOwnedInstallConfig(
        input(baseConfig(overrides)),
      );
      expect(result.status, label).toBe("invalid");
      if (result.status !== "invalid") continue;
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_context_mapping_conflict",
      );
      expect(JSON.stringify(result)).not.toContain("private-static-value");
    }
  });

  test("refuses retained runtime projection targets that overlap context inputs", async () => {
    const cases: readonly [
      string,
      NonNullable<InstallConfig["installExperience"]>,
    ][] = [
      [
        "service_name exact target",
        { projections: [{ kind: "service_name", variable: "workspace_id" }] },
      ],
      [
        "initial_secret nested target",
        { projections: [{ kind: "initial_secret", variable: "context.child" }] },
      ],
      [
        "public_endpoint exact target",
        { projections: [{ kind: "public_endpoint", variables: { url: "capsule_id" } }] },
      ],
      [
        "artifact nested target",
        { projections: [{ kind: "artifact", variables: { sha256: "context.child" } }] },
      ],
    ];

    for (const [label, installExperience] of cases) {
      const result = await adoptRepoOwnedInstallConfig(
        input(baseConfig({ installExperience })),
      );
      expect(result.status, label).toBe("invalid");
      if (result.status !== "invalid") continue;
      expect(result.diagnostic.code).toBe(
        "repository_install_ux_context_mapping_conflict",
      );
    }
  });

  test("keeps unrelated retained projections and does not reject discarded base OIDC", async () => {
    const installExperience: NonNullable<InstallConfig["installExperience"]> = {
      projections: [
        { kind: "service_name", variable: "operator_service_name" },
        { kind: "initial_secret", variable: "operator_initial_secret" },
        {
          kind: "public_endpoint",
          variables: { subdomain: "operator_subdomain", url: "operator_url" },
        },
        {
          kind: "artifact",
          variables: { url: "artifact_url", sha256: "artifact_sha256" },
        },
        {
          kind: "oidc_client",
          variables: { clientId: "workspace_id" },
          callbackPath: "/auth/callback",
        },
      ],
    };
    const result = await adoptRepoOwnedInstallConfig(
      input(baseConfig({ installExperience })),
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") return;
    expect(result.installExperience?.projections).toEqual(
      installExperience.projections?.filter(
        (projection) => projection.kind !== "oidc_client",
      ),
    );
  });
});
