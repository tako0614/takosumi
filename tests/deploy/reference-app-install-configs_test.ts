import { expect, test } from "bun:test";
import type { CapsuleCompatibilityReport } from "takosumi-contract/capsules";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import type { InstallConfig } from "takosumi-contract/install-configs";
import type { RepositoryManifestDocument } from "takosumi-contract/repository-manifest";
import type { Source, SourceSnapshot } from "takosumi-contract/sources";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
} from "../../core/domains/interfaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import {
  adoptRepoOwnedInstallConfig,
  type RepoOwnedInstallConfigAdoptionInput,
} from "../../accounts/service/src/control/repo-owned-install-config.ts";
import type { ControlPlaneOperations } from "../../accounts/service/src/control-operations.ts";
import { uniqueStoreInstallConfigForSource } from "../../dashboard/src/views/new/install-helpers.ts";
import { parseUiSurfaceInterface } from "../../dashboard/src/lib/ui-surface-interfaces.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../fixtures/reference-app-install-configs.ts";
import { seedCapsuleModel } from "../helpers/deploy-control/model_fixture.ts";

const EXPECTED_STORE_SOURCES = [
  "takos-git",
  "takos-office",
  "takos-storage",
  "takos",
  "yurucommu",
].map((repo) => `https://github.com/tako0614/${repo}.git`);

function bindingPermissions(blueprint: CapsuleInterfaceBlueprint): string[] {
  return [...(blueprint.bindings?.[0]?.permissions ?? [])];
}

type CurrentRepositoryApp = "takos" | "yurucommu";

const CURRENT_REPOSITORY_FIXTURE_CASES = [
  {
    configName: "yurucommu-main",
    app: "yurucommu",
    apiVersion: "takosumi.com/v2.1",
    modulePath: ".",
    modulePaths: [".", "deploy/takoform"],
    sourceUrl: "https://github.com/tako0614/yurucommu.git",
  },
  {
    configName: "yurucommu-managed",
    app: "yurucommu",
    apiVersion: "takosumi.com/v2.3",
    modulePath: "deploy/takoform",
    modulePaths: [".", "deploy/takoform"],
    sourceUrl: "https://github.com/tako0614/yurucommu.git",
  },
  {
    configName: "takos-main",
    app: "takos",
    apiVersion: "takosumi.com/v2.1",
    modulePath: "deploy/opentofu",
    sourcePath: ".",
    modulePaths: ["deploy/opentofu"],
    sourceUrl: "https://github.com/tako0614/takos.git",
  },
] as const satisfies readonly {
  readonly configName: string;
  readonly app: CurrentRepositoryApp;
  readonly apiVersion: "takosumi.com/v2.1" | "takosumi.com/v2.3";
  readonly modulePath: string;
  readonly sourcePath?: string;
  readonly modulePaths: readonly string[];
  readonly sourceUrl: string;
}[];

const REPOSITORY_FIXTURE_NOW = "2026-08-02T00:00:00.000Z";

