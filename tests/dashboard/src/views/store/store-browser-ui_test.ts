import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const storeBrowserSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/store/StoreBrowser.tsx"),
  "utf8",
);
const storeBrowserCss = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/store/StoreBrowser.css"),
  "utf8",
);
const storeViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/store/StoreView.tsx"),
  "utf8",
);

describe("StoreBrowser install UI", () => {
  test("presents service choices like installable apps", () => {
    expect(storeBrowserSource).toContain("function listingIcon");
    expect(storeBrowserSource).toContain('class="tcs-app-icon"');
    expect(storeBrowserSource).toContain('class="tcs-card-top"');
    expect(storeBrowserSource).toContain('class="tcs-card-main"');
    expect(storeBrowserSource).toContain('class="tcs-detail-title"');
    expect(storeBrowserSource).toContain(
      "<h3>{pick(listing.name, props.locale)}</h3>",
    );
    expect(storeBrowserSource).not.toContain(
      "<h4>{pick(listing.name, props.locale)}</h4>",
    );
    expect(storeBrowserCss).toContain(".tcs-card-open h3");
    expect(storeBrowserCss).not.toContain(".tcs-card-open h4");
    // Face is the repo's declared icon (full-bleed) with a monogram fallback —
    // not a per-kind glyph. Kind is not a browse facet anymore.
    expect(storeBrowserSource).toContain("function monogramInitials");
    expect(storeBrowserSource).toContain('class="tcs-app-mono"');
    expect(storeBrowserCss).toContain(".tcs-app-mono");
    expect(storeBrowserSource).not.toContain("data-kind");
    expect(storeBrowserSource).not.toContain("tcsKindLabel");
    expect(storeBrowserSource).not.toContain("tcs-badge");
    expect(storeBrowserSource).not.toContain("showKindFilters");
    expect(storeBrowserSource).not.toContain("localListings");
    expect(storeBrowserSource).toContain(
      'install: { ja: "インストール", en: "Install" }',
    );
    expect(storeBrowserSource).toContain(
      'configure: { ja: "インストール", en: "Install" }',
    );
  });

  test("keeps cards stable on desktop and full width on narrow screens", () => {
    expect(storeBrowserCss).toContain(".tcs-card-top");
    expect(storeBrowserCss).toContain(
      "grid-template-columns: auto minmax(0, 1fr)",
    );
    expect(storeBrowserCss).toContain("min-height: 204px");
    expect(storeBrowserCss).toContain(".tcs-card-actions .tcs-btn");
    expect(storeBrowserCss).toContain("@media (max-width: 520px)");
    expect(storeBrowserCss).toContain("grid-template-columns: 1fr");
    expect(storeBrowserCss).toContain("width: 100%");
  });

  test("the standalone Store tab is store-driven, not a hardcoded catalog", () => {
    // Discovery comes from the takosumi-store node(s); the dashboard no longer
    // injects a local catalog.
    expect(storeViewSource).not.toContain("installableAppStoreListings");
    expect(storeViewSource).not.toContain("localListings");
    expect(storeViewSource).toContain("<StoreBrowser");
  });
});
