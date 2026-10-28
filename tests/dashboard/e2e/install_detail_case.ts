import { expect, test, type Locator, type Page } from "@playwright/test";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import { PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS, PORTABLE_UI_SURFACES } from "./fixture-data.ts";

type BaseFixture = {
  readonly mutations: string[];
  readonly sourceCreateBodies?: readonly unknown[];
  readonly compatibilityBodies?: readonly unknown[];
  installPlanBody?: {
    readonly capsule?: Readonly<Record<string, unknown>>;
    readonly source?: Readonly<Record<string, unknown>>;
    readonly variables?: Readonly<Record<string, unknown>>;
    readonly options?: { readonly providerBindings?: readonly Record<string, unknown>[] };
  };
};
type CostFixture = "not_applicable" | "rated_zero" | "unrated" | "unavailable";
const capId = "cap_provider_destination_e2e";
const sourceId = "src_provider_destination_e2e";
const planId = "run_provider_plan_e2e";
const applyId = "run_provider_apply_e2e";
const now = "2026-10-27T01:00:00.000Z";
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const sourceUrl = `/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fcloudflare-service.git&ref=${sourceCommit}&path=.&name=cloudflare-service`;
const domainField = /^Domain(?:\s*\*)?$/;
const applyMutation = `POST /api/v1/runs/${planId}/apply`;
const abandonMutation = `POST /api/v1/capsules/${capId}/abandon`;
const sourceDeleteMutation = `DELETE /api/v1/sources/${sourceId}`;

