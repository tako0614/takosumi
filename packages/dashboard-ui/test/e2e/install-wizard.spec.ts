import { expect, test } from "@playwright/test";

// Browser E2E for the install wizard: local dev sign-in → /install
// with autoplan → fill account/space → click Install → land on
// /apps/<id> with the detail rendered. Catches SPA regressions that
// the curl-based smoke can't (route registration, component rendering,
// session-derived state, etc.).
test("install wizard end-to-end", async ({ page }) => {
  // 1. Sign in via the local dev button (real OAuth would need the
  //    oauth-mock dance, but the SPA's auth shell is already covered
  //    by the Bun + curl smokes — here we just need ANY session so
  //    AuthGuard lets us through).
  await page.goto("/sign-in?fresh=playwright");
  const devButton = page.locator(".sign-in-dev");
  await expect(devButton).toBeVisible();
  await devButton.click();
  await page.waitForURL("**/home");

  // 2. Deep link into the install wizard with the takos repo pre-filled.
  const repoUrl = "https://github.com/tako0614/takos.git";
  const accountId = "acct_local";
  const spaceId = "space_local";
  const installUrl = `/install?git=${
    encodeURIComponent(
      repoUrl,
    )
  }&ref=main&mode=shared-cell&space=${spaceId}&autoplan=1`;
  await page.goto(installUrl);

  // 3. autoplan should populate the plan summary within ~5s.
  await expect(
    page.locator(".detail-section", { hasText: "Plan 結果" }),
  ).toBeVisible({ timeout: 7000 });
  await expect(page.locator(".kv-list")).toContainText("Commit");

  // 4. Fill Account ID + Space ID, then click Install.
  const accountInput = page.locator(".install-grid input").nth(0);
  const spaceInput = page.locator(".install-grid input").nth(1);
  await accountInput.fill(accountId);
  await spaceInput.fill(spaceId);

  const installButton = page.getByRole("button", { name: /^Install/ });
  await expect(installButton).toBeEnabled();
  await installButton.click();

  // 5. Should land on /apps/<inst_uuid> with the detail page rendered.
  await page.waitForURL(/\/apps\/inst_/, { timeout: 10_000 });
  await expect(page.locator(".page-header h1")).toBeVisible();
  // The detail page shows the appId in the h1 — for the takos repo
  // fixture, the appId is "takos" (the repo basename).
  await expect(page.locator(".page-header h1")).toContainText("takos");
  await expect(
    page.locator(".detail-section", { hasText: "Launch" }),
  ).toContainText("no Cloud launch entry");
  // Overview + Danger tabs visible. Grants was removed from the v1 public
  // surface; permission scopes are resolved during install instead of managed
  // as a dashboard tab.
  await expect(page.locator(".detail-nav-link")).toHaveCount(2);
  await expect(
    page.locator(".detail-nav-link", { hasText: /Grants/ }),
  ).toHaveCount(0);

  // γ18 — tab navigation: Danger moves the active marker, and the
  // destructive Uninstall button starts disabled until the appId is retyped
  // correctly.
  const dangerTab = page.locator(".detail-nav-link", { hasText: /Danger/ });
  await dangerTab.click();
  await page.waitForURL(/\/apps\/inst_[^/]+\/danger$/, { timeout: 5_000 });
  await expect(
    page.locator(".detail-nav-link.active", { hasText: /Danger/ }),
  ).toBeVisible();
  // .danger-form input + the Uninstall button. Starts disabled because
  // typed() !== appId (input is empty until the user types).
  const dangerInput = page.locator(".danger-form input");
  const uninstallButton = page.locator(".danger-form button.btn-danger");
  await expect(dangerInput).toBeVisible();
  await expect(uninstallButton).toBeDisabled();
  // We deliberately do NOT type the matching id + click — that would
  // delete the installation under the next smoke run. The disabled
  // assertion proves the typed() !== appId guard works.
});

