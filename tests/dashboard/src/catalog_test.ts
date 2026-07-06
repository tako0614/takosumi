import { describe, expect, test } from "bun:test";
import { installableAppStoreListings } from "../../../dashboard/src/views/store/installable-app-listings.ts";
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

  test("product distributions are not generic Takosumi template cards", () => {
    const builtInConfigs = officialInstallConfigs();
    const productConfigs = builtInConfigs.filter((config) =>
      ["cfg-catalog-yurucommu", "cfg-catalog-takos"].includes(config.id),
    );
    expect(productConfigs.map((config) => config.sourceKind)).toEqual([
      "generic_capsule",
      "generic_capsule",
    ]);
    expect(
      productConfigs.every((config) => config.templateBinding === undefined),
    ).toBe(true);
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

  test("internal template catalog stays narrow and template-backed", () => {
    const entries = catalogEntries();
    const services = entries.filter((entry) => entry.surface === "service");
    const buildingBlocks = entries.filter(
      (entry) => entry.surface === "building_block",
    );
    expect(
      services
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.templateId ?? entry.installConfigId),
    ).toEqual([
      "cloudflare-hello-worker",
      "cfg-catalog-yurucommu",
      "cfg-catalog-takos",
    ]);
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
    const builtInConfigs = officialInstallConfigs();
    for (const entry of catalogEntries().filter(
      (catalogEntry) => catalogEntry.surface === "service",
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

  test("template catalog entries resolve to built-in template configs", () => {
    const builtInConfigs = officialInstallConfigs();
    for (const entry of catalogEntries()) {
      const config = builtInConfigs.find(
        (builtIn) => builtIn.id === entry.installConfigId,
      );
      if (!config?.templateBinding) continue;
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

  test("/new installable app listings show actual apps instead of generic templates", () => {
    expect(
      installableAppStoreListings.map((listing) => listing.id).sort(),
    ).toEqual(["takos", "yurucommu"]);
    expect(
      installableAppStoreListings.map((listing) => [
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
        "main",
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
    for (const listing of installableAppStoreListings) {
      expect(listing.provider).toBe("cloudflare");
      expect(listing.badge.ja).toBe("追加候補");
      expect(listing.badge.en).toBe("Installable");
      expect(
        listing.source.resolvedCommit,
        `${listing.id} resolved commit`,
      ).toMatch(/^[0-9a-f]{40}$/);
      expect(
        new URLSearchParams(buildNewQuery(listing)).get("ref"),
        `${listing.id} install handoff ref`,
      ).toBeNull();
      expect(
        new URLSearchParams(buildNewQuery(listing)).get("installConfigId"),
        `${listing.id} install handoff config`,
      ).toBe(listing.installConfigId);
    }
    const takos = installableAppStoreListings.find(
      (listing) => listing.id === "takos",
    );
    const releaseImagesDefault = takos?.inputs.find(
      (input) => input.name === "release_container_images",
    )?.defaultValue;
    expect(releaseImagesDefault).toContain("0.10.0-3cfcc10f7ad1");
    expect(releaseImagesDefault).not.toContain("0.10.0-bfdd9f8bb79c");
    expect(
      installableAppStoreListings.some((listing) =>
        listing.name.ja.includes("Webアプリを公開"),
      ),
    ).toBe(false);
    expect(
      installableAppStoreListings.some(
        (listing) => listing.id === "cloudflare-hello-worker",
      ),
    ).toBe(false);
  });
});
