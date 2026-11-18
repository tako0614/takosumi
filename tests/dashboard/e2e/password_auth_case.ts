import { expect, test, type Page } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";
import { handleStagingLoginPortal } from "../../../deploy/accounts-cloudflare/src/staging-login-portal.ts";

const password = "a fixture password phrase";
const email = "person@example.test";

async function passwordSignInFixture(page: Page) {
  let authenticated = false;
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await page.route("**/api/v1/auth/providers", (route) => route.fulfill({ json: {
    providers: [], password: { enabled: true },
  } }));
  await page.route("**/api/v1/dashboard/bootstrap?**", (route) => authenticated
    ? route.fallback() : route.fulfill({ status: 401, json: { error: "unauthenticated" } }));
  await page.route("**/api/v1/account/session/me", (route) => authenticated
    ? route.fallback() : route.fulfill({ json: { session: null } }));
  return { signIn: () => { authenticated = true; } };
}

export function registerPasswordAuthCases(mode: DashboardE2EMode) {
  test.describe("Password authentication", () => {
    test.skip(mode !== "portable", "synthetic account responses only");

    test("password-only login preserves the return path without an OAuth warning", async ({ page }) => {
      const fixture = await passwordSignInFixture(page);
      const bodies: unknown[] = [];
      await page.route("**/api/v1/auth/password/login", (route) => {
        bodies.push(route.request().postDataJSON());
        fixture.signIn();
        return route.fulfill({ json: { subject: "sub_portable_e2e" } });
      });
      await page.goto("/sign-in?return_to=%2Faccount%3Ffrom%3Dpassword%23profile");
      await expect(page.locator(".sign-in-notice")).toHaveCount(0);
      const form = page.getByRole("form", { name: "Sign in with a password" });
      await form.getByLabel("Email address", { exact: true }).fill(email);
      await form.getByLabel("Password", { exact: true }).fill(password);
      await expect(page.getByRole("button", { name: "Create an account", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Forgot your password?", exact: true })).toHaveCount(0);
      await form.getByRole("button", { name: "Sign in with a password" }).click();
      await expect(page).toHaveURL(/\/account\?from=password#profile$/u);
      expect(bodies).toEqual([{ email, password }]);
    });

    test("login errors stay generic and are retried only by an explicit submit", async ({ page }) => {
      const fixture = await passwordSignInFixture(page);
      let writes = 0;
      await page.route("**/api/v1/auth/password/login", (route) => {
        writes++;
        if (writes < 3) return route.fulfill({ status: writes === 1 ? 429 : 401,
          json: { error: "invalid_credentials", error_description: "private account lookup detail" } });
        fixture.signIn();
        return route.fulfill({ json: { subject: "sub_portable_e2e" } });
      });
      await page.goto("/sign-in?return=%2Faccount");
      const form = page.getByRole("form", { name: "Sign in with a password" });
      await form.getByLabel("Email address", { exact: true }).fill(email);
      await form.getByLabel("Password", { exact: true }).fill(password);
      const submit = form.getByRole("button", { name: "Sign in with a password" });
      await submit.click();
      await expect(page.getByRole("alert")).toContainText("Too many attempts");
      expect(writes).toBe(1);
      await submit.click();
      await expect(page.getByRole("alert")).toContainText("We couldn't verify these details");
      await expect(page.locator("body")).not.toContainText("private account lookup detail");
      await expect(page).toHaveURL(/\/sign-in\?/u);
      expect(writes).toBe(2);
      await submit.click();
      await expect(page).toHaveURL(/\/account$/u);
      expect(writes).toBe(3);
    });

    test("existing account sets and changes a password without a wrong proof signing it out", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      let hasPassword = false;
      const writes: unknown[] = [];
      await page.route(/\/api\/v1\/account\/sign-in-methods(?:\/[^/?]+)?(?:\?.*)?$/u, (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: {
          email, hasPassword, passwordEnabled: true, canSetPassword: true,
        } });
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.currentPassword === "wrong") return route.fulfill({ status: 401, json: {
          error: "invalid_credentials", error_description: "private proof detail",
        } });
        hasPassword = true;
        return route.fulfill({ json: { subject: "sub_portable_e2e" } });
      });
      await page.goto("/account");
      const first = page.getByRole("form", { name: "Set a password" });
      await first.getByLabel("New password", { exact: true }).fill(password);
      await first.getByLabel("Confirm new password").fill(password);
      await first.getByRole("button", { name: "Set a password" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Your sign-in settings have been updated." })).toBeVisible();
      const change = page.getByRole("form", { name: "Change password" });
      await change.getByLabel("Current password", { exact: true }).fill("wrong");
      await change.getByLabel("New password", { exact: true }).fill(password);
      await change.getByLabel("Confirm new password").fill(password);
      await change.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByRole("alert")).toContainText("We couldn't verify these details");
      await expect(page).toHaveURL(/\/account$/u);
      await expect(page.locator("body")).not.toContainText("private proof detail");
      await change.getByLabel("Current password", { exact: true }).fill(password);
      await change.getByRole("button", { name: "Change password" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Your sign-in settings have been updated." })).toBeVisible();
      expect(writes).toEqual([{ password }, { password, currentPassword: "wrong" }, { password, currentPassword: password }]);
    });

    const productReturn = "/oauth/authorize?client_id=takosumi-hosted-staging-v1&redirect_uri=https%3A%2F%2Fapp-staging.takosumi.com%2Fauth%2Foidc%2Fcallback&state=original&nonce=original";
    for (const destination of ["/account", productReturn]) {
      test(`issuer password login continues to ${destination.split("?")[0]}`, async ({ page }) => {
        const path = "/__e2e/issuer-password";
        const issuer = "https://auth-staging.takos.jp";
        const requestUrl = new URL("/sign-in", issuer);
        if (destination !== "/account") requestUrl.searchParams.set("return", destination);
        const portal = await handleStagingLoginPortal({ request: new Request(requestUrl), issuer,
          accountsHandler: () => Response.json({
            providers: [
              { id: "google", label: "Google", protocol: "oidc", enabled: true },
              { id: "github", label: "GitHub", protocol: "oauth2", enabled: true },
            ],
            password: { enabled: true },
          }) });
        const html = await portal!.text();
        await page.route(`**${path}`, (route) => route.fulfill({ body: html, headers: Object.fromEntries(portal!.headers) }));
        await page.route((url) => url.pathname + url.search === destination, (route) => route.fulfill({ contentType: "text/html", body: "<h1>Sign-in continued</h1>" }));
        const bodies: unknown[] = [];
        await page.route("**/api/v1/auth/password/login", (route) => {
          bodies.push(route.request().postDataJSON());
          return route.fulfill({ json: { subject: "sub_fixture" } });
        });
        await page.setViewportSize({ width: 320, height: 568 });
        await page.goto(path);
        const heading = destination === productReturn ? "Sign in to Takosumi" : "Sign in";
        await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
        await expect(page.getByText("TAKOS INC.", { exact: true })).toBeVisible();
        await expect(page.getByRole("link", { name: "Continue with Google" })).toBeInViewport();
        await expect(page.getByRole("link", { name: "Continue with GitHub" })).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
        const form = page.getByRole("form", { name: "Sign in with a password" });
        await form.getByLabel("Email address", { exact: true }).fill(email);
        await form.getByLabel("Password", { exact: true }).fill(password);
        await form.getByRole("button", { name: "Sign in with a password" }).click();
        await expect(page.getByRole("heading", { name: "Sign-in continued" })).toBeVisible();
        expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(destination);
        expect(bodies).toEqual([{ email, password }]);
      });
    }
  });
}