test("yurucommu install CTA rewrites accounts.takosumi.com → .test on .test hosts", async ({ page }) => {
  // Separate hostname — Caddy serves yurucommu.test via the same TLS root.
  await page.goto("https://yurucommu.test/");
  const installLinks = page.locator('a[href*="accounts.takosumi"]');
  const count = await installLinks.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const href = await installLinks.nth(i).getAttribute("href");
    expect(href).toMatch(/cloud\.takosumi\.test/);
    expect(href).not.toMatch(/cloud\.takosumi\.com/);
  }

  await installLinks.first().click();
  await page.waitForURL("https://accounts.takosumi.test/sign-in?**");
  await page.waitForLoadState("domcontentloaded");
  const returnPath = new URL(page.url()).searchParams.get("return");
  expect(returnPath).toMatch(/^\/install\?/);
  await page.evaluate(() => {
    globalThis.localStorage.setItem(
      "tg_session",
      JSON.stringify({
        subject: "tsub_yurucommu_install_e2e",
        sessionId: "sess_local_substrate",
        expiresAt: Date.now() + 600_000,
        provider: "playwright",
      }),
    );
    globalThis.localStorage.setItem("tg_apps_account_id", "acct_local");
    globalThis.localStorage.setItem("tg_apps_space_id", "space_local");
  });
  await expect.poll(() =>
    page.evaluate(() => globalThis.localStorage.getItem("tg_session"))
  )
    .toContain("sess_local_substrate");
  await page.goto(returnPath ?? "/install");
  await page.waitForURL("https://accounts.takosumi.test/install?**");
  const installUrl = new URL(page.url());
  expect(installUrl.searchParams.get("git")).toBe(
    "https://github.com/tako0614/yurucommu.git",
  );
  expect(installUrl.searchParams.get("ref")).toBe("main");
  expect(installUrl.searchParams.get("mode")).toBe("shared-cell");
  expect(installUrl.searchParams.get("autoplan")).toBe("1");
  await expect(page.getByRole("heading", { name: "App を install" }))
    .toBeVisible();
  await expect(page.getByLabel("Git URL")).toHaveValue(
    "https://github.com/tako0614/yurucommu.git",
  );
  await expect(page.getByLabel("Ref")).toHaveValue("main");
  await expect(page.getByLabel("Mode")).toHaveValue("shared-cell");
});

