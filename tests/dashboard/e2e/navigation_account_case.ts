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
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
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

/** Narrow the fixture's workspace list to one workspace (bootstrap and page reads). */
async function singleWorkspace(page: Page): Promise<void> {
  await page.route(
    (url) =>
      url.pathname === "/api/v1/dashboard/bootstrap" ||
      url.pathname === "/api/v1/workspaces",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      const only = (list: unknown) =>
        Array.isArray(list) ? list.filter((item) => item.id === "ws_alpha") : list;
      if (Array.isArray(body.workspaces)) body.workspaces = only(body.workspaces);
      for (const key of ["workspaceList"]) {
        const page = body[key] as Record<string, unknown> | undefined;
        if (page) Object.assign(page, { total: 1, returned: 1 });
      }
      if (typeof body.total === "number") Object.assign(body, { total: 1, returned: 1 });
      await route.fulfill({ response, json: body });
    },
  );
}

const DIRECT = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1];
const OPERATOR = PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[0];

type AccountFixture = { readonly mutations: string[] };

/** Stubs the reads 接続 and アカウント add on top of the fixture server. */
async function accountFixture(page: Page): Promise<AccountFixture> {
  const mutations: string[] = [];
  const handle = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 500, json: { error: "fixture_read_only" } });
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
    if (path === "/api/v1/workspaces/ws_alpha/members") {
      const row = (accountId: string, role: string, extra: object) => ({
        id: `wsm_${accountId}`,
        workspaceId: "ws_alpha",
        accountId,
        roles: [role],
        status: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        ...extra,
      });
      return route.fulfill({
        json: {
          members: [
            row("sub_portable_e2e", "owner", {
              displayName: "Portable E2E",
              email: "portable-e2e@example.test",
            }),
            row("tsub_hanako0123456789", "admin", {
              displayName: "Hanako Sato",
              email: "hanako@example.test",
            }),
            row("tsub_kenta0123456789", "viewer", {
              displayName: "Kenta Ito",
              email: "kenta@example.test",
            }),
            row("tsub_noname0123456789", "member", {}),
          ],
        },
      });
    }
    if (path === "/api/v1/workspaces/ws_alpha/billing") {
      return route.fulfill({ json: { billing: { settings: { mode: "showback" } } } });
    }
    if (path === "/api/v1/workspaces/ws_alpha/usage") {
      return route.fulfill({
        json: {
          usageEvents: [
            {
              id: "use_rated",
              workspaceId: "ws_alpha",
              capsuleId: "cap_repository_office",
              kind: "runner_minute",
              quantity: 3,
              usdMicros: 12_000,
              ratingStatus: "rated",
              source: "runner",
              idempotencyKey: "use_rated",
              createdAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
            },
            {
              id: "use_unrated",
              workspaceId: "ws_alpha",
              capsuleId: "cap_repository_office",
              kind: "operation",
              quantity: 1,
              usdMicros: 0,
              ratingStatus: "unrated",
              source: "control",
              idempotencyKey: "use_unrated",
              createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
            },
          ],
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
    return route.fallback();
  };
  await page.route("**/api/v1/**", handle);
  return { mutations };
}

export function registerNavigationAccountCases(mode: string): void {
  test.describe("Navigation, connections and account", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");

    test("the primary nav is the four behaviors and one workspace shows no switcher", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      await singleWorkspace(page);
      await page.setViewportSize(DESKTOP);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const sidebar = page.locator(".sidebar-nav");
      await expect(sidebar.getByRole("link")).toHaveText(["ホーム", "ストア", "接続", "アカウント"]);
      // One workspace: no switcher and no workspace name anywhere in the chrome.
      await expect(page.getByRole("button", { name: /スペースを切り替え|Switch workspace/u })).toHaveCount(0);
      await expect(page.locator(".sidebar")).not.toContainText(PORTABLE_EXPECTATIONS.workspaceName);
      await expect(page.locator(".topbar")).not.toContainText(PORTABLE_EXPECTATIONS.workspaceName);
      // The profile menu matches: アカウント, no run history.
      await page.getByRole("button", { name: /ユーザーメニュー|User menu/u }).click();
      const menu = page.getByRole("group", { name: /ユーザーメニュー|User menu/u });
      await expect(menu.getByRole("link", { name: "アカウント" })).toHaveAttribute("href", "/account");
      await expect(menu).not.toContainText("デプロイ履歴");
      await page.keyboard.press("Escape");
      await shot(page, "nav-desktop-single-workspace");

      await page.setViewportSize(PHONE);
      const tabs = page.locator(".mobile-tabs");
      await expect(tabs.getByRole("link")).toHaveText(["ホーム", "ストア", "接続", "アカウント"]);
      await expect(page.getByRole("button", { name: /スペースを切り替え|Switch workspace/u })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(1);
      await shot(page, "nav-mobile-single-workspace");
      expect(errors).toEqual([]);
    });

    test("two or more workspaces show a switcher by name with create-by-purpose", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      await page.setViewportSize(DESKTOP);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const trigger = page.getByRole("button", { name: /スペースを切り替え/u }).first();
      await expect(trigger).toBeVisible();
      await trigger.click();
      const menu = page.locator('[role="menu"]:visible').first();
      await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
      await expect(menu).toContainText(PORTABLE_EXPECTATIONS.switchWorkspaceName);
      await expect(menu).not.toContainText("@workspace-");
      await expect(menu.getByRole("menuitem", { name: "環境を分ける" })).toBeVisible();
      await expect(menu.getByRole("menuitem", { name: "チームで使う" })).toBeVisible();
      await shot(page, "workspace-switcher-desktop");
      await page.keyboard.press("Escape");

      await page.setViewportSize(PHONE);
      const compact = page.getByRole("button", { name: /スペースを切り替え/u }).first();
      await compact.click();
      await expect(page.locator('[role="menu"]:visible').first()).toBeVisible();
      await shot(page, "workspace-switcher-mobile");
      expect(errors).toEqual([]);
    });

    test("接続 shows the apps using each connection and removal names them", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const fixture = await accountFixture(page);
      await page.setViewportSize(DESKTOP);
      await page.goto("/connections", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "接続", level: 1 })).toBeVisible();
      const direct = page.locator(".conn-card").filter({ hasText: DIRECT.displayName });
      const operator = page.locator(".conn-card").filter({ hasText: OPERATOR.displayName });
      await expect(direct.locator(".conn-apps")).toContainText("使っているアプリ");
      await expect(direct.getByRole("link", { name: PORTABLE_EXPECTATIONS.appName })).toHaveAttribute(
        "href",
        "/workloads/cap_repository_office",
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

    test("アカウント sections: you, members by name, billing, workspace and CLI keys", async ({ page }) => {
      const errors = collectPageErrors(page);
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const fixture = await accountFixture(page);
      await page.setViewportSize(DESKTOP);

      await page.goto("/account", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "アカウント", level: 1 })).toBeVisible();
      const tabs = page.locator(".acct-tabs");
      await expect(tabs.getByRole("link")).toHaveText([
        "自分",
        "メンバー",
        "料金と利用量",
        "スペース",
        "CLI・APIから使う",
      ]);
      await expect(page.getByRole("button", { name: "このブラウザからサインアウト" })).toBeVisible();
      await shots(page, "account-me");

      await tabs.getByRole("link", { name: "メンバー" }).click();
      await expect(page).toHaveURL(/\/account\/members$/u);
      const list = page.getByRole("list", { name: "メンバー一覧" });
      await expect(list).toContainText("Hanako Sato");
      await expect(list).toContainText("hanako@example.test");
      await expect(list).toContainText("メンバー（tsub_nonam…）");
      await expect(list).not.toContainText("tsub_hanako");
      await expect(page.locator(".acct-roles")).toContainText("閲覧のみ");
      await shots(page, "account-members");

      await tabs.getByRole("link", { name: "料金と利用量" }).click();
      await expect(page).toHaveURL(/\/account\/billing$/u);
      await expect(page.getByText("Takosumi はこのスペースの利用量を記録しますが、請求はしません。")).toBeVisible();
      await expect(page.locator(".acct-row-amount").filter({ hasText: "金額不明" })).toHaveCount(1);
      await expect(page.locator(".acct-section")).not.toContainText("ショーバック");
      await shots(page, "account-billing");

      await tabs.getByRole("link", { name: "スペース" }).click();
      await expect(page).toHaveURL(/\/account\/workspace$/u);
      await expect(page.getByRole("textbox", { name: /名前/u }).first()).toHaveValue(
        PORTABLE_EXPECTATIONS.workspaceName,
      );
      await expect(page.locator(".acct-section")).not.toContainText("@alpha");
      await expect(page.getByRole("button", { name: /環境を分ける/u })).toBeVisible();
      await expect(page.getByRole("button", { name: /チームで使う/u })).toBeVisible();
      await shots(page, "account-workspace");

      await tabs.getByRole("link", { name: "CLI・APIから使う" }).click();
      await expect(page).toHaveURL(/\/account\/cli$/u);
      await expect(page.getByText("開発用 CLI")).toBeVisible();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toHaveCount(0);
      await page.getByRole("button", { name: "キーを作成" }).click();
      await expect(page.getByRole("textbox", { name: /キーの名前/u })).toBeVisible();
      await page.getByRole("button", { name: "キャンセル" }).click();
      await shots(page, "account-cli");
      expect(fixture.mutations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("old URLs land where the behavior lives now", async ({ page }) => {
      const errors = collectPageErrors(page);
      await accountFixture(page);
      for (const [from, to] of [
        ["/settings", "/account"],
        ["/settings/billing", "/account/billing"],
        ["/settings/manage", "/account"],
        ["/advanced/workspace", "/account/workspace"],
        ["/advanced/workspace/members", "/account/members"],
        ["/advanced/workspace/connections", "/connections"],
        ["/members", "/account/members"],
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
