import { expect, test } from "@playwright/test";

// /account/profile renders a read-only key/value list of the active
// session: subject, displayName, email, provider, expiry. If the SPA
// changes its session shape or the profile route stops rendering,
// this catches the regression before users see an empty page.
test("/account/profile renders session fields", async ({ page }) => {
  await page.goto("/sign-in?fresh=playwright-profile");
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sign-in-dev").click();
  await page.waitForURL("**/home", { timeout: 7_000 });

  await page.goto("/account/profile");
  await expect(page.locator(".page-header")).toBeVisible();
  // kv-list has 5 <dt>/<dd> pairs (subject, displayName, email,
  // provider, expiry). We just assert the structural shape — value
  // contents depend on which local dev provider the sign-in helper used.
  await expect(page.locator(".kv-list")).toBeVisible();
  // <code> wraps the subject id (tsub_...).
  await expect(page.locator(".kv-list code")).toContainText(/tsub_/);
});
