import { describe, expect, test } from "bun:test";
import { buildNewQuery } from "../../../../../dashboard/src/views/store/store-link.ts";
import { installableAppStoreListings } from "../../../../../dashboard/src/views/store/installable-app-listings.ts";
import type { TcsListing } from "../../../../../dashboard/src/lib/tcs-client.ts";

const text = (value: string) => ({ ja: value, en: value });

function listing(extra: Partial<TcsListing> = {}): TcsListing {
  return {
    id: "installable-worker",
    source: {
      git: "https://github.com/tako0614/takosumi-template.git",
      ref: "0123456789abcdef0123456789abcdef01234567",
      path: "modules/worker",
    },
    kind: "worker",
    surface: "service",
    provider: "cloudflare",
    category: "service",
    suggestedName: "my-app",
    name: text("Web app"),
    description: text("Deploy a web app"),
    badge: text("Web app"),
    inputs: [
      {
        name: "project_name",
        label: text("Project"),
        defaultValue: "service-name-with-space",
      },
    ],
    outputAllowlist: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("store link handoff", () => {
  test("installConfigId-backed installable listings hand off by InstallConfig id", () => {
    const query = buildNewQuery(
      listing({ installConfigId: "install_cloudflare_worker" }),
    );
    const params = new URLSearchParams(query);
    expect(params.get("installConfigId")).toBe("install_cloudflare_worker");
    expect(params.has("git")).toBe(false);
    expect(params.has("var.project_name")).toBe(false);
  });

  test("external TCS listings still hand off as explicit Git sources", () => {
    const query = buildNewQuery(listing());
    const params = new URLSearchParams(query);
    expect(params.get("git")).toBe(
      "https://github.com/tako0614/takosumi-template.git",
    );
    expect(params.get("ref")).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(params.get("path")).toBe("modules/worker");
    expect(params.get("var.project_name")).toBe("service-name-with-space");
  });

  test("typed listing defaults are handed off as JSON variables", () => {
    const query = buildNewQuery(
      listing({
        inputs: [
          {
            name: "enable_cloudflare_resources",
            type: "boolean",
            label: text("Enabled"),
            defaultValue: "true",
          },
          {
            name: "replicas",
            type: "number",
            label: text("Replicas"),
            defaultValue: "2",
          },
          {
            name: "release_container_images",
            type: "json",
            label: text("Release images"),
            defaultValue:
              '{"runtime":"registry.cloudflare.com/acc/takos-worker-runtime:0.10.0-abcdef","executor":"registry.cloudflare.com/acc/takos-agent-executor:0.10.0-abcdef"}',
          },
        ],
      }),
    );
    const params = new URLSearchParams(query);
    expect(params.get("varjson.enable_cloudflare_resources")).toBe("true");
    expect(params.get("varjson.replicas")).toBe("2");
    expect(params.get("varjson.release_container_images")).toBe(
      '{"runtime":"registry.cloudflare.com/acc/takos-worker-runtime:0.10.0-abcdef","executor":"registry.cloudflare.com/acc/takos-agent-executor:0.10.0-abcdef"}',
    );
    expect(params.has("var.enable_cloudflare_resources")).toBe(false);
  });

  test("yurucommu handoff carries the Worker artifact inputs for OpenTofu", () => {
    const yurucommu = installableAppStoreListings.find(
      (entry) => entry.id === "yurucommu",
    );
    expect(yurucommu).toBeDefined();
    const params = new URLSearchParams(buildNewQuery(yurucommu!));

    expect(params.get("git")).toBe("https://github.com/tako0614/yurucommu.git");
    expect(params.get("ref")).toBe("1fe727f1843c0c4a91fece16cbc73950225e078d");
    expect(params.get("varjson.enable_cloudflare_resources")).toBe("true");
    expect(params.get("varjson.enable_cloudflare_worker_script")).toBe("true");
    expect(params.get("var.worker_bundle_url")).toBe(
      "https://github.com/tako0614/yurucommu-core/releases/download/v2.0.0/takos-worker.js",
    );
    expect(params.get("var.worker_bundle_sha256")).toBe(
      "5a5713b2cc548414951c51a469b32bdba756d2101933575d0ab230131eaa8c95",
    );
  });

  test("takos handoff carries release container images for operator activation", () => {
    const takos = installableAppStoreListings.find(
      (entry) => entry.id === "takos",
    );
    expect(takos).toBeDefined();
    const params = new URLSearchParams(buildNewQuery(takos!));

    expect(params.get("git")).toBe("https://github.com/tako0614/takos.git");
    expect(params.get("ref")).toBe("8157ba6cfe8036fbcf5c7ac4cad718c47ce111b8");
    const rawImages = params.get("varjson.release_container_images");
    expect(rawImages).toBeTruthy();
    const images = JSON.parse(rawImages!);
    expect(images).toEqual({
      runtime:
        "registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-worker-runtime:0.10.0-bfdd9f8bb79c",
      executor:
        "registry.cloudflare.com/a10162d23653f1ad1193dabf520a5dd0/takos-agent-executor:0.10.0-bfdd9f8bb79c",
    });
  });
});
