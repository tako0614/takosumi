import { expect, test, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PORTABLE_APPS, PORTABLE_APP_MEMBERS, PORTABLE_PERSONAL_CONNECTIONS, PORTABLE_SHARED_APP_MEMBERS, portableAppConnectionLabels } from "./fixture-data.ts";
import type { DashboardE2EMode } from "./traffic-policy.ts";

const OWNER_APP = "cap_repository_office";
const SHARED_APP = "cap_beta_office";
const TRANSFER_ID = "otf_portable_pending";
const shotsDir = process.env.TAKOSUMI_E2E_SHOTS_DIR?.trim();

async function captureSharing(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  mkdirSync(shotsDir, { recursive: true });
  const original = page.viewportSize();
  for (const [size, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.screenshot({ path: join(shotsDir, `${name}-${size}.png`), fullPage: true });
    await page.getByTestId("app-sharing").screenshot({ path: join(shotsDir, `${name}-section-${size}.png`) });
  }
  if (original) await page.setViewportSize(original);
}

type RequestRecord = { readonly method: string; readonly path: string; readonly search?: string; readonly body?: unknown };

async function accountAs(page: Page, role: "owner" | "member"): Promise<RequestRecord[]> {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
  const requests: RequestRecord[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname === "/api/v1/apps" ||
      url.pathname === "/api/v1/connections" ||
      /\/api\/v1\/capsules\/[^/]+\/members(?:\/[^/]+)?$/u.test(url.pathname) ||
      url.pathname.includes("/ownership-transfers")
    ) {
      requests.push({
        method: request.method(),
        path: url.pathname,
        ...(url.search ? { search: url.search } : {}),
        ...(request.postData() ? { body: request.postDataJSON() } : {}),
      });
    }
  });
  await page.route("**/api/v1/apps**", (route) => {
    const apps = PORTABLE_APPS.map((app) => ({
      ...app,
      role: app.capsuleId === SHARED_APP ? "member" : role,
    }));
    return route.fulfill({ json: { apps } });
  });
  return requests;
}

function memberRoutes(
  page: Page,
  capsuleId: string,
  initial: { readonly owner: unknown; readonly members: readonly Record<string, unknown>[] },
) {
  let members = [...initial.members];
  const base = `/api/v1/capsules/${capsuleId}/members`;
  return page.route((url) => url.pathname === base || url.pathname.startsWith(`${base}/`), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === base) {
      return route.fulfill({ json: { owner: initial.owner, members } });
    }
    if (request.method() === "POST" && url.pathname === base) {
      const body = request.postDataJSON() as { email: string; consent: string };
      members = [...members, {
        accountId: "tsub_new_member0123456789",
        displayName: "New Member",
        email: body.email,
        status: "active",
      }];
      return route.fulfill({ status: 201, json: { member: members.at(-1) } });
    }
    const removePrefix = `${base}/`;
    if (request.method() === "DELETE" && url.pathname.startsWith(removePrefix)) {
      const accountId = decodeURIComponent(url.pathname.slice(removePrefix.length));
      members = members.filter((member) => member.accountId !== accountId);
      return route.fulfill({ json: { removed: true } });
    }
    return route.fulfill({ status: 404, json: { error: "not_found" } });
  });
}

