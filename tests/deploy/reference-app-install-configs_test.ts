import { expect, test } from "bun:test";
import type { CapsuleInterfaceBlueprint } from "takosumi-contract/interfaces";
import { REFERENCE_APP_INSTALL_CONFIGS } from "../../deploy/reference-app-install-configs.ts";

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
  expect(REFERENCE_APP_INSTALL_CONFIGS).toHaveLength(4);
  const storeConfigs = REFERENCE_APP_INSTALL_CONFIGS.filter(
    (config) => config.store?.source !== undefined,
  );
  expect(
    storeConfigs.map((config) => config.store!.source!.url).sort(),
  ).toEqual(EXPECTED_STORE_SOURCES);
  expect(
    new Set(REFERENCE_APP_INSTALL_CONFIGS.map((config) => config.id)).size,
  ).toBe(4);

  for (const config of REFERENCE_APP_INSTALL_CONFIGS) {
    expect(config.workspaceId).toBeUndefined();
    expect(config.internal).toBeUndefined();
    expect(config.modulePath).toBe(".");
    for (const key of Object.keys(config.variableMapping)) {
      expect(key).not.toMatch(/secret|password|token|api.?key/iu);
    }
  }

  for (const config of storeConfigs) {
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

test("Office publishes the three surfaces and exact file handlers", () => {
  const office = REFERENCE_APP_INSTALL_CONFIGS.find(
    (config) => config.name === "takos-office-main",
  )!;
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
  const storageAndGit = REFERENCE_APP_INSTALL_CONFIGS.filter((config) =>
    ["takos-storage-main", "takos-git-main"].includes(config.name),
  );
  for (const config of storageAndGit) {
    expect(config.installContextVariableMapping).toEqual({
      "env.APP_WORKSPACE_ID": "workspace_id",
      "env.APP_CAPSULE_ID": "capsule_id",
    });
  }
});
