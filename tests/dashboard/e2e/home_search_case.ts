import { expect, test, type Page } from "@playwright/test";
import { PORTABLE_APPS } from "./fixture-data.ts";

function app(id: string, name: string) {
  return { ...PORTABLE_APPS[0], capsuleId: id, name, displayName: name, screens: [] };
}
function heldResponse() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return { ready, release };
}
async function openHome(page: Page) {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("searchbox", { name: "Search your apps" })).toBeVisible();
  return page.getByTestId("home-apps");
}

export function registerHomeSearchCases(mode: string): void {
  test.describe("Home server search", () => {
    test.skip(mode !== "portable", "synthetic account fixtures; no live account reads");

    test("a stalled home app list offers Retry and then loads with reads only", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.clock.install();
      const held = heldResponse();
      const reads: string[] = [];
      const mutations: string[] = [];
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") mutations.push(path);
        if (path !== "/api/v1/apps") return route.fallback();
        reads.push(request.method());
        if (reads.length === 1) {
          await held.ready;
          return route.abort().catch(() => {});
        }
        return route.fulfill({ json: { apps: [app("recovered", "Recovered app")] } });
      });
      try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect.poll(() => reads.length).toBe(1);
        await page.clock.fastForward(30_100);
        const home = page.getByTestId("home-apps");
        const retry = home.getByRole("button", { name: "Retry", exact: true });
        await expect(retry).toBeVisible();
        expect(reads).toEqual(["GET"]);
        await retry.click();
        await expect(home.getByTestId("home-app")).toContainText("Recovered app");
        expect(reads).toEqual(["GET", "GET"]);
        expect(mutations).toEqual([]);
      } finally {
        held.release();
      }
    });

    test("applied-query search follows an empty candidate page without showing false no-results", async ({ page }) => {
      const held = heldResponse();
      let waiting = false;
      const queries: string[] = [];
      await page.route("**/api/v1/apps**", async (route) => {
        const url = new URL(route.request().url());
        const q = url.searchParams.get("q");
        if (!q) return route.fulfill({ json: { apps: [app("initial", "Initial app")] } });
        queries.push(q);
        if (!url.searchParams.has("cursor")) return route.fulfill({ json: { apps: [], appliedQuery: q, nextCursor: "last" } });
        waiting = true;
        await held.ready;
        return route.fulfill({ json: { apps: [app("archive", "Archive app")], appliedQuery: q } });
      });
      try {
        const home = await openHome(page);
        await page.getByRole("searchbox").fill("Archive");
        await expect.poll(() => waiting).toBe(true);
        await expect(home.locator(".av-search-empty")).toHaveCount(0);
        await expect(home.locator(".av-home-loading")).toBeVisible();
        held.release();
        await expect(home.getByTestId("home-app")).toContainText("Archive app");
        await expect(home.locator(".av-home-loading")).toHaveCount(0);
        await expect(home.locator(".av-search-empty")).toHaveCount(0);
        expect(queries).toEqual(["archive", "archive"]);
      } finally { held.release(); }
    });

    test("a delayed old query cannot replace the current search or append stale rows", async ({ page }) => {
      const held = heldResponse();
      let oldStarted = false;
      await page.route("**/api/v1/apps**", async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q");
        if (q === "old") { oldStarted = true; await held.ready; }
        return route.fulfill({ json: { apps: [app(q ?? "initial", q ? `${q} app` : "Initial app")],
          ...(q ? { appliedQuery: q } : {}) } });
      });
      try {
        const home = await openHome(page);
        const search = page.getByRole("searchbox");
        await search.fill("old");
        await expect.poll(() => oldStarted).toBe(true);
        await search.fill("new");
        // Release before the next query's debounce; the old transport is aborted.
        held.release();
        await expect(home.locator('[data-capsule-id="old"]')).toHaveCount(0);
        await expect(search).toHaveValue("new");
        await expect(home.getByTestId("home-app")).toContainText("new app");
        await expect(home.locator('[data-capsule-id="old"]')).toHaveCount(0);
        await expect(home.locator(".av-search-empty")).toHaveCount(0);
      } finally { held.release(); }
    });

    test("legacy ignored-q pages remain searchable and a failed page cannot claim no matches", async ({ page }) => {
      let fail = true;
      await page.route("**/api/v1/apps**", async (route) => {
        const url = new URL(route.request().url());
        const q = url.searchParams.get("q");
        if (!q) return route.fulfill({ json: { apps: [app("alpha", "Alpha mail")] } });
        if (!url.searchParams.has("cursor")) {
          // Legacy server deliberately ignores q and omits appliedQuery.
          return route.fulfill({ json: { apps: [app("alpha", "Alpha mail")], nextCursor: "more" } });
        }
        if (q === "missing" && fail) return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        return route.fulfill({ json: { apps: q === "beta" ? [app("beta", "Beta office")] : [] } });
      });
      const home = await openHome(page);
      const search = page.getByRole("searchbox");
      await search.fill("beta");
      await expect(home.getByTestId("home-app")).toContainText("Beta office");
      await expect(home.locator('[data-capsule-id="alpha"]')).toHaveCount(0);
      await search.fill("missing");
      await expect(home).toContainText("Couldn't load more apps.");
      await expect(home.locator(".av-search-empty")).toHaveCount(0);
      fail = false;
      await home.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(home.locator(".av-search-empty")).toHaveText("No matching apps. Try another name.");
    });

    test("a first search-page failure can be cleared back to the normal app list", async ({ page }) => {
      await page.route("**/api/v1/apps**", async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q");
        return q ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
          : route.fulfill({ json: { apps: [app("initial", "Initial app")] } });
      });
      const home = await openHome(page);
      await page.getByRole("searchbox").fill("broken");
      await expect(home.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(home.locator(".av-search-empty")).toHaveCount(0);
      await home.getByRole("button", { name: "Clear search", exact: true }).click();
      await expect(page.getByRole("searchbox")).toHaveValue("");
      await expect(home.getByTestId("home-app")).toContainText("Initial app");
      await expect(home.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
    });

    test("300 search results keep the rendered tile count bounded and never trigger per-app reads", async ({ page }) => {
      const rows = Array.from({ length: 300 }, (_, index) => app(`library_${index}`, `Library ${String(index).padStart(3, "0")}`));
      const searchPages: string[] = [];
      const detailReads: string[] = [];
      await page.addInitScript(() => {
        const state = globalThis as typeof globalThis & { homeMaxRendered?: number };
        state.homeMaxRendered = 0;
        new MutationObserver(() => {
          state.homeMaxRendered = Math.max(state.homeMaxRendered ?? 0, document.querySelectorAll('[data-testid="home-app"]').length);
        }).observe(document, { childList: true, subtree: true });
      });
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (/^\/api\/v1\/capsules\/[^/]+\/app$/u.test(path)) detailReads.push(path);
      });
      await page.route("**/api/v1/apps**", async (route) => {
        const url = new URL(route.request().url());
        const q = url.searchParams.get("q");
        const start = Number(url.searchParams.get("cursor") ?? "0");
        if (q) searchPages.push(String(start));
        return route.fulfill({ json: { apps: rows.slice(start, start + 50),
          ...(start + 50 < rows.length ? { nextCursor: String(start + 50) } : {}),
          ...(q ? { appliedQuery: q } : {}) } });
      });
      const home = await openHome(page);
      await page.getByRole("searchbox").fill("library");
      await expect.poll(() => searchPages.length).toBe(1);
      await expect(home.locator(".av-home-loading")).toHaveCount(0);
      expect(searchPages).toEqual(["0"]);
      expect(await home.getByTestId("home-app").count()).toBeGreaterThan(0);
      // Each natural scroll requests one more nonempty server page.
      for (let pageCount = 2; pageCount <= 6; pageCount++) {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await expect.poll(() => searchPages.length).toBe(pageCount);
        await expect(home.locator(".av-home-loading")).toHaveCount(0);
      }
      await expect(home.locator(".av-section-head-count")).toHaveText("300");
      expect(searchPages).toEqual(["0", "50", "100", "150", "200", "250"]);
      expect(await home.getByTestId("home-app").count()).toBeLessThanOrEqual(120);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await expect(home.locator('[data-capsule-id="library_299"]')).toBeVisible();
      expect(await page.evaluate(() => (globalThis as typeof globalThis & { homeMaxRendered: number }).homeMaxRendered)).toBeLessThanOrEqual(120);
      expect(detailReads).toEqual([]);
    });
  });
}
