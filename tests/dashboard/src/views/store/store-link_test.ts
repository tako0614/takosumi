import { describe, expect, test } from "bun:test";
import { buildNewQuery } from "../../../../../dashboard/src/views/store/store-link.ts";
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
});
