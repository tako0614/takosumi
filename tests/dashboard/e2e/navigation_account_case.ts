/**
 * Navigation, 接続 and アカウント (TASK-0115) against the portable fixture.
 *
 * Reads the fixture server for the workspace list, apps and activity, and stubs
 * only the reads these pages add (connections, bindings, members, billing,
 * API keys). Set TAKOSUMI_E2E_SHOTS_DIR to save desktop (1440x900) and phone
 * (390x844) screenshots of each surface.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import {
  PORTABLE_APPS,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  portableUsageResponse,
} from "./fixture-data.ts";

const DESKTOP = { width: 1440, height: 900 } as const;
const PHONE = { width: 390, height: 844 } as const;
const shotsDir = process.env.TAKOSUMI_E2E_SHOTS_DIR?.trim();

async function shot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
}

/** Desktop and phone screenshots of the current route. */
async function shots(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(150);
  await shot(page, `${name}-desktop`);
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(150);
  await shot(page, `${name}-mobile`);
  await page.setViewportSize(DESKTOP);
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

const DIRECT = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1];
const OPERATOR = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0];

type AccountFixture = { readonly mutations: string[]; readonly reads: string[] };

/** Stubs the reads 接続 and アカウント add on top of the fixture server. */
async function accountFixture(page: Page): Promise<AccountFixture> {
  const mutations: string[] = [];
  const reads: string[] = [];
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: "fixture_read_only" } });
    }
    reads.push(`${path}${url.search}`);
    if (path === "/api/v1/apps") {
      return route.fulfill({ json: { apps: PORTABLE_APPS } });
    }
    if (path === "/api/v1/connections") {
      return route.fulfill({ json: { connections: [DIRECT, OPERATOR] } });
    }
    if (path === "/api/v1/usage") {
      return route.fulfill({ json: portableUsageResponse() });
    }
    if (path === "/api/v1/provider-connections") {
      return route.fulfill({
        json: {
          providerConnections:
            url.searchParams.get("projection") === "release-owned"
              ? []
              : [DIRECT, OPERATOR],
        },
      });
    }
    if (path === "/api/v1/credential-recipes") {
      return route.fulfill({
        json: { recipes: REFERENCE_CREDENTIAL_RECIPES, oauthHelpers: [] },
      });
    }
    if (path === "/api/v1/capsules/cap_repository_office/provider-bindings") {
      return route.fulfill({
        json: {
          providerBindingSet: {
            id: "pbs_repository_office",
            workspaceId: "ws_alpha",
            capsuleId: "cap_repository_office",
            environment: "production",
            bindings: [
              {
                provider: "registry.opentofu.org/cloudflare/cloudflare",
                connectionId: DIRECT.id,
              },
            ],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        },
      });
    }
    if (path === "/api/v1/account/tokens/scopes") {
      const scope = (
        name: string,
        ja: string,
        en: string,
        selfService: boolean,
        workspaceBinding: "optional" | "required",
      ) => ({
        scope: name,
        label: { ja, en },
        description: { ja: `${ja}の権限です。`, en: `${en} access.` },
        selfService,
        workspaceBinding,
      });
      return route.fulfill({
        json: {
          kind: "takosumi.account-pat-scope-catalog@v1",
          scopes: [
            scope("read", "読み取り", "Read", true, "optional"),
            scope("write", "変更", "Write", true, "optional"),
          ],
        },
      });
    }
    if (path === "/api/v1/account/tokens") {
      return route.fulfill({
        json: {
          tokens: [
            {
              id: "pat_cli",
              subject: "sub_portable_e2e",
              name: "開発用 CLI",
              prefix: "tks_8f2a",
              scopes: ["read", "write"],
              created_at: "2026-10-01T00:00:00.000Z",
              expires_at: "2026-12-30T00:00:00.000Z",
              last_used_at: new Date(Date.now() - 5 * 60_000).toISOString(),
            },
          ],
          next_cursor: null,
        },
      });
    }
    if (path === "/api/v1/account/notification-pushers") {
      return route.fulfill({
        json: {
          web_push_public_key: "BFixtureVapidPublicKey",
          web_push_unavailable_reason: null,
          pushers: [
            {
              id: "npsh_fixture_pixel",
              kind: "webpush",
              app_id: "com.takosumi",
              pushkey: "BFixturePushKey",
              data: { url: "https://relay.example.test/push/fixture" },
              device_display_name: "Pixel 9",
              lang: "ja-JP",
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-01T00:00:00.000Z",
              last_success_at: "2026-10-28T00:00:00.000Z",
              last_failure_at: "2026-10-29T00:00:00.000Z",
              last_failure_status: 403,
              failing: true,
            },
          ],
        },
      });
    }
    return route.fallback();
  };
  await page.route("**/api/v1/**", handle);
  return { mutations, reads };
}

