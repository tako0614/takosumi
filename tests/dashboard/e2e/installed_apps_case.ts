import { expect, test, type Page } from "@playwright/test";
import type { InstalledAppSummary } from "../../../contract/installed-apps.ts";
import { createInstallAttemptFixture, PORTABLE_SOURCE_COMMIT } from "./fixture-data.ts";
import type { DashboardE2EMode } from "./traffic-policy.ts";

const repository = "https://github.com/example/repository-office";
const modulePath = "deploy/app";
const hint = "別のアプリとして新しくインストールします。データや設定は共有されません。";
const listing = {
  id: "example/installed-app", source: { git: repository, path: modulePath },
  suggestedName: "another-office", name: { ja: "共有オフィス", en: "Shared Office" },
  description: { ja: "導入済みのアプリを開くか、別のアプリを追加します。", en: "Open an installed app or add a separate one." },
  badge: { ja: "アプリ", en: "App" }, createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
};
function app(capsuleId: string, name: string): InstalledAppSummary {
  return { capsuleId, name, state: "installed", installedFrom: { url: `${repository}.git/`, path: `./${modulePath}/` } };
}

type FixtureOptions = { readonly legacy?: boolean };

async function fixture(page: Page, apps: readonly InstalledAppSummary[], complete = true, options: FixtureOptions = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("tg_lang", "ja");
    localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
  });
  const mutations: string[] = [];
  const reads: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/") && request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    if (path.startsWith("/api/v1/") && request.method() === "GET") reads.push(path);
  });
  // Each case owns its attempt ledger; creating another app cannot leave an
  // unfinished attempt in the next case's Store or screenshots.
  const attempts = createInstallAttemptFixture({ workspaceId: "ws_alpha" });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = attempts.handle({
      method: request.method(), path: url.pathname, search: url.search,
      body: request.postData() ? request.postDataJSON() : undefined,
      idempotencyKey: request.headers()["idempotency-key"],
    });
    if (reply) return route.fulfill({ status: reply.status, json: reply.json });
    return route.fallback();
  });
  await page.route("https://store.example.test/tcs/v2/listings**", (route) => route.fulfill({
    json: new URL(route.request().url()).pathname === "/tcs/v2/listings" ? { items: [listing] } : listing,
  }));
  if (options.legacy) {
    await page.route("**/api/v1/apps", (route) => route.fulfill({ status: 404, json: { error: "route_not_found" } }));
    await page.route("**/api/v1/workspaces/*/installed-apps", (route) => route.fulfill({ json: { installedApps: apps, complete } }));
  } else {
    const appRows = apps.map((row) => ({
      capsuleId: row.capsuleId,
      name: row.name,
      role: "owner",
      ownerDisplayName: "Portable E2E",
      state: row.state,
      primaryAction: "open",
    }));
    // Model a bounded list whose one incomplete per-app detail makes the
    // overall discovery partial while keeping every known row authoritative.
    if (!complete) appRows.push({
      capsuleId: "cap_incomplete_store_fixture",
      name: "incomplete-detail",
      role: "owner",
      ownerDisplayName: "Portable E2E",
      state: "installed",
      primaryAction: "open",
    });
    await page.route("**/api/v1/apps", (route) => route.fulfill({ json: { apps: appRows } }));
    await page.route("**/api/v1/capsules/*", (route) => {
      const capsuleId = new URL(route.request().url()).pathname.split("/").at(-1)!;
      if (capsuleId === "cap_incomplete_store_fixture") return route.fulfill({ status: 404, json: { error: "not_found" } });
      const row = apps.find((candidate) => candidate.capsuleId === capsuleId);
      if (!row) return route.fulfill({ status: 404, json: { error: "not_found" } });
      return route.fulfill({ json: { capsule: {
        id: row.capsuleId, workspaceId: "ws_alpha", projectId: "prj_alpha", sourceId: "src_store_fixture",
        name: row.name, slug: row.name, installConfigId: `cfg_${row.capsuleId}`, environment: "production",
        currentStateGeneration: 1, status: "active", createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z",
      } } });
    });
    await page.route("**/api/v1/capsule-configs/*", async (route) => {
      const configId = new URL(route.request().url()).pathname.split("/").at(-1)!;
      const row = apps.find((candidate) => `cfg_${candidate.capsuleId}` === configId);
      if (!row) return route.fulfill({ status: 404, json: { error: "not_found" } });
      return route.fulfill({ json: { installConfig: {
        id: configId,
        name: configId,
        workspaceId: "ws_alpha",
        sourceSelector: { url: row.installedFrom.url, path: row.installedFrom.path },
        modulePath: ".",
        store: { name: { ja: "共有オフィス", en: "Shared Office" } },
      } } });
    });
  }
  await page.route("**/api/v1/source-ref-resolutions/stable-semver", (route) => route.fulfill({ json: { tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT } }));
  await page.route("**/api/v1/workspaces/*/source-ref-resolutions/stable-semver", (route) => route.fulfill({ json: { tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT } }));
  return { mutations, reads, errors };
}

