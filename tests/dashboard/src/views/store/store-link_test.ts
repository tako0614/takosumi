import { describe, expect, test } from "bun:test";
import { buildNewQuery } from "../../../../../dashboard/src/views/store/store-link.ts";
import type { TcsListing } from "../../../../../dashboard/src/lib/tcs-client.ts";

const text = (value: string) => ({ ja: value, en: value });

function listing(extra: Partial<TcsListing> = {}): TcsListing {
  return {
    id: "installable-worker",
    source: {
      git: "https://github.com/tako0614/takosumi-template.git",
      // Runtime compatibility: older external store nodes may still include a
      // ref-like property, but Store handoff must not make it authoritative.
      ref: "0123456789abcdef0123456789abcdef01234567",
      path: "modules/worker",
    } as unknown as TcsListing["source"],
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
  test("store listings hand off as Git sources", () => {
    const query = buildNewQuery(
      listing({
        primaryServer: "https://store.takosumi.com/",
      }),
    );
    const params = new URLSearchParams(query);
    expect(params.has("installConfigId")).toBe(false);
    expect(params.get("tcsBase")).toBe("https://store.takosumi.com/");
    expect(params.get("tcsListing")).toBe("installable-worker");
    expect(params.get("git")).toBe(
      "https://github.com/tako0614/takosumi-template.git",
    );
    expect(params.has("ref")).toBe(false);
    expect(params.get("path")).toBe("modules/worker");
    expect(params.has("var.project_name")).toBe(false);
  });

  test("external TCS listings still hand off as explicit Git sources", () => {
    const query = buildNewQuery(
      listing({ primaryServer: "https://store.takosumi.com/" }),
    );
    const params = new URLSearchParams(query);
    expect(params.get("tcsBase")).toBe("https://store.takosumi.com/");
    expect(params.get("tcsListing")).toBe("installable-worker");
    expect(params.get("git")).toBe(
      "https://github.com/tako0614/takosumi-template.git",
    );
    expect(params.has("ref")).toBe(false);
    expect(params.get("path")).toBe("modules/worker");
    expect(params.has("var.project_name")).toBe(false);
  });

  test("listing setup defaults stay out of the store handoff URL", () => {
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
    expect(params.has("varjson.enable_cloudflare_resources")).toBe(false);
    expect(params.has("varjson.replicas")).toBe(false);
    expect(params.has("varjson.release_container_images")).toBe(false);
    expect(params.has("var.enable_cloudflare_resources")).toBe(false);
  });
});