function currentRepositoryLauncher(app: CurrentRepositoryApp) {
  const title = app === "takos" ? "Takos" : "Yurucommu";
  const icon = app === "takos" ? "/logo.png" : "/icons/yurucommu.svg";
  return {
    key: "launcher",
    name: `${app}.launcher`,
    spec: {
      type: "interface.ui.surface",
      version: "1",
      document: {
        launcher: true,
        display: { title, icon },
      },
      inputs: {
        url: {
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
  } as const;
}

function currentRepositoryManifest(
  app: CurrentRepositoryApp,
  modulePaths: readonly string[],
  apiVersion: "takosumi.com/v2.1" | "takosumi.com/v2.3",
): RepositoryManifestDocument {
  const launcher = currentRepositoryLauncher(app);
  return {
    apiVersion,
    kind: "Repository",
    install: {
      defaultModule: app === "takos" ? "deploy/opentofu" : "deploy/takoform",
      modules: Object.fromEntries(
        modulePaths.map((modulePath) => [
          modulePath,
          {
            inputs: [],
            interfaces: [launcher],
            ...(apiVersion === "takosumi.com/v2.3" &&
            modulePath === "deploy/takoform"
              ? {
                  sourceBuild: {
                    commands: [
                      { argv: ["bun", "install", "--frozen-lockfile"] },
                      { argv: ["bun", "run", "build:worker"] },
                    ],
                    outputs: ["deploy/takoform/dist/yurucommu-worker.js"],
                  },
                }
              : {}),
          },
        ]),
      ),
    },
  } as RepositoryManifestDocument;
}

function fixtureSource(input: {
  readonly app: CurrentRepositoryApp;
  readonly sourceUrl: string;
  readonly modulePath: string;
  readonly sourcePath?: string;
}): Source {
  return {
    id: `source_reference_${input.app}_${input.modulePath.replace(/[^a-z0-9]+/giu, "_")}`,
    workspaceId: "workspace_reference_apps",
    name: `${input.app}-source`,
    url: input.sourceUrl,
    defaultRef: "main",
    defaultPath: input.sourcePath ?? input.modulePath,
    status: "active",
    autoSync: false,
    createdAt: REPOSITORY_FIXTURE_NOW,
    updatedAt: REPOSITORY_FIXTURE_NOW,
  };
}

function fixtureSnapshot(
  source: Source,
  repositoryManifest: SourceSnapshot["repositoryManifest"],
): SourceSnapshot {
  return {
    id: `snapshot_${source.id}`,
    origin: "git",
    workspaceId: source.workspaceId,
    sourceId: source.id,
    url: source.url,
    ref: source.defaultRef,
    resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
    path: source.defaultPath,
    archiveRef: `test://archives/${source.id}`,
    archiveDigest: `sha256:${"a".repeat(64)}`,
    archiveSizeBytes: 1,
    repositoryManifest,
    fetchedByRunId: `run_${source.id}`,
    fetchedAt: REPOSITORY_FIXTURE_NOW,
  };
}

function fixtureCompatibilityReport(
  source: Source,
  snapshot: SourceSnapshot,
  modulePath: string,
): CapsuleCompatibilityReport {
  return {
    id: `compatibility_${snapshot.id}`,
    sourceId: source.id,
    sourceSnapshotId: snapshot.id,
    modulePath,
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
    createdAt: REPOSITORY_FIXTURE_NOW,
  };
}

function adoptionInput(input: {
  readonly source: Source;
  readonly snapshot: SourceSnapshot;
  readonly config: InstallConfig;
  readonly modulePath: string;
  readonly compatibilityReport?: CapsuleCompatibilityReport;
  readonly installingPrincipalId?: string;
}): RepoOwnedInstallConfigAdoptionInput {
  return {
    operations: {} as ControlPlaneOperations,
    source: input.source,
    sourceSnapshot: input.snapshot,
    baseConfig: input.config,
    modulePath: input.modulePath,
    capsuleName: input.config.name,
    workspaceId: input.source.workspaceId,
    ...(input.compatibilityReport
      ? { compatibilityReport: input.compatibilityReport }
      : {}),
    ...(input.installingPrincipalId
      ? { installingPrincipalId: input.installingPrincipalId }
      : {}),
  };
}

async function materializeAdoptedLauncher(input: {
  readonly config: InstallConfig;
  readonly source: Source;
  readonly modulePath: string;
  readonly interfaceBlueprints: NonNullable<
    InstallConfig["interfaceBlueprints"]
  >;
  readonly outputAllowlist: InstallConfig["outputAllowlist"];
}): Promise<void> {
  const opentofu = new InMemoryOpenTofuControlStore();
  const capsuleId = `capsule_${input.config.name}`;
  const seeded = await seedCapsuleModel(opentofu, {
    workspaceId: input.source.workspaceId,
    capsuleId,
    sourceId: input.source.id,
    installConfigId: input.config.id,
    name: input.config.name,
    sourceUrl: input.source.url,
    installConfig: {
      ...input.config,
      modulePath: input.modulePath,
      interfaceBlueprints: input.interfaceBlueprints,
      outputAllowlist: input.outputAllowlist,
    },
  });
  const launchUrl = `https://${input.config.name}.example.test/`;
  await opentofu.putOutput({
    id: `output_${input.config.name}`,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: `sealed/output_${input.config.name}`,
    publicOutputs: { launch_url: launchUrl },
    workspaceOutputs: { launch_url: launchUrl },
    outputDigest: `sha256:${"b".repeat(64)}`,
    createdAt: REPOSITORY_FIXTURE_NOW,
  });
  await opentofu.putStateVersion({
    id: `state_${input.config.name}`,
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: `sealed/state_${input.config.name}`,
    digest: `sha256:${"c".repeat(64)}`,
    createdByRunId: `apply_${input.config.name}`,
    createdAt: REPOSITORY_FIXTURE_NOW,
  });
  await opentofu.patchCapsule(seeded.capsule.id, {
    status: "active",
    currentOutputId: `output_${input.config.name}`,
    currentStateGeneration: 1,
    currentStateVersionId: `state_${input.config.name}`,
  });

  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({ opentofu }),
  });
  const [launcher] = await interfaces.ensureCapsuleBlueprints({
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    blueprints: input.interfaceBlueprints,
  });
  expect(launcher?.status).toMatchObject({
    phase: "Resolved",
    resolvedInputs: { url: launchUrl },
  });
  await expect(
    interfaces.listAuthorizedForPrincipal(
      {
        workspaceId: seeded.workspace.id,
        ownerKind: "Capsule",
        ownerId: seeded.capsule.id,
        type: "interface.ui.surface",
        phase: "Resolved",
      },
      "principal_reference_app",
      "ui.open",
    ),
  ).resolves.toEqual([launcher!]);
  expect(parseUiSurfaceInterface(launcher, seeded.workspace.id)).toMatchObject({
    capsuleId: seeded.capsule.id,
    name: input.config.name.startsWith("takos") ? "Takos" : "Yurucommu",
    url: launchUrl,
  });
}

test("reference app composition exposes five replaceable Store source identities", () => {
  expect(REFERENCE_APP_INSTALL_CONFIGS).toHaveLength(6);
  const storeConfigs = REFERENCE_APP_INSTALL_CONFIGS.filter(
    (config) => config.store?.source !== undefined,
  );
  expect(
    storeConfigs.map((config) => config.store!.source!.url).sort(),
  ).toEqual(EXPECTED_STORE_SOURCES);
  expect(
    new Set(REFERENCE_APP_INSTALL_CONFIGS.map((config) => config.id)).size,
  ).toBe(6);
  for (const config of REFERENCE_APP_INSTALL_CONFIGS) {
    expect(config.workspaceId).toBeUndefined();
    expect(config.internal).toBeUndefined();
    expect(config.modulePath).toBe(
      config.name === "takos-main"
        ? "deploy/opentofu"
        : config.name === "yurucommu-managed"
          ? "deploy/takoform"
          : ".",
    );
    for (const key of Object.keys(config.variableMapping)) {
      expect(key).not.toMatch(/secret|password|token|api.?key/iu);
    }
    expect(config.policy?.repositoryInstallUx).toEqual({
      allowedInterfacePermissions: ["ui.open"],
      ...(config.name === "takos-main" || config.name === "yurucommu-main"
        ? { requiredManifestApiVersion: "takosumi.com/v2.1" }
        : config.name === "yurucommu-managed"
          ? { requiredManifestApiVersion: "takosumi.com/v2.3" }
          : {}),
    });
  }

  for (const config of storeConfigs) {
    expect(config.sourceSelector).toEqual(config.store!.source);
    expect(config.store!.source).toEqual({
      url: config.store!.source!.url,
      path: ".",
    });
    // Store presentation does not select a ref. The Source sync/Run path owns
    // the reviewed ref and resolves it to an immutable SourceSnapshot commit.
    expect(config.store!.source!.ref).toBeUndefined();
  }
});

test("Takos archives the repository root and pins lifecycle execution policy", () => {
  const takos = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-main",
  )!;
  expect(takos.sourceSelector).toEqual({
    url: "https://github.com/tako0614/takos.git",
    path: ".",
  });
  expect(takos.modulePath).toBe("deploy/opentofu");
  expect(takos.sourceBuild).toEqual({
    commands: [{ argv: ["bun", "install", "--frozen-lockfile"] }],
    outputs: ["node_modules/wrangler/bin/wrangler.js"],
  });
  expect(takos.lifecycleActions).toEqual([
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "takos-product-activate-v1",
      phase: "post_apply",
      executor: "runner",
      command: ["bun", "run", "product:activate"],
      workingDirectory: ".",
      env: {
        TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL:
          "https://github.com/tako0614/takos/releases/download/v0.11.8/takosumi-artifact.json",
        TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256:
          "sha256:f6e9ee74d352803bf9a4af07be57b7c03e9ed61d6127794c382e224ff1775b2c",
      },
      timeoutSeconds: 3600,
      runnerCapability: "capsule.lifecycle.command.v1",
      useProviderCredentials: true,
    },
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "takos-product-pre-destroy-v1",
      phase: "pre_destroy",
      cleanupFor: "takos-product-activate-v1",
      executor: "runner",
      command: ["bun", "run", "product:pre-destroy"],
      workingDirectory: ".",
      timeoutSeconds: 1800,
      runnerCapability: "capsule.lifecycle.command.v1",
      useProviderCredentials: true,
    },
  ]);
  expect(takos.policy).toMatchObject({
    allowedProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    providerCredentials: {
      requiredProviders: ["registry.opentofu.org/cloudflare/cloudflare"],
    },
    lifecycleActions: {
      allowedExecutors: ["runner"],
      allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
      allowProviderCredentials: true,
    },
  });
  expect(takos.lifecycleActions?.[0]?.env).toEqual({
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_URL:
      "https://github.com/tako0614/takos/releases/download/v0.11.8/takosumi-artifact.json",
    TAKOS_RELEASE_ARTIFACT_DESCRIPTOR_SHA256:
      "sha256:f6e9ee74d352803bf9a4af07be57b7c03e9ed61d6127794c382e224ff1775b2c",
  });
});

