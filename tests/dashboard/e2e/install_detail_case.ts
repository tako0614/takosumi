import { expect, test, type Locator, type Page } from "@playwright/test";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import {
  createInstallAttemptFixture,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_UI_SURFACES,
  type InstallAttemptFixture,
  type InstallAttemptFixtureOptions,
} from "./fixture-data.ts";

type BaseFixture = { readonly mutations: string[] };
type CostFixture = "not_applicable" | "rated_zero" | "unrated" | "unavailable";
const capId = "cap_provider_destination_e2e";
const sourceId = "src_provider_destination_e2e";
const planId = "run_provider_plan_e2e";
const applyId = "run_provider_apply_e2e";
const now = "2026-10-27T01:00:00.000Z";
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const cloudflare = "registry.opentofu.org/cloudflare/cloudflare";
const sourceUrl = `/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fcloudflare-service.git&ref=${sourceCommit}&path=.&name=cloudflare-service`;
const domainField = /^Domain(?:\s*\*)?$/;
const applyMutation = `POST /api/v1/runs/${planId}/apply`;
const attemptPost = "POST /api/v1/workspaces/ws_alpha/install-plans";

/**
 * One app behind the install-plan coordinator: the attempt routes come from
 * the shared fixture coordinator, the Run, Capsule and app-page reads from
 * this fixture's state.
 */
