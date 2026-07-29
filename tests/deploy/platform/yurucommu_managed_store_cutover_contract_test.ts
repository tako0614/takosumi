import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { RepositoryInstallUxDocument } from "takosumi-contract/install-ux";
import { parseRepositoryInstallUxText } from "takosumi-contract/install-ux";
import type { InstallConfig } from "takosumi-contract/install-configs";
import {
  UI_SURFACE_INTERFACE_TYPE,
  UI_SURFACE_INTERFACE_VERSION,
  UI_SURFACE_OPEN_PERMISSION,
} from "takosumi-contract";
import { resolveCapsuleResourceInterfaceBindingInstallingPrincipal } from "takosumi-contract/interfaces";
import { compileRepositoryInstallUx } from "../../../core/domains/capsules/repository_install_ux_compiler.ts";
import { uniqueStoreInstallConfigForSource } from "../../../dashboard/src/views/new/install-helpers.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../../deploy/reference-app-install-configs.ts";

const SOURCE_URL = "https://github.com/tako0614/yurucommu.git";
const MODULE_PATH = "deploy/takoform";
const SNAPSHOT_ID = "snapshot_yurucommu_managed_cutover";
const NOW = "2026-07-29T00:00:00.000Z";
const YURUCOMMU_ROOT = new URL("../../../../yurucommu/", import.meta.url);