test("Takos Use Takos CTA rewrites accounts.takosumi.com → .test and builds /start handoff", async ({ page }) => {
  await page.goto("https://takos.test/");
  const cloudLinks = page.locator('a[href*="accounts.takosumi"]');
  const cloudLinkCount = await cloudLinks.count();
  expect(cloudLinkCount).toBeGreaterThan(0);
  for (let i = 0; i < cloudLinkCount; i++) {
    const href = await cloudLinks.nth(i).getAttribute("href");
    expect(href).toMatch(/cloud\.takosumi\.test/);
    expect(href).not.toMatch(/cloud\.takosumi\.com/);
  }

  const useTakosLinks = page.locator('a[href*="/takos/start"]');
  await expect(useTakosLinks.first()).toBeVisible();
  const useTakosHref = await useTakosLinks.first().getAttribute("href");
  expect(useTakosHref).toBeTruthy();
  const useTakosUrl = new URL(useTakosHref ?? "", page.url());
  expect(useTakosUrl.origin).toBe("https://accounts.takosumi.test");
  expect(useTakosUrl.pathname).toBe("/takos/start");
  expect(useTakosUrl.searchParams.get("takos_url")).toBe("https://takos.test");

  await Promise.all([
    page.waitForURL(
      /^https:\/\/cloud\.takosumi\.test\/(?:sign-in\?|takos\/start\?)/,
      {
        waitUntil: "commit",
      },
    ),
    useTakosLinks.first().click(),
  ]);

  const cloudEntryUrl = new URL(page.url());
  const returnPath = cloudEntryUrl.pathname === "/sign-in"
    ? cloudEntryUrl.searchParams.get("return")
    : cloudEntryUrl.pathname + cloudEntryUrl.search;
  expect(returnPath).toMatch(/^\/takos\/start\?/);
  const returnUrl = new URL(returnPath ?? "", "https://accounts.takosumi.test");
  expect(returnUrl.searchParams.get("takos_url")).toBe("https://takos.test");

  if (cloudEntryUrl.pathname === "/sign-in") {
    await expect(page.locator(".sign-in-card")).toBeVisible({
      timeout: 10_000,
    });
  } else {
    expect(cloudEntryUrl.pathname).toBe("/takos/start");
  }

  await page.evaluate(() => {
    globalThis.localStorage.setItem(
      "tg_session",
      JSON.stringify({
        subject: "tsub_takos_use_page_e2e",
        sessionId: "sess_use_takos_page_e2e",
        expiresAt: Date.now() + 600_000,
        provider: "playwright",
      }),
    );
    globalThis.localStorage.setItem("tg_apps_account_id", "acct_local");
    globalThis.localStorage.setItem("tg_apps_space_id", "space_local");
  });

  let startUrl: URL | undefined;
  await page.route("**/start?**", async (route) => {
    startUrl = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>captured takos public page use-takos start</h1>",
    });
  });

  await page.goto(returnPath ?? "/takos/start");
  await expect(page.getByRole("heading", { name: "Use Takos" })).toBeVisible();
  await expect(page.getByLabel("Takos URL")).toHaveValue("https://takos.test");
  await expect(page.getByLabel("Account ID")).toHaveValue("acct_local");
  await expect(page.getByLabel("Space ID")).toHaveValue("space_local");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Launch Takos/ }).click();
  await page.waitForURL("**/start?**");

  expect(startUrl).toBeDefined();
  expect(startUrl?.pathname).toBe("/start");
  expect(startUrl?.searchParams.get("takos_url")).toBe("https://takos.test");
  expect(startUrl?.searchParams.get("account_id")).toBe("acct_local");
  expect(startUrl?.searchParams.get("space_id")).toBe("space_local");
  expect(startUrl?.searchParams.get("terms_accepted")).toBe("true");
  expect(startUrl?.searchParams.get("subject")).toBe(
    "tsub_takos_use_page_e2e",
  );
});

test("Use Takos dashboard entry collects terms and builds /start handoff", async ({ page }) => {
  let startUrl: URL | undefined;
  await page.addInitScript(() => {
    localStorage.setItem(
      "tg_session",
      JSON.stringify({
        subject: "tsub_use_takos_e2e",
        sessionId: "sess_use_takos_e2e",
        expiresAt: Date.now() + 600_000,
        provider: "playwright",
      }),
    );
  });
  await page.route("**/start?**", async (route) => {
    startUrl = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<h1>captured use takos start</h1>",
    });
  });

  await page.goto(
    "/takos/start?takos_url=https%3A%2F%2Ftakos.test&return_to=%2Fspaces%2Fspace_local%2Fthreads",
  );
  await expect(page.getByRole("heading", { name: "Use Takos" })).toBeVisible();
  await expect(page.getByLabel("Takos URL")).toHaveValue("https://takos.test");
  await page.getByLabel("Account ID").fill("acct_local");
  await page.getByLabel("Space ID").fill("space_local");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: /Launch Takos/ }).click();
  await page.waitForURL("**/start?**");

  expect(startUrl).toBeDefined();
  expect(startUrl?.pathname).toBe("/start");
  expect(startUrl?.searchParams.get("takos_url")).toBe("https://takos.test");
  expect(startUrl?.searchParams.get("account_id")).toBe("acct_local");
  expect(startUrl?.searchParams.get("space_id")).toBe("space_local");
  expect(startUrl?.searchParams.get("terms_accepted")).toBe("true");
  expect(startUrl?.searchParams.get("return_to")).toBe(
    "/spaces/space_local/threads",
  );
  expect(startUrl?.searchParams.get("subject")).toBe("tsub_use_takos_e2e");
});
