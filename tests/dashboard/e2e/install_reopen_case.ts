import { expect, test, type Page } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";
import type { InstallAttemptFixture } from "./fixture-data.ts";

type ReopenFixture = {
  readonly mutations: string[];
  readonly attempts: InstallAttemptFixture;
  readonly continued: () => { readonly variables?: Readonly<Record<string, unknown>> } | undefined;
};

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const sourceUrl = `/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fcloudflare-service.git&ref=${sourceCommit}&path=.&name=cloudflare-service`;
const secret = "fixture-secret-value-task0118";
const publicSetting = "reopen.example.test";

async function capture(page: Page, name: string): Promise<string[]> {
  const original = page.viewportSize();
  const paths: string[] = [];
  for (const [suffix, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    const path = test.info().outputPath(`${name}-${suffix}.png`);
    await page.screenshot({ path, fullPage: true });
    paths.push(path);
  }
  if (original) await page.setViewportSize(original);
  return paths;
}

export function registerInstallReopenCases(
  mode: DashboardE2EMode,
  fixture: (page: Page) => Promise<ReopenFixture>,
) {
  test.describe("install review reopen summary", () => {
    test.skip(mode !== "portable", "deterministic install coordinator fixture; not production evidence");

    test("reopens the same review with committed provider and settings using GET only", async ({ page }) => {
      const f = await fixture(page);
      const errors: string[] = [];
      const responseBodies: string[] = [];
      const responseReads: Promise<void>[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (!new URL(response.url()).pathname.startsWith("/api/v1/")) return;
        responseReads.push((async () => {
          try { responseBodies.push(await response.text()); } catch { /* aborted optional responses have no body */ }
        })());
      });
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();

      const sheet = page.getByTestId("install-configuration");
      await expect(sheet.getByTestId("install-settings")).toBeVisible();
      const nameField = sheet.getByLabel(/^App name/u);
      await expect(nameField).toHaveValue("cloudflare-service");
      const publicField = sheet.getByRole("textbox", { name: "Domain", exact: true });
      await publicField.fill(publicSetting);
      const secretField = sheet.getByLabel(/^API token/u);
      await secretField.fill(secret);
      await secretField.press("Enter");

      const review = page.getByTestId("install-review");
      await expect(review.getByRole("button", { name: "Allow and install", exact: true })).toBeVisible({ timeout: 15_000 });
      expect(f.continued()?.variables).toEqual({ domain: publicSetting, api_token: secret });
      expect(f.attempts.log.creates.map((entry) => JSON.stringify(entry)).join("\n")).not.toContain(secret);
      await Promise.all(responseReads);
      expect(responseBodies.join("\n")).not.toContain(secret);

      const initialUrl = page.url();
      expect(initialUrl).toContain("installPlan=gip_");
      expect(initialUrl).not.toContain(secret);
      const attemptId = new URL(initialUrl).searchParams.get("installPlan")!;
      const reopenedResponse = f.attempts.handle({ method: "GET", path: `/api/v1/install-plans/${attemptId}` });
      expect(reopenedResponse?.json).toMatchObject({ reviewSummary: {
        appName: "cloudflare-service",
        connections: [{ connectionId: "pc_account_42", displayName: "Takosumi account · account-42" }],
        settings: [
          { name: "domain", type: "string", required: false, sensitive: false, set: true, value: publicSetting },
          { name: "api_token", type: "string", required: true, sensitive: true, set: true },
        ],
      } });
      const beforeReloadMutations = [...f.mutations];
      const screenshots = await capture(page, "task0118-review-before-reopen");
      await page.reload();
      await expect(page).toHaveURL(initialUrl);
      const reopened = page.getByTestId("install-review");
      await expect(reopened.getByRole("button", { name: "Allow and install", exact: true })).toBeVisible();
      await expect(page.getByTestId("install-app-name")).toHaveValue("cloudflare-service");
      await expect(page.getByTestId("install-connections")).toContainText("Takosumi account · account-42");
      await expect(page.locator('[data-variable-name="domain"]')).toContainText(publicSetting);
      await expect(page.locator('[data-variable-name="api_token"]')).toContainText("Set");
      await expect(reopened).not.toContainText(secret);
      const afterReload = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
      expect(afterReload).not.toContain(secret);
      expect(afterReload).not.toContain(publicSetting);
      await Promise.all(responseReads);
      expect(responseBodies.join("\n")).not.toContain(secret);
      expect(f.mutations).toEqual(beforeReloadMutations);
      expect(f.mutations.some((entry) => entry.includes("/apply") || entry.includes("/plan"))).toBe(false);
      const reopenedScreenshots = await capture(page, "task0118-review-after-reopen");
      screenshots.push(...reopenedScreenshots);
      expect(errors).toEqual([]);
      test.info().annotations.push({ type: "screenshots", description: screenshots.join("\n") });
    });
  });
}
