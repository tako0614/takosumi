import { expect, test } from "bun:test";

import {
  DEFAULT_CAPSULE_INSTALL_CONFIG_ID,
  installConfigIdForName,
  installConfigIdForTemplate,
  officialInstallConfigs,
  seedOfficialInstallConfigs,
} from "../../../../core/domains/installations/official_seed.ts";
import { defaultTemplateRegistry } from "../../../../core/domains/templates/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../../../../core/domains/deploy-control/store.ts";

const NOW = () => new Date("2026-06-06T00:00:00.000Z");

const NAMED = [
  { name: "core", templateId: "core", installType: "core" },
] as const;

test("officialInstallConfigs seeds the generic Capsule default + first-party template configs", () => {
  const configs = officialInstallConfigs({ now: NOW });
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
    url: { from: "url", type: "url" },
    worker_name: { from: "worker_name", type: "string" },
  });
  for (const config of configs) {
    expect(config.spaceId).toBeUndefined();
    expect(config.createdAt).toBe("2026-06-06T00:00:00.000Z");
  }
});

test("the named official aliases carry friendly names, ids, and §10 install types without talk/files", () => {
  const configs = officialInstallConfigs({ now: NOW });
  for (const named of NAMED) {
    const config = configs.find((c) => c.name === named.name);
    expect(config?.id).toBe(installConfigIdForName(named.name));
    expect(config?.installType).toBe(named.installType);
    expect(config?.templateBinding?.templateId).toBe(named.templateId);
    expect(config?.sourceKind).toBe("first_party_capsule");
  }
  expect(configs.find((c) => c.name === "talk")).toBeUndefined();
  expect(configs.find((c) => c.name === "files")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-official-talk")).toBeUndefined();
  expect(configs.find((c) => c.id === "cfg-official-files")).toBeUndefined();
  // core is the only `core` install type.
  const core = configs.find((c) => c.name === "core");
  expect(core?.installType).toBe("core");
});

test("a template bound by a named install does not also get a generic config", () => {
  const configs = officialInstallConfigs({ now: NOW });
  // The core template is bound as `core`; there must be exactly one config over
  // that template surface.
  expect(
    configs.filter((c) => c.templateBinding?.templateId === "core"),
  ).toHaveLength(1);
});

test("generic per-template configs keep installType opentofu_module + a template-derived id", () => {
  const configs = officialInstallConfigs({ now: NOW });
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

test("hostable official configs expose public catalog metadata for the dashboard", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const catalogTemplateIds = configs
    .map((config) => config.catalog?.templateId)
    .filter(Boolean);
  expect(catalogTemplateIds).toEqual([
    "cloudflare-hello-worker",
    "cloudflare-r2-storage",
    "aws-s3-storage",
  ]);
  expect(
    configs
      .map((config) => config.catalog?.order)
      .filter((order): order is number => order !== undefined),
  ).toEqual([10, 30, 40]);

  const hello = configs.find(
    (config) => config.catalog?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.catalog?.source?.git).toBe(
    "https://github.com/tako0614/takosumi.git",
  );
  expect(hello?.catalog?.source?.ref).toMatch(/^[0-9a-f]{40}$/);
  expect(hello?.catalog?.source?.path).toBe(
    "providers/cloudflare/modules/cloudflare-hello-worker/module",
  );
  expect(hello?.catalog?.inputs.map((input) => input.name)).toContain(
    "workersSubdomain",
  );
  expect(hello?.catalog?.name.ja).toBe("Webアプリを公開");
  expect(hello?.catalog?.surface).toBe("service");

  const hidden = configs.find((config) => config.name === "core");
  expect(hidden?.catalog).toBeUndefined();
});

test("official catalog source can be operator-selected without changing templates", () => {
  const configs = officialInstallConfigs({
    now: NOW,
    officialCatalogSource: {
      git: "https://github.com/example/takosumi-release.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
    },
  });
  const hello = configs.find(
    (config) => config.catalog?.templateId === "cloudflare-hello-worker",
  );
  expect(hello?.catalog?.source?.git).toBe(
    "https://github.com/example/takosumi-release.git",
  );
  expect(hello?.catalog?.source?.ref).toBe(
    "0123456789abcdef0123456789abcdef01234567",
  );
});

test("seeded config output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-r2-storage",
    "1.0.0",
  );
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-r2-storage",
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(config?.outputAllowlist[name]?.from).toBe(spec.from);
    expect(config?.outputAllowlist[name]?.type).toBe("string");
  }
});

test("seeded config policy mirrors the template policy spec", () => {
  const template = defaultTemplateRegistry.require(
    "cloudflare-r2-storage",
    "1.0.0",
  );
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "cloudflare-r2-storage",
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

test("seedOfficialInstallConfigs persists every official config (idempotent)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedOfficialInstallConfigs(store, { now: NOW });
  const expected = officialInstallConfigs({ now: NOW });
  const persisted = await store.listInstallConfigs();
  expect(persisted.length).toBe(expected.length);
  // Re-seeding is an idempotent upsert by the derived id, not a duplicate.
  await seedOfficialInstallConfigs(store, { now: NOW });
  expect((await store.listInstallConfigs()).length).toBe(expected.length);
  expect(
    (await store.getInstallConfig(DEFAULT_CAPSULE_INSTALL_CONFIG_ID))
      ?.sourceKind,
  ).toBe("generic_capsule");
  // The named official alias is reachable by its friendly id.
  for (const named of NAMED) {
    const fetched = await store.getInstallConfig(
      installConfigIdForName(named.name),
    );
    expect(fetched?.installType).toBe(named.installType);
    expect(fetched?.name).toBe(named.name);
  }
});