test("managed Yurucommu requires short-lived Takoform provider credentials", () => {
  const managed = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "yurucommu-managed",
  );
  expect(managed?.policy?.providerCredentials).toEqual({
    requiredProviders: ["registry.terraform.io/tako0614/takoform"],
    requireTemporary: true,
    requireTtlEnforced: true,
  });
  expect(managed?.lifecycleActions).toBeUndefined();
  expect(managed?.policy?.lifecycleActions).toBeUndefined();
});

test("default composition omits apps without an executable public source and release", () => {
  for (const app of ["road-to-me", "takos-computer", "yurumeet"]) {
    expect(
      REFERENCE_APP_INSTALL_CONFIGS.some(
        (config) =>
          config.name === `${app}-main` ||
          config.store?.source?.url.includes(`/${app}.git`),
      ),
    ).toBe(false);
  }
});

test("every runtime blueprint maps an allowlisted ordinary Output and installer binding", () => {
  for (const config of REFERENCE_APP_INSTALL_CONFIGS) {
    for (const blueprint of config.interfaceBlueprints ?? []) {
      for (const input of Object.values(blueprint.spec.inputs ?? {})) {
        if (input.source !== "capsule_output") continue;
        expect(config.outputAllowlist[input.outputName]).toEqual({
          from: input.outputName,
          type: "url",
          required: true,
        });
      }
      expect(blueprint.bindings).toHaveLength(1);
      const binding = blueprint.bindings?.[0];
      expect(
        binding && "subject" in binding ? binding.subject : undefined,
      ).toEqual({ source: "installing_principal" });
      expect(
        binding && "subjectRef" in binding ? binding.subjectRef : undefined,
      ).toBeUndefined();
      expect(binding?.delivery.type).toBe(
        blueprint.spec.type === "interface.ui.surface" ||
          blueprint.spec.type === "interface.file.handler"
          ? "none"
          : "oauth2",
      );
    }
  }
});

