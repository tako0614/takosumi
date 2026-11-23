import { expect, test } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";

export function registerSessionIdentityCases(mode: DashboardE2EMode) {
  test.describe("Session identity boundary", () => {
    test.skip(mode !== "portable", "isolated account-switch fixture only");

    for (const [description, nextSubject, nextAccount, nextDisplayName, preservePage] of [
      ["preserves its own page", "a", "account-a", "Renamed person a", true],
      ["replaces the previous person's page identity", "b", "account-b", "Person b", false],
      ["replaces the page when the canonical account changes", "a", "account-b", "Other account profile", false],
    ] as const) {
      test(`a revalidated account ${description}`, async ({ page }) => {
        await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
        const start = Date.parse("2026-11-04T00:00:00Z");
        await page.clock.setFixedTime(start);
        let revalidate = false;
        let sessionHeld = false;
        const release = Promise.withResolvers<void>();
        await page.route("**/api/v1/dashboard/bootstrap?**", async (route) => {
          const isRevalidation = revalidate && new URL(route.request().url()).search === "?includeWorkspaces=false";
          const subject = isRevalidation ? nextSubject : "a";
          if (isRevalidation) {
            sessionHeld = true;
            await release.promise;
          }
          return route.fulfill({ json: {
            session: {
              subject,
              primaryAccountId: isRevalidation ? nextAccount : "account-a",
              displayName: isRevalidation ? nextDisplayName : "Person a",
              email: `${subject}@example.test`,
            },
            notifications: [],
          } });
        });
        await page.goto("/", { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("home-apps")).toBeVisible();

        // Advance session age while leaving the router and browser timers real.
        revalidate = true;
        await page.clock.setFixedTime(start + 31_000);
        let previousPage;
        const profile = page.locator(".acct-section");
        try {
          await page.getByRole("link", { name: "Account", exact: true }).first().click();
          await expect(page).toHaveURL(/\/account$/u);
          await expect.poll(() => sessionHeld).toBe(true);
          await expect(profile).toContainText("Person a");
          previousPage = await page.locator(".acct-page").elementHandle();
        } finally {
          release.resolve();
        }
        if (!previousPage) throw new Error("Account page did not mount");
        await expect(profile).toContainText(nextDisplayName);
        expect(await previousPage.evaluate((node) => node.isConnected)).toBe(preservePage);
        if (!preservePage) await expect(profile).not.toContainText("Person a");
      });
    }
  });
}
