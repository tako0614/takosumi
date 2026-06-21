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

  test("starter copy does not imply a public URL is always produced", () => {
    const hello = CATALOG.find(
      (entry) => entry.id === "cloudflare-hello-worker",
    );
    expect(hello?.description.en.toLowerCase()).not.toContain(
      "public url is output",
    );
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
