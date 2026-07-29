import { expect, test } from "bun:test";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import { resolveCapsuleInterfaceBlueprintInstallingPrincipal } from "takosumi-contract/interfaces";
import {
  createInMemoryInterfaceStores,
  InterfaceService,
  OutputBackedInterfaceInputResolver,
} from "../../core/domains/interfaces/mod.ts";
import { InMemoryOpenTofuControlStore } from "../../core/domains/deploy-control/store.ts";
import { uniqueStoreInstallConfigForSource } from "../../dashboard/src/views/new/install-helpers.ts";
import { parseUiSurfaceInterface } from "../../dashboard/src/lib/ui-surface-interfaces.ts";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../deploy/reference-app-install-configs.ts";
import { seedCapsuleModel } from "../helpers/deploy-control/model_fixture.ts";

const EXPECTED_STORE_SOURCES = [
  "takos-git",
  "takos-office",
  "takos-storage",
  "yurucommu",
].map((repo) => `https://github.com/tako0614/${repo}.git`);

function bindingPermissions(blueprint: CapsuleInterfaceBlueprint): string[] {
  return [...(blueprint.bindings?.[0]?.permissions ?? [])];
}

test("reference app composition exposes four replaceable Store source identities", () => {
  expect(REFERENCE_APP_INSTALL_CONFIGS).toHaveLength(5);
  const storeConfigs = REFERENCE_APP_INSTALL_CONFIGS.filter(
    (config) => config.store?.source !== undefined,
  );
  expect(
    storeConfigs.map((config) => config.store!.source!.url).sort(),
  ).toEqual(EXPECTED_STORE_SOURCES);
  expect(
    new Set(REFERENCE_APP_INSTALL_CONFIGS.map((config) => config.id)).size,
  ).toBe(5);
  // Takos is the workspace shell, not an app installed into one: it stays
  // addressable without appearing in shared Store discovery.
  expect(
    REFERENCE_APP_INSTALL_CONFIGS.find((config) => config.name === "takos-main")
      ?.store,
  ).toBeUndefined();

  for (const config of REFERENCE_APP_INSTALL_CONFIGS) {
    expect(config.workspaceId).toBeUndefined();
    expect(config.internal).toBeUndefined();
    expect(config.modulePath).toBe(
      config.name === "takos-main" ? "deploy/opentofu" : ".",
    );
    for (const key of Object.keys(config.variableMapping)) {
      expect(key).not.toMatch(/secret|password|token|api.?key/iu);
    }
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

  expect(blueprints("yurucommu").map((item) => item.spec.type)).toEqual([
    "interface.ui.surface",
  ]);
  expect(byName.get("yurucommu-main")!.outputAllowlist).toEqual({
    launch_url: {
      from: "launch_url",
      type: "url",
      required: true,
    },
  });
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
  expect(icon("yurucommu-main")).toBe("/icons/yurucommu.svg");
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

test("Yurucommu Store selection reaches an authorized launcher URL and never the invisible generic config", async () => {
  const sourceUrl = "https://github.com/tako0614/yurucommu.git";
  const yurucommu = uniqueStoreInstallConfigForSource(
    REFERENCE_APP_INSTALL_CONFIGS,
    sourceUrl,
    ".",
  );
  expect(yurucommu?.id).toBe("cfg-reference-yurucommu-main");
  expect(yurucommu?.outputAllowlist.launch_url).toEqual({
    from: "launch_url",
    type: "url",
    required: true,
  });

  const generic = {
    id: "cfg-default-opentofu-capsule",
    name: "opentofu-capsule",
    variableMapping: {},
    outputAllowlist: {},
    policy: {},
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
  expect(
    uniqueStoreInstallConfigForSource(
      [generic, { ...yurucommu!, sourceSelector: undefined }],
      sourceUrl,
      ".",
    ),
  ).toBeNull();

  const principal = "user_yurucommu";
  const blueprints = resolveCapsuleInterfaceBlueprintInstallingPrincipal(
    yurucommu!.interfaceBlueprints!,
    principal,
  )!;
  const opentofu = new InMemoryOpenTofuControlStore();
  const seeded = await seedCapsuleModel(opentofu, {
    workspaceId: "workspace_yurucommu",
    capsuleId: "capsule_yurucommu",
    installConfigId: yurucommu!.id,
    name: "yurucommu",
    sourceUrl,
    installConfig: {
      ...yurucommu!,
      interfaceBlueprints: blueprints,
    },
  });
  const launchUrl = "https://yurucommu.example.test/";
  await opentofu.putOutput({
    id: "output_yurucommu",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    stateGeneration: 1,
    rawArtifactRef: "sealed/output_yurucommu",
    publicOutputs: { launch_url: launchUrl },
    workspaceOutputs: { launch_url: launchUrl },
    outputDigest: `sha256:${"a".repeat(64)}`,
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  await opentofu.putStateVersion({
    id: "state_yurucommu",
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    environment: seeded.capsule.environment,
    generation: 1,
    stateRef: "sealed/state_yurucommu",
    digest: `sha256:${"b".repeat(64)}`,
    createdByRunId: "apply_yurucommu",
    createdAt: "2026-07-14T00:00:00.000Z",
  });
  await opentofu.patchCapsule(seeded.capsule.id, {
    status: "active",
    currentOutputId: "output_yurucommu",
    currentStateGeneration: 1,
    currentStateVersionId: "state_yurucommu",
  });

  const interfaces = new InterfaceService({
    stores: createInMemoryInterfaceStores(),
    resolver: new OutputBackedInterfaceInputResolver({ opentofu }),
  });
  const [launcher] = await interfaces.ensureCapsuleBlueprints({
    workspaceId: seeded.workspace.id,
    capsuleId: seeded.capsule.id,
    blueprints,
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
      principal,
      "ui.open",
    ),
  ).resolves.toEqual([launcher!]);
  expect(parseUiSurfaceInterface(launcher, seeded.workspace.id)).toMatchObject({
    capsuleId: seeded.capsule.id,
    name: "Yurucommu",
    url: launchUrl,
  });
});