async function detailFixture(
  page: Page,
  base: (page: Page, provider: boolean) => Promise<BaseFixture>,
  provider = false,
  oauth = false,
  cost: CostFixture = "not_applicable",
  attemptOptions: Partial<InstallAttemptFixtureOptions> = {},
) {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  await base(page, provider);
  const mutations: string[] = [];
  let applied = false;
  let applyStatus = "running";
  let capsuleStatus = "pending";
  let connected = false;
  let retryCount = 0;
  let retryFailed = false;
  const connection = { ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], ...(oauth ? { credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" } } : {}), id: "conn_inline_fixture", displayName: "My Cloudflare" };
  const attempts: InstallAttemptFixture = createInstallAttemptFixture({
    capsuleId: capId,
    planRunId: planId,
    resources: [
      { type: "cloudflare_workers_script", allowed: true },
      { type: "cloudflare_d1_database", count: 2, allowed: true },
    ],
    requirements: provider ? [{ provider: cloudflare, moduleLocalName: "cloudflare" }] : [],
    connections: () => connected ? [{ ...connection, status: "verified" }] : [],
    variables: [
      { name: "domain", type: "string", required: false, sensitive: false, label: { ja: "ドメイン", en: "Domain" }, defaultValue: "default.example.com" },
      { name: "custom_domain", type: "string", required: false, sensitive: false, label: { en: "Custom domain", ja: "カスタムドメイン" } },
      { name: "service_name", type: "string", required: false, sensitive: false, label: { en: "Service name", ja: "サービス名" }, derivedDefault: "capsule_name" },
    ],
    ...attemptOptions,
  });
  const planResources = [
    { address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["create"] },
    { address: "cloudflare_d1_database.data", type: "cloudflare_d1_database", actions: ["create"] },
  ];
  const plan = () => ({ id: retryCount ? `run_retry_fixture_${retryCount}` : planId, workspaceId: "ws_alpha", capsuleId: capId, type: "plan", status: retryCount && retryFailed ? "failed" : "succeeded", summary: { add: 2, change: 0, destroy: 0 }, planResources, policyStatus: "pass", createdBy: "portable-e2e", createdAt: retryCount ? new Date(Date.parse(now) + 120000 + retryCount * 1000).toISOString() : now });
  const apply = () => ({ ...plan(), id: applyId, planRunId: planId, type: "apply", status: applyStatus, errorCode: applyStatus === "failed" ? "runner_apply_failed" : undefined, createdAt: "2026-10-27T01:01:00.000Z" });
  const capsule = () => ({ id: capId, workspaceId: "ws_alpha", sourceId, name: "cloudflare-service", slug: "cloudflare-service", installConfigId: "cfg-default-opentofu-capsule", environment: "production", status: capsuleStatus, currentStateGeneration: capsuleStatus === "pending" ? 0 : 1, currentStateVersionId: capsuleStatus === "pending" ? undefined : "sv_inline", uninstall: capsuleStatus === "uninstalled" ? { phase: "scheduled", requestedAt: now, scheduledDestroyAt: "2026-11-03T01:00:00Z" } : undefined, createdAt: now, updatedAt: now });
  if (oauth) await page.context().route("**/api/v1/connections/oauth/cloudflare/callback**", async (route) => {
    const url = new URL(route.request().url());
    connected = !url.searchParams.has("error");
    const flow = "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify("opaque-fixture-state")))).toString("hex");
    const result = { kind: "connection-oauth", error: !connected, connectionId: connection.id, connectionStatus: "verified" };
    return route.fulfill({ contentType: "text/html", body: `<h1>Connection callback</h1><script>new BroadcastChannel(${JSON.stringify("takosumi.oauth." + flow)}).postMessage(${JSON.stringify(result)})</script>` });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const url = new URL(request.url()); const path = url.pathname;
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    const attempt = attempts.handle({
      method: request.method(),
      path,
      search: url.search,
      body: request.postData() ? request.postDataJSON() : undefined,
      idempotencyKey: request.headers()["idempotency-key"],
    });
    if (attempt) return route.fulfill({ status: attempt.status, json: attempt.json });
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES, oauthHelpers: oauth ? [{ id: "cloudflare", providerSource: cloudflare, credentialRecipe: { id: "cloudflare", authMode: "oauth" }, setupFields: [{ key: "accountId", envName: "CLOUDFLARE_ACCOUNT_ID" }] }] : [] } });
    if (path === "/api/v1/connections/oauth/cloudflare/start") return route.fulfill({ json: { authorizationUrl: "https://dash.cloudflare.test/oauth2/auth?state=opaque-fixture-state", state: "opaque-fixture-state", expiresAt: new Date(Date.now() + 600000).toISOString() } });
    if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: connected ? [connection] : [] } });
    if (path === "/api/v1/connections") {
      if (request.method() === "POST") return route.fulfill({ status: 201, json: { connection: { ...connection, status: "pending" } } });
      return route.fulfill({ json: { connections: connected ? [connection] : [] } });
    }
    if (path === "/api/v1/connections/conn_inline_fixture/test") { connected = true; return route.fulfill({ json: { status: "verified" } }); }
    if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") return route.fulfill({ json: { installConfig: {
      id: "cfg-default-opentofu-capsule", name: "Example", policy: {}, variableMapping: {}, variablePresentation: [],
      outputAllowlist: {}, createdAt: now, updatedAt: now,
    } } });
    if (path === `/api/v1/capsules/${capId}`) {
      if (request.method() === "DELETE") capsuleStatus = "uninstalled";
      // A capsule read always carries the configuration authority guard.
      return route.fulfill({ json: { capsule: capsule(), graceDays: 7, installConfigReAdoption: { authorityGuard: `sha256:${"c".repeat(64)}` } } });
    }
    if (path === `/api/v1/capsules/${capId}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: { id: "pbs_inline", workspaceId: "ws_alpha", capsuleId: capId, environment: "production", bindings: provider ? [{ provider: cloudflare, moduleLocalName: "cloudflare", connectionId: connection.id }] : [], createdAt: now, updatedAt: now } } });
    if (path === `/api/v1/capsules/${capId}/current-resource-inventory`) return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: capId, workspaceId: "ws_alpha", environment: "production", stateVersionId: "sv_inline", generation: 1, applyRunId: applyId, planRunId: planId, recordedAt: now, availability: "recorded", resources: planResources.map(({ address, type }) => ({ address, type, providerSource: cloudflare })) } } });
    if (path === `/api/v1/capsules/${capId}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId: capId, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
    if (path === "/api/v1/workspaces/ws_alpha/graph") return route.fulfill({ json: { nodes: [], edges: [] } });
    if (path === `/api/v1/capsules/${capId}/cancel-uninstall`) { capsuleStatus = "active"; return route.fulfill({ json: { capsule: capsule() } }); }
    if (path === `/api/v1/capsules/${capId}/plan`) { retryCount += 1; return route.fulfill({ json: { run: plan() } }); }
    if (path === "/api/v1/workspaces/ws_alpha/runs") return route.fulfill({ json: { runs: applied ? [apply(), plan()] : [plan()] } });
    if (path.startsWith("/api/v1/runs/") && path.endsWith("/cost")) {
      if (cost === "unavailable") return route.fulfill({ status: 503, json: { error: "fixture_cost_unavailable" } });
      return route.fulfill({ json: { cost: {
        runId: path.split("/").at(-2), billingMode: cost === "not_applicable" ? "disabled" : "showback",
        estimatedUsdMicros: 0, ratingStatus: cost === "rated_zero" ? "rated" : cost, blocked: false, reasons: [],
      } } });
    }
    if (path === `/api/v1/runs/${planId}` || path.startsWith("/api/v1/runs/run_retry_fixture_") && !path.endsWith("/stream") && !path.endsWith("/logs")) return route.fulfill({ json: { run: { ...plan(), id: path.split("/").at(-1) } } });
    if (path === `/api/v1/runs/${planId}/apply`) { applied = true; return route.fulfill({ status: 201, json: { run: apply() } }); }
    if (path === `/api/v1/runs/${applyId}`) return route.fulfill({ json: { run: apply() } });
    if (path.endsWith("/stream") && [planId, applyId, "run_retry_fixture_"].some((id) => path.includes(id))) return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (path.endsWith("/logs") && [planId, applyId, "run_retry_fixture_"].some((id) => path.includes(id))) return route.fulfill({ json: { diagnostics: [{ severity: "info", message: "Installing fixture resources" }], auditEvents: [] } });
    if (path === `/api/v1/capsules/${capId}/state-versions`) return route.fulfill({ json: { stateVersions: applyStatus === "succeeded" ? [{ id: "sv_inline", capsuleId: capId, workspaceId: "ws_alpha", generation: 1, createdByRunId: applyId, createdAt: now }] : [] } });
    if (path === "/api/v1/workspaces/ws_alpha/ui-surfaces") {
      const surface = JSON.parse(JSON.stringify(PORTABLE_UI_SURFACES.ws_alpha[0]));
      surface.metadata.ownerRef.id = capId; surface.metadata.id = "if_inline";
      surface.spec.inputs.url.capsuleId = capId; surface.status.resolvedInputs.url = "https://apps.example.test/inline-app";
      return route.fulfill({ json: { interfaces: ["active", "error", "disabled"].includes(capsuleStatus) ? [surface] : [] } });
    }
    return route.fallback();
  });
  await page.context().route("https://apps.example.test/inline-app", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Installed application</h1>" }));
  return {
    attempts,
    mutations,
    authorize: () => { connected = true; },
    finish: () => { applied = true; applyStatus = "succeeded"; capsuleStatus = "active"; },
    fail: (partialState = false) => { applyStatus = "failed"; if (partialState) capsuleStatus = "error"; },
    destroy: () => { capsuleStatus = "destroyed"; },
    problem: (status: string) => { capsuleStatus = status; },
    failRetry: (failed: boolean) => { retryFailed = failed; },
    /** The confirming answer (`continue: true`) the page sent, if any. */
    continued: () => attempts.log.answers.find((answer) => (answer as { continue?: boolean } | undefined)?.continue === true) as
      { readonly variables?: Readonly<Record<string, unknown>>; readonly capsuleName?: string } | undefined,
  };
}

