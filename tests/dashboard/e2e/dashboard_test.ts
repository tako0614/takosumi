import { expect, test, type Page } from "@playwright/test";
import { PORTABLE_EXPECTATIONS } from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import type { DashboardE2EMode } from "./traffic-policy.ts";

type Expectations = {
  readonly workspaceName: string;
  readonly switchWorkspaceName: string;
  readonly appName: string;
  readonly appUrl: string;
  readonly objectBucketName: string;
};

const rawMode = process.env.TAKOSUMI_E2E_MODE ?? "portable";
if (rawMode !== "portable" && rawMode !== "live") {
  throw new Error("TAKOSUMI_E2E_MODE must be either portable or live");
}
const mode: DashboardE2EMode = rawMode;

function requiredLive(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`live dashboard E2E requires ${name}`);
  return value;
}

const expectations: Expectations =
  mode === "portable"
    ? PORTABLE_EXPECTATIONS
    : {
        workspaceName: requiredLive("TAKOSUMI_E2E_WORKSPACE_NAME"),
        switchWorkspaceName: requiredLive(
          "TAKOSUMI_E2E_SWITCH_WORKSPACE_NAME",
        ),
        appName: requiredLive("TAKOSUMI_E2E_APP_NAME"),
        appUrl: requiredLive("TAKOSUMI_E2E_APP_URL"),
        objectBucketName: requiredLive("TAKOSUMI_E2E_OBJECT_BUCKET_NAME"),
      };

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

async function assertNoPageErrors(errors: readonly string[]): Promise<void> {
  expect(errors, "dashboard page raised a browser runtime error").toEqual([]);
}

function workspaceTrigger(page: Page) {
  return page
    .getByRole("button", { name: /ワークスペースを切り替え|Switch workspace/u })
    .first();
}

test.describe("Takosumi dashboard browser surface", () => {
  test("authenticates through dashboard bootstrap and switches Workspace scope", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    const bootstrap = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/dashboard/bootstrap" &&
        response.status() === 200
      );
    });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect((await bootstrap).status()).toBe(200);

    const trigger = workspaceTrigger(page);
    await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute(
      "aria-label",
      new RegExp(expectations.workspaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );

    await trigger.click();
    const menu = page.locator('[role="menu"]:visible').first();
    await expect(menu).toBeVisible();
    const workspaces = menu.getByRole("menuitemradio");
    if (mode === "portable") {
      await expect(workspaces).toHaveCount(2);
    } else {
      expect(await workspaces.count()).toBeGreaterThanOrEqual(2);
    }
    await workspaces
      .filter({ hasText: expectations.switchWorkspaceName })
      .first()
      .click();
    await expect(trigger).toHaveAttribute(
      "aria-label",
      new RegExp(expectations.switchWorkspaceName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
    );
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("renders the New App discovery view without a runtime trim crash", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/new", { waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("heading", {
        name: /追加するサービスを選ぶ|Choose a service to add/u,
      }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("undefined.trim");
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("shows the repository-owned installed app and its launch URL", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const app = page
      .locator("a.av-tile[target=\"_blank\"]")
      .filter({ hasText: expectations.appName })
      .first();
    await expect(app).toBeVisible();
    await expect(app).toHaveAttribute("href", expectations.appUrl);
    await expect(app).toHaveAttribute("target", "_blank");
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("lists an ObjectBucket and renders its customer-key controls in detail", async ({
    page,
  }) => {
    const errors = pageErrors(page);
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/resources", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("ObjectBucket", { exact: true }).first()).toBeVisible();

    const detailHref = `/resources/ObjectBucket/${encodeURIComponent(expectations.objectBucketName)}`;
    const detail = page.locator(`a[href="${detailHref}"]`).first();
    await expect(detail).toBeVisible();
    await detail.click();
    await expect(page).toHaveURL(new RegExp(`/resources/ObjectBucket/${expectations.objectBucketName}`));
    await expect(
      page.getByText(/S3互換アクセスキー|S3-compatible access keys/u).first(),
    ).toBeVisible();
    await expect(
      page.getByLabel(/キーのラベル|Key label/u),
    ).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /S3互換キーを作成|Create S3-compatible key/u,
      }),
    ).toBeVisible();
    await assertNoPageErrors(errors);
    traffic.assertNoFailures();
  });

  test("fails closed on an unexpected same-origin API 404", async ({ page }) => {
    test.skip(mode !== "portable", "the intentional 404 exists only in the fixture server");
    const traffic = monitorDashboardTraffic(page, mode);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    traffic.assertNoFailures();

    const status = await page.evaluate(async () => {
      const response = await fetch("/api/v1/__e2e/unexpected-404");
      return response.status;
    });
    expect(status).toBe(404);
    await expect.poll(() => traffic.failures.length).toBe(1);
    expect(() => traffic.assertNoFailures()).toThrow(/404/u);
  });
});