export function registerNavigationAccountCases(mode: string): void {
  test.describe("Navigation, connections and account", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");

    test("primary navigation has no workspace switcher and Home lists owned and shared apps", async ({ page }) => {
      const errors = collectPageErrors(page);
      const apiReads: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "GET" && new URL(request.url()).pathname.startsWith("/api/v1/")) {
          apiReads.push(new URL(request.url()).pathname);
        }
      });
      await page.addInitScript(() => { localStorage.setItem("tg_lang", "ja"); localStorage.setItem("takosumi.currentWorkspaceId", "ws_beta"); });
      await page.setViewportSize(DESKTOP);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const sidebar = page.locator(".sidebar-nav");
      await expect(sidebar.getByRole("link")).toHaveText(["ホーム", "ストア", "接続", "アカウント"]);
      await expect(page.getByTestId("workspace-switcher")).toHaveCount(0);
      await expect(page.locator(".sidebar")).not.toContainText(/workspace|space|スペース|ワークスペース/iu);
      await expect(page.locator(".topbar")).not.toContainText(/workspace|space|スペース|ワークスペース/iu);
      const home = page.getByTestId("home-apps");
      await expect(home.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName })).toBeVisible();
      await expect(home.getByTestId("home-app").filter({ hasText: "Beta Office" })).toBeVisible();
      await expect(home).toContainText("Hanako Sato");
      expect(apiReads.filter((path) => path === "/api/v1/apps")).toHaveLength(1);
      expect(await page.evaluate(() => localStorage.getItem("takosumi.currentWorkspaceId"))).toBeNull();
      expect(apiReads.some((path) => path === "/api/v1/workspaces" || path.startsWith("/api/v1/workspaces/"))).toBe(false);
      await page.getByRole("button", { name: /ユーザーメニュー|User menu/u }).click();
      const menu = page.getByRole("group", { name: /ユーザーメニュー|User menu/u });
      await expect(menu.getByRole("link", { name: "アカウント" })).toHaveAttribute("href", "/account");
      await expect(menu).not.toContainText("デプロイ履歴");
      await page.keyboard.press("Escape");
      await shot(page, "nav-desktop-app-ownership");

      await page.setViewportSize(PHONE);
      const tabs = page.locator(".mobile-tabs");
      await expect(tabs.getByRole("link")).toHaveText(["ホーム", "ストア", "接続", "アカウント"]);
      await expect(page.getByTestId("workspace-switcher")).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await shot(page, "nav-mobile-app-ownership");
      expect(errors).toEqual([]);
    });

    test("legacy workspace selection remains available only after the apps route is missing", async ({ page }) => {
      await page.addInitScript(() => { localStorage.setItem("tg_lang", "ja"); localStorage.setItem("takosumi.currentWorkspaceId", "ws_alpha"); });
      await page.route("**/api/v1/apps**", (route) => route.fulfill({ status: 404, json: { error: { code: "route_not_found" } } }));
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const selector = page.locator(".topbar select.workspace-switcher");
      await expect(selector).toBeVisible();
      await expect(page.getByTestId("home-apps")).toContainText(PORTABLE_EXPECTATIONS.appName);
      await selector.selectOption("ws_beta");
      await expect(page.getByTestId("home-apps")).toContainText("Beta Office");
      await expect(page.getByTestId("home-apps")).not.toContainText(PORTABLE_EXPECTATIONS.appName);
    });

    test("Home bounds app reads and reports failed screen discovery", async ({ page }) => {
      const apps = Array.from({ length: 9 }, (_, index) => ({ ...PORTABLE_APPS[0]!, capsuleId: `cap_home_${index}`, name: `Home app ${index}` }));
      let active = 0;
      let maximum = 0;
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      await page.route("**/api/v1/apps**", (route) => route.fulfill({ json: { apps } }));
      await page.route((url) => /^\/api\/v1\/capsules\/cap_home_\d+\/app$/u.test(url.pathname), async (route) => {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 40));
        active -= 1;
        const id = new URL(route.request().url()).pathname.split("/")[4]!;
        if (id === "cap_home_2") return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
        return route.fulfill({ json: { app: { kind: "takosumi.capsule-app@v1", capsuleId: id, state: "installed", primaryAction: "none",
          problems: [], screens: [], version: {}, progress: {}, uninstall: {} } } });
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("home-app")).toHaveCount(9);
      expect(maximum).toBeLessThanOrEqual(4);
      expect(maximum).toBeGreaterThan(1);
      await expect(page.getByTestId("home-apps")).toContainText("一部のアプリの画面を読み込めませんでした");
    });

    test("接続 shows the apps using each connection and removal names them", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const fixture = await accountFixture(page);
      await page.setViewportSize(DESKTOP);
      await page.goto("/connections", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/connections$/u);
      await expect(page.getByRole("heading", { name: "接続", exact: true, level: 1 })).toBeVisible();
      const direct = page.locator(".conn-card").filter({ hasText: DIRECT.displayName });
      const operator = page.locator(".conn-card").filter({ hasText: OPERATOR.displayName });
      await expect(direct.locator(".conn-apps")).toContainText("使っているアプリ");
      await expect(direct.getByRole("link", { name: PORTABLE_EXPECTATIONS.appName })).toHaveAttribute(
        "href",
        "/apps/cap_repository_office",
      );
      await expect(operator.locator(".conn-apps")).toContainText("まだどのアプリも使っていません");
      // Operator-provided connections cannot be removed from here.
      await expect(operator.getByRole("button", { name: "削除" })).toHaveCount(0);
      await shots(page, "connections");

      await direct.getByRole("button", { name: "削除" }).click();
      const dialog = page.getByRole("alertdialog").or(page.getByRole("dialog")).first();
      await expect(dialog).toContainText(PORTABLE_EXPECTATIONS.appName);
      await expect(dialog).toContainText("リソースは削除されません");
      await dialog.getByRole("button", { name: /キャンセル/u }).click();
      expect(fixture.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("アカウント has only personal profile, usage, CLI and notification device sections", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const fixture = await accountFixture(page);
      await page.setViewportSize(DESKTOP);

      await page.goto("/account", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "アカウント", level: 1 })).toBeVisible();
      const tabs = page.locator(".acct-tabs");
      await expect(tabs.getByRole("link")).toHaveText([
        "自分",
        "料金と利用量",
        "CLI・APIから使う",
        "通知を受け取る端末",
      ]);
      await expect(tabs).not.toContainText(/メンバー|スペース|workspace/iu);
      await expect(page.getByRole("button", { name: "このブラウザからサインアウト" })).toBeVisible();
      await shots(page, "account-profile");

      await page.locator(".sidebar").getByRole("link", { name: "接続", exact: true }).click();
      await expect(page).toHaveURL(/\/connections$/u);
      await expect(page.getByRole("heading", { name: "接続", exact: true, level: 1 })).toBeVisible();
      await expect(page.locator(".sidebar").getByRole("link", { name: "接続", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(page.getByText(DIRECT.displayName, { exact: true })).toBeVisible();
      await expect(page.getByText(OPERATOR.displayName, { exact: true })).toBeVisible();
      expect(fixture.reads).toContain("/api/v1/connections");
      expect(fixture.reads.some((path) => path.startsWith("/api/v1/connections?"))).toBe(false);
      await shots(page, "account-connections");

      await page.locator(".sidebar").getByRole("link", { name: "アカウント", exact: true }).click();
      await tabs.getByRole("link", { name: "料金と利用量" }).click();
      await expect(page).toHaveURL(/\/account\/usage$/u);
      await expect(page.getByRole("heading", { name: "利用量", level: 2 })).toBeVisible();
      await expect(page.locator(".acct-row-amount").filter({ hasText: "金額不明" })).toHaveCount(1);
      expect(fixture.reads.some((path) => path === "/api/v1/usage" || path.startsWith("/api/v1/usage?"))).toBe(true);
      expect(fixture.reads.some((path) => path.startsWith("/api/v1/workspaces/"))).toBe(false);
      await shots(page, "account-usage");

      await tabs.getByRole("link", { name: "CLI・APIから使う" }).click();
      await expect(page).toHaveURL(/\/account\/cli$/u);
      await expect(page.getByText("開発用 CLI")).toBeVisible();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toHaveCount(0);
      await page.getByRole("button", { name: "キーを作成" }).click();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();
      await shots(page, "account-cli");

      await tabs.getByRole("link", { name: "通知を受け取る端末" }).click();
      await expect(page).toHaveURL(/\/account\/devices$/u);
      await expect(page.getByText("Pixel 9", { exact: true })).toBeVisible();
      await expect(page.getByText("届いていません", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "消す", exact: true }).click();
      await expect(page.getByText("この端末には通知が届かなくなります。")).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();
      expect(fixture.reads).toContain("/api/v1/account/notification-pushers");
      await shots(page, "account-devices");
      expect(fixture.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("old URLs land where the behavior lives now", async ({ page }) => {
      const errors = collectPageErrors(page);
      await accountFixture(page);
      for (const [from, to] of [
        ["/settings", "/account"],
        ["/settings/billing", "/account/usage"],
        ["/settings/manage", "/account"],
        ["/advanced/workspace", "/account"],
        ["/advanced/workspace/members", "/account"],
        ["/advanced/workspace/connections", "/connections"],
        ["/account/connections", "/connections"],
        ["/account/members", "/account"],
        ["/account/workspace", "/account"],
        ["/runs", "/"],
        ["/activity", "/"],
        ["/graph", "/"],
        ["/workloads", "/"],
      ] as const) {
        await page.goto(from, { waitUntil: "domcontentloaded" });
        await expect(page, `${from} → ${to}`).toHaveURL(
          new RegExp(`${to.replace(/\//gu, "\\/")}$`, "u"),
        );
      }
      expect(errors).toEqual([]);
    });
  });
}
