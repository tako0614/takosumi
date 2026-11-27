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

    for (const [language, scenario] of [
      ["ja", "shared"],
      ["en", "shared"],
      ["ja", "stock"],
      ["ja", "no access"],
      ["ja", "unadvertised"],
      ["en", "retired view"],
      ["en", "signed out"],
    ] as const) {
      test(`Account usage links only to advertised Hosted personal billing (${language}, ${scenario})`, async ({ page }) => {
        const fixture = await accountFixture(page);
        const holdWorkspaceRead = scenario === "retired view" || scenario === "signed out";
        await page.addInitScript(({ lang, hold }) => {
          localStorage.setItem("tg_lang", lang);
          localStorage.setItem("takosumi.currentWorkspaceId", "ws_team");
          if (!hold) return;
          const fetch = window.fetch.bind(window);
          window.fetch = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input.toString(), location.origin);
            if (url.pathname !== "/api/v1/workspaces" || url.searchParams.get("order") !== "created_asc") {
              return fetch(input, init);
            }
            // Let a response cross the cancellation boundary to check the view/session guard too.
            const response = await fetch(input, { ...init, signal: null });
            requestAnimationFrame(() => requestAnimationFrame(() => {
              document.documentElement.dataset.lateBillingWorkspaceRead = String(response.status);
            }));
            return response;
          };
        }, { lang: language, hold: holdWorkspaceRead });
        const subject = "tsub_usage_fixture";
        const base = { handle: "fixture", displayName: "Fixture", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
        const workspace = { ...base, id: "ws_personal", type: "personal", ownerUserId: subject };
        const otherWorkspaces = [
          { ...workspace, id: "ws_team", type: "organization" },
          { ...workspace, id: "ws_foreign", ownerUserId: "tsub_other" },
          { ...workspace, id: "ws_archived", archivedAt: base.createdAt },
          ...Array.from({ length: 47 }, (_, index) => ({ ...workspace, id: `ws_team_${index}`, type: "organization" })),
        ];
        const workspaceReadStarted = Promise.withResolvers<void>();
        const releaseWorkspaceRead = Promise.withResolvers<void>();
        const cursors: Array<string | null> = [];
        const ownedWorkspacesRoute = (url: URL) =>
          url.pathname === "/api/v1/workspaces" && url.searchParams.get("order") === "created_asc";
        await page.route(ownedWorkspacesRoute, async (route) => {
          const cursor = new URL(route.request().url()).searchParams.get("cursor");
          expect(route.request().method()).toBe("GET");
          expect(new URL(route.request().url()).searchParams.get("limit")).toBe("50");
          cursors.push(cursor);
          workspaceReadStarted.resolve();
          if (holdWorkspaceRead) {
            await releaseWorkspaceRead.promise;
            if (scenario === "retired view") return route.fulfill({ status: 401, json: { error: "unauthenticated" } });
          }
          const workspaces = cursor ? [workspace] : otherWorkspaces;
          const truncated = !cursor && scenario !== "no access";
          return route.fulfill({ json: { workspaces, returned: workspaces.length, limit: 50, truncated,
            ...(truncated ? { nextCursor: "next_workspace_page" } : {}) } });
        });
        let authenticated = true;
        let signOuts = 0;
        if (scenario === "signed out") {
          await page.route("**/api/v1/account/session/me", (route) => {
            if (route.request().method() !== "DELETE") return route.fallback();
            signOuts += 1;
            authenticated = false;
            return route.fulfill({ status: 204 });
          });
        }
        if (scenario !== "stock") {
          await page.route("**/auth/oidc/session", (route) => route.fulfill({ status: authenticated ? 200 : 401, json: { authenticated } }));
        }
        await page.route("**/api/v1/dashboard/bootstrap?**", (route) => {
          const query = new URL(route.request().url()).searchParams;
          return route.fulfill({ headers: { "x-takosumi-shared-auth-read": "1" }, json: {
            session: { subject }, notifications: [],
            ...(query.get("includeWorkspaces") === "true" ? { workspaces: otherWorkspaces } : {}),
          } });
        });
        await page.route("**/__takosumi/platform/contributions", (route) => route.fulfill({
          json: {
            kind: "takosumi.platform-extension-contributions@v1",
            contributions: [{
              id: "hosted-workspace-billing", slot: "workspace.billing",
              href: scenario === "unadvertised" ? "/api/v1/billing/subscription" : "/api/v1/billing",
              presentation: "link", label: "使用量と課金", labels: { en: "Usage and billing", ja: "使用量と課金" },
              descriptions: { en: "Rates and invoices", ja: "料金明細を確認" },
            }],
          },
        }));
        const catalog = page.waitForResponse((response) => new URL(response.url()).pathname === "/__takosumi/platform/contributions");
        const workspaceRead = scenario === "no access"
          ? page.waitForResponse((response) => ownedWorkspacesRoute(new URL(response.url()))) : undefined;
        await page.goto("/account/usage", { waitUntil: "domcontentloaded" });
        await catalog;
        await expect(page.getByRole("heading", { level: 1, name: language === "ja" ? "料金と利用量" : "Billing and usage" })).toBeVisible();
        const label = language === "ja" ? "使用量と課金" : "Usage and billing";
        const link = page.getByRole("link", { name: label, exact: true });
        if (scenario === "shared") {
          const href = `/api/v1/billing?workspaceId=ws_personal&lang=${language}`;
          await expect(link).toHaveAttribute("href", href);
          await expect(page.getByText(label, { exact: true })).toHaveCount(1);
          await expect(page.getByText(language === "ja" ? "料金明細を確認" : "Rates and invoices", { exact: true })).toBeVisible();
          expect(cursors).toEqual([null, "next_workspace_page"]);
          await page.route("**/api/v1/billing?**", (route) => {
            expect(route.request().method()).toBe("GET");
            return route.fulfill({
              contentType: "text/html",
              body: '<h1>Hosted billing fixture</h1><a href="/account/usage">Return to usage</a>',
            });
          });
          await link.click();
          await expect(page.getByRole("heading", { name: "Hosted billing fixture" })).toBeVisible();
          expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(href);
          await page.getByRole("link", { name: "Return to usage" }).click();
          await expect(page).toHaveURL((url) => url.pathname === "/account/usage");
          await expect(link).toHaveAttribute("href", href);
          await expect(page.getByText(label, { exact: true })).toHaveCount(1);
          expect(cursors).toEqual([null, "next_workspace_page", null, "next_workspace_page"]);
        } else if (holdWorkspaceRead) {
          try {
            await workspaceReadStarted.promise;
            if (scenario === "signed out") {
              await page.getByRole("button", { name: "User menu" }).click();
              await page.getByRole("button", { name: "Sign out", exact: true }).click();
            } else {
              await page.getByRole("link", { name: "Account", exact: true }).filter({ visible: true }).last().click();
            }
            const path = scenario === "signed out" ? "/sign-in" : "/account";
            await expect(page).toHaveURL((url) => url.pathname === path && url.search === "");
            releaseWorkspaceRead.resolve();
            await expect(page.locator("html")).toHaveAttribute("data-late-billing-workspace-read", scenario === "signed out" ? "200" : "401");
            await expect(page).toHaveURL((url) => url.pathname === path && url.search === "");
            await expect(link).toHaveCount(0);
            expect(cursors).toEqual([null]);
            expect(signOuts).toBe(scenario === "signed out" ? 1 : 0);
          } finally {
            releaseWorkspaceRead.resolve();
          }
        } else {
          await workspaceRead;
          await expect(link).toHaveCount(0);
          expect(cursors).toEqual(scenario === "no access" ? [null] : []);
        }
        expect(fixture.mutations).toEqual([]);
      });
    }

    for (const [language, theme] of [["ja", "dark"], ["en", "light"]] as const) {
      test(`Home, Store, App, Connections and Account fit at five widths (${language}, ${theme})`, async ({ page }, info) => {
        test.setTimeout(75_000);
        const errors = collectPageErrors(page);
        const fixture = await accountFixture(page);
        await page.addInitScript(({ language, theme }) => {
          localStorage.setItem("tg_lang", language);
          localStorage.setItem("tg_theme", theme);
          localStorage.setItem("tcs.stores", JSON.stringify(["https://store.example.test"]));
        }, { language, theme });
        await page.route("https://store.example.test/tcs/v2/listings**", (route) => route.fulfill({ json: { items: [{
          id: "fixtures/office",
          source: { git: "https://github.com/example/office.git" },
          name: { ja: "共同作業オフィス", en: "Team Office" },
          description: { ja: "チームの作業をまとめるアプリ。", en: "An app for your team's shared work." },
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        }] } }));
        const surfaces = [
          { name: "home", route: "/", target: '[data-app-opens="true"] .av-tile' },
          // The listing button's pseudo-element makes the entire card clickable.
          { name: "store", route: "/new", target: '[data-tcs-listing-id="fixtures/office"]', card: true },
          { name: "app", route: "/apps/cap_repository_office", target: '[data-testid="app-primary"] .ap-open > a' },
          { name: "connections", route: "/connections", target: ".conn-details > summary" },
          { name: "account", route: "/account", target: ".acct-page nav a" },
        ] as const;
        for (const { name, route, target, ...options } of surfaces) {
          await page.goto(route, { waitUntil: "domcontentloaded" });
          await expect(page.locator("html")).toHaveAttribute("lang", language);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          const primary = page.locator(target).first();
          await expect(primary).toBeVisible();
          await expect(page.getByRole("main")).toHaveCount(1);
          if (name === "store") {
            const options = page.getByRole("button", { name: language === "ja" ? "表示設定" : "Display options" });
            const order = page.getByRole("combobox", { name: language === "ja" ? "並び順" : "Sort", exact: true });
            await expect(order).toBeHidden();
            await options.click();
            await order.selectOption("created");
            await options.click();
            await expect(order).toBeHidden();
            await options.click();
            await expect(order).toHaveValue("created");
            await options.click();
          }
          for (const width of [320, 375, 414, 768, 1440]) {
            const label = `${name}-${language}-${theme}-${width}`;
            await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
            if (name === "home") {
              // The virtual grid recomputes its columns on the next animation frame.
              const grid = page.locator(".av-home-grid");
              await expect.poll(() => grid.evaluate((node) =>
                getComputedStyle(node).gridTemplateColumns.trim().split(/\s+/u).length
              ), `${label} Home columns`).toBeGreaterThanOrEqual(3);
            }
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth), label).toBeLessThanOrEqual(1);
            const size = await primary.boundingBox();
            expect(size?.width, `${label} target width`).toBeGreaterThanOrEqual(44);
            expect(size?.height, `${label} target height`).toBeGreaterThanOrEqual(44);
            if ("card" in options) {
              await primary.scrollIntoViewIfNeeded();
              expect(await primary.evaluate((card) => {
                const { left, bottom } = card.getBoundingClientRect();
                return Boolean(document.elementFromPoint(left + 12, bottom - 12)?.closest(".tcs-card-open"));
              }), `${label} card hit area`).toBe(true);
              await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
            }
            await page.screenshot({ path: info.outputPath(`${label}.png`), animations: "disabled", fullPage: true });
          }
        }
        expect(fixture.mutations).toEqual([]);
        expect(errors).toEqual([]);
      });
    }

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
      await expect(page.getByTestId("home-apps")).toContainText("一部のアプリの起動情報を読み込めませんでした");
      expect(maximum).toBeLessThanOrEqual(4);
      expect(maximum).toBeGreaterThan(1);
    });

    test("接続 shows the apps using each connection and removal names them", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const fixture = await accountFixture(page);
      await page.setViewportSize(DESKTOP);
      await page.goto("/connections", { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(/\/connections$/u);
      await expect(page.getByRole("heading", { name: "接続", exact: true, level: 1 })).toBeVisible();
      const direct = page.locator(".conn-details").filter({ hasText: DIRECT.displayName });
      const operator = page.locator(".conn-details").filter({ hasText: OPERATOR.displayName });
      await expect(direct.locator("summary")).toBeVisible();
      await expect(direct.getByRole("button", { name: "削除" })).toHaveCount(0);
      await direct.locator("summary").press("Enter");
      await operator.locator("summary").click();
      await expect(direct.locator(".conn-apps")).toBeVisible();
      await expect(direct.locator(".conn-apps")).toContainText("使っているアプリ");
      await expect(direct.getByRole("link", { name: PORTABLE_EXPECTATIONS.appName })).toHaveAttribute(
        "href",
        "/apps/cap_repository_office",
      );
      await expect(operator.locator(".conn-apps")).toBeVisible();
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
      const sections = page.getByRole("navigation", { name: "アカウントの項目" });
      const accountBack = page.getByRole("main").getByRole("link", { name: "アカウント", exact: true });
      await expect(sections.getByRole("link")).toHaveText([
        "料金と利用量",
        "CLI・APIから使う",
        "通知を受け取る端末",
      ]);
      await expect(sections).not.toContainText(/メンバー|スペース|workspace/iu);
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
      const usageLink = sections.getByRole("link", { name: "料金と利用量" });
      const usageHeading = page.getByRole("heading", { name: "料金と利用量", level: 1 });
      await usageLink.press("Enter");
      await expect(page).toHaveURL(/\/account\/usage$/u);
      await expect(usageHeading).toBeFocused();
      await expect(sections).toHaveCount(0);
      await page.goBack();
      await expect(usageLink).toBeFocused();
      await page.goForward();
      await expect(usageHeading).toBeFocused();
      await expect(page.getByRole("heading", { name: "利用量", level: 2 })).toBeVisible();
      await expect(page.locator(".acct-row-amount").filter({ hasText: "金額不明" })).toHaveCount(1);
      expect(fixture.reads.some((path) => path === "/api/v1/usage" || path.startsWith("/api/v1/usage?"))).toBe(true);
      expect(fixture.reads.some((path) => path.startsWith("/api/v1/workspaces/"))).toBe(false);
      await shots(page, "account-usage");
      await accountBack.press("Enter");
      await expect(page).toHaveURL(/\/account$/u);
      await expect(usageLink).toBeFocused();

      await sections.getByRole("link", { name: "CLI・APIから使う" }).click();
      await expect(page).toHaveURL(/\/account\/cli$/u);
      await expect(page.getByText("開発用 CLI")).toBeVisible();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toHaveCount(0);
      await page.getByRole("button", { name: "キーを作成" }).click();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();
      await shots(page, "account-cli");
      await accountBack.click();
      await expect(page).toHaveURL(/\/account$/u);

      await sections.getByRole("link", { name: "通知を受け取る端末" }).click();
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

    for (const committed of [true, false]) {
      test(`API key revocation reads back after a lost response (committed: ${committed})`, async ({ page }) => {
        const errors = collectPageErrors(page);
        await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
        const fixture = await accountFixture(page);
        const token = {
          id: "pat_cli",
          subject: "sub_portable_e2e",
          name: "開発用 CLI",
          prefix: "tks_8f2a",
          scopes: ["read"],
          created_at: "2026-10-01T00:00:00.000Z",
        };
        let revoked = false;
        let listReads = 0;
        let revokeRequests = 0;
        await page.route((url) => url.pathname === "/api/v1/account/tokens", (route) => {
          expect(route.request().method()).toBe("GET");
          listReads += 1;
          return route.fulfill({
            json: {
              tokens: [
                { ...token, ...(revoked ? { revoked_at: "2026-10-02T00:00:00.000Z" } : {}) },
                { ...token, id: "pat_other", name: "別のキー", revoked_at: "2026-10-02T00:00:00.000Z" },
              ],
              next_cursor: null,
            },
          });
        });
        await page.route("**/api/v1/account/tokens/pat_cli/revoke", (route) => {
          expect(route.request().method()).toBe("POST");
          revokeRequests += 1;
          revoked = committed;
          return route.abort("failed");
        });

        await page.goto("/account/cli", { waitUntil: "domcontentloaded" });
        const row = page.getByRole("listitem").filter({ hasText: token.name });
        const revoke = row.getByRole("button", { name: "無効にする", exact: true });
        const error = page.getByText(/API キーの操作を完了できませんでした/u);
        await expect(row.getByText("有効", { exact: true })).toBeVisible();
        await revoke.click();
        await expect(row.getByRole("group")).toBeVisible();
        await revoke.click();

        if (committed) {
          await expect(row.getByText("無効", { exact: true })).toBeVisible();
          await expect(revoke).toHaveCount(0);
          await expect(error).toHaveCount(0);
        } else {
          await expect(error).toBeVisible();
          await expect(row.getByText("有効", { exact: true })).toBeVisible();
          await expect(revoke).toBeEnabled();
        }
        expect(listReads).toBe(2);
        expect(revokeRequests).toBe(1);
        expect(fixture.mutations).toEqual([]);
        expect(errors).toEqual([]);
      });
    }

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
