import { expect, test } from "@playwright/test";

test.describe("Takosumi docs mobile navigation", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    expect(page.viewportSize()?.width).toBe(390);
  });

  test("does not expose the closed sidebar as keyboard stops", async ({
    page,
  }) => {
    const sidebar = page.locator(".VPSidebar");

    await expect(sidebar).toHaveCount(1);
    await expect(sidebar).not.toHaveClass(/\bopen\b/);
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(sidebar).toHaveAttribute("aria-hidden", "true");

    for (let index = 0; index < 24; index += 1) {
      await page.keyboard.press("Tab");
      await expect(page.locator(".VPSidebar :focus")).toHaveCount(0);
    }
  });

  test("returns focus to the sidebar trigger after Escape", async ({ page }) => {
    const sidebar = page.locator(".VPSidebar");
    const trigger = page.locator(".VPLocalNav .menu");

    await trigger.click();
    await expect(sidebar).toHaveClass(/\bopen\b/);
    await expect(sidebar).not.toHaveAttribute("inert");
    await expect(sidebar).not.toHaveAttribute("aria-hidden");

    await page.keyboard.press("Escape");
    await expect(sidebar).not.toHaveClass(/\bopen\b/);
    await expect(trigger).toBeFocused();
  });

  test("closes the expanded top navigation on Escape", async ({ page }) => {
    const trigger = page.locator(".VPNavBarHamburger");

    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".VPNavScreen")).toBeVisible();

    await page.locator(".VPNavScreen a, .VPNavScreen button").first().focus();
    await page.keyboard.press("Escape");

    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".VPNavScreen")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
