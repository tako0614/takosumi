import { expect, test } from "@playwright/test";

// AuthGuard regression: unauthenticated visits to gated routes must
// redirect to /sign-in with the originally-requested path preserved in
// ?return=, and local dev sign-in must complete the round-trip back to that
// path. Without this spec the AuthGuard component could degrade to
// "render the gated content and rely on the API 401" and we'd never
// notice — see src/components/auth/AuthGuard.tsx.
test("AuthGuard redirects unauthenticated visitor to /sign-in?return=...", async ({ page }) => {
  // Make sure the SPA storage is fresh — no leftover session from a
  // sibling spec.
  await page.goto("/sign-in?fresh=playwright-auth-guard");
  await page.evaluate(() => localStorage.clear());

  // Hit a gated route directly. AuthGuard runs onMount → readSession()
  // → null → nav("/sign-in?return=...").
  await page.goto("/apps");
  await page.waitForURL(/\/sign-in\?return=/);
  const url = new URL(page.url());
  expect(url.searchParams.get("return")).toBe("/apps");

  // Complete sign-in via the local dev bypass and confirm we land back on /apps.
  await page.locator(".sign-in-dev").click();
  await page.waitForURL(/\/apps(\?|$)/, { timeout: 7_000 });
});

test("AuthGuard preserves query string in return path", async ({ page }) => {
  await page.goto("/sign-in?fresh=playwright-auth-guard-qs");
  await page.evaluate(() => localStorage.clear());

  await page.goto("/notifications?filter=unread");
  await page.waitForURL(/\/sign-in\?return=/);
  const url = new URL(page.url());
  expect(url.searchParams.get("return")).toBe("/notifications?filter=unread");
});
