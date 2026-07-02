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
    expect(storeBrowserSource).toContain("AppWindow");
    expect(storeBrowserSource).toContain("Globe2");
    expect(storeBrowserSource).toContain("HardDrive");
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

  test("passes official first-party listings into the standalone Store tab", () => {
    expect(storeViewSource).toContain("firstPartyStoreListings");
    expect(storeViewSource).toContain(
      "localListings={firstPartyStoreListings}",
    );
  });
});
