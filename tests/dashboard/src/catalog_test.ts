import { describe, expect, test } from "bun:test";
import { firstPartyStoreListings } from "../../../dashboard/src/views/store/first-party-listings.ts";
import { buildNewQuery } from "../../../dashboard/src/views/store/store-link.ts";
import { officialInstallConfigs } from "../../../core/domains/capsules/official_seed.ts";
import { defaultTemplateRegistry } from "../../../core/domains/templates/mod.ts";

describe("dashboard catalog", () => {
  const catalogEntries = () =>
    officialInstallConfigs()
      .filter((config) => config.catalog)
      .map((config) => ({
        installConfigId: config.id,
        ...config.catalog!,
      }));

  test("curated install entries are pinned to immutable refs", () => {
    for (const entry of catalogEntries()) {
      expect(entry.source?.ref, entry.templateId).toMatch(/^[0-9a-f]{40}$/);
      expect(["main", "latest", "HEAD"]).not.toContain(entry.source?.ref);
    }
  });

  test("product distributions are not generic Takosumi starter cards", () => {
    expect(catalogEntries().map((entry) => entry.templateId)).not.toContain(
      "takos",
    );
  });

  test("the internal web app template is browser-openable after apply", () => {
    const hello = catalogEntries().find(
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

  test("internal starter catalog stays narrow and template-backed", () => {
    const entries = catalogEntries();
    const services = entries.filter((entry) => entry.surface === "service");
    const buildingBlocks = entries.filter(
      (entry) => entry.surface === "building_block",
    );
    expect(
      services
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.templateId),
    ).toEqual(["cloudflare-hello-worker"]);
    expect(buildingBlocks).toEqual([]);
    expect(entries.some((entry) => entry.surface === "example")).toBe(false);
  });

  test("primary catalog services stay inside the Cloudflare Workers provider compatibility MVP surface", () => {
    const compatMvpResourceTypes = new Set([
      "cloudflare_workers_script",
      "cloudflare_workers_script_subdomain",
      "cloudflare_workers_route",
      "cloudflare_workers_kv_namespace",
      "cloudflare_r2_bucket",
      "cloudflare_d1_database",
    ]);
    const seededConfigs = officialInstallConfigs();
    for (const entry of catalogEntries().filter(
      (catalogEntry) => catalogEntry.surface === "service",
    )) {
      const config = seededConfigs.find(
        (seeded) => seeded.id === entry.installConfigId,
      );
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

  test("starter catalog entries resolve to seeded official template configs", () => {
    const seededConfigs = officialInstallConfigs();
    for (const entry of catalogEntries()) {
      const config = seededConfigs.find(
        (seeded) => seeded.id === entry.installConfigId,
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

  test("/new first-party listings show actual apps instead of generic templates", () => {
    expect(firstPartyStoreListings.map((listing) => listing.id).sort()).toEqual(
      ["takos", "yurucommu"],
    );
    expect(
      firstPartyStoreListings.map((listing) => [
        listing.id,
        listing.kind,
        listing.source.git,
        listing.source.ref,
        listing.source.path,
      ]),
    ).toEqual([
      [
        "yurucommu",
        "app",
        "https://github.com/tako0614/yurucommu.git",
        "master",
        ".",
      ],
      [
        "takos",
        "app",
        "https://github.com/tako0614/takos.git",
        "main",
        "deploy/opentofu",
      ],
    ]);
    for (const listing of firstPartyStoreListings) {
      expect(
        listing.source.resolvedCommit,
        `${listing.id} resolved commit`,
      ).toMatch(/^[0-9a-f]{40}$/);
      expect(
        new URLSearchParams(buildNewQuery(listing)).get("ref"),
        `${listing.id} install handoff ref`,
      ).toBe(listing.source.resolvedCommit);
    }
    expect(
      firstPartyStoreListings.some((listing) =>
        listing.name.ja.includes("Webアプリを公開"),
      ),
    ).toBe(false);
    expect(
      firstPartyStoreListings.some(
        (listing) => listing.id === "cloudflare-hello-worker",
      ),
    ).toBe(false);
  });
});
