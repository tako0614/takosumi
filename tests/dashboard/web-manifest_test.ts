/**
 * The dashboard can be added to a phone's home screen: one web app manifest
 * linked from index.html, served as a data-free public file, allowed by the
 * dashboard CSP, with icons whose files really have the sizes they declare.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classifyPlatformRequestDataAccess } from "../../deploy/platform/request-data-access.ts";

const repositoryRoot = resolve(import.meta.dir, "../..");
const dashboardRoot = resolve(repositoryRoot, "dashboard");
const publicRoot = resolve(dashboardRoot, "public");
const manifestPath = resolve(publicRoot, "manifest.webmanifest");
const html = readFileSync(resolve(dashboardRoot, "index.html"), "utf8");

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  readonly id?: string;
  readonly name?: string;
  readonly short_name?: string;
  readonly start_url?: string;
  readonly scope?: string;
  readonly display?: string;
  readonly theme_color?: string;
  readonly background_color?: string;
  readonly icons?: readonly ManifestIcon[];
};

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): { readonly width: number; readonly height: number } {
  const bytes = readFileSync(path);
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("dashboard web app manifest", () => {
  test("index.html links the manifest", () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });

  test("names Takosumi and opens the dashboard home on its own", () => {
    expect(manifest.name).toBe("Takosumi");
    expect(manifest.short_name).toBe("Takosumi");
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/");
    expect(manifest.display).toBe("standalone");
  });

  test("colors match the page before the stylesheet loads", () => {
    const themeColor = html.match(/<meta name="theme-color" content="(#[0-9a-f]{6})" \/>/u)?.[1];
    const background = html.match(/html,\s*body \{[^}]*background: (#[0-9a-f]{6});/u)?.[1];
    expect(themeColor).toBeDefined();
    expect(background).toBeDefined();
    expect(manifest.theme_color).toBe(themeColor);
    expect(manifest.background_color).toBe(background);
  });

  test("declares 192 and 512 pixel PNG icons whose files have exactly those sizes", () => {
    const icons = manifest.icons ?? [];
    for (const size of ["192x192", "512x512"]) {
      expect(icons.some((icon) => icon.sizes === size && (icon.purpose ?? "any").split(" ").includes("any"))).toBe(true);
    }
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.src.startsWith("/")).toBe(true);
      const file = resolve(publicRoot, `.${icon.src}`);
      expect({ src: icon.src, exists: existsSync(file) }).toEqual({ src: icon.src, exists: true });
      const [width, height] = icon.sizes.split("x").map(Number);
      expect({ src: icon.src, ...pngSize(file) }).toEqual({ src: icon.src, width: width!, height: height! });
    }
  });

  test("the manifest and its icons are public files that need no account data", () => {
    const assets = { fetch: async () => new Response() };
    for (const path of ["/manifest.webmanifest", ...(manifest.icons ?? []).map((icon) => icon.src)]) {
      const access = classifyPlatformRequestDataAccess(new Request(`https://app.example.test${path}`), { ASSETS: assets });
      expect({ path, kind: access.kind }).toEqual({ path, kind: "data-free" });
    }
  });

  test("is served as a web app manifest", () => {
    // The Bun + Postgres distribution serves dashboard/dist through Bun.file;
    // Wrangler's asset upload maps .webmanifest to the same type.
    expect(Bun.file(manifestPath).type).toStartWith("application/manifest+json");
  });

  test("the dashboard CSP lets the page load its manifest and icons", () => {
    const handler = readFileSync(resolve(repositoryRoot, "deploy/accounts-cloudflare/src/handler.ts"), "utf8");
    const policy = handler.match(/const DASHBOARD_CSP =\s*((?:"[^"]*"\s*\+?\s*)+);/u)?.[1]
      ?.match(/"([^"]*)"/gu)
      ?.map((part) => part.slice(1, -1))
      .join("");
    expect(policy).toBeDefined();
    const directives = new Map(
      policy!.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
        const [name, ...values] = part.split(/\s+/u);
        return [name!, values] as const;
      }),
    );
    const manifestSources = directives.get("manifest-src") ?? directives.get("default-src") ?? [];
    expect(manifestSources).toContain("'self'");
    expect(directives.get("img-src") ?? directives.get("default-src") ?? []).toContain("'self'");
  });
});
