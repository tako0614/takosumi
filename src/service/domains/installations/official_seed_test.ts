import { expect, test } from "bun:test";

import {
  installConfigIdForTemplate,
  officialInstallConfigs,
  seedOfficialInstallConfigs,
} from "./official_seed.ts";
import { defaultTemplateRegistry } from "../templates/mod.ts";
import { InMemoryOpenTofuDeploymentStore } from "../deploy-control/store.ts";

const NOW = () => new Date("2026-06-06T00:00:00.000Z");

test("officialInstallConfigs derives one official config per catalog template", () => {
  const configs = officialInstallConfigs({ now: NOW });
  const templates = defaultTemplateRegistry.list();
  expect(configs.length).toBe(templates.length);
  for (const config of configs) {
    expect(config.trustLevel).toBe("official");
    expect(config.installType).toBe("opentofu_module");
    expect(config.spaceId).toBeUndefined();
    expect(config.templateBinding).toBeDefined();
    expect(config.createdAt).toBe("2026-06-06T00:00:00.000Z");
  }
});

test("each seeded config id is stable and template-derived", () => {
  for (const template of defaultTemplateRegistry.list()) {
    const expected = installConfigIdForTemplate(template.id);
    expect(expected).toBe(`cfg-official-${template.id}`);
    const config = officialInstallConfigs({ now: NOW }).find(
      (c) => c.templateBinding?.templateId === template.id,
    );
    expect(config?.id).toBe(expected);
    expect(config?.templateBinding?.templateVersion).toBe(template.version);
  }
});

test("seeded config output allowlist mirrors the template public outputs", () => {
  const template = defaultTemplateRegistry.list()[0]!;
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.templateBinding?.templateId === template.id,
  );
  for (const [name, spec] of Object.entries(template.outputs.public)) {
    expect(config?.outputAllowlist[name]?.from).toBe(spec.from);
    expect(config?.outputAllowlist[name]?.type).toBe("string");
  }
});

test("seeded config policy mirrors the template policy spec", () => {
  const template = defaultTemplateRegistry.list()[0]!;
  const config = officialInstallConfigs({ now: NOW }).find(
    (c) => c.templateBinding?.templateId === template.id,
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

test("seedOfficialInstallConfigs persists every catalog config (idempotent)", async () => {
  const store = new InMemoryOpenTofuDeploymentStore();
  await seedOfficialInstallConfigs(store, { now: NOW });
  const templates = defaultTemplateRegistry.list();
  const persisted = await store.listInstallConfigs();
  expect(persisted.length).toBe(templates.length);
  // Re-seeding is an idempotent upsert by the derived id, not a duplicate.
  await seedOfficialInstallConfigs(store, { now: NOW });
  expect((await store.listInstallConfigs()).length).toBe(templates.length);
  for (const template of templates) {
    const fetched = await store.getInstallConfig(
      installConfigIdForTemplate(template.id),
    );
    expect(fetched?.installType).toBe("opentofu_module");
  }
});