test("reference interfaces match each app's audited runtime contract", () => {
  const byName = new Map(
    REFERENCE_APP_INSTALL_CONFIGS.map((config) => [config.name, config]),
  );
  const blueprints = (repo: string) =>
    byName.get(`${repo}-main`)!.interfaceBlueprints!;

  expect(byName.get("yurucommu-main")!.interfaceBlueprints).toBeUndefined();
  expect(byName.get("yurucommu-main")!.outputAllowlist).toEqual({});
  expect(byName.get("yurucommu-managed")!.interfaceBlueprints).toBeUndefined();
  expect(byName.get("yurucommu-managed")!.outputAllowlist).toEqual({});
  expect(byName.get("takos-main")!.interfaceBlueprints).toBeUndefined();
  expect(byName.get("takos-main")!.outputAllowlist).toEqual({});
  const storage = blueprints("takos-storage");
  expect(storage.map((item) => item.spec.type).sort()).toEqual([
    "interface.ui.surface",
    "mcp.server",
    "storage.object",
  ]);
  expect(
    bindingPermissions(
      storage.find((item) => item.spec.type === "storage.object")!,
    ),
  ).toEqual([
    "storage.object.read",
    "storage.object.write",
    "storage.object.delete",
    "storage.object.list",
  ]);

  const git = blueprints("takos-git");
  expect(git.map((item) => item.spec.type).sort()).toEqual([
    "interface.ui.surface",
    "mcp.server",
    "source.git.hosting",
    "source.git.smart_http",
  ]);
  expect(
    bindingPermissions(
      git.find((item) => item.spec.type === "source.git.smart_http")!,
    ),
  ).toEqual(["source.git.smart_http.read", "source.git.smart_http.write"]);
  expect(
    bindingPermissions(
      git.find((item) => item.spec.type === "source.git.hosting")!,
    ),
  ).toEqual(["source.git.hosting.read"]);
});