async function detailFixture(page: Page, base: (page: Page, provider: boolean) => Promise<BaseFixture>, provider = false, oauth = false, cost: CostFixture = "not_applicable") {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  const initial = await base(page, provider);
  const mutations: string[] = [];
  let applied = false;
  let applyStatus = "running";
  let capsuleStatus = "pending";
  let connected = false;
  let retryCount = 0;
  let retryFailed = false;
  let screensUnreadable = false;
  const connection = { ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], ...(oauth ? { credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" } } : {}), id: "conn_inline_fixture", displayName: "My Cloudflare" };
  const planResources = [
    { address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["create"] },
    { address: "cloudflare_d1_database.data", type: "cloudflare_d1_database", actions: ["create"] },
  ];
  const plan = () => ({ id: retryCount ? `run_retry_fixture_${retryCount}` : planId, workspaceId: "ws_alpha", capsuleId: capId, type: "plan", status: retryCount && retryFailed ? "failed" : "succeeded", summary: { add: 2, change: 0, destroy: 0 }, planResources, policyStatus: "pass", createdBy: "portable-e2e", createdAt: retryCount ? new Date(Date.parse(now) + 120000 + retryCount * 1000).toISOString() : now });
  const apply = () => ({ ...plan(), id: applyId, planRunId: planId, type: "apply", status: applyStatus, errorCode: applyStatus === "failed" ? "runner_apply_failed" : undefined, createdAt: "2026-10-27T01:01:00.000Z" });
  const capsule = () => ({ id: capId, workspaceId: "ws_alpha", sourceId, name: "cloudflare-service", slug: "cloudflare-service", installConfigId: "cfg-default-opentofu-capsule", environment: "production", status: capsuleStatus, currentStateGeneration: capsuleStatus === "pending" ? 0 : 1, currentStateVersionId: capsuleStatus === "pending" ? undefined : "sv_inline", uninstall: capsuleStatus === "uninstalled" ? { phase: "scheduled", requestedAt: now, scheduledDestroyAt: "2026-11-03T01:00:00Z" } : undefined, createdAt: now, updatedAt: now });
  // The control plane's view of the app (`GET /capsules/:id/app`), derived
  // from the same fixture state the Capsule read reports.
  const appView = () => {
    const base = {
      kind: "takosumi.capsule-app@v1", capsuleId: capId, workspaceId: "ws_alpha", projectId: "prj_alpha",
      name: "cloudflare-service", environment: "production", status: capsuleStatus,
      applied: capsuleStatus !== "pending" && capsuleStatus !== "destroyed", problems: [] as Record<string, unknown>[],
      screens: [] as Record<string, unknown>[],
      version: {
        repository: { url: "https://github.com/example/cloudflare-service.git", defaultRef: sourceCommit },
        ...(capsuleStatus !== "pending" && capsuleStatus !== "destroyed"
          ? { current: { sourceSnapshotId: "snap_inline", ref: sourceCommit, path: ".", commit: sourceCommit } }
          : {}),
        updateAvailable: false, stale: false, autoUpdate: false,
      },
      progress: { revisionPreparing: false } as Record<string, unknown>,
      uninstall: { mode: "scheduled", graceDays: 7 } as Record<string, unknown>,
      observedAt: now,
    };
    const failedApply = { code: "run_failed", severity: "error", runId: applyId, runType: "apply", errorCode: "runner_apply_failed" };
    switch (capsuleStatus) {
      case "pending":
        if (applied && applyStatus === "running") {
          return { ...base, state: "installing", primaryAction: "none", progress: { revisionPreparing: false, run: { id: applyId, type: "apply", status: "running", createdAt: apply().createdAt } }, uninstall: { mode: "discard" } };
        }
        if (applied && applyStatus === "failed") {
          return { ...base, state: "needs_attention", primaryAction: "retry", problems: [failedApply], uninstall: { mode: "discard" } };
        }
        return { ...base, state: "installing", primaryAction: "review", progress: { revisionPreparing: false, review: { runId: plan().id, runType: "plan" } }, uninstall: { mode: "discard" } };
      case "active":
        return screensUnreadable
          ? { ...base, state: "installed", primaryAction: "open", incomplete: ["screens"] }
          : { ...base, state: "installed", primaryAction: "open", screens: [{ interfaceId: "if_inline", name: "app.launcher", title: "Cloudflare Service", url: "https://apps.example.test/inline-app" }] };
      case "error":
        return { ...base, state: "needs_attention", primaryAction: "retry", problems: applyStatus === "failed" ? [failedApply] : [{ code: "capsule_error", severity: "error" }] };
      case "uninstalled":
        return {
          ...base, state: "uninstall_scheduled", primaryAction: "cancel_uninstall",
          problems: [{ code: "uninstall_scheduled", severity: "warning" }],
          uninstall: { mode: "scheduled", graceDays: 7, scheduled: { phase: "scheduled", requestedAt: now, deleteAfter: "2026-11-03T01:00:00Z", cancellable: true, blocked: false } },
        };
      case "disabled":
        return { ...base, state: "stopped", primaryAction: "none", uninstall: { mode: "none" } };
      default:
        return { ...base, state: "uninstalled", primaryAction: "reinstall", uninstall: { mode: "none" } };
    }
  };
  if (oauth) await page.context().route("**/api/v1/connections/oauth/cloudflare/callback**", async (route) => {
    const url = new URL(route.request().url());
    connected = !url.searchParams.has("error");
    const flow = "sha256:" + Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify("opaque-fixture-state")))).toString("hex");
    const result = { kind: "connection-oauth", error: !connected, connectionId: connection.id, connectionStatus: "verified" };
    return route.fulfill({ contentType: "text/html", body: `<h1>Connection callback</h1><script>new BroadcastChannel(${JSON.stringify("takosumi.oauth." + flow)}).postMessage(${JSON.stringify(result)})</script>` });
  });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES, oauthHelpers: oauth ? [{ id: "cloudflare", providerSource: "registry.opentofu.org/cloudflare/cloudflare", credentialRecipe: { id: "cloudflare", authMode: "oauth" }, setupFields: [{ key: "accountId", envName: "CLOUDFLARE_ACCOUNT_ID" }] }] : [] } });
    if (path === "/api/v1/connections/oauth/cloudflare/start") return route.fulfill({ json: { authorizationUrl: "https://dash.cloudflare.test/oauth2/auth?state=opaque-fixture-state", state: "opaque-fixture-state", expiresAt: new Date(Date.now() + 600000).toISOString() } });
    if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: connected ? [connection] : [] } });
    if (path === "/api/v1/connections") {
      if (request.method() === "POST") return route.fulfill({ status: 201, json: { connection: { ...connection, status: "pending" } } });
      return route.fulfill({ json: { connections: connected ? [connection] : [] } });
    }
    if (path === "/api/v1/connections/conn_inline_fixture/test") { connected = true; return route.fulfill({ json: { status: "verified" } }); }
    if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") return route.fulfill({ json: { installConfig: {
      id: "cfg-default-opentofu-capsule", name: "Example", policy: {}, variableMapping: {},
      variablePresentation: [{ name: "domain", type: "string", required: true, label: { ja: "ドメイン", en: "Domain" }, defaultValue: { source: "literal", value: "default.example.com" } }, { name: "custom_domain", type: "string", required: false, label: { en: "Custom domain", ja: "カスタムドメイン" } }, { name: "service_name", type: "string", required: true, label: { en: "Service name", ja: "サービス名" }, defaultValue: { source: "capsule_name" } }],
      outputAllowlist: {}, createdAt: now, updatedAt: now,
    } } });
    if (path === `/api/v1/capsules/${capId}/abandon` && request.method() === "POST") {
      // The server abandons only a never-applied Capsule.
      capsuleStatus = "destroyed";
      return route.fulfill({ json: { capsule: { ...capsule(), status: "destroyed", currentStateGeneration: 0, currentStateVersionId: undefined }, abandoned: true } });
    }
    if (path === `/api/v1/sources/${sourceId}` && request.method() === "DELETE") {
      return route.fulfill({ json: { source: { id: sourceId, workspaceId: "ws_alpha", name: "cloudflare-service", url: "https://github.com/example/cloudflare-service.git", defaultRef: sourceCommit, defaultPath: ".", status: "disabled", autoSync: false, createdAt: now, updatedAt: now } } });
    }
    if (path === `/api/v1/capsules/${capId}`) {
      if (request.method() === "DELETE") capsuleStatus = "uninstalled";
      // A capsule read always carries the configuration authority guard.
      return route.fulfill({ json: { capsule: capsule(), graceDays: 7, installConfigReAdoption: { authorityGuard: `sha256:${"c".repeat(64)}` } } });
    }
    if (path === `/api/v1/capsules/${capId}/app`) return route.fulfill({ json: { app: appView() } });
    if (path === `/api/v1/capsules/${capId}/runs`) {
      const runs = applied ? [apply(), plan()] : [plan()];
      return route.fulfill({ json: { runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) } });
    }
    if (path === `/api/v1/capsules/${capId}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: { id: "pbs_inline", workspaceId: "ws_alpha", capsuleId: capId, environment: "production", bindings: provider ? [{ provider: "registry.opentofu.org/cloudflare/cloudflare", moduleLocalName: "cloudflare", connectionId: connection.id }] : [], createdAt: now, updatedAt: now } } });
    if (path === `/api/v1/capsules/${capId}/current-resource-inventory`) return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: capId, workspaceId: "ws_alpha", environment: "production", stateVersionId: "sv_inline", generation: 1, applyRunId: applyId, planRunId: planId, recordedAt: now, availability: "recorded", resources: planResources.map(({ address, type }) => ({ address, type, providerSource: "registry.opentofu.org/cloudflare/cloudflare" })) } } });
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
  return { initial, mutations, authorize: () => { connected = true; }, finish: () => { applied = true; applyStatus = "succeeded"; capsuleStatus = "active"; }, fail: (partialState = false) => { applyStatus = "failed"; if (partialState) capsuleStatus = "error"; }, destroy: () => { capsuleStatus = "destroyed"; }, problem: (status: string) => { capsuleStatus = status; }, failRetry: (failed: boolean) => { retryFailed = failed; }, screensUnreadable: (value: boolean) => { screensUnreadable = value; } };
}

/** The install sheet opened by the app page's single Install button. */
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

/** Review creates the Plan; Allow and install is the only Apply consent. */
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
  const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  for (const value of values) expect(stored).not.toContain(value);
}

export function registerInstallDetailCases(mode: string, base: (page: Page, provider: boolean) => Promise<BaseFixture>) {
  test.describe("Inline app detail installation", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");
    test("connects a missing provider inline, keeps settings, and submits the verified binding", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      const provenance = page.getByTestId("install-provenance");
      await expect(provenance).toContainText("github.com/example/cloudflare-service");
      // A pinned full commit reads as its short form.
      await expect(provenance).toContainText(sourceCommit.slice(0, 7));
      await expect(provenance).not.toContainText(sourceCommit);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(installSheet(page)).toHaveCount(0);
      expect(f.initial.sourceCreateBodies ?? []).toEqual([]);
      const sheet = await openInstallSheet(page);
      await expect(sheet).toHaveAttribute("data-install-state", "provider-required");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("default.example.com");
      await sheet.getByRole("textbox", { name: domainField }).fill("chosen.example.com");
      expect(f.initial.installPlanBody).toBeUndefined();

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
      // and it opens that row instead of creating a Plan.
      // Opening the form must not suspend and remount the whole sheet.
      await sheet.evaluate((element) => element.setAttribute("data-e2e-mounted", "before-connect"));
      await sheetActions(page).getByRole("button", { name: "Connect", exact: true }).click();
      await expect(form).toBeVisible();
      await expect(form.getByText("Connect account", { exact: true })).toBeVisible();
      await expect(sheet).toHaveAttribute("data-e2e-mounted", "before-connect");
      await expect(form).toHaveClass(/\biv-inline-connect\b/u);
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveText("Close");
      expect(f.initial.installPlanBody).toBeUndefined();
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
      // Saved, tested once, then selected for this row; the form closes.
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
      expect(f.initial.installPlanBody).toBeUndefined();

      await reviewPlan(page);
      await expect.poll(() => f.initial.installPlanBody?.variables).toEqual({ domain: "chosen.example.com" });
      expect(f.initial.installPlanBody?.options?.providerBindings).toEqual([
        expect.objectContaining({ provider: "registry.opentofu.org/cloudflare/cloudflare", connectionId: "conn_inline_fixture" }),
      ]);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "fixture-only-token", "chosen.example.com");
      expect(errors).toEqual([]);
    });
    test("OAuth keeps declared domain settings mounted and uses the verified returned connection", async ({ page, context }) => {
      const f = await detailFixture(page, base, true, true);
      await context.route("https://dash.cloudflare.test/**", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Authorize Cloudflare</h1>" }));
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      await sheet.getByRole("textbox", { name: domainField }).fill("oauth-chosen.example.net");
      // Optional settings are shown plainly, not behind a disclosure.
      await expect(sheet.getByTestId("install-optional-settings")).toBeVisible();
      await expect(sheet.getByRole("textbox", { name: /^Service name(?:\s*\*)?$/ })).toHaveValue("cloudflare-service");
      await sheet.getByLabel("Custom domain", { exact: true }).fill("custom.example.org");
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
      // The OAuth connection arrives verified: adopted for the row without a test.
      await expect(row).toHaveAttribute("data-connection-state", "connected");
      await expect(form).toHaveCount(0);
      await expect(page.getByTestId("install-connections")).toContainText("Connected. Ready to install.");
      await expect(sheet.getByRole("textbox", { name: domainField })).toHaveValue("oauth-chosen.example.net");
      await expect(sheet.getByLabel("Custom domain", { exact: true })).toHaveValue("custom.example.org");
      await reviewPlan(page);
      await expect.poll(() => f.initial.installPlanBody?.variables).toEqual({ domain: "oauth-chosen.example.net", custom_domain: "custom.example.org" });
      expect(f.initial.installPlanBody?.options?.providerBindings?.[0]?.connectionId).toBe("conn_inline_fixture");
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
      expect(f.initial.installPlanBody).toBeUndefined();
    });
    test("installs inline, restores the real running Apply after reload, and opens the deployed app", async ({ page, context }) => {
      const f = await detailFixture(page, base);
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose again", exact: true })).toBeVisible();
      await captureInstallState(page, "app-not-installed");
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalOverflow(page, "not-installed app page at 390px");
      await openInstallSheet(page);
      await reviewPlan(page);
      await page.getByRole("button", { name: "Allow and install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      // A reload lands on the app's own page, which follows the running Apply
      // the server reports — nothing is applied again.
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`/apps/${capId}$`, "u"));
      const app = page.getByTestId("app-page");
      await expect(app).toHaveAttribute("data-app-state", "installing");
      await expect(page.getByTestId("app-header")).toContainText("cloudflare-service");
      await expect(page.locator(".iv-execution")).toContainText("Installing");
      await page.getByText("Progress and logs", { exact: true }).click();
      await expect(page.getByTestId("install-run-logs")).toContainText("Installing fixture resources");
      f.finish();
      // Once installed, the page shows the same sections as everywhere else.
      await expect(app).toHaveAttribute("data-app-state", "installed", { timeout: 20000 });
      await expect(page.getByTestId("install-app-header")).toHaveCount(0);
      const open = page.getByTestId("app-header").getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", "https://apps.example.test/inline-app");
      for (const section of ["app-version", "app-settings", "app-created", "app-history", "app-uninstall"]) {
        await expect(app.getByTestId(section)).toBeVisible();
      }
      await expect(app.getByTestId("app-created-groups")).toContainText("Workers Script");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await captureInstallState(page, "app-installed");
      const popupPromise = context.waitForEvent("page"); await open.click(); const popup = await popupPromise;
      await expect(popup.getByRole("heading")).toHaveText("Installed application"); await popup.close();
      await page.reload(); await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(errors).toEqual([]);
    });
    for (const cost of ["rated_zero", "not_applicable", "unrated", "unavailable"] as const) {
      test(`review lists planned resources and the ${cost} cost before an explicit Allow and install`, async ({ page }) => {
        const f = await detailFixture(page, base, false, false, cost);
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(sourceUrl);
        const sheet = await openInstallSheet(page);
        // Before any connection or Plan, the sheet previews the scanned types.
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
        await allow.click();
        await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
        await expect(review.getByRole("heading", { name: "Installing", exact: true })).toBeVisible();
        expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
        expect(errors).toEqual([]);
      });
    }
    test("Stop installing from the sheet deletes only the Source this attempt created", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      expect(f.mutations).toContain("POST /api/v1/sources");
      await sheetActions(page).getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(installSheet(page)).toHaveCount(0);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page.getByTestId("install-start")).toBeVisible();
      await expect.poll(() => f.mutations.filter((m) => m === sourceDeleteMutation).length).toBe(1);
      // No Capsule existed yet, so nothing is abandoned and no Plan exists.
      expect(f.mutations.some((m) => m.includes("/abandon"))).toBe(false);
      expect(f.mutations.some((m) => m.includes("/install-plans"))).toBe(false);
      // A deleted Source needs no polling opt-out.
      expect(f.mutations.some((m) => m.startsWith("PATCH /api/v1/sources/"))).toBe(false);
      expect(f.initial.installPlanBody).toBeUndefined();
      // The URL still names this app, so a reload returns to the same page.
      const discarded = new URL(page.url());
      expect(discarded.searchParams.get("git")).toBe("https://github.com/example/cloudflare-service.git");
      expect(discarded.searchParams.get("name")).toBe("cloudflare-service");
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "cloudflare-service" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(f.mutations.filter((m) => m === "POST /api/v1/sources")).toHaveLength(1);
      // A new attempt starts from a fresh Source rather than the deleted one.
      await openInstallSheet(page);
      expect(f.mutations.filter((m) => m === "POST /api/v1/sources")).toHaveLength(2);
      expect(f.mutations.filter((m) => m === sourceDeleteMutation)).toHaveLength(1);
    });
    test("Stop installing from the review abandons the unapplied Capsule before deleting its Source", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      await openInstallSheet(page);
      const review = await reviewPlan(page);
      await expect(page).toHaveURL(new RegExp(`[?&]capsule=${capId}`, "u"));
      await review.getByRole("button", { name: "Stop installing", exact: true }).click();
      await expect(page.locator(".iv-execution")).toHaveCount(0);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(page).not.toHaveURL(/[?&]capsule=/u);
      expect(new URL(page.url()).searchParams.get("git")).toBe("https://github.com/example/cloudflare-service.git");
      await expect.poll(() => f.mutations.filter((m) => m === sourceDeleteMutation).length).toBe(1);
      expect(f.mutations.filter((m) => m === abandonMutation)).toHaveLength(1);
      expect(f.mutations.indexOf(abandonMutation)).toBeLessThan(f.mutations.indexOf(sourceDeleteMutation));
      expect(f.mutations.some((m) => m.endsWith("/apply") || m.startsWith("DELETE /api/v1/capsules/"))).toBe(false);
    });
    test("Cancel while preparing before a Source exists deletes nothing", async ({ page }) => {
      const f = await detailFixture(page, base);
      let releaseList!: () => void;
      const listHeld = new Promise<void>((resolve) => { releaseList = resolve; });
      let listRequested = false;
      await page.route((url) => url.pathname === "/api/v1/sources", async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        listRequested = true;
        await listHeld;
        await route.fulfill({ json: { sources: [] } }).catch(() => undefined);
      });
      await page.goto(sourceUrl);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Getting the install ready", exact: true })).toBeVisible();
      await expect.poll(() => listRequested).toBe(true);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      releaseList();
      await expect(page.getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(installSheet(page)).toHaveCount(0);
      // The user's own cancel is not reported as a failure.
      await expect(page.locator(".iv-error")).toHaveCount(0);
      expect(f.mutations.filter((m) => m === "POST /api/v1/sources")).toEqual([]);
      expect(f.mutations.some((m) => m.startsWith("DELETE ") || m.includes("/abandon"))).toBe(false);
    });
    test("the app name stays editable in the sheet and becomes the planned Capsule name", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl);
      const sheet = await openInstallSheet(page);
      const name = sheet.getByRole("textbox", { name: /^App name\b/u });
      await expect(name).toHaveValue("cloudflare-service");
      await name.fill("Not A Valid Name");
      await sheetActions(page).getByRole("button", { name: "Review", exact: true }).click();
      await expect(sheet.locator(".iv-error[role=alert]")).toBeVisible();
      expect(f.initial.installPlanBody).toBeUndefined();
      await name.fill("renamed-app");
      await reviewPlan(page);
      await expect.poll(() => f.initial.installPlanBody?.capsule?.name).toBe("renamed-app");
      // The Source keeps the name it was registered with during preparation.
      expect(f.initial.installPlanBody?.source?.name).toBe("cloudflare-service");
      expect(f.initial.sourceCreateBodies).toEqual([expect.objectContaining({ name: "cloudflare-service" })]);
      // Renaming does not repeat the Source or compatibility work.
      expect(f.initial.compatibilityBodies).toHaveLength(1);
      expect(f.mutations.filter((m) => m === "POST /api/v1/sources")).toHaveLength(1);
      expect(f.mutations).not.toContain(applyMutation);
      await expectNothingStored(page, "renamed-app");
    });
    test("failed Apply offers a new reviewed Plan without abandoning partial state or replaying Apply", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl); await openInstallSheet(page);
      await reviewPlan(page);
      await page.getByRole("button", { name: "Allow and install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m === applyMutation).length).toBe(1);
      f.fail(true); f.failRetry(true); await page.reload();
      // The failure is this app's problem, on its own page (`/apps/:id`).
      await expect(page).toHaveURL(new RegExp(`/apps/${capId}$`, "u"));
      const problem = page.getByTestId("app-problems").locator('[data-problem="run_failed"]');
      await expect(problem).toContainText("The last change couldn't be applied");
      await expect(problem.getByRole("link", { name: "See reason and logs" })).toHaveAttribute("href", `/runs/${applyId}`);
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(1);
      const review = page.getByTestId("app-review");
      await expect(review.locator('.iv-error a[href="/runs/run_retry_fixture_1"]')).toBeVisible();
      f.failRetry(false);
      await review.getByRole("button", { name: "Review again", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(2);
      await expect(review.getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(f.mutations.filter((m) => m === applyMutation)).toHaveLength(1);
      expect(f.mutations.some((m) => m.includes("/abandon"))).toBe(false);
    });
    test("Uninstall confirms once, restores its real reservation, and supports cancellation", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      // An old install-page locator opens the app's own page.
      await page.goto(`/new?capsule=${capId}`);
      await expect(page).toHaveURL(new RegExp(`/apps/${capId}$`, "u"));
      const appPage = page.getByTestId("app-page");
      const section = page.getByTestId("app-uninstall");
      // The grace period shows before anything is scheduled.
      await expect(section).toContainText("Its data stays for 7 days");
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
      await section.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      await page.reload(); await expect(appPage).toHaveAttribute("data-app-state", "uninstall_scheduled");
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
      // The scheduled uninstall is this app's problem until it runs.
      const scheduled = page.getByTestId("app-problems").locator('[data-problem="uninstall"]');
      await expect(scheduled).toContainText("will be uninstalled on");
      await expect(page.getByTestId("app-uninstall")).toHaveCount(0);
      await page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      f.destroy(); await page.reload();
      await expect(appPage).toHaveAttribute("data-app-state", "uninstalled");
      await expect(page.getByTestId("app-header").getByRole("link", { name: "Install again", exact: true })).toBeVisible();
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
      const f = await detailFixture(page, base); f.finish(); f.screensUnreadable(true);
      await page.goto(`/apps/${capId}`);
      const header = page.getByTestId("app-header");
      // Screens the server could not read are named, never silently absent.
      await expect(header.getByRole("alert")).toContainText("Couldn't read its screens.");
      await expect(header.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
      f.screensUnreadable(false);
      await header.getByRole("button", { name: "Reload screens", exact: true }).click();
      await expect(header.getByRole("link", { name: "Open", exact: true })).toBeVisible();
      await expect(header.getByRole("alert")).toHaveCount(0);
      // A later problem is this app's, with the server's next step; the app
      // stays manageable.
      f.problem("error"); await page.reload();
      await expect(page.getByTestId("app-problems").locator('[data-problem="capsule_error"]')).toContainText("This app has a problem");
      await expect(header.getByRole("button", { name: "Review again", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      f.problem("disabled"); await page.reload();
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Stopped.");
      await expect(page.getByRole("link", { name: "Open", exact: true })).toHaveCount(0);
      // A stopped app cannot be scheduled for uninstall; it is removed by a
      // reviewed plan instead.
      await expect(page.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall now", exact: true })).toBeVisible();
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
}
