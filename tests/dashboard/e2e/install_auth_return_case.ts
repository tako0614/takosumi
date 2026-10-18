import { expect, test } from "@playwright/test";
import type { DashboardE2EMode } from "./traffic-policy.ts";
import { resolvePortableOrigin } from "./portable-origin.ts";

/** The existing built SPA must reach the server-owned login route as a document. */
export function registerInstallAuthReturnCase(mode: DashboardE2EMode): void {
  test("installed app sign-in reaches the server with its complete local return", async ({ page, context }) => {
    test.skip(mode !== "portable", "This test supplies only local portable authentication responses.");
    const origin = resolvePortableOrigin();
    const query = "git=https%3A%2F%2Fgit.example.test%2Facme%2Fnotes.git&ref=v1&product=notes-app&return_uri=notesapp%3A%2F%2Fconnect";
    const destination = `/new?${query}`;
    const signInUrl = `${origin}/sign-in?return=${encodeURIComponent(destination)}`;
    const navigations: string[] = [];
    const writes: string[] = [];
    await context.clearCookies();
    await page.route("**/api/v1/dashboard/bootstrap**", (route) => route.fulfill({
      status: 401, contentType: "application/json", body: '{"error":"unauthenticated"}',
    }));
    await page.route("**/api/v1/account/session/me", (route) => route.fulfill({
      status: 200, contentType: "application/json", body: '{"session":null}',
    }));
    // A response at this boundary proves a real document request. SPA URL-bar
    // changes cannot invoke this route or load the terminal document below.
    await page.route("**/sign-in?**", (route) => route.fulfill({
      status: 200, contentType: "text/html", body: "<!doctype html><title>Login boundary reached</title>",
    }));
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.pathname === "/sign-in") {
        navigations.push(request.url());
      }
      if (url.pathname.startsWith("/api/v1/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${url.pathname}`);
      }
    });
    await page.goto(`/install?${query}`, { waitUntil: "commit" });
    await expect.poll(() => navigations.length, {
      timeout: 5_000, message: "sign-in must be one main-frame document request, not a SPA URL change",
    }).toBe(1);
    expect(navigations).toEqual([signInUrl]);
    await expect(page).toHaveTitle("Login boundary reached");
    expect(page.url()).toBe(signInUrl);
    expect(writes, "login must not install an app or issue a payment").toEqual([]);
  });
}