/** The install sheet the attempt opens once the repository is read. */
function installSheet(page: Page): Locator {
  return page.getByTestId("install-configuration");
}

/** The sheet's own actions (Review / Connect and Stop installing), not a row's. */
function sheetActions(page: Page): Locator {
  return installSheet(page).locator(":scope > .iv-action-row");
}

/** One provider row in the sheet's connection block. */
function connectionRows(page: Page): Locator {
  return page.getByTestId("install-connections").getByTestId("install-required-connection");
}

async function openInstallSheet(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Install", exact: true }).click();
  const sheet = installSheet(page);
  await expect(sheet.getByRole("heading", { name: "What this install does", exact: true })).toBeVisible();
  return sheet;
}

/** Review confirms the sheet; Allow and install is the only Apply consent. */
async function reviewPlan(page: Page): Promise<Locator> {
  await sheetActions(page).getByRole("button", { name: "Review", exact: true }).click();
  const review = page.locator(".iv-execution");
  await expect(review.getByRole("heading", { name: "What this app will create in your cloud", exact: true })).toBeVisible();
  return review;
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `${label} must not overflow horizontally`).toBeLessThanOrEqual(1);
}

/** A box starts below the sticky top bar and ends above the mobile tab bar. */
async function expectBetweenChrome(page: Page, target: Locator, label: string): Promise<void> {
  const box = (await target.boundingBox())!;
  const topbar = (await page.locator("header.topbar").boundingBox())!;
  expect(box, `${label} has a layout box`).not.toBeNull();
  expect(box.y, `${label} starts below the sticky top bar`).toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
  const tabs = page.locator(".mobile-tabs");
  const tabsBox = await tabs.isVisible() ? await tabs.boundingBox() : null;
  const bottom = tabsBox ? tabsBox.y : page.viewportSize()!.height;
  expect(box.y + box.height, `${label} ends above the bottom navigation`).toBeLessThanOrEqual(bottom + 1);
}

/** Desktop 1440×900 and mobile 390×844 captures of one install state. */
async function captureInstallState(page: Page, name: string): Promise<void> {
  const original = page.viewportSize();
  for (const [suffix, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await expectNoHorizontalOverflow(page, `${name} at ${size.width}px`);
    // From the top, so the sticky shell is not stamped into the middle of a full-page capture.
    // Instant: the shell's smooth scrolling would otherwise race later clicks.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: test.info().outputPath(`${name}-${suffix}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

async function expectNothingStored(page: Page, ...values: string[]): Promise<void> {
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, url: location.href }));
  for (const value of values) expect(stored).not.toContain(value);
}

