import { describe, expect, test } from "bun:test";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import {
  parseRepositoryManifestText,
  type RepositoryManifestDocument,
} from "takosumi-contract/repository-manifest";
import type { InstallConfig } from "takosumi-contract/install-configs";
import { compileRepositoryInstallUx } from "../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { uniqueStoreInstallConfigForSource } from "../../../dashboard/src/views/new/install-helpers.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../../deploy/reference-app-install-configs.ts";

const SOURCE_URL = "https://github.com/tako0614/yurucommu.git";
const MODULE_PATH = "deploy/takoform";
const SNAPSHOT_ID = "snapshot_yurucommu_managed_cutover";
const NOW = "2026-07-29T00:00:00.000Z";

const MANAGED_INPUTS = [
  {
    name: "project_name",
    source: { kind: "capsule_name" as const },
    role: "service_name" as const,
    type: "string" as const,
    format: "subdomain" as const,
    label: { ja: "サービス名", en: "Service name" },
    helper: {
      ja: "ワークスペース内で使うYurucommuの名前です。",
      en: "The name of this Yurucommu service in the workspace.",
    },
    advanced: true,
  },
  {
    name: "worker_release_tag",
    source: { kind: "module_default" as const },
    type: "string" as const,
    label: { ja: "リリース", en: "Release" },
    advanced: true,
  },
  {
    name: "worker_bundle_url",
    source: { kind: "module_default" as const },
    type: "string" as const,
    format: "url" as const,
    label: { ja: "リリースURL", en: "Release URL" },
    advanced: true,
  },
  {
    name: "worker_bundle_sha256",
    source: { kind: "module_default" as const },
    type: "string" as const,
    label: { ja: "リリースSHA-256", en: "Release SHA-256" },
    advanced: true,
  },
] as const;

function managedCompatibilityReport(): CapsuleCompatibilityReport {
  return {
    id: "compat_yurucommu_managed_cutover",
    sourceId: "source_yurucommu_managed_cutover",
    sourceSnapshotId: SNAPSHOT_ID,
    modulePath: MODULE_PATH,
    level: "ready",
    findings: [],
    providers: ["registry.terraform.io/tako0614/takoform"],
    resources: [
      "takoform_edge_worker.worker",
      "takoform_relational_database.database",
      "takoform_object_bucket.media",
      "takoform_key_value_store.kv",
      "takoform_queue.delivery",
      "takoform_queue.delivery_dlq",
      "takoform_schedule.retention",
    ],
    dataSources: ["takoform_interface.worker_http"],
    provisioners: [],
    rootModuleVariables: MANAGED_INPUTS.map((input) => input.name),
    rootModuleVariableDeclarations: MANAGED_INPUTS.map((input) => ({
      name: input.name,
      type: input.type,
      hasDefault: true,
    })),
    rootModuleOutputs: [
      "worker_name",
      "launch_url",
      "api_url",
      "takoform_resource_ids",
    ],
    createdAt: NOW,
  };
}

function managedInstallUx(): RepositoryManifestDocument {
  return {
    apiVersion: "takosumi.com/v1",
    kind: "Repository",
    install: {
      modules: {
        [MODULE_PATH]: {
          inputs: MANAGED_INPUTS,
        },
      },
    },
  };
}