export function registerAppSharingCases(mode: DashboardE2EMode): void {
  test.describe("Per-app ownership and sharing", () => {
    test.skip(mode !== "portable", "local deterministic app ownership fixture only");

    test("owner must consent before inviting, can remove a member, and cancel a transfer", async ({ page }) => {
      const requests = await accountAs(page, "owner");
      await memberRoutes(page, OWNER_APP, PORTABLE_APP_MEMBERS);
      const memberStatuses: number[] = [];
      page.on("response", (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith(`/api/v1/capsules/${OWNER_APP}/members`)) memberStatuses.push(response.status());
      });
      await page.route((url) => url.pathname === "/api/v1/connections", (route) => {
        const url = new URL(route.request().url());
        return route.fulfill({ json: url.searchParams.get("projection") === "labels"
          ? portableAppConnectionLabels(OWNER_APP)
          : { connections: PORTABLE_PERSONAL_CONNECTIONS } });
      });
      await page.route(`**/api/v1/capsules/${OWNER_APP}/ownership-transfers`, async (route) => {
        return route.fulfill({ status: 202, json: { transferId: TRANSFER_ID, state: "pending" } });
      });
      await page.route(`**/api/v1/ownership-transfers/${TRANSFER_ID}`, async (route) => {
        return route.fulfill({ json: { cancelled: true } });
      });

      await page.goto(`/apps/${OWNER_APP}`, { waitUntil: "domcontentloaded" });
      const sharing = page.getByTestId("app-sharing");
      await expect(sharing).toBeVisible();
      await expect(sharing).toContainText("Portable E2E");
      await expect(sharing.locator('input[name="sharing-consent"]')).toHaveAccessibleName(
        "このメンバーは、あなたの接続〈Cloudflare (direct)、Takosumi hosted service〉を使ってこのアプリを変更できます（リポジトリの変更を含む）",
      );
      await captureSharing(page, "sharing-owner");
      const email = sharing.getByRole("textbox", { name: "メールアドレス" });
      await email.fill("new-member@example.test");
      const invite = sharing.getByRole("button", { name: "招待", exact: true });
      await expect(invite).toBeDisabled();
      await sharing.locator('input[name="sharing-consent"]').check();
      await expect(invite).toBeEnabled();
      await invite.click();
      await expect(sharing).toContainText("new-member@example.test");
      expect(requests.find((request) => request.method === "POST" && request.path.endsWith("/members"))?.body).toEqual({
        email: "new-member@example.test",
        consent: "connections_and_code",
      });

      const hanako = sharing.getByRole("listitem").filter({ hasText: "Hanako Sato" });
      await hanako.getByRole("button", { name: "メンバーを削除" }).click();
      const removeDialog = page.getByRole("dialog");
      await expect(removeDialog).toContainText("Hanako Sato");
      const removeResponse = page.waitForResponse((response) =>
        response.request().method() === "DELETE" && new URL(response.url()).pathname.startsWith(`/api/v1/capsules/${OWNER_APP}/members/`));
      await removeDialog.getByRole("button", { name: "メンバーを削除" }).click();
      expect((await removeResponse).status()).toBe(200);
      await expect(sharing.getByRole("listitem").filter({ hasText: "Hanako Sato" })).toHaveCount(0);
      expect(memberStatuses.filter((status) => status >= 400)).toEqual([]);

      await sharing.locator('select[name="transfer-recipient"]').selectOption("tsub_kenta0123456789");
      await sharing.getByRole("button", { name: "所有権を譲渡" }).click();
      const transferDialog = page.getByRole("dialog");
      await expect(transferDialog).toContainText("接続は解除され");
      await transferDialog.getByRole("button", { name: "所有権を譲渡" }).click();
      await expect(sharing).toContainText(TRANSFER_ID);
      await sharing.getByRole("button", { name: "譲渡を取り消す" }).click();
      await expect(sharing.getByRole("button", { name: "所有権を譲渡" })).toBeVisible();
      expect(requests.filter((request) => request.method !== "GET")).toEqual([
        { method: "POST", path: `/api/v1/capsules/${OWNER_APP}/members`, body: { email: "new-member@example.test", consent: "connections_and_code" } },
        { method: "DELETE", path: `/api/v1/capsules/${OWNER_APP}/members/tsub_hanako0123456789` },
        { method: "POST", path: `/api/v1/capsules/${OWNER_APP}/ownership-transfers`, body: { toAccountId: "tsub_kenta0123456789" } },
        { method: "DELETE", path: `/api/v1/ownership-transfers/${TRANSFER_ID}` },
      ]);
    });

    test("an invite account-not-found response stays visible and keeps the sharing form", async ({ page }) => {
      const requests = await accountAs(page, "owner");
      await page.route(`**/api/v1/capsules/${OWNER_APP}/members`, async (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: PORTABLE_APP_MEMBERS });
        requests.push({ method: "POST", path: `/api/v1/capsules/${OWNER_APP}/members`, body: route.request().postDataJSON() });
        return route.fulfill({ status: 404, json: { error: { code: "account_not_found", message: "No account matches this email." } } });
      });
      await page.route("**/api/v1/connections**", (route) =>
        route.fulfill({ json: { connections: PORTABLE_PERSONAL_CONNECTIONS } }));

      await page.goto(`/apps/${OWNER_APP}`, { waitUntil: "domcontentloaded" });
      const sharing = page.getByTestId("app-sharing");
      const email = sharing.getByRole("textbox", { name: "メールアドレス" });
      await email.fill("missing-account@example.test");
      await sharing.locator('input[name="sharing-consent"]').check();
      await sharing.getByRole("button", { name: "招待", exact: true }).click();
      await expect(sharing.getByRole("alert")).toBeVisible();
      await expect(email).toHaveValue("missing-account@example.test");
      await expect(sharing).toBeVisible();
      expect(requests.find((request) => request.method === "POST" && request.path.endsWith("/members"))?.body).toEqual({
        email: "missing-account@example.test",
        consent: "connections_and_code",
      });
    });

    test("a member can leave but cannot manage members or uninstall the app", async ({ page }) => {
      const requests = await accountAs(page, "member");
      await memberRoutes(page, SHARED_APP, PORTABLE_SHARED_APP_MEMBERS);
      await page.route((url) => url.pathname === "/api/v1/connections", (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("projection") === "labels" && url.searchParams.get("capsuleId") === SHARED_APP) {
          return route.fulfill({ json: portableAppConnectionLabels(SHARED_APP) });
        }
        return route.fulfill({ status: 403, json: { error: "unexpected_full_connection_list" } });
      });
      await page.route(`**/api/v1/capsules/${SHARED_APP}/members/sub_portable_e2e`, async (route) => {
        return route.fulfill({ json: { removed: true } });
      });

      await page.goto(`/apps/${SHARED_APP}`, { waitUntil: "domcontentloaded" });
      const sharing = page.getByTestId("app-sharing");
      await expect(sharing).toBeVisible();
      await expect(sharing).toContainText("Hanako Sato");
      await expect(sharing.getByRole("textbox", { name: "メールアドレス" })).toHaveCount(0);
      await expect(sharing.getByRole("button", { name: "メンバーを削除" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /アンインストール|Uninstall/u })).toHaveCount(0);
      await captureSharing(page, "sharing-member");
      const connectionReads = requests.filter((request) => request.method === "GET" && request.path === "/api/v1/connections");
      expect(connectionReads.length).toBeGreaterThan(0);
      expect(connectionReads.every((request) => request.search === `?capsuleId=${SHARED_APP}&projection=labels`)).toBe(true);

      await sharing.getByRole("button", { name: "共有から退出" }).click();
      const leaveDialog = page.getByRole("dialog");
      await expect(leaveDialog).toContainText("共有から退出します");
      await leaveDialog.getByRole("button", { name: "共有から退出" }).click();
      await expect(page).toHaveURL(/\/$/u);
      expect(requests.filter((request) => request.method === "DELETE")).toEqual([
        { method: "DELETE", path: `/api/v1/capsules/${SHARED_APP}/members/sub_portable_e2e` },
      ]);
    });

    test("a member can accept an ownership transfer by its transfer id", async ({ page }) => {
      const requests = await accountAs(page, "member");
      let role: "member" | "owner" = "member";
      await page.route("**/api/v1/apps**", (route) => {
        const apps = PORTABLE_APPS.map((app) => ({
          ...app,
          role: app.capsuleId === SHARED_APP ? role : "owner",
        }));
        return route.fulfill({ json: { apps } });
      });
      await memberRoutes(page, SHARED_APP, PORTABLE_SHARED_APP_MEMBERS);
      await page.route(`**/api/v1/ownership-transfers/${TRANSFER_ID}/accept`, async (route) => {
        role = "owner";
        return route.fulfill({ json: { transferId: TRANSFER_ID, state: "accepted" } });
      });

      await page.goto(`/apps/${SHARED_APP}`, { waitUntil: "domcontentloaded" });
      const sharing = page.getByTestId("app-sharing");
      const transferId = sharing.locator('input[name="ownership-transfer-id"]');
      await transferId.fill(TRANSFER_ID);
      await sharing.getByRole("button", { name: "所有権を受け取る" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("利用料金を支払います");
      await dialog.getByRole("button", { name: "所有権を受け取る" }).click();
      await expect(sharing).toContainText("共有を更新しました");
      await expect(sharing.getByRole("textbox", { name: "メールアドレス" })).toBeVisible();
      await expect(sharing.getByRole("button", { name: "共有から退出" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "アンインストール" })).toBeVisible();
      expect(requests.filter((request) => request.method === "POST")).toContainEqual({
        method: "POST",
        path: `/api/v1/ownership-transfers/${TRANSFER_ID}/accept`,
      });
    });

    test("hides the app-sharing section when its new members route is absent", async ({ page }) => {
      await accountAs(page, "owner");
      await page.route(`**/api/v1/capsules/${OWNER_APP}/members`, (route) =>
        route.fulfill({ status: 404, json: { error: "not_found" } }));
      const response = page.waitForResponse((candidate) =>
        new URL(candidate.url()).pathname === `/api/v1/capsules/${OWNER_APP}/members`);
      await page.goto(`/apps/${OWNER_APP}`, { waitUntil: "domcontentloaded" });
      await response;
      await expect(page.getByTestId("app-sharing")).toHaveCount(0);
    });
  });
}