export function registerInstallDetailCases(mode: string, base: (page: Page, provider: boolean) => Promise<BaseFixture>) {
  test.describe("Inline app detail installation", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");
    test("opening the app page creates nothing; Install reads the repository as one attempt", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { roundsPerPhase: 6 });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      const provenance = page.getByTestId("install-provenance");
      await expect(provenance).toContainText("github.com/example/cloudflare-service");
      // A pinned full commit reads as its short form.
      await expect(provenance).toContainText(sourceCommit.slice(0, 7));
      await expect(provenance).not.toContainText(sourceCommit);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("link", { name: "Choose again", exact: true })).toHaveAttribute("href", "/new");
      await expect(page.getByTestId("install-start")).toContainText("Nothing is created in your cloud yet");
      await captureInstallState(page, "app-not-installed");
      await page.waitForTimeout(500);
      expect(f.mutations).toEqual([]);

      await page.getByRole("button", { name: "Install", exact: true }).click();
      const reading = page.getByTestId("install-reading");
      await expect(reading.getByRole("heading", { name: "Reading the repository", exact: true })).toBeVisible();
      await expect(page).toHaveURL(/[?&]installPlan=gip_[0-9a-f]{16}/u);
      await captureInstallState(page, "app-reading");
      await expect(installSheet(page)).toBeVisible({ timeout: 15_000 });
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
      expect(f.attempts.log.creates).toEqual([{
        mode: "attempt",
        source: { url: "https://github.com/example/cloudflare-service.git", ref: sourceCommit },
        capsule: { name: "cloudflare-service" },
        options: { modulePath: "." },
      }]);
      // Reading and the sheet never apply anything.
      expect(f.mutations.some((m) => /\/(apply|approve)$/u.test(m))).toBe(false);
      expect(errors).toEqual([]);
    });
    test("connects a missing provider inline, keeps settings, and submits the verified binding", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(installSheet(page)).toHaveCount(0);
      const sheet = await openInstallSheet(page);
      await expect(sheet).toHaveAttribute("data-install-state", "provider-required");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("default.example.com");
      await sheet.getByRole("textbox", { name: domainField }).fill("chosen.example.com");
      expect(f.continued()).toBeUndefined();

      const row = connectionRows(page);
      await expect(row).toHaveCount(1);
      await expect(row).toHaveAttribute("data-connection-state", "missing");
      await expect(row).toContainText("Not connected");
      await expect(row.locator("select")).toHaveCount(0);
      const connect = row.getByRole("button", { name: "Connect", exact: true });
      await expect(connect).toHaveAttribute("aria-expanded", "false");
      const formId = await connect.getAttribute("aria-controls");
      expect(formId).toMatch(/^install-connect-[A-Za-z0-9_-]+$/u);
      // The row toggle keeps its identity while its label changes.
      const toggle = row.locator(`button[aria-controls="${formId}"]`);
      const form = page.locator(`[id="${formId}"]`);
      await expect(form).toHaveCount(0);
      await captureInstallState(page, "app-sheet-missing-connection");
      // While a connection is missing the sheet's primary action is Connect,
      // and it opens that row instead of confirming the sheet.
      // Opening the form must not suspend and remount the whole sheet.
      await sheet.evaluate((element) => element.setAttribute("data-e2e-mounted", "before-connect"));
      await sheetActions(page).getByRole("button", { name: "Connect", exact: true }).click();
      await expect(form).toBeVisible();
      await expect(form.getByText("Connect account", { exact: true })).toBeVisible();
      await expect(sheet).toHaveAttribute("data-e2e-mounted", "before-connect");
      await expect(form).toHaveClass(/\biv-inline-connect\b/u);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveText("Close");
      expect(f.continued()).toBeUndefined();
      // The form is limited to the row's provider: only its own sign-in methods.
      const methods = await form.locator("#connection-provider option").allTextContents();
      expect(methods.length).toBeGreaterThan(0);
      for (const method of methods) expect(method).toMatch(/^Cloudflare\b/u);
      await expect(form.locator("#connection-field-CLOUDFLARE_API_TOKEN")).toBeVisible();
      // It lands between the sticky top bar and the bottom tabs, not behind either.
      await expectBetweenChrome(page, form.getByText("Connect account", { exact: true }), "inline connection form heading");
      await expectNoHorizontalOverflow(page, "inline connection form at 390px");
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await captureInstallState(page, "app-inline-connect");

      // Closing the row keeps every setting already typed in the sheet.
      await toggle.click();
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toBeFocused();
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("chosen.example.com");

      await toggle.click();
      await form.locator("#connection-field-CLOUDFLARE_API_TOKEN").fill("fixture-only-token");
      await form.locator("#connection-field-CLOUDFLARE_ACCOUNT_ID").fill("fixture-account");
      await form.getByRole("button", { name: "Save connection", exact: true }).click();
      // Saved, tested once, then offered (and chosen) for this row; the form closes.
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(row).toContainText("Connected");
      await expect(row).toContainText("My Cloudflare");
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveText("Connect another account");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      // The form that held focus is gone; focus returns to the row toggle.
      await expect(toggle).toBeFocused();
      await expect(page.getByTestId("install-connections")).toContainText("Connected. Ready to install.");
      await expect(sheet).toHaveAttribute("data-install-state", "ready");
      expect(f.mutations.filter((m) => m === "POST /api/v1/connections")).toHaveLength(1);
      expect(f.mutations.filter((m) => m === "POST /api/v1/connections/conn_inline_fixture/test")).toHaveLength(1);
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("chosen.example.com");
      expect(f.continued()).toBeUndefined();

      await reviewPlan(page);
      // Only the edited value travels, and only in the confirming answer.
      expect(f.continued()?.variables).toEqual({ domain: "chosen.example.com" });
      expect(f.attempts.latest()?.options.providerBindings ?? []).toEqual([]);
      expect(f.attempts.log.answers.filter((answer) => JSON.stringify(answer).includes("chosen.example.com"))).toHaveLength(1);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "fixture-only-token", "chosen.example.com");
      expect(errors).toEqual([]);
    });
    test("several connections ask for a choice that is answered as the exact provider tuple", async ({ page }) => {
      const others = [
        { id: "pc_account_a", providerSource: cloudflare, displayName: "Cloudflare account A", status: "verified", scope: "workspace", workspaceId: "ws_alpha" },
        { id: "pc_account_b", providerSource: cloudflare, displayName: "Cloudflare account B", status: "verified", scope: "workspace", workspaceId: "ws_alpha" },
      ];
      const f = await detailFixture(page, base, true, false, "not_applicable", { connections: () => others });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const row = connectionRows(page);
      const choice = row.getByRole("combobox", { name: /Host \/ account/u });
      await expect(choice).toHaveValue("");
      await expect(choice.locator("option")).toContainText(["Cloudflare account A", "Cloudflare account B"]);
      await expect(sheet).toHaveAttribute("data-install-state", "provider-required");
      await choice.selectOption("pc_account_b");
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(row).toContainText("✓ Connected");
      expect(f.attempts.log.answers).toEqual([{
        expectedGeneration: expect.any(Number),
        providerBindings: [{ provider: cloudflare, moduleLocalName: "cloudflare", connectionId: "pc_account_b" }],
      }]);
      await reviewPlan(page);
      expect(f.continued()).toEqual({ expectedGeneration: expect.any(Number), continue: true });
    });
    test("OAuth keeps settings mounted and uses the verified returned connection", async ({ page, context }) => {
      const f = await detailFixture(page, base, true, true);
      await context.route("https://dash.cloudflare.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Authorize Cloudflare</h1>" }));
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await sheet.getByRole("textbox", { name: domainField }).fill("oauth-chosen.example.net");
      // Optional settings are shown plainly, not behind a disclosure.
      await expect(sheet.getByTestId("install-optional-settings")).toBeVisible();
      await sheet.getByLabel("Custom domain", { exact: false }).fill("custom.example.org");
      const row = connectionRows(page);
      await row.getByRole("button", { name: "Connect", exact: true }).click();
      const form = row.locator(".iv-inline-connect");
      await expect(form).toBeVisible();
      await expect(form.locator("#connection-field-CLOUDFLARE_API_TOKEN")).toBeHidden();
      const popupEvent = context.waitForEvent("page");
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      const popup = await popupEvent;
      await expect(popup.getByRole("heading")).toHaveText("Authorize Cloudflare");
      await popup.goto(new URL("/api/v1/connections/oauth/cloudflare/callback?state=opaque-fixture-state&code=fixture", page.url()).toString());
      // The OAuth connection arrives verified: chosen for the row without a test.
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId("install-connections")).toContainText("Connected. Ready to install.");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("oauth-chosen.example.net");
      await expect(sheet.getByLabel("Custom domain", { exact: false })).toHaveValue("custom.example.org");
      await reviewPlan(page);
      expect(f.continued()?.variables).toEqual({ domain: "oauth-chosen.example.net", custom_domain: "custom.example.org" });
      expect(f.mutations.some((entry) => entry === "POST /api/v1/connections")).toBe(false);
      expect(f.mutations.some((entry) => entry.endsWith("/test"))).toBe(false);
      await expectNothingStored(page, "oauth-chosen.example.net", "opaque-fixture-state");
    });
    test("OAuth failure and cancel leave settings editable and allow retry", async ({ page, context }) => {
      const f = await detailFixture(page, base, true, true);
      await context.route("https://dash.cloudflare.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Authorize Cloudflare</h1>" }));
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await sheet.getByRole("textbox", { name: domainField }).fill("retry.example.net");
      const row = connectionRows(page);
      const formId = await row.getByRole("button", { name: "Connect", exact: true }).getAttribute("aria-controls");
      const toggle = row.locator(`button[aria-controls="${formId}"]`);
      await toggle.click();
      const form = row.locator(".iv-inline-connect");
      const popupEvent = context.waitForEvent("page");
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      const popup = await popupEvent;
      await expect(popup.getByRole("heading")).toHaveText("Authorize Cloudflare");
      await popup.goto(new URL("/api/v1/connections/oauth/cloudflare/callback?state=opaque-fixture-state&error=access_denied", page.url()).toString());
      await expect(form.getByText("Connection was not completed.", { exact: false })).toBeVisible();
      await expect(row).toHaveAttribute("data-connection-state", "missing");
      await expect(form.getByRole("button", { name: "Connect Cloudflare", exact: true })).toBeEnabled();
      await form.getByRole("button", { name: "Connect Cloudflare", exact: true }).click();
      await form.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(form.getByRole("button", { name: "Connect Cloudflare", exact: true })).toBeEnabled();
      await expect(toggle).toHaveText("Close");
      // One Close per row: the row toggle closes the form and keeps focus.
      await expect(form.getByRole("button", { name: "Close", exact: true })).toHaveCount(0);
      await toggle.click();
      await expect(form).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveText("Connect");
      await expect(toggle).toBeFocused();
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("retry.example.net");
      await expect(sheet).toHaveAttribute("data-install-state", "provider-required");
      expect(f.continued()).toBeUndefined();
    });
    test("a secret setting is write-only and leaves the page only in the confirming answer", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        variables: [{ name: "api_token", type: "string", required: true, sensitive: true, label: { en: "API token", ja: "APIトークン" } }],
      });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const secret = sheet.getByLabel(/^API token/u);
      await expect(secret).toHaveAttribute("type", "password");
      await expect(secret).toHaveValue("");
      await expect(sheet).toContainText("Not saved. Sent only when you confirm the install.");
      const review = sheetActions(page).getByRole("button", { name: "Review", exact: true });
      await expect(review).toBeDisabled();
      await secret.fill("fixture-secret-value");
      await expect(review).toBeEnabled();
      await reviewPlan(page);
      expect(f.continued()?.variables).toEqual({ api_token: "fixture-secret-value" });
      const carrying = f.attempts.log.answers.filter((answer) => JSON.stringify(answer).includes("fixture-secret-value"));
      expect(carrying).toEqual([f.continued()]);
      expect(JSON.stringify(f.attempts.log.creates)).not.toContain("fixture-secret-value");
      await expectNothingStored(page, "fixture-secret-value");
    });
    test("installs inline after the explicit click and moves to the installed app's page", async ({ page, context }) => {
      const f = await detailFixture(page, base);
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      await reviewPlan(page);
      await page.getByRole("button", { name: "Allow and install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      await expect(page.locator(".iv-execution")).toContainText("Installing");
      await page.getByText("Progress and logs", { exact: true }).click();
      await expect(page.getByTestId("install-run-logs")).toContainText("Installing fixture resources");
      f.finish();
      // Once installed, the app's own page takes over: the same sections as
      // everywhere else.
      await expect(page).toHaveURL(new RegExp(`/(workloads|apps)/${capId}$`, "u"), { timeout: 20_000 });
      const app = page.getByTestId("app-page");
      await expect(app).toBeVisible();
      await expect(page.getByTestId("install-app-header")).toHaveCount(0);
      const open = page.getByTestId("app-header").getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", "https://apps.example.test/inline-app");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await captureInstallState(page, "app-installed");
      const popupPromise = context.waitForEvent("page"); await open.click(); const popup = await popupPromise;
      await expect(popup.getByRole("heading")).toHaveText("Installed application"); await popup.close();
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(errors).toEqual([]);
    });
    for (const cost of ["rated_zero", "not_applicable", "unrated", "unavailable"] as const) {
      test(`review lists planned resources and the ${cost} cost before an explicit Allow and install`, async ({ page }) => {
        const f = await detailFixture(page, base, false, false, cost);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(sourceUrl);
        const sheet = await openInstallSheet(page);
        // Before any connection or Plan, the sheet previews the analyzed types.
        const planned = sheet.getByTestId("install-planned-resources");
        await expect(planned.getByRole("heading", { name: "What this app will create (planned)" })).toBeVisible();
        await expect(planned.locator('li[data-resource-type="cloudflare_workers_script"]')).toBeVisible();
        await expect(planned.locator('li[data-resource-type="cloudflare_d1_database"]')).toContainText("×2");
        const review = await reviewPlan(page);
        const counts = review.getByRole("definition");
        await expect(counts).toHaveText(["2", "0", "0"]);
        const resources = review.getByTestId("install-plan-resources");
        await expect(resources.getByRole("heading", { name: "Planned changes" })).toBeVisible();
        await expect(resources).toContainText("Cloudflare Workers Script");
        await expect(resources).toContainText("Cloudflare D1 Database");
        const costBlock = review.getByTestId("install-plan-cost");
        await expect(costBlock.getByRole("heading", { name: "Cost estimate", exact: true })).toBeVisible();
        const expectedCost = {
          rated_zero: "The estimate is $0.00.",
          not_applicable: "Takosumi doesn't calculate costs in this workspace.",
          unrated: "Usage measured; no price policy is configured.",
          unavailable: "Couldn't load the cost estimate. Treat the cost as unknown.",
        }[cost];
        await expect(costBlock).toContainText(expectedCost);
        // An unknown cost is never presented as free.
        if (cost !== "rated_zero") await expect(costBlock).not.toContainText("$0.00");
        const allow = review.getByRole("button", { name: "Allow and install", exact: true });
        await expect(allow).toBeEnabled();
        await expect(review.getByRole("checkbox")).toHaveCount(0);
        expect(f.mutations).not.toContain(applyMutation);
        if (cost !== "rated_zero") return;
        await captureInstallState(page, "app-review");
        // A clean Plan waits for consent: no Apply across Run poll intervals.
        await page.waitForTimeout(3_500);
        expect(f.mutations).not.toContain(applyMutation);
        // A reload reopens the same review, read-only: no new attempt, no Apply.
        await page.reload();
        await expect(page.locator(".iv-execution").getByRole("button", { name: "Allow and install", exact: true })).toBeEnabled();
        expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
        expect(f.mutations).not.toContain(applyMutation);
        await page.locator(".iv-execution").getByRole("button", { name: "Allow and install", exact: true }).click();
        await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
        await expect(page.locator(".iv-execution").getByRole("heading", { name: "Installing", exact: true })).toBeVisible();
        expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
        expect(errors).toEqual([]);
      });
    }
    test("Stop installing from the sheet discards the whole attempt and returns to the same app", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const attemptId = new URL(page.url()).searchParams.get("installPlan");
      await sheetActions(page).getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(installSheet(page)).toHaveCount(0);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page.getByTestId("install-start")).toBeVisible();
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/install-plans/${attemptId}`)).toHaveLength(1);
      expect(f.attempts.log.discards).toEqual([{ id: attemptId, expectedGeneration: f.attempts.latest()!.generation - 1 }]);
      // The page itself deletes nothing else: the coordinator owns the cleanup.
      expect(f.mutations.some((m) => m.includes("/sources") || m.includes("/abandon"))).toBe(false);
      // The URL still names this app, so a reload returns to the same page.
      const discarded = new URL(page.url());
      expect(discarded.searchParams.get("installPlan")).toBeNull();
      expect(discarded.searchParams.get("git")).toBe("https://github.com/example/cloudflare-service.git");
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "cloudflare-service" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("Stop installing from the review discards the attempt and its unapplied app", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const review = await reviewPlan(page);
      await review.getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(page.locator(".iv-execution")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page).not.toHaveURL(/[?&]installPlan=/u);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      expect(f.mutations.some((m) => m.endsWith("/apply") || m.startsWith("DELETE /api/v1/capsules/") || m.includes("/abandon"))).toBe(false);
    });
    test("Stop installing while reading waits for the coordinator and then discards", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { roundsPerPhase: 1_000 });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const reading = page.getByTestId("install-reading");
      await expect(reading).toBeVisible();
      await expect.poll(() => f.attempts.log.reconciles).toBeGreaterThan(0);
      await reading.getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      // The user's own stop is not reported as a failure.
      await expect(page.locator(".iv-error")).toHaveCount(0);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      const reconcilesAfterStop = f.attempts.log.reconciles;
      await page.waitForTimeout(1_000);
      expect(f.attempts.log.reconciles).toBe(reconcilesAfterStop);
    });
    test("the app name is edited before the app exists; a taken name offers a free one", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { takenNames: ["cloudflare-service"] });
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const name = sheet.getByTestId("install-app-name");
      await expect(name).toHaveValue("cloudflare-service");
      await expect(sheet).toContainText("Another app in this workspace already uses this name.");
      const review = sheetActions(page).getByRole("button", { name: "Review", exact: true });
      await expect(review).toBeDisabled();
      await name.fill("Not A Valid Name");
      await expect(review).toBeDisabled();
      await sheet.getByRole("button", { name: "Use “cloudflare-service-2”", exact: true }).click();
      await expect(name).toHaveValue("cloudflare-service-2");
      await expect(review).toBeEnabled();
      expect(f.attempts.log.answers).toContainEqual({ expectedGeneration: expect.any(Number), capsuleName: "cloudflare-service-2" });
      await reviewPlan(page);
      expect(f.attempts.latest()?.capsule.name).toBe("cloudflare-service-2");
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "cloudflare-service-2");
    });
    test("a repository with several modules asks which one before the sheet", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        modules: [{ path: "apps/web", providers: [cloudflare] }, { path: "apps/api", providers: [] }],
      });
      await page.goto(`/new?git=${encodeURIComponent("https://github.com/example/cloudflare-service.git")}&name=cloudflare-service`);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const chooser = page.getByTestId("install-module-chooser");
      await expect(chooser.getByRole("heading", { name: "Choose a module" })).toBeVisible();
      await chooser.getByRole("combobox").selectOption("apps/api");
      await chooser.getByRole("button", { name: "Continue with this module", exact: true }).click();
      await expect(installSheet(page)).toBeVisible();
      expect(f.attempts.log.answers).toContainEqual({ expectedGeneration: expect.any(Number), modulePath: "apps/api" });
    });
    test("a failed attempt explains why and starts over as a new attempt", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", {
        failAt: { phase: "analyzing_compatibility", code: "source_sync_failed" },
      });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      const problem = page.getByTestId("install-attempt-problem");
      await expect(problem).toHaveAttribute("data-install-stage", "failed");
      await expect(problem).toContainText("The Git repository couldn't be read.");
      await problem.getByRole("button", { name: "Start over", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === attemptPost).length).toBe(2);
      expect(f.mutations.filter((m) => m.startsWith("DELETE /api/v1/install-plans/"))).toHaveLength(1);
      expect(f.attempts.log.creates[1]).toEqual(f.attempts.log.creates[0]);
    });
    test("a reopened attempt is read only until the person continues", async ({ page }) => {
      const f = await detailFixture(page, base, false, false, "not_applicable", { roundsPerPhase: 3 });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page).toHaveURL(/[?&]installPlan=gip_/u);
      const attemptId = new URL(page.url()).searchParams.get("installPlan")!;
      // A reopened attempt alone (as from the Store's unfinished list).
      await page.goto(`/new?installPlan=${attemptId}`);
      const reading = page.getByTestId("install-reading");
      await expect(reading.getByRole("heading", { name: "Reading paused", exact: true })).toBeVisible();
      const reconciles = f.attempts.log.reconciles;
      await page.waitForTimeout(1_000);
      expect(f.attempts.log.reconciles).toBe(reconciles);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await reading.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(installSheet(page)).toBeVisible();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("unfinished installs are listed on the Store page and can continue or stop", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const attemptId = new URL(page.url()).searchParams.get("installPlan")!;
      await page.goto("/new");
      const open = page.getByTestId("install-open-attempts");
      await expect(open.getByRole("heading", { name: "Unfinished installs" })).toBeVisible();
      const row = open.locator(`li[data-install-plan-id="${attemptId}"]`);
      await expect(row).toContainText("cloudflare-service");
      await expect(row).toContainText("github.com/example/cloudflare-service");
      await expect(row).toContainText("Waiting for connections and settings");
      await captureInstallState(page, "store-unfinished");
      await row.getByRole("link", { name: "Continue", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/new\\?installPlan=${attemptId}$`, "u"));
      await expect(installSheet(page)).toBeVisible();
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await page.goto("/new");
      await open.locator(`li[data-install-plan-id="${attemptId}"]`).getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(open).toHaveCount(0);
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/install-plans/${attemptId}`)).toHaveLength(1);
      // Listing, opening and continuing created nothing new.
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(1);
    });
    test("an expired attempt says so and starts over", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const attemptId = new URL(page.url()).searchParams.get("installPlan")!;
      f.attempts.invalidate(attemptId);
      await page.reload();
      const problem = page.getByTestId("install-attempt-problem");
      await expect(problem).toHaveAttribute("data-install-stage", "invalidated");
      await expect(problem).toContainText("This install expired");
      await problem.getByRole("button", { name: "Start over", exact: true }).click();
      await expect(installSheet(page)).toBeVisible();
      expect(f.mutations.filter((m) => m === attemptPost)).toHaveLength(2);
    });
    test("failed Apply offers a new reviewed Plan without abandoning partial state or replaying Apply", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl); await openInstallSheet(page);
      await reviewPlan(page);
      await page.getByRole("button", { name: "Allow and install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      f.fail(true); f.failRetry(true);
      const review = page.locator(".iv-execution");
      await expect(review.getByRole("button", { name: "Retry installation", exact: true })).toBeVisible({ timeout: 15_000 });
      await review.getByRole("button", { name: "Retry installation", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(1);
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(f.mutations.some((m) => m.includes("/abandon") || m.startsWith("DELETE "))).toBe(false);
    });
    test("an unconfirmed Apply is held and reload does not restore consent", async ({ page }) => {
      await detailFixture(page, base);
      let posts = 0;
      await page.route(`**/runs/${planId}/apply`, (route) => { posts += 1; return route.fulfill({ status: 503, json: { error: "fixture_indeterminate" } }); });
      await page.goto(sourceUrl); await openInstallSheet(page);
      const review = await reviewPlan(page);
      expect(posts).toBe(0);
      await review.getByRole("button", { name: "Allow and install", exact: true }).click();
      await expect(review.getByRole("button", { name: "Allow and install", exact: true })).toBeDisabled();
      await expect(review.getByRole("alert")).toContainText("The execution could not be confirmed.");
      // An Apply that may have started can no longer be discarded from here.
      await expect(review.getByRole("button", { name: "Stop installing", exact: true })).toHaveCount(0);
      expect(posts).toBe(1);
      await page.reload();
      await expect(page.locator(".iv-execution").getByRole("button", { name: "Allow and install", exact: true })).toBeEnabled();
      expect(posts).toBe(1);
    });
  });

  test.describe("Installed app page", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");
    test("Uninstall confirms once, restores its real reservation, and supports cancellation", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      const section = page.getByTestId("app-uninstall");
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-state", "uninstalling");
      await page.reload(); await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-state", "uninstalling");
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
      // The scheduled uninstall is this app's problem until it runs.
      const scheduled = page.getByTestId("app-problems").locator('[data-problem="uninstall"]');
      await expect(scheduled).toContainText("will be uninstalled on");
      await expect(page.getByTestId("app-uninstall")).toHaveCount(0);
      await scheduled.getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      f.destroy(); await page.reload();
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-state", "uninstalled");
    });
    test("returning to Store exits the installed detail without replaying any action", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Store", exact: true }).first().click();
      await expect(page).toHaveURL(/\/new$/u);
      await expect(page.getByTestId("install-app-header")).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "Install an app" })).toBeVisible();
      await expect(page.locator('input[name="storeSearch"]')).toBeVisible();
      expect(f.mutations).toEqual([]);
    });
    test("launch read failure is retryable and a later failed update retains management", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish(); f.problem("error");
      let failScreens = true;
      await page.route("**/workspaces/ws_alpha/ui-surfaces**", (route) => failScreens
        ? route.fulfill({ status: 503, json: { error: "fixture_read_unavailable" } }) : route.fallback());
      await page.goto(`/new?capsule=${capId}`);
      await expect(page.getByTestId("app-problems").locator('[data-problem="error"]')).toContainText("This app has a problem");
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      const header = page.getByTestId("app-header");
      await expect(header.getByRole("alert")).toContainText("Its screens couldn't be loaded");
      failScreens = false;
      await header.getByRole("button", { name: "Reload screens", exact: true }).click();
      // The error app still has the state its last successful apply made;
      // its authorized screen stays openable while the problem is shown.
      await expect(header.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      f.problem("disabled"); await page.reload();
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Stopped.");
      await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
    });
    test("deletion confirmation includes dependent apps and failed dependency reads", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      let failGraph = false;
      await page.route("**/workspaces/ws_alpha/graph", (route) => failGraph
        ? route.fulfill({ status: 503, json: { error: "fixture_graph_unavailable" } })
        : route.fulfill({ json: { nodes: [{ capsuleId: "cap_consumer", name: "Dependent app" }], edges: [{ id: "dep_fixture", producerCapsuleId: capId, consumerCapsuleId: "cap_consumer", outputs: {} }] } }));
      await page.goto(`/new?capsule=${capId}`);
      // The apps that use this one are named before anything is confirmed.
      await expect(page.getByTestId("app-uninstall")).toContainText("Dependent app");
      await expect(page.getByTestId("app-linked")).toContainText("Dependent app");
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("Dependent app");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      failGraph = true;
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("Couldn't check linked apps");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
    });
  });
}
