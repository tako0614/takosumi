import { expect, test, type Page } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";

async function signedOut(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await page.route("**/api/v1/dashboard/bootstrap?**", (route) => route.fulfill({
    status: 401, json: { error: "unauthenticated" },
  }));
  await page.route("**/api/v1/account/session/me", (route) => route.fulfill({
    json: { session: null },
  }));
}

export function registerSharedSignInCases(mode: DashboardE2EMode): void {
  test.describe("Shared sign-in", () => {
    test.skip(mode !== "portable", "isolated sign-in responses only");

    test("logout offers an explicit RP document navigation without restarting sign-in", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      let authenticated = true;
      let providers = 0;
      const navigations: string[] = [];
      await page.route("**/auth/oidc/session", (route) => route.fulfill({
        status: authenticated ? 200 : 401, json: { authenticated },
      }));
      await page.route("**/api/v1/dashboard/bootstrap?**", (route) => authenticated
        ? route.fallback()
        : route.fulfill({ status: 401, json: { error: "unauthenticated" } }));
      await page.route("**/api/v1/account/session/me", (route) => {
        if (route.request().method() === "DELETE") {
          authenticated = false;
          return route.fulfill({ status: 204 });
        }
        return authenticated ? route.fallback() : route.fulfill({ json: { session: null } });
      });
      await page.route("**/api/v1/auth/providers", (route) => {
        providers += 1;
        return route.fulfill({ status: 404, json: { error: "not_found" } });
      });
      await page.route("**/auth/oidc/login", (route) => {
        if (route.request().isNavigationRequest() && route.request().frame() === page.mainFrame()) {
          navigations.push(route.request().url());
        }
        return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>RP login reached</title>" });
      });
      await page.goto("/");
      await expect(page.getByTestId("home-apps")).toBeVisible();
      await page.locator("button.topbar-user").click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(/\/sign-in$/u);
      const login = page.locator(".sign-in-buttons a");
      await expect(login).toBeVisible();
      expect(authenticated).toBe(false);
      expect(navigations).toEqual([]);
      expect(providers).toBe(0);
      await expect(page.locator(".sign-in-notice")).toHaveCount(0);
      await login.click();
      await expect(page).toHaveTitle("RP login reached");
      expect(navigations).toEqual([new URL("/auth/oidc/login", page.url()).href]);
    });

    for (const key of ["return", "return_to"]) {
      test(`the explicit RP action preserves the complete ${key} install destination`, async ({ page }) => {
        await signedOut(page);
        await page.route("**/auth/oidc/session", (route) => route.fulfill({
          status: 401, json: { authenticated: false },
        }));
        const destination = "/new?git=https%3A%2F%2Fgithub.com%2Facme%2Fnotes.git&ref=v1&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect";
        await page.goto(`/sign-in?${new URLSearchParams({ [key]: destination })}`);
        const login = page.locator(".sign-in-buttons a");
        await expect(login).toBeVisible();
        await expect(login).toHaveAttribute("href", `/auth/oidc/login?${new URLSearchParams({ return: destination })}`);
        await expect(login).toHaveAttribute("target", "_self");
        await expect(page.locator(".sign-in-return-context")).toContainText("notes");
      });
    }

    test("explicit OSS route absence retains configured OAuth providers", async ({ page }) => {
      await signedOut(page);
      await page.route("**/api/v1/auth/providers", (route) => route.fulfill({ json: {
        providers: [
          { id: "company", enabled: true, label: "Company SSO", protocol: "oidc" },
          { id: "disabled", enabled: false, label: "Disabled SSO", protocol: "oidc" },
          { id: "passkey", enabled: true, label: "Passkey", protocol: "webauthn" },
        ],
      } }));
      await page.goto("/sign-in");
      await expect(page.getByRole("button", { name: "Continue with Company SSO", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: /Continue with Disabled SSO/u })).toBeDisabled();
      await expect(page.locator(".sign-in-buttons button")).toHaveCount(2);
      await expect(page.locator(".sign-in-buttons a")).toHaveCount(0);
    });

    for (const failure of ["unavailable", "ambiguous-absence", "malformed"] as const) {
      test(`${failure} health fails closed and can be explicitly retried`, async ({ page }) => {
        await signedOut(page);
        let recovered = false;
        let providers = 0;
        await page.route("**/auth/oidc/session", (route) => route.fulfill(recovered
          ? { status: 401, json: { authenticated: false } }
          : failure === "unavailable"
          ? { status: 503, json: { error: "authentication_unavailable" } }
          : failure === "ambiguous-absence"
          ? { status: 404, json: { error: "not_found" } }
          : { status: 200, json: { authenticated: true, subject: "untrusted" } }));
        await page.route("**/api/v1/auth/providers", (route) => {
          providers += 1;
          return route.fulfill({ json: { providers: [] } });
        });
        await page.goto("/sign-in");
        const retry = page.locator("button.sign-in-retry");
        await expect(retry).toBeVisible();
        await expect(page.locator(".sign-in-buttons a, .sign-in-buttons button:not([disabled])")).toHaveCount(0);
        expect(providers).toBe(0);
        recovered = true;
        await retry.click();
        await expect(page.locator(".sign-in-buttons a")).toBeVisible();
        await expect(retry).toHaveCount(0);
        expect(providers).toBe(0);
      });
    }
  });
}