async function capture(page: Page, name: string) {
  const original = page.viewportSize();
  for (const [suffix, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath(`${name}-${suffix}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

export function registerInstalledAppsCases(mode: DashboardE2EMode) {
  test.describe("Store installed apps", () => {
    test.skip(mode !== "portable", "deterministic installed app identity fixture; not production evidence");

    test("shows one installed app in Store and incoming Git links before starting another", async ({ page }) => {
      const h = await fixture(page, [app("cap_repository_office", "office-personal")]);
      await page.goto("/new");
      const card = page.locator('[data-tcs-listing-id="example/installed-app"]');
      await expect(card.getByText("インストール済み", { exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: "開く: office-personal", exact: true })).toHaveAttribute("href", "/apps/cap_repository_office");
      await expect(card.getByRole("button", { name: "もう1つ入れる: 共有オフィス", exact: true })).toBeVisible();
      await expect(card.getByText(hint, { exact: true })).toBeVisible();
      await capture(page, "store-installed-one");
      expect(h.mutations).toEqual([]);
      await card.getByRole("link", { name: "開く: office-personal", exact: true }).click();
      await expect(page).toHaveURL(/\/apps\/cap_repository_office$/u);
      expect(h.mutations).toEqual([]);

      // A different ref still names the same app; opening this URL creates nothing.
      const query = new URLSearchParams({ git: `${repository}.git`, path: modulePath, ref: "v2.0.0", name: "another-office" });
      await page.goto(`/new?${query}`);
      await expect(page.getByTestId("install-existing-apps").getByText("インストール済み", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "もう1つ入れる", exact: true })).toBeEnabled();
      await expect(page.getByText(hint, { exact: true })).toBeVisible();
      await capture(page, "new-installed-one");
      expect(h.mutations).toEqual([]);
      await page.getByRole("button", { name: "もう1つ入れる", exact: true }).click();
      await expect.poll(() => h.mutations.filter((entry) => entry === "POST /api/v1/install-plans").length).toBe(1);
      expect(h.errors).toEqual([]);
    });

    test("shows two distinct installed apps and excludes a different module", async ({ page }) => {
      const h = await fixture(page, [app("cap_repository_office", "office-personal"), app("cap_imported_state", "office-team")]);
      await page.goto("/new");
      const card = page.locator('[data-tcs-listing-id="example/installed-app"]');
      await expect(card.getByText("2件インストール済み", { exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: /^開く:/u })).toHaveCount(2);
      await capture(page, "store-installed-two");
      await card.getByRole("heading", { name: "共有オフィス" }).getByRole("button").click();
      await expect(page.getByTestId("install-existing-apps").getByText("2件インストール済み", { exact: true })).toBeVisible();
      await expect(page.getByTestId("install-existing-apps").getByRole("link", { name: /^開く:/u })).toHaveCount(2);
      await capture(page, "new-installed-two");
      expect(h.mutations).toEqual([]);
      const query = new URLSearchParams({ git: repository, path: "deploy/other", ref: "main", name: "other-module" });
      await page.goto(`/new?${query}`);
      await expect(page.getByTestId("install-existing-apps")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toBeEnabled();
      expect(h.mutations).toEqual([]);
      expect(h.errors).toEqual([]);
    });

    test("marks unmatched listings unknown for a partial summary", async ({ page }) => {
      const knownButDifferent = {
        ...app("cap_other_module", "other-app"),
        installedFrom: { url: "https://github.com/example/other-repository.git", path: "." },
      };
      const h = await fixture(page, [knownButDifferent], false);
      await page.goto("/new");
      const card = page.locator('[data-tcs-listing-id="example/installed-app"]');
      await expect(card.getByTestId("store-installed-unknown")).toBeVisible();
      await expect(card.getByText("インストール状況を確認できません", { exact: true })).toBeVisible();
      await expect(card.getByRole("button", { name: "追加: 共有オフィス" })).toBeVisible();
      await card.getByRole("heading", { name: "共有オフィス" }).getByRole("button").click();
      await expect(page.getByText("インストール済みのアプリを確認できませんでした。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toBeEnabled();
      expect(h.errors).toEqual([]);
    });

    test("keeps known app links but labels the count as partial", async ({ page }) => {
      const h = await fixture(page, [app("cap_repository_office", "office-personal")], false, { legacy: true });
      await page.goto("/new");
      const card = page.locator('[data-tcs-listing-id="example/installed-app"]');
      await expect(card.getByText("確認できた範囲では1件インストール済み", { exact: true })).toBeVisible();
      await expect(card.getByRole("link", { name: "開く: office-personal", exact: true })).toHaveAttribute("href", "/apps/cap_repository_office");
      await expect(card.getByText("既存アプリとの一致を確認できませんでした。続ける前にアプリ一覧を確認してください。", { exact: true })).toBeVisible();
      expect(h.reads).toContain("/api/v1/workspaces/ws_alpha/installed-apps");
      expect(h.errors).toEqual([]);
    });

    test("waits for installed identity and offers retry after a failed read", async ({ page }) => {
      const h = await fixture(page, [app("cap_repository_office", "office-personal")]);
      let releaseRead!: () => void;
      const read = new Promise<void>((resolve) => { releaseRead = resolve; });
      let failed = false;
      await page.route("**/api/v1/apps", async (route) => {
        await read;
        if (!failed) {
          failed = true;
          return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        }
        return route.fulfill({ json: { apps: [{ capsuleId: "cap_repository_office", name: "office-personal", role: "owner", ownerDisplayName: "Portable E2E", state: "installed", primaryAction: "open" }] } });
      });
      const query = new URLSearchParams({ git: `${repository}.git`, path: modulePath, ref: "main" });
      await page.goto(`/new?${query}`);
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toBeDisabled();
      expect(h.mutations).toEqual([]);
      releaseRead();
      await expect(page.getByText("インストール済みのアプリを確認できませんでした。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "インストール", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "再試行", exact: true }).click();
      await expect(page.getByTestId("install-existing-apps")).toBeVisible();
      await expect(page.getByRole("button", { name: "もう1つ入れる", exact: true })).toBeEnabled();
      expect(h.mutations).toEqual([]);
      expect(h.errors).toEqual([]);
    });

    test("keeps Store install status neutral while installed apps are loading", async ({ page }) => {
      const h = await fixture(page, []);
      let releaseRead!: () => void;
      const read = new Promise<void>((resolve) => { releaseRead = resolve; });
      await page.route("**/api/v1/apps", async (route) => {
        await read;
        return route.fulfill({ json: { apps: [] } });
      });
      await page.goto("/new");
      const card = page.locator('[data-tcs-listing-id="example/installed-app"]');
      await expect(card).toBeVisible();
      await expect(card.getByTestId("store-installed-loading")).toBeVisible();
      await expect(card.getByTestId("store-installed-unknown")).toHaveCount(0);
      await expect(card.getByRole("button", { name: "追加: 共有オフィス" })).toHaveCount(0);
      releaseRead();
      await expect(card.getByRole("button", { name: "追加: 共有オフィス" })).toBeEnabled();
      expect(h.errors).toEqual([]);
    });

    test("a person can start app install without creating or selecting a workspace", async ({ page }) => {
      const h = await fixture(page, []);
      await page.addInitScript(() => localStorage.removeItem("takosumi.currentWorkspaceId"));
      await page.route("**/api/v1/workspaces", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
      const query = new URLSearchParams({ git: repository, path: modulePath, ref: PORTABLE_SOURCE_COMMIT });
      await page.goto(`/new?${query}`);
      const install = page.getByRole("button", { name: "インストール", exact: true });
      await expect(install).toBeEnabled();
      await install.click();
      await expect.poll(() => h.mutations).toContain("POST /api/v1/install-plans");
      expect(h.mutations).not.toContain("POST /api/v1/workspaces");
      expect(h.reads.some((path) => path.startsWith("/api/v1/workspaces/") && path !== "/api/v1/workspaces" )).toBe(false);
      expect(h.errors).toEqual([]);
    });

    test("uses the legacy install route only after a 404 and an explicit workspace", async ({ page }) => {
      const h = await fixture(page, []);
      await page.addInitScript(() => localStorage.setItem("takosumi.currentWorkspaceId", "ws_alpha"));
      await page.route("**/api/v1/install-plans", (route) => route.fulfill({ status: 404, json: { error: "not_found" } }));
      const query = new URLSearchParams({ git: repository, path: modulePath, ref: "main" });
      await page.goto(`/new?${query}`);
      await page.getByRole("button", { name: "インストール", exact: true }).click();
      await expect.poll(() => h.mutations).toContain("POST /api/v1/workspaces/ws_alpha/install-plans");
      expect(h.mutations.slice(0, 2)).toEqual([
        "POST /api/v1/install-plans",
        "POST /api/v1/workspaces/ws_alpha/install-plans",
      ]);
      expect(h.mutations.some((entry) => /\/apply(?:$|\/)/u.test(entry))).toBe(false);
      expect(h.errors).toEqual([]);
    });

    test("does not use the legacy install route when the new route fails with 403", async ({ page }) => {
      const h = await fixture(page, []);
      await page.addInitScript(() => localStorage.setItem("takosumi.currentWorkspaceId", "ws_alpha"));
      await page.route("**/api/v1/install-plans", (route) => route.fulfill({ status: 403, json: { error: "forbidden" } }));
      const query = new URLSearchParams({ git: repository, path: modulePath, ref: "main" });
      await page.goto(`/new?${query}`);
      await page.getByRole("button", { name: "インストール", exact: true }).click();
      await expect.poll(() => h.mutations.filter((entry) => entry.includes("install-plans"))).toEqual([
        "POST /api/v1/install-plans",
      ]);
      expect(h.errors).toEqual([]);
    });
  });
}
