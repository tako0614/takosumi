import { expect, test } from "@playwright/test";

// Sign-out flow: local dev sign-in → open user menu → click "Sign out" →
// AuthGuard kicks back to /sign-in and localStorage is cleared. This
// catches regressions where signOut() forgets to call clearSession()
// or the redirect target drifts.
test("user menu sign-out clears session and returns to /sign-in", async ({ page }) => {
  await page.goto("/sign-in?fresh=playwright-sign-out");
  await page.evaluate(() => localStorage.clear());
  await page.locator(".sign-in-dev").click();
  await page.waitForURL("**/home", { timeout: 7_000 });

  // Confirm a session is actually present before we sign out.
  const hadSession = await page.evaluate(() => {
    // The SPA stores under a known key; we just check that the storage
    // is non-empty so the test doesn't couple to the exact key name.
    return Object.keys(localStorage).length > 0;
  });
  expect(hadSession).toBe(true);

  // Open the user menu (topbar avatar button) and click Sign out.
  await page.locator(".topbar-user").click();
  await expect(page.locator(".user-menu-pop")).toBeVisible();
  const signOutButton = page.locator(".user-menu-danger");
  await expect(signOutButton).toBeVisible();
  await signOutButton.click();

  await page.waitForURL(/\/sign-in/, { timeout: 5_000 });

  // localStorage should now be empty (or at least no session key left).
  const remaining = await page.evaluate(() => {
    return Object.entries(localStorage).filter(
      ([k, v]) =>
        k.toLowerCase().includes("session") || String(v).startsWith("sess_"),
    );
  });
  expect(remaining).toEqual([]);
});
