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
// The store grid has exactly one host: the merged ストア/追加 page.
const storeHostSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
  "utf8",
);

describe("StoreBrowser install UI", () => {
  test("the local STR table follows the product vocabulary the i18n guard enforces", () => {
    // StoreBrowser deliberately keeps its own locale table so the takos product
    // can reuse the component without the dashboard dictionary — which also
    // puts it outside tests/dashboard/src/i18n's parity + blocked-term guard.
    // Cover it here instead of moving it.
    const table = storeBrowserSource.slice(
      storeBrowserSource.indexOf("const STR = {"),
      storeBrowserSource.indexOf("} as const;"),
    );
    expect(table.length).toBeGreaterThan(0);
    // Mirrors tests/dashboard/src/i18n's blocked list. `InstallConfig` and
    // `fail-closed` were missing here, so the only copy the i18n guard cannot
    // see was also the only copy allowed to leak those two.
    for (const banned of [
      "Capsule",
      "InstallConfig",
      "fail-closed",
      "TargetPool",
      "SpacePolicy",
      "Resource Shape",
      "OpenTofu",
      "Terraform",
      "リポジトリ",
      "入手",
    ]) {
      expect(table).not.toContain(banned);
    }
    // One verb for one action, matching ja.ts's `new.installCta`. 「追加」 is
    // that verb: 42 dictionary entries say 追加 and the progress, done and
    // error lines all do, so a button reading インストール made pressing one
    // word produce another.
    expect(table).toContain('install: { ja: "追加", en: "Add" }');
    expect(table).not.toContain('ja: "インストール"');
    // Every entry carries both locales...
    const entries = table.match(/ja: "([^"]*)"/g) ?? [];
    const english = table.match(/en: "([^"]*)"/g) ?? [];
    expect(entries.length).toBe(english.length);
    // ...neither is empty, and both interpolate the same placeholders — the
    // parity the i18n dictionaries get from their own test.
    const ja = [...table.matchAll(/ja: "([^"]*)"/g)].map((m) => m[1]!);
    const en = [...table.matchAll(/en: "([^"]*)"/g)].map((m) => m[1]!);
    const placeholders = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const [i, jaValue] of ja.entries()) {
      expect(jaValue.length).toBeGreaterThan(0);
      expect(en[i]!.length).toBeGreaterThan(0);
      expect({ i, params: placeholders(jaValue) }).toEqual({
        i,
        params: placeholders(en[i]!),
      });
    }
  });

  test("presents service choices like installable apps", () => {
    expect(storeBrowserSource).toContain("function listingIcon");
    expect(storeBrowserSource).toContain('class="tcs-app-icon"');
    expect(storeBrowserSource).toContain('class="tcs-card-top"');
    expect(storeBrowserSource).toContain('class="tcs-card-main"');
    expect(storeBrowserSource).toContain('class="tcs-detail-title"');
    // Card titles are an <h2> WRAPPING the open <button> (headings-outline
    // fix): the page h1 (store title) is the only heading above them, so the
    // card heading stays h2 (h3 would skip a level), and the title text is not
    // swallowed by the button's presentational subtree. The description is a
    // sibling <p class="tcs-card-desc">, not nested inside the button.
    expect(storeBrowserSource).toContain('<h2 class="tcs-card-title">');
    expect(storeBrowserSource).toContain('class="tcs-card-open"');
    expect(storeBrowserSource).toContain("{pick(listing.name, props.locale)}");
    expect(storeBrowserSource).toContain('<p class="tcs-card-desc">');
    expect(storeBrowserSource).toContain(
      "{pick(listing.description, props.locale)}",
    );
    expect(storeBrowserSource).not.toContain(
      "<h3>{pick(listing.name, props.locale)}</h3>",
    );
    expect(storeBrowserCss).toContain(".tcs-card-title");
    expect(storeBrowserCss).not.toContain(".tcs-card-open h3");
    // Face is the repo's declared icon (full-bleed) with a monogram fallback —
    // not a per-kind glyph. Kind is not a browse facet anymore. The monogram
    // rule and the broken-icon fallback come from the shared AppFace, so the
    // same service cannot come out "PH" here and "PB" on the launcher; only
    // the .tcs-* frame stays local (the component renders standalone).
    expect(storeBrowserSource).toContain("<AppFace");
    expect(storeBrowserSource).not.toContain("function monogramInitials");
    expect(storeBrowserSource).toContain('monogramClass="tcs-app-mono"');
    expect(storeBrowserCss).toContain(".tcs-app-mono");
    expect(storeBrowserSource).not.toContain("data-kind");
    expect(storeBrowserSource).not.toContain("tcsKindLabel");
    expect(storeBrowserSource).not.toContain("tcsCategoryLabel");
    expect(storeBrowserSource).not.toContain("tcsProviderLabel");
    expect(storeBrowserSource).not.toContain("tcs-badge");
    expect(storeBrowserSource).not.toContain("showKindFilters");
    expect(storeBrowserSource).not.toContain("localListings");
    // App-store vocabulary and posture: the card action reads 追加 — the one
    // verb, pinned above — and the grid uses the quiet variant so a page of
    // apps is not a page of primary buttons. The filled accent is reserved for
    // the detail drawer.
    expect(storeBrowserSource).toContain('"tcs-btn tcs-install"');
    expect(storeBrowserSource).toContain("installButton(listing(), true)");
    expect(storeBrowserSource).toContain("installButton(listing)");
    expect(storeBrowserCss).toContain(".tcs-btn.tcs-install");
    // Publisher byline, presentation only.
    expect(storeBrowserSource).toContain("const publisherLabel = (");
    expect(storeBrowserSource).toContain('class="tcs-card-by"');
    expect(storeBrowserCss).toContain(".tcs-card-by");
    expect(storeBrowserSource).toContain('name="storeSource"');
    expect(storeBrowserSource).toContain("l.seenOn.includes(activeStore())");
    expect(storeBrowserSource).toContain("listingForActiveStore");
    expect(storeBrowserSource).toContain("primaryServer: base");
    expect(storeBrowserSource).toContain("data-tcs-listing-id={listing.id}");
    expect(storeBrowserSource).not.toContain("canQuickInstall");
    expect(storeBrowserSource).not.toContain("installState");
    expect(storeBrowserSource).not.toContain("handleInstall");
    expect(storeBrowserSource).not.toContain('class="tcs-filters"');
    expect(storeBrowserSource).not.toContain('s("settings"');
    expect(storeBrowserSource).not.toContain('s("inputs"');
    expect(storeBrowserSource).not.toContain("inputId");
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

  test("the Store tab is store-driven, not a hardcoded template list", () => {
    // Discovery comes from the takosumi-store node(s); the dashboard no longer
    // injects a local template list.
    expect(storeHostSource).not.toContain("installableAppStoreListings");
    expect(storeHostSource).not.toContain("localListings");
    expect(storeHostSource).not.toContain("onInstall=");
    expect(storeHostSource).toContain("<StoreBrowser");
    // Merged page: the store tab carries the source controls AND the sort
    // control that the separate store page used to own.
    expect(storeHostSource).toContain("showSourceControls={true}");
    expect(storeHostSource).toContain("showSortControl={true}");
  });

  test("offers only TCS v2 sort choices", () => {
    expect(storeBrowserSource).toContain('option value="updated"');
    expect(storeBrowserSource).toContain('option value="created"');
    expect(storeBrowserSource).not.toContain('option value="name"');
    expect(storeBrowserSource).not.toContain("sortName");
  });

  test("the invalid-server alert is associated with the URL input", () => {
    expect(storeBrowserSource).toContain(
      "const serverErrorId = createUniqueId()",
    );
    expect(storeBrowserSource).toContain(
      "aria-describedby={serverError() ? serverErrorId : undefined}",
    );
    expect(storeBrowserSource).toContain(
      '<p class="tcs-err" role="alert" id={serverErrorId}>',
    );
  });

  test("keeps install readiness out of the discovery feed", () => {
    expect(storeHostSource).toContain("repository-owned metadata");
    expect(storeHostSource).toContain("nothing about build or deploy duration");
    expect(storeHostSource).not.toContain("store-owned");
    expect(storeHostSource).not.toContain("deriveInstallReadiness");
    expect(storeHostSource).not.toContain("listingBadge");
    expect(storeBrowserSource).not.toContain("listingBadge");
    expect(storeBrowserSource).not.toContain("すぐに使える");
    expect(storeBrowserCss).not.toContain("tcs-ready-badge");
  });
});
