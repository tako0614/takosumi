import { expect, test } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";

export function registerSessionIdentityCases(mode: DashboardE2EMode) {
  test.describe("Session identity boundary", () => {
    test.skip(mode !== "portable", "isolated account-switch fixture only");

    for (const nextSubject of ["a", "b"] as const) {
    test(`a revalidated account ${nextSubject === "a" ? "preserves its own page" : "replaces the previous person's page identity"}`, async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.clock.install({ time: new Date("2026-11-04T00:00:00Z") });
      let subject = "a";
      let holdSession = false;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/v1/dashboard/bootstrap?**", async (route) => {
        const selectedSubject = subject;
        if (holdSession && new URL(route.request().url()).search === "?includeWorkspaces=false") {
          holdSession = false;
          await held;
        }
        return route.fulfill({ json: {
          session: { subject: selectedSubject, displayName: `Person ${selectedSubject}`, email: `${selectedSubject}@example.test` },
          notifications: [],
        } });
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("home-apps")).toBeVisible();
      subject = nextSubject;
      await page.clock.fastForward(31_000);
      const nextSession = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return url.pathname === "/api/v1/dashboard/bootstrap" && url.search === "?includeWorkspaces=false";
      });
      holdSession = true;
      await page.getByRole("link", { name: "Account", exact: true }).first().click();
      const profile = page.locator(".acct-section");
      await expect(profile).toContainText("Person a");
      const previousPage = await page.locator(".acct-page").elementHandle();
      if (!previousPage) throw new Error("Account page did not mount");
      release();
      await (await nextSession).finished();
      await page.clock.runFor(100);
      await expect(profile).toContainText(`Person ${nextSubject}`);
      expect(await previousPage.evaluate((node) => node.isConnected)).toBe(nextSubject === "a");
      if (nextSubject === "b") await expect(profile).not.toContainText("Person a");
    });
    }
  });
}
