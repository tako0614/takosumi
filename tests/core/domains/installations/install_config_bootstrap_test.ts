import { expect, test } from "bun:test";

import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS,
  installConfigIdForName,
  installConfigIdForTemplate,
  builtInInstallConfigs,
  bootstrapInstallConfigs,
} from "../../../../core/domains/capsules/install_config_bootstrap.ts";
import { defaultTemplateRegistry } from "../../../../core/domains/templates/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = () => new Date("2026-06-06T00:00:00.000Z");

const NAMED = [
  { name: "core", templateId: "core", installType: "core" },
] as const;

test("builtInInstallConfigs returns the generic Capsule default + first-party template configs", () => {
  const configs = builtInInstallConfigs({ now: NOW });
  const templates = defaultTemplateRegistry.list();
  // One generic Capsule config plus one config per template (except templates
  // already bound by a named alias, currently only core).
  expect(configs.length).toBe(templates.length + 1);
  const generic = configs[0];
  expect(generic?.id).toBe(DEFAULT_CAPSULE_INSTALL_CONFIG_ID);
  expect(generic?.sourceKind).toBe("generic_capsule");
  expect(generic?.templateBinding).toBeUndefined();
  expect(generic?.trustLevel).toBe("trusted");
  expect(generic?.outputAllowlist).toEqual({
    launch_url: { from: "launch_url", type: "url" },
    url: { from: "url", type: "url" },
    public_url: { from: "public_url", type: "url" },
    api_url: { from: "api_url", type: "url" },
    app_deployment: { from: "app_deployment", type: "json" },
    service_exports: { from: "service_exports", type: "json" },
    worker_name: { from: "worker_name", type: "string" },
  });
  for (const config of configs) {
    expect(config.spaceId).toBeUndefined();
    expect(config.createdAt).toBe("2026-06-06T00:00:00.000Z");
  }
});

test("the named built-in aliases carry friendly names, ids, and §10 install types without talk/files", () => {
  const configs = builtInInstallConfigs({ now: NOW });
  for (const named of NAMED) {
    const config = configs.find((c) => c.name === named.name);
    expect(config?.id).toBe(installConfigIdForName(named.name));
    expect(config?.installType).toBe(named.installType);
    expect(config?.templateBinding?.templateId).toBe(named.templateId);
    expect(config?.sourceKind).toBe("first_party_capsule");
  }
  expect(configs.find((c) => c.name === "talk")).toBeUndefined();
  expect(configs.find((c) => c.name === "files")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-built-in-talk")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-built-in-files")).toBeUndefined();
  // core is the only `core` install type.
  const core = configs.find((c) => c.name === "core");
  expect(core?.installType).toBe("core");
});

test("a template bound by a named install does not also get a generic config", () => {
  const configs = builtInInstallConfigs({ now: NOW });
  // The core template is bound as `core`; there must be exactly one config over
  // that template surface.
  expect(
    configs.filter((c) => c.templateBinding?.templateId === "core"),
  ).toHaveLength(1);
});

test("generic per-template configs keep installType opentofu_module + a template-derived id", () => {
  const configs = builtInInstallConfigs({ now: NOW });
  const namedTemplateIds = new Set(NAMED.map((n) => n.templateId));
  for (const template of defaultTemplateRegistry.list()) {
    if (namedTemplateIds.has(template.id)) continue;
    const config = configs.find(
      (c) => c.id === installConfigIdForTemplate(template.id),
    );
    expect(config?.installType).toBe("opentofu_module");
    expect(config?.name).toBe(template.id);
    expect(config?.sourceKind).toBe("first_party_capsule");
    expect(config?.templateBinding?.templateVersion).toBe(template.version);
  }
});

test("hostable built-in configs expose public store metadata for the dashboard", () => {
  const configs = builtInInstallConfigs({ now: NOW });
  const storeTemplateIds = configs
    .map((config) => config.store?.templateId)
    .filter(Boolean);
  expect(storeTemplateIds).toEqual(["cloudflare-hello-worker"]);
  expect(
    configs
      .map((config) => config.store?.order)
      .filter((order): order is number => order !== undefined)
      .sort((a, b) => a - b),
  ).toEqual([10]);

  const hello = configs.find(
    (config) => config.store?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.store?.source?.git).toBe(
    "https://github.com/tako0614/takosumi.git",
  );
  expect(hello?.store?.source).not.toHaveProperty("ref");
  expect(hello?.store?.source?.path).toBe(
    "providers/cloudflare/modules/cloudflare-hello-worker/module",
  );
  expect(hello?.store?.inputs.map((input) => input.name)).toContain(
    "workersSubdomain",
  );
  expect(hello?.store?.name.ja).toBe("Webアプリを公開");
  expect(hello?.store?.surface).toBe("service");

  const hidden = configs.find((config) => config.name === "core");
  expect(hidden?.store).toBeUndefined();

  for (const id of NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS) {
    expect(configs.find((config) => config.id === id)).toBeUndefined();
  }
});

test("built-in store source can be operator-selected without owning a Git ref", () => {
  const configs = builtInInstallConfigs({
    now: NOW,
    builtInStoreSource: {
      git: "https://github.com/example/takosumi-release.git",
    },
  });
  const hello = configs.find(
    (config) => config.store?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.store?.source?.git).toBe(
    "https://github.com/example/takosumi-release.git",
  );
  expect(hello?.store?.source).not.toHaveProperty("ref");
});

test("bootstrap config output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-hello-worker",
    "1.0.0",
  );
  const config = builtInInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-hello-worker",
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(config?.outputAllowlist[name]?.from).toBe(spec.from);
    expect(config?.outputAllowlist[name]?.type).toBe("string");
  }
});

test("bootstrap config policy mirrors the template policy spec", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-hello-worker",
    "1.0.0",
  );
  const config = builtInInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-hello-worker",
  );
  expect(config?.policy.allowedProviders).toEqual(
    template.policy.allowedProviders,
  );
  expect(config?.policy.allowedResourceTypes).toEqual(
    template.policy.allowedResourceTypes,
  );
  expect(config?.policy.destructiveChanges?.requireExplicitConfirmation).toBe(
    template.policy.destructiveChanges.requireExplicitConfirmation,
  );
});

test("bootstrapInstallConfigs persists every built-in config (idempotent)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await bootstrapInstallConfigs(store, { now: NOW });
  const expected = builtInInstallConfigs({ now: NOW });
  const persisted = await store.listInstallConfigs();
  expect(persisted.length).toBe(expected.length);
  // Bootstrapping is an idempotent upsert by the derived id, not a duplicate.
  await bootstrapInstallConfigs(store, { now: NOW });
  expect((await store.listInstallConfigs()).length).toBe(expected.length);
  expect(
    (await store.getInstallConfig(DEFAULT_CAPSULE_INSTALL_CONFIG_ID))
      ?.sourceKind,
  ).toBe("generic_capsule");
  // The named built-in alias is reachable by its friendly id.
  for (const named of NAMED) {
    const fetched = await store.getInstallConfig(
      installConfigIdForName(named.name),
    );
    expect(fetched?.installType).toBe(named.installType);
    expect(fetched?.name).toBe(named.name);
  }
});
