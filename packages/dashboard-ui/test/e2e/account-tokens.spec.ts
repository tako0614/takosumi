import { expect, test } from "@playwright/test";

// /account/tokens lets a signed-in user create a Personal Access
// Token. Spec walks: sign in → /account/tokens → submit the create
// form with a unique name → the new-token panel appears with the
// once-revealed token value visible. Revoke is not exercised because
// the backend API may not yet wire it; display verification is
// sufficient to catch SPA regressions.
test("/account/tokens — create flow reveals the token once", async ({ page }) => {
  await page.goto("/sign-in?fresh=playwright-tokens");
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sign-in-dev").click();
  await page.waitForURL("**/home", { timeout: 7_000 });

  await page.goto("/account/tokens");
  await expect(page.locator(".page-header")).toBeVisible();
  await expect(page.locator(".token-form")).toBeVisible();

  const tokenName = `e2e-${Date.now()}`;
  await page.locator(".token-form input").fill(tokenName);
  await page.locator(".token-form button[type='submit']").click();

  // The reveal panel uses .token-issued-value to show the once-revealed
  // token string. We don't know what string the backend returns, but it
  // MUST be visible and non-empty within ~5 seconds.
  const revealed = page.locator(".token-issued-value");
  await expect(revealed).toBeVisible({ timeout: 7_000 });
  const text = await revealed.textContent();
  expect((text ?? "").trim().length).toBeGreaterThan(8);
});