test("first-party launcher blueprints publish contract-safe runtime icon paths", () => {
  const byName = new Map(
    REFERENCE_APP_INSTALL_CONFIGS.map((config) => [config.name, config]),
  );
  const icon = (configName: string, interfaceName?: string) => {
    const blueprint = byName
      .get(configName)!
      .interfaceBlueprints!.find(
        (item) =>
          item.spec.type === "interface.ui.surface" &&
          (interfaceName === undefined || item.name === interfaceName),
      )!;
    return (blueprint.spec.document as { display?: { icon?: string } }).display
      ?.icon;
  };
  expect(icon("takos-storage-main")).toBe("/icons/takos-storage.svg");
  expect(icon("takos-git-main")).toBe("/icons/takos-git.svg");
  expect(icon("takos-office-main", "takos-office.docs")).toBe(
    "/docs/icons/docs.svg",
  );
  expect(icon("takos-office-main", "takos-office.slide")).toBe(
    "/slide/icons/slide.svg",
  );
  expect(icon("takos-office-main", "takos-office.sheet")).toBe(
    "/sheet/icons/excel.svg",
  );
});

test("stateful R2 services use reviewed runner pre-destroy cleanup", () => {
  const expectedAction = (script: string) => [
    {
      apiVersion: "takosumi.dev/v1alpha1",
      kind: "command",
      id: "empty-r2-before-destroy-v1",
      phase: "pre_destroy",
      executor: "runner",
      command: ["bun", "run", script],
      workingDirectory: ".",
      timeoutSeconds: 3600,
      runnerCapability: "capsule.lifecycle.command.v1",
      useProviderCredentials: true,
    },
  ];
  const expectedPolicy = {
    allowedExecutors: ["runner"],
    allowedRunnerCapabilities: ["capsule.lifecycle.command.v1"],
    allowProviderCredentials: true,
  };
  for (const [name, script] of [
    ["takos-storage-main", "storage:pre-destroy"],
    ["takos-git-main", "git:pre-destroy"],
  ] as const) {
    const config = REFERENCE_APP_INSTALL_CONFIGS.find(
      (candidate) => candidate.name === name,
    )!;
    expect(config.lifecycleActions).toEqual(expectedAction(script));
    expect(config.policy.lifecycleActions).toEqual(expectedPolicy);
    expect(config.outputAllowlist.object_bucket_name).toEqual({
      from: "object_bucket_name",
      type: "string",
      required: true,
    });
    expect(config.outputAllowlist.cloudflare_account_id).toEqual({
      from: "cloudflare_account_id",
      type: "string",
      required: true,
    });
  }
  const storage = REFERENCE_APP_INSTALL_CONFIGS.find(
    (candidate) => candidate.name === "takos-storage-main",
  )!;
  const git = REFERENCE_APP_INSTALL_CONFIGS.find(
    (candidate) => candidate.name === "takos-git-main",
  )!;
  expect(storage.outputAllowlist.actions_logs_bucket_name).toBeUndefined();
  expect(git.outputAllowlist.actions_logs_bucket_name).toEqual({
    from: "actions_logs_bucket_name",
    type: "string",
    required: true,
  });
});

