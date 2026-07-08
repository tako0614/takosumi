import { describe, expect, test } from "bun:test";
import {
  NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS,
  builtInInstallConfigs,
} from "../../../core/domains/capsules/install_config_bootstrap.ts";
import { defaultTemplateRegistry } from "../../../core/domains/templates/mod.ts";

describe("dashboard store", () => {
  const storeEntries = () =>
    builtInInstallConfigs()
      .filter((config) => config.store)
      .map((config) => ({
        installConfigId: config.id,
        ...config.store!,
      }));

  test("built-in store entries announce repositories without owning release refs", () => {
    for (const entry of storeEntries()) {
      expect(entry.source?.git).toMatch(/^https:\/\/github\.com\//);
      expect(entry.source?.path).toBeTruthy();
      expect(entry.source).not.toHaveProperty("ref");
    }
  });

  test("product distributions are not seeded as generic Takosumi template cards", () => {
    const builtInConfigs = builtInInstallConfigs();
    for (const id of NONSELECTABLE_REPOSITORY_STORE_INSTALL_CONFIG_IDS) {
      expect(builtInConfigs.find((config) => config.id === id)).toBeUndefined();
    }
  });

  test("the internal web app template is browser-openable after apply", () => {
    const hello = storeEntries().find(
      (entry) => entry.templateId === "cloudflare-hello-worker",
    );
    expect(hello).toBeDefined();
    expect(hello?.surface).toBe("service");
    expect(hello?.description.en.toLowerCase()).toContain("public url");
    expect(
      hello?.inputs.map((field) => [field.name, field.required]),
    ).toContainEqual(["workersSubdomain", true]);
    const template = defaultTemplateRegistry.require(
      "cloudflare-hello-worker",
      "1.0.0",
    );
    expect(template.policy.allowedResourceTypes).toContain(
      "cloudflare_workers_script_subdomain",
    );
    expect(template.outputs.public.url?.from).toBe("url");
  });

  test("internal store view stays narrow and template-backed", () => {
    const entries = storeEntries();
    const services = entries.filter((entry) => entry.surface === "service");
    const buildingBlocks = entries.filter(
      (entry) => entry.surface === "building_block",
    );
    expect(
      services
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.templateId ?? entry.installConfigId),
    ).toEqual(["cloudflare-hello-worker"]);
    expect(buildingBlocks).toEqual([]);
    expect(entries.some((entry) => entry.surface === "example")).toBe(false);
  });

  test("primary store services stay inside the Cloudflare Workers provider compatibility MVP surface", () => {
    const compatMvpResourceTypes = new Set([
      "cloudflare_workers_script",
      "cloudflare_workers_script_subdomain",
      "cloudflare_workers_route",
      "cloudflare_workers_kv_namespace",
      "cloudflare_r2_bucket",
      "cloudflare_d1_database",
    ]);
    const builtInConfigs = builtInInstallConfigs();
    for (const entry of storeEntries().filter(
      (storeEntry) => storeEntry.surface === "service",
    )) {
      const config = builtInConfigs.find(
        (builtIn) => builtIn.id === entry.installConfigId,
      );
      if (!config?.templateBinding) continue;
      const template = defaultTemplateRegistry.require(
        config!.templateBinding!.templateId,
        config!.templateBinding!.templateVersion,
      );
      expect(
        template.policy.allowedResourceTypes.every((resourceType) =>
          compatMvpResourceTypes.has(resourceType),
        ),
        entry.templateId,
      ).toBe(true);
    }
  });

  test("store view entries resolve to built-in template configs", () => {
    const builtInConfigs = builtInInstallConfigs();
    for (const entry of storeEntries()) {
      const config = builtInConfigs.find(
        (builtIn) => builtIn.id === entry.installConfigId,
      );
      expect(config, entry.templateId).toBeDefined();
      expect(config?.sourceKind).toBe("first_party_capsule");
      expect(config?.templateBinding, entry.templateId).toBeDefined();
      expect(config?.templateBinding?.templateId).toBe(entry.templateId);
      const template = defaultTemplateRegistry.require(
        config!.templateBinding!.templateId,
        config!.templateBinding!.templateVersion,
      );
      for (const field of entry.inputs) {
        expect(
          Object.keys(template.inputs),
          `${entry.templateId}.${field.name}`,
        ).toContain(field.name);
      }
      for (const [name, input] of Object.entries(template.inputs)) {
        if (input.required) {
          expect(
            entry.inputs.map((field) => field.name),
            `${entry.templateId}.${name}`,
          ).toContain(name);
        }
      }
    }
  });
});
