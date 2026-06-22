import { describe, expect, test } from "bun:test";
import { CATALOG } from "../../../dashboard/src/catalog.ts";
import { officialInstallConfigs } from "../../../core/domains/installations/official_seed.ts";
import { defaultTemplateRegistry } from "../../../core/domains/templates/mod.ts";

describe("dashboard catalog", () => {
  test("curated install entries are pinned to immutable refs", () => {
    for (const entry of CATALOG) {
      expect(entry.ref, entry.id).toMatch(/^[0-9a-f]{40}$/);
      expect(["main", "latest", "HEAD"]).not.toContain(entry.ref);
    }
  });

  test("product distributions are not generic Takosumi starter cards", () => {
    expect(CATALOG.map((entry) => entry.id)).not.toContain("takos");
  });

  test("the first Worker starter is browser-openable after apply", () => {
    const hello = CATALOG.find(
      (entry) => entry.id === "cloudflare-hello-worker",
    );
    expect(hello).toBeDefined();
    expect(hello?.description.en.toLowerCase()).toContain("workers.dev");
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

  test("catalog keeps hostable services first and building blocks secondary", () => {
    const services = CATALOG.filter((entry) => entry.surface === "service");
    const buildingBlocks = CATALOG.filter(
      (entry) => entry.surface === "building_block",
    );
    expect(services.map((entry) => entry.id)).toEqual([
      "cloudflare-hello-worker",
      "cloudflare-static-site",
    ]);
    expect(buildingBlocks.map((entry) => entry.id)).toEqual([
      "cloudflare-r2-storage",
      "aws-s3-storage",
    ]);
  });

  test("visible cards resolve to seeded official template configs", () => {
    const seededConfigs = officialInstallConfigs();
    for (const entry of CATALOG) {
      const config = seededConfigs.find(
        (seeded) => seeded.id === entry.installConfigId,
      );
      expect(config, entry.id).toBeDefined();
      expect(config?.sourceKind).toBe("first_party_capsule");
      expect(config?.templateBinding, entry.id).toBeDefined();
      expect(config?.templateBinding?.templateId).toBe(entry.id);
      const template = defaultTemplateRegistry.require(
        config!.templateBinding!.templateId,
        config!.templateBinding!.templateVersion,
      );
      for (const field of entry.inputs) {
        expect(
          Object.keys(template.inputs),
          `${entry.id}.${field.name}`,
        ).toContain(field.name);
      }
      for (const [name, input] of Object.entries(template.inputs)) {
        if (input.required) {
          expect(
            entry.inputs.map((field) => field.name),
            `${entry.id}.${name}`,
          ).toContain(name);
        }
      }
    }
  });
});