test("Office publishes the three surfaces and exact file handlers", () => {
  const office = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-office-main",
  )!;
  expect(office.installContextVariableMapping).toEqual({
    object_storage_workspace_id: "workspace_id",
    app_capsule_id: "capsule_id",
  });
  const handlers = (office.interfaceBlueprints ?? []).filter(
    (item) => item.spec.type === "interface.file.handler",
  );
  const surfaces = (office.interfaceBlueprints ?? []).filter(
    (item) => item.spec.type === "interface.ui.surface",
  );
  expect(surfaces.map((item) => item.spec.inputs?.url)).toEqual([
    { source: "capsule_output", outputName: "docs_url" },
    { source: "capsule_output", outputName: "slide_url" },
    { source: "capsule_output", outputName: "sheet_url" },
  ]);
  expect(
    handlers.map((item) => ({
      document: item.spec.document,
      input: item.spec.inputs?.openUrl,
      permissions: bindingPermissions(item),
    })),
  ).toEqual([
    {
      document: {
        display: { title: "Takos Docs" },
        mimeTypes: ["application/vnd.takos.docs+json"],
        extensions: [".takosdoc"],
      },
      input: { source: "capsule_output", outputName: "docs_file_open_url" },
      permissions: ["file.open"],
    },
    {
      document: {
        display: { title: "Takos Slide" },
        mimeTypes: ["application/vnd.takos.slide+json"],
        extensions: [".takosslide"],
      },
      input: { source: "capsule_output", outputName: "slide_file_open_url" },
      permissions: ["file.open"],
    },
    {
      document: {
        display: { title: "Takos Sheet" },
        mimeTypes: ["application/vnd.takos.excel+json"],
        extensions: [".takossheet"],
      },
      input: { source: "capsule_output", outputName: "sheet_file_open_url" },
      permissions: ["file.open"],
    },
  ]);
});

test("reference configs contain no retired runtime authority schema", () => {
  const serialized = JSON.stringify(REFERENCE_APP_INSTALL_CONFIGS);
  for (const retired of [
    "service_exports",
    "service_bindings",
    "app_deployment",
    ["takos", "provided"].join("_"),
    ".well-known/tcs.json",
    "managedPublicHostname",
    "oidc_client",
  ]) {
    expect(serialized).not.toContain(retired);
  }
  const storage = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-storage-main",
  )!;
  expect(storage.installContextVariableMapping).toEqual({
    "env.APP_WORKSPACE_ID": "workspace_id",
    "env.APP_CAPSULE_ID": "capsule_id",
  });
  const git = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-git-main",
  )!;
  expect(
    git.variablePresentation?.find(
      (variable) => variable.name === "app_session_secret",
    ),
  ).toMatchObject({
    type: "string",
    format: "password",
    required: true,
    secret: true,
  });
  expect(git.installContextVariableMapping).toEqual({
    "env.APP_WORKSPACE_ID": "workspace_id",
    "env.APP_CAPSULE_ID": "capsule_id",
  });
});

test("current repository manifests are adopted into exact launcher/output/binding materialization", async () => {
  for (const fixture of CURRENT_REPOSITORY_FIXTURE_CASES) {
    const config = REFERENCE_APP_INSTALL_CONFIGS.find(
      (candidate) => candidate.name === fixture.configName,
    )!;
    const source = fixtureSource(fixture);
    const document = currentRepositoryManifest(
      fixture.app,
      fixture.modulePaths,
      fixture.apiVersion,
    );
    const snapshot = fixtureSnapshot(source, {
      status: "present",
      digest: `sha256:${"d".repeat(64)}`,
      document,
    });
    const compatibilityReport = fixtureCompatibilityReport(
      source,
      snapshot,
      fixture.modulePath,
    );
    const result = await adoptRepoOwnedInstallConfig(
      adoptionInput({
        source,
        snapshot,
        config,
        modulePath: fixture.modulePath,
        compatibilityReport,
        installingPrincipalId: "principal_reference_app",
      }),
    );

    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") continue;
    const manifestLauncher = currentRepositoryLauncher(fixture.app);
    const expectedBlueprint = {
      key: manifestLauncher.key,
      name: manifestLauncher.name,
      spec: {
        ...manifestLauncher.spec,
        inputs: {
          url: { source: "capsule_output", outputName: "launch_url" },
        },
      },
      bindings: [
        {
          key: "installer",
          subjectRef: {
            kind: "Principal" as const,
            id: "principal_reference_app",
          },
          permissions: ["ui.open"],
          delivery: { type: "none" as const },
        },
      ],
    };
    expect(result.interfaceBlueprints).toEqual([expectedBlueprint]);
    expect(result.outputAllowlist).toEqual({
      launch_url: { from: "launch_url", type: "url", required: true },
    });
    expect(result.sourceBuild).toEqual(
      fixture.apiVersion === "takosumi.com/v2.3"
        ? {
            commands: [
              { argv: ["bun", "install", "--frozen-lockfile"] },
              { argv: ["bun", "run", "build:worker"] },
            ],
            outputs: ["deploy/takoform/dist/yurucommu-worker.js"],
          }
        : config.sourceBuild,
    );
    await materializeAdoptedLauncher({
      config,
      source,
      modulePath: fixture.modulePath,
      interfaceBlueprints: result.interfaceBlueprints ?? [],
      outputAllowlist: result.outputAllowlist,
    });
  }
});

