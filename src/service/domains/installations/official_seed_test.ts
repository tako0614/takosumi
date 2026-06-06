import { expect, test } from "bun:test";

import {
  installConfigIdForName,
  installConfigIdForTemplate,
  officialInstallConfigs,
  seedOfficialInstallConfigs,
} from "./official_seed.ts";
import { defaultTemplateRegistry } from "../templates/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";

const NOW = () => new Date("2026-06-06T00:00:00.000Z");

// The three named first-party installs (spec §10) bind these templates.
const NAMED = [
  { name: "core", templateId: "core", installType: "core" },
  {
    name: "talk",
    templateId: "cloudflare-worker-service",
    installType: "opentofu_module",
  },
  {
    name: "files",
    templateId: "cloudflare-r2-storage",
    installType: "opentofu_module",
  },
] as const;

test("officialInstallConfigs seeds the named installs + a generic config per other template", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const templates = defaultTemplateRegistry.list();
  // One config per template: 3 named (over 3 distinct templates) + generic for
  // every remaining template. Total == template count (no template is doubled).
  expect(configs.length).toBe(templates.length);
  for (const config of configs) {
    expect(config.trustLevel).toBe("official");
    expect(config.spaceId).toBeUndefined();
    expect(config.templateBinding).toBeDefined();
    expect(config.createdAt).toBe("2026-06-06T00:00:00.000Z");
  }
});

test("the named first-party installs carry friendly names, ids, and §10 install types", () => {
  const configs = officialInstallConfigs({ now: NOW });
  for (const named of NAMED) {
    const config = configs.find((c) => c.name === named.name);
    expect(config?.id).toBe(installConfigIdForName(named.name));
    expect(config?.installType).toBe(named.installType);
    expect(config?.templateBinding?.templateId).toBe(named.templateId);
  }
  // core is the only `core` install type; talk/files are opentofu_module.
  const core = configs.find((c) => c.name === "core");
  expect(core?.installType).toBe("core");
});

test("a template bound by a named install does not also get a generic config", () => {
  const configs = officialInstallConfigs({ now: NOW });
  // The cloudflare-worker-service template is bound as `talk`; there must be no
  // separate `cfg-official-cloudflare-worker-service` config alongside it.
  expect(
    configs.find(
      (c) => c.id === installConfigIdForTemplate("cloudflare-worker-service"),
    ),
  ).toBeUndefined();
  expect(configs.filter((c) => c.templateBinding?.templateId ===
    "cloudflare-worker-service")).toHaveLength(1);
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
    expect(config?.templateBinding?.templateVersion).toBe(template.version);
  }
});

test("seeded config output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "files",
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(config?.outputAllowlist[name]?.from).toBe(spec.from);
    expect(config?.outputAllowlist[name]?.type).toBe("string");
  }
});

test("seeded config policy mirrors the template policy spec", () => {
  const template = defaultTemplateRegistry.require("cloudflare-r2-storage", "1.0.0");
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.name === "files",
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
  // The named first-party installs are reachable by their friendly id.
  for (const named of NAMED) {
    const fetched = await store.getInstallConfig(installConfigIdForName(named.name));
    expect(fetched?.installType).toBe(named.installType);
    expect(fetched?.name).toBe(named.name);
  }
});