function managedInstallConfig(): InstallConfig {
  const compiled = compileRepositoryInstallUx({
    document: managedInstallUx(),
    sourceSnapshotId: SNAPSHOT_ID,
    modulePath: MODULE_PATH,
    compatibilityReport: managedCompatibilityReport(),
    capsuleName: "Yurucommu",
    workspaceId: "workspace_yurucommu_managed_cutover",
  });
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) {
    throw new Error(compiled.diagnostic.message);
  }
  return {
    id: "config_yurucommu_managed_cutover",
    name: "yurucommu-managed",
    sourceResourceKind: "generic_capsule",
    installType: "opentofu_module",
    sourceSelector: { url: SOURCE_URL, path: "." },
    modulePath: MODULE_PATH,
    variableMapping: compiled.compiled.variableMapping,
    variablePresentation: compiled.compiled.variablePresentation,
    userVariableNames: compiled.compiled.userVariableNames,
    installExperience: compiled.compiled.installExperience,
    requiredProviders: ["registry.terraform.io/tako0614/takoform"],
    outputAllowlist: {},
    policy: {},
    store: {
      surface: "app",
      kind: "application",
      badge: { ja: "SNS", en: "Social" },
      name: { ja: "Yurucommu", en: "Yurucommu" },
      description: {
        ja: "コミュニティ向けSNS",
        en: "A community social network",
      },
      source: { url: SOURCE_URL, path: "." },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Yurucommu managed Store cutover contract", () => {
  test("normal Store selection resolves only the URL-eligible managed module InstallConfig", () => {
    const managed = managedInstallConfig();
    const { store: _directStore, ...direct } = {
      ...managed,
      id: "config_yurucommu_direct",
      name: "yurucommu-direct",
      sourceSelector: { url: SOURCE_URL, path: "." },
      modulePath: ".",
    };

    expect(
      uniqueStoreInstallConfigForSource([direct], SOURCE_URL, "."),
    ).toBeNull();
    expect(
      uniqueStoreInstallConfigForSource(
        [direct, managed],
        SOURCE_URL,
        MODULE_PATH,
      )?.id,
    ).toBe(managed.id);
    expect(
      uniqueStoreInstallConfigForSource([direct, managed], SOURCE_URL, ".")?.id,
    ).toBe(managed.id);
    expect(managed.sourceSelector).toEqual({
      url: SOURCE_URL,
      path: ".",
    });
    expect(managed.store?.source).toEqual({
      url: SOURCE_URL,
      path: ".",
    });
    expect(managed.modulePath).toBe(MODULE_PATH);
    expect(managed.variableMapping).toEqual({ project_name: "yurucommu" });
    expect(managed.outputAllowlist).toEqual({});
    expect(managed.resourceInterfaceBindingProposals).toBeUndefined();
    expect(managed.interfaceBlueprints).toBeUndefined();
  });

  test("production discovery selects the managed module while retaining the direct Git module", async () => {
    const selectableYurucommu = REFERENCE_APP_INSTALL_CONFIGS.filter(
      (config) => config.store?.source?.url === SOURCE_URL,
    );
    expect(selectableYurucommu).toHaveLength(1);
    const managed = selectableYurucommu[0]!;
    expect(managed.modulePath).toBe(MODULE_PATH);
    expect(managed.sourceSelector).toEqual({
      url: SOURCE_URL,
      path: ".",
    });
    expect(managed.store?.source).toEqual({
      url: SOURCE_URL,
      path: ".",
    });
    expect(managed.interfaceBlueprints).toBeUndefined();
    expect(managed.outputAllowlist).toEqual({});
    expect(managed.lifecycleActions).toBeUndefined();
    expect(managed.policy.lifecycleActions).toBeUndefined();
    expect(managed.hostRuntimeMaterialization?.contract).toBe(
      "takosumi.host-runtime-materialization/v1",
    );
    expect(
      managed.hostRuntimeMaterialization?.requirements.find(
        (requirement) => requirement.kind === "public_oidc",
      ),
    ).toMatchObject({
      id: "takosumi-accounts",
      callbackPath: "/api/auth/callback/takos",
      scopes: ["email", "openid", "profile"],
    });
    expect(
      managed.hostRuntimeMaterialization?.requirements.find(
        (requirement) => requirement.binding === "ENCRYPTION_KEY",
      ),
    ).toMatchObject({
      kind: "generated_secret",
      secretRef: "secret:yurucommu/encryption-key",
    });
    expect(
      managed.hostRuntimeMaterialization?.requirements.find(
        (requirement) => requirement.binding === "DB",
      ),
    ).toMatchObject({
      kind: "resource_binding",
      connectionAlias: "DB",
      requiredPermission: "takosumi.resource.bind",
    });
    expect(
      managed.hostRuntimeMaterialization?.backgroundActivations?.[0],
    ).toMatchObject({
      id: "delivery",
      sourceConnectionAlias: "DELIVERY_QUEUE",
      deadLetterConnectionAlias: "DELIVERY_DLQ",
      entrypoint: "yurucommu.delivery",
    });
    expect(
      managed.hostRuntimeMaterialization?.backgroundActivations?.[1],
    ).toEqual({
      id: "retention",
      sourceResourceKind: "Schedule",
      sourceConnectionAlias: "WORKER",
      entrypoint: "yurucommu.retention",
      retry: {
        maxAttempts: 1,
        retryDelaySeconds: 0,
        onExhausted: "fail",
      },
    });
    expect(managed.resourceInterfaceBindingProposals).toBeUndefined();
    expect(
      REFERENCE_APP_INSTALL_CONFIGS.find(
        (config) =>
          config.sourceSelector?.url === SOURCE_URL &&
          config.modulePath === "." &&
          config.store === undefined,
      ),
    ).toBeDefined();
  });

  test("legacy v1 UI metadata does not synthesize a central launcher", async () => {
    const manifestText = JSON.stringify(managedInstallUx());
    const parsed = parseRepositoryManifestText(manifestText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);

    const baseConfig = REFERENCE_APP_INSTALL_CONFIGS.find(
      (config) =>
        config.store?.source?.url === SOURCE_URL &&
        config.modulePath === MODULE_PATH,
    )!;
    const compiled = compileRepositoryInstallUx({
      document: parsed.document,
      sourceSnapshotId: SNAPSHOT_ID,
      modulePath: MODULE_PATH,
      compatibilityReport: managedCompatibilityReport(),
      capsuleName: "My Yurucommu",
      workspaceId: "workspace_yurucommu_managed_cutover",
      reviewedVariables: {},
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) throw new Error(compiled.diagnostic.message);
    expect(compiled.compiled.variableMapping).toEqual({
      project_name: "my-yurucommu",
    });
    expect(compiled.compiled.variablePresentation).toEqual([
      {
        name: "project_name",
        type: "string",
        format: "subdomain",
        required: false,
        defaultValue: { source: "capsule_name" },
        label: { ja: "サービス名", en: "Service name" },
        helper: {
          ja: "ワークスペース内で使うYurucommuの名前です。",
          en: "The name of this Yurucommu service in the workspace.",
        },
        advanced: true,
      },
    ]);
    expect(compiled.compiled.installExperience).toEqual({
      projections: [{ kind: "service_name", variable: "project_name" }],
      repositoryInstallUx: { status: "accepted" },
    });
    expect(compiled.compiled.interfaceBlueprints).toEqual([]);
    expect(compiled.compiled.outputAllowlist).toEqual({});
    expect(baseConfig.interfaceBlueprints).toBeUndefined();
    expect(baseConfig.lifecycleActions).toBeUndefined();
    expect(baseConfig.policy.lifecycleActions).toBeUndefined();
    expect(baseConfig.resourceInterfaceBindingProposals).toBeUndefined();
  });
});