test("strict reference configs reject absent and legacy v1 snapshots before Capsule creation", async () => {
  for (const fixture of CURRENT_REPOSITORY_FIXTURE_CASES) {
    const config = REFERENCE_APP_INSTALL_CONFIGS.find(
      (candidate) => candidate.name === fixture.configName,
    )!;
    expect(config.interfaceBlueprints).toBeUndefined();
    expect(config.outputAllowlist).toEqual({});
    const source = fixtureSource(fixture);
    const currentDocument = currentRepositoryManifest(
      fixture.app,
      fixture.modulePaths,
      fixture.apiVersion,
    );
    const currentSnapshot = fixtureSnapshot(source, {
      status: "present",
      digest: `sha256:${"e".repeat(64)}`,
      document: currentDocument,
    });
    const absentResult = await adoptRepoOwnedInstallConfig(
      adoptionInput({
        source,
        snapshot: fixtureSnapshot(source, { status: "absent" }),
        config,
        modulePath: fixture.modulePath,
      }),
    );
    expect(absentResult).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_manifest_api_version_required",
        message: `Repository install UX requires manifest API ${fixture.apiVersion}; observed absent.`,
      },
    });

    const legacyResult = await adoptRepoOwnedInstallConfig(
      adoptionInput({
        source,
        snapshot: fixtureSnapshot(source, {
          status: "present",
          digest: `sha256:${"f".repeat(64)}`,
          document: {
            apiVersion: "takosumi.com/v1",
            kind: "Repository",
            install: {
              modules: { [fixture.modulePath]: { inputs: [] } },
            },
          },
        }),
        config,
        modulePath: fixture.modulePath,
        compatibilityReport: fixtureCompatibilityReport(
          source,
          currentSnapshot,
          fixture.modulePath,
        ),
      }),
    );
    expect(legacyResult).toEqual({
      status: "invalid",
      diagnostic: {
        code: "repository_install_ux_manifest_api_version_required",
        message: `Repository install UX requires manifest API ${fixture.apiVersion}; observed takosumi.com/v1.`,
      },
    });
  }
});

test("generic configs retain absent and v1 repository install UX compatibility", async () => {
  const source = fixtureSource({
    app: "takos",
    sourceUrl: "https://git.example.test/generic.git",
    modulePath: ".",
  });
  const generic: InstallConfig = {
    id: "cfg-default-opentofu-capsule",
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: REPOSITORY_FIXTURE_NOW,
    updatedAt: REPOSITORY_FIXTURE_NOW,
  };
  const absent = await adoptRepoOwnedInstallConfig(
    adoptionInput({
      source,
      snapshot: fixtureSnapshot(source, { status: "absent" }),
      config: generic,
      modulePath: ".",
    }),
  );
  expect(absent).toEqual({ status: "absent" });

  const legacySnapshot = fixtureSnapshot(source, {
    status: "present",
    digest: `sha256:${"1".repeat(64)}`,
    document: {
      apiVersion: "takosumi.com/v1",
      kind: "Repository",
      install: { modules: { ".": { inputs: [] } } },
    },
  });
  const legacy = await adoptRepoOwnedInstallConfig(
    adoptionInput({
      source,
      snapshot: legacySnapshot,
      config: generic,
      modulePath: ".",
      compatibilityReport: fixtureCompatibilityReport(
        source,
        legacySnapshot,
        ".",
      ),
    }),
  );
  expect(legacy.status).toBe("accepted");
  if (legacy.status === "accepted") {
    expect(legacy.interfaceBlueprints ?? []).toEqual([]);
    expect(legacy.outputAllowlist).toEqual({});
  }
});

test("Store discovery resolves URL-only host policies without central launcher declarations", () => {
  expect(
    uniqueStoreInstallConfigForSource(
      REFERENCE_APP_INSTALL_CONFIGS,
      "https://github.com/tako0614/takos.git",
      "deploy/opentofu",
    )?.name,
  ).toBe("takos-main");
  expect(
    uniqueStoreInstallConfigForSource(
      REFERENCE_APP_INSTALL_CONFIGS,
      "https://github.com/tako0614/yurucommu.git",
      ".",
    )?.name,
  ).toBe("yurucommu-managed");
});