const MANAGED_INPUTS = [
  {
    name: "project_name",
    source: { kind: "capsule_name" as const },
    type: "string" as const,
    format: "subdomain" as const,
    label: { ja: "サービス名", en: "Service name" },
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
      "takoform_http_service.worker",
      "takoform_relational_database.database",
      "takoform_object_bucket.media",
      "takoform_key_value_store.kv",
      "takoform_queue.delivery",
      "takoform_queue.delivery_dlq",
      "takoform_schedule.retention",
      "takoform_interface.launcher",
    ],
    dataSources: [],
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

function managedInstallUx(): RepositoryInstallUxDocument {
  return {
    schemaVersion: "takosumi.install-ux/v1",
    modules: {
      [MODULE_PATH]: {
        inputs: MANAGED_INPUTS,
        installExperience: {
          projections: [{ kind: "service_name", variable: "project_name" }],
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
    sourceSelector: { url: SOURCE_URL, path: MODULE_PATH },
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
      source: { url: SOURCE_URL, path: MODULE_PATH },
    },
    resourceInterfaceBindingProposals: [
      {
        key: "launcher",
        interface: {
          name: "yurucommu.launcher",
          version: "1",
        },
        subject: { source: "installing_principal" },
        permissions: [UI_SURFACE_OPEN_PERMISSION],
        delivery: { type: "none" },
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function declaredResources(source: string): string[] {
  return Array.from(
    source.matchAll(/resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/gu),
    (match) => `${match[1]}.${match[2]}`,
  );
}

describe("Yurucommu managed Store cutover contract", () => {
  test("normal Store selection resolves only the exact managed module InstallConfig", () => {
    const managed = managedInstallConfig();
    const direct = {
      ...managed,
      id: "config_yurucommu_direct",
      name: "yurucommu-direct",
      sourceSelector: { url: SOURCE_URL, path: "." },
      modulePath: ".",
      store: {
        ...managed.store!,
        source: { url: SOURCE_URL, path: "." },
      },
    };

    expect(
      uniqueStoreInstallConfigForSource(
        [direct, managed],
        SOURCE_URL,
        MODULE_PATH,
      )?.id,
    ).toBe(managed.id);
    expect(
      uniqueStoreInstallConfigForSource([direct, managed], SOURCE_URL, ".")?.id,
    ).toBe(direct.id);
    expect(managed.modulePath).toBe(MODULE_PATH);
    expect(managed.variableMapping).toEqual({ project_name: "yurucommu" });
    expect(managed.interfaceBlueprints).toBeUndefined();
    expect(managed.outputAllowlist).toEqual({});
    expect(managed.resourceInterfaceBindingProposals).toEqual([
      {
        key: "launcher",
        interface: {
          name: "yurucommu.launcher",
          version: "1",
        },
        subject: { source: "installing_principal" },
        permissions: [UI_SURFACE_OPEN_PERMISSION],
        delivery: { type: "none" },
      },
    ]);
  });

  test("the selected module owns the complete canonical Resource graph and opaque launcher declaration", async () => {
    const source = await readFile(
      new URL("deploy/takoform/main.tf", YURUCOMMU_ROOT),
      "utf8",
    );
    expect(declaredResources(source)).toEqual([
      "takoform_relational_database.database",
      "takoform_object_bucket.media",
      "takoform_key_value_store.kv",
      "takoform_queue.delivery",
      "takoform_queue.delivery_dlq",
      "takoform_http_service.worker",
      "takoform_schedule.retention",
      "takoform_interface.launcher",
    ]);
    expect(source).toContain('resource_kind = "HttpService"');
    expect(source).toContain(
      "resource_name = takoform_http_service.worker.name",
    );
    expect(source).toContain('originInput = "origin"');
    expect(source).toContain('source  = "output"');
    expect(source).toContain('pointer = "/url"');
    expect(source).not.toMatch(/\bcloudflare_[a-z0-9_]+\b/u);
    expect(source).not.toContain("subjectRef");
    expect(source).not.toContain("ui.open");
  });

  test("production discovery selects the managed module while retaining the direct Git module", async () => {
    const manifest = JSON.parse(
      await readFile(
        new URL(".well-known/takosumi.json", YURUCOMMU_ROOT),
        "utf8",
      ),
    ) as RepositoryInstallUxDocument;
    expect(Object.keys(manifest.modules)).toEqual([".", MODULE_PATH]);
    expect(manifest.modules[MODULE_PATH]).toBeDefined();

    const selectableYurucommu = REFERENCE_APP_INSTALL_CONFIGS.filter(
      (config) => config.store?.source?.url === SOURCE_URL,
    );
    expect(selectableYurucommu).toHaveLength(1);
    const managed = selectableYurucommu[0]!;
    expect(managed.modulePath).toBe(MODULE_PATH);
    expect(managed.sourceSelector).toEqual({
      url: SOURCE_URL,
      path: MODULE_PATH,
    });
    expect(managed.interfaceBlueprints).toBeUndefined();
    expect(managed.outputAllowlist).toEqual({});
    expect(managed.lifecycleActions).toEqual([
      {
        apiVersion: "takosumi.dev/v1alpha1",
        kind: "resource_migration",
        id: "yurucommu-schema",
        phase: "post_apply",
        executor: "operator",
        runnerCapability: "resource.migration.sqlite.v1",
        target: {
          resourceAddress: "takoform_relational_database.database",
        },
        bundle: {
          format: "takosumi.resource-migrations/v1",
          manifestPath: "deploy/takoform/migrations/manifest.json",
          digest:
            "sha256:3b3f36501936a84ed19b9bef37e5581c3e04948733b947ebaa002f196e66817c",
        },
      },
    ]);
    expect(managed.hostRuntimeMaterialization?.contract).toBe(
      "takosumi.host-runtime-materialization/v1",
    );
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
      kind: "managed_connection",
      connectionAlias: "DB",
      requiredPermission: "takosumi.managed-runtime.invoke",
      capabilityRef: "capability:yurucommu/database",
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
    expect(managed.resourceInterfaceBindingProposals).toEqual([
      {
        key: "launcher",
        interface: {
          name: "yurucommu.launcher",
          version: "1",
        },
        subject: { source: "installing_principal" },
        permissions: [UI_SURFACE_OPEN_PERMISSION],
        delivery: { type: "none" },
      },
    ]);
    expect(
      REFERENCE_APP_INSTALL_CONFIGS.find(
        (config) =>
          config.sourceSelector?.url === SOURCE_URL &&
          config.modulePath === "." &&
          config.store === undefined,
      ),
    ).toBeDefined();
  });

  test("normal UI selection compiles the exact repository proposal and fixes installer authority before lifecycle execution", async () => {
    const manifestText = await readFile(
      new URL(".well-known/takosumi.json", YURUCOMMU_ROOT),
      "utf8",
    );
    const parsed = parseRepositoryInstallUxText(manifestText);
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

    const resolvedBindings =
      resolveCapsuleResourceInterfaceBindingInstallingPrincipal(
        baseConfig.resourceInterfaceBindingProposals,
        "principal_normal_ui_installer",
      );
    expect(resolvedBindings).toMatchObject([
      {
        key: "launcher",
        subjectRef: {
          kind: "Principal",
          id: "principal_normal_ui_installer",
        },
        permissions: [UI_SURFACE_OPEN_PERMISSION],
      },
    ]);
    expect(JSON.stringify(resolvedBindings)).not.toContain(
      "installing_principal",
    );
    expect(baseConfig.lifecycleActions?.[0]).toMatchObject({
      kind: "resource_migration",
      executor: "operator",
      target: {
        resourceAddress: "takoform_relational_database.database",
      },
    });
    expect(baseConfig.interfaceBlueprints).toBeUndefined();
  });
});
