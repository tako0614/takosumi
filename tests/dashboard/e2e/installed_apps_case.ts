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

async function fixture(page: Page, apps: readonly InstalledAppSummary[]) {
  await page.addInitScript(() => {
    localStorage.setItem("tg_lang", "ja");
    localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
  });
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/v1/") && request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
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
  await page.route("**/api/v1/workspaces/*/installed-apps", (route) => route.fulfill({ json: { installedApps: apps } }));
  await page.route("**/api/v1/workspaces/*/source-ref-resolutions/stable-semver", (route) => route.fulfill({ json: { tag: "v1.0.0", commit: PORTABLE_SOURCE_COMMIT } }));
  return { mutations, errors };
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
      await expect.poll(() => h.mutations.filter((entry) => entry === "POST /api/v1/workspaces/ws_alpha/install-plans").length).toBe(1);
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

    test("waits for installed identity and offers retry after a failed read", async ({ page }) => {
      const h = await fixture(page, []);
      let releaseRead!: () => void;
      const read = new Promise<void>((resolve) => { releaseRead = resolve; });
      let failed = false;
      await page.route("**/api/v1/workspaces/*/installed-apps", async (route) => {
        await read;
        if (!failed) {
          failed = true;
          return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        }
        return route.fulfill({ json: { installedApps: [app("cap_repository_office", "office-personal")] } });
      });
      const query = new URLSearchParams({ git: repository, path: modulePath, ref: "main" });
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

    test("a person with no workspace can start Install and create one", async ({ page }) => {
      const h = await fixture(page, []);
      await page.addInitScript(() => localStorage.removeItem("takosumi.currentWorkspaceId"));
      await page.route((url) => url.pathname === "/api/v1/dashboard/bootstrap", (route) => route.fulfill({
        json: { session: { subject: "sub_portable_e2e", expiresAt: Date.now() + 60_000 },
          workspaces: [], workspaceList: { total: 0, returned: 0, limit: 50, truncated: false }, notifications: [] },
      }));
      await page.route((url) => url.pathname === "/api/v1/workspaces", (route) =>
        route.fulfill({ json: route.request().method() === "POST"
          ? { workspace: { id: "ws_alpha", handle: "alpha", displayName: "Alpha Workspace", type: "personal", ownerUserId: "sub_portable_e2e", createdAt: "2026-10-28T00:00:00.000Z", updatedAt: "2026-10-28T00:00:00.000Z" } }
          : { workspaces: [], total: 0, returned: 0, limit: 50, truncated: false } }));
      const query = new URLSearchParams({ git: repository, path: modulePath, ref: PORTABLE_SOURCE_COMMIT });
      await page.goto(`/new?${query}`);
      const install = page.getByRole("button", { name: "インストール", exact: true });
      await expect(install).toBeEnabled();
      await install.click();
      await expect.poll(() => h.mutations).toContain("POST /api/v1/workspaces");
      await expect.poll(() => h.mutations).toContain("POST /api/v1/workspaces/ws_alpha/install-plans");
      expect(h.errors).toEqual([]);
    });
  });
}
