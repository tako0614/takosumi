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
      let logoutRequests = 0;
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
          if (++logoutRequests === 1) return route.fulfill({ status: 503, json: { error: "session_revocation_unavailable" } });
          authenticated = false;
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({ json: authenticated ? { subject: "tsub_fixture_user" } : { session: null } });
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
      await expect(page.locator(".user-menu-pop").getByRole("alert")).toBeVisible();
      await expect(page.getByTestId("home-apps")).toBeVisible();
      expect(authenticated).toBe(true);
      expect(logoutRequests).toBe(1);
      expect(navigations).toEqual([]);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await expect(page).toHaveURL(/\/sign-in$/u);
      const login = page.locator(".sign-in-buttons a");
      await expect(login).toBeVisible();
      expect(authenticated).toBe(false);
      expect(logoutRequests).toBe(2);
      expect(navigations).toEqual([]);
      expect(providers).toBe(0);
      await expect(page.locator(".sign-in-notice")).toHaveCount(0);
      await login.click();
      await expect(page).toHaveTitle("RP login reached");
      expect(navigations).toEqual([new URL("/auth/oidc/login", page.url()).href]);
    });

    test("a session refresh during confirmed logout leaves sign-in explicit", async ({ page }) => {
      const releaseRefresh = Promise.withResolvers<void>();
      const releaseLogout = Promise.withResolvers<void>();
      let refreshPending = false;
      await page.route("**/api/v1/dashboard/bootstrap?**", async (route) => {
        if (!refreshPending) return route.fallback();
        await releaseRefresh.promise;
        return route.fulfill({ status: 401, json: { error: "unauthenticated" } });
      });
      await page.route("**/api/v1/account/session/me", async (route) => {
        if (route.request().method() === "DELETE") {
          await releaseLogout.promise;
          return route.fulfill({ status: 204 });
        }
        return route.fulfill({ json: { session: null } });
      });
      await page.route("**/sign-in?**", (route) => route.fulfill({
        contentType: "text/html", body: "<!doctype html><title>Login boundary reached</title>",
      }));
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.goto("/");
      const appSettings = page.locator('a[href="/apps/cap_repository_office#settings"]');
      await expect(appSettings).toBeVisible();
      await page.clock.setFixedTime(new Date(Date.now() + 31_000));
      refreshPending = true;
      const refreshStarted = page.waitForRequest((request) =>
        new URL(request.url()).pathname === "/api/v1/dashboard/bootstrap");
      try {
        await appSettings.click();
        await refreshStarted;
        await page.locator("button.topbar-user").click();
        const logoutStarted = page.waitForRequest((request) => request.method() === "DELETE" &&
          new URL(request.url()).pathname === "/api/v1/account/session/me");
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await logoutStarted;
        // Observe the revoked session before the DELETE response reaches the browser.
        releaseRefresh.resolve();
        await page.waitForURL((url) => url.pathname === "/sign-in");
        expect(new URL(page.url()).search).toBe("");
      } finally {
        releaseRefresh.resolve();
        releaseLogout.resolve();
      }
    });

    test("concurrent rejected account reads recover once to the account page", async ({ page }) => {
      const destination = "/account/cli?from=keys";
      const startReplies = Promise.withResolvers<void>();
      const repliesFinished = Promise.withResolvers<void>();
      const reads = new Set<string>();
      let replies = 0;
      let clears = 0;
      const signIns: string[] = [];
      page.on("request", (request) => {
        const { pathname } = new URL(request.url());
        if (pathname === "/api/v1/account/session/me" && request.method() === "DELETE") clears++;
        if (pathname === "/sign-in" && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          signIns.push(request.url());
        }
      });
      await page.route(/\/api\/v1\/account\/tokens(?:\/scopes)?(?:\?.*)?$/u, async (route) => {
        const path = new URL(route.request().url()).pathname;
        reads.add(path);
        if (reads.size === 2) startReplies.resolve();
        await startReplies.promise;
        await route.fulfill({ status: 401, json: { error: "unauthenticated" } });
        if (++replies === 2) repliesFinished.resolve();
      });
      await page.route("**/api/v1/account/session/me", (route) => {
        if (route.request().method() !== "DELETE") return route.fallback();
        return route.fulfill({ status: 204 });
      });
      await page.route("**/sign-in?**", async (route) => {
        await repliesFinished.promise;
        return route.fulfill({
          contentType: "text/html", body: "<!doctype html><title>Login boundary reached</title>",
        });
      });
      try {
        await page.goto(destination, { waitUntil: "commit" });
        await expect(page).toHaveTitle("Login boundary reached");
        expect([...reads].sort()).toEqual(["/api/v1/account/tokens", "/api/v1/account/tokens/scopes"]);
        expect(signIns).toEqual([page.url()]);
        expect(new URL(page.url()).searchParams.get("return")).toBe(destination);
        expect(clears).toBe(1);
      } finally {
        startReplies.resolve();
        repliesFinished.resolve();
      }
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
