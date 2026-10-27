import { expect, test, type Page } from "@playwright/test";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import { PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS, PORTABLE_UI_SURFACES } from "./fixture-data.ts";

type BaseFixture = { readonly mutations: string[]; readonly sourceCreateBodies?: readonly unknown[]; installPlanBody?: { readonly variables?: Readonly<Record<string, unknown>>; readonly options?: { readonly providerBindings?: readonly Record<string, unknown>[] } } };
const capId = "cap_provider_destination_e2e";
const planId = "run_provider_plan_e2e";
const applyId = "run_provider_apply_e2e";
const now = "2026-10-27T01:00:00.000Z";
const sourceUrl = "/new?git=https%3A%2F%2Fgithub.com%2Fexample%2Fcloudflare-service.git&ref=0123456789abcdef0123456789abcdef01234567&path=.&name=cloudflare-service";

async function detailFixture(page: Page, base: (page: Page, provider: boolean) => Promise<BaseFixture>, provider = false) {
  await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
  const initial = await base(page, provider);
  const mutations: string[] = [];
  let applied = false;
  let applyStatus = "running";
  let capsuleStatus = "pending";
  let connected = false;
  let retryCount = 0;
  let retryFailed = false;
  const connection = { ...PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS[1], id: "conn_inline_fixture", displayName: "My Cloudflare" };
  const plan = () => ({ id: retryCount ? `run_retry_fixture_${retryCount}` : planId, workspaceId: "ws_alpha", capsuleId: capId, type: "plan", status: retryCount && retryFailed ? "failed" : "succeeded", summary: { add: 1, change: 0, destroy: 0 }, policyStatus: "pass", createdBy: "portable-e2e", createdAt: retryCount ? new Date(Date.parse(now) + 120000 + retryCount * 1000).toISOString() : now });
  const apply = () => ({ ...plan(), id: applyId, planRunId: planId, type: "apply", status: applyStatus, errorCode: applyStatus === "failed" ? "runner_apply_failed" : undefined, createdAt: "2026-10-27T01:01:00.000Z" });
  const capsule = () => ({ id: capId, workspaceId: "ws_alpha", sourceId: "src_provider_destination_e2e", name: "cloudflare-service", slug: "cloudflare-service", installConfigId: "cfg-default-opentofu-capsule", environment: "production", status: capsuleStatus, currentStateGeneration: capsuleStatus === "pending" ? 0 : 1, currentStateVersionId: capsuleStatus === "pending" ? undefined : "sv_inline", uninstall: capsuleStatus === "uninstalled" ? { phase: "scheduled", requestedAt: now, scheduledDestroyAt: "2026-11-03T01:00:00Z" } : undefined, createdAt: now, updatedAt: now });
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
    if (path === "/api/v1/credential-recipes") return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES } });
    if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: connected ? [connection] : [] } });
    if (path === "/api/v1/connections") {
      if (request.method() === "POST") return route.fulfill({ status: 201, json: { connection: { ...connection, status: "pending" } } });
      return route.fulfill({ json: { connections: connected ? [connection] : [] } });
    }
    if (path === "/api/v1/connections/conn_inline_fixture/test") { connected = true; return route.fulfill({ json: { status: "verified" } }); }
    if (path === "/api/v1/capsule-configs/cfg-default-opentofu-capsule") return route.fulfill({ json: { installConfig: {
      id: "cfg-default-opentofu-capsule", name: "Example", policy: {}, variableMapping: {},
      variablePresentation: [{ name: "domain", type: "string", required: true, label: { ja: "ドメイン", en: "Domain" }, defaultValue: { source: "literal", value: "default.example.com" } }],
      outputAllowlist: {}, createdAt: now, updatedAt: now,
    } } });
    if (path === `/api/v1/capsules/${capId}`) {
      if (request.method() === "DELETE") capsuleStatus = "uninstalled";
      return route.fulfill({ json: { capsule: capsule(), graceDays: 7 } });
    }
    if (path === `/api/v1/capsules/${capId}/cancel-uninstall`) { capsuleStatus = "active"; return route.fulfill({ json: { capsule: capsule() } }); }
    if (path === `/api/v1/capsules/${capId}/plan`) { retryCount += 1; return route.fulfill({ json: { run: plan() } }); }
    if (path === "/api/v1/workspaces/ws_alpha/runs") return route.fulfill({ json: { runs: applied ? [apply(), plan()] : [plan()] } });
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
  return { initial, mutations, finish: () => { applyStatus = "succeeded"; capsuleStatus = "active"; }, fail: (partialState = false) => { applyStatus = "failed"; if (partialState) capsuleStatus = "error"; }, destroy: () => { capsuleStatus = "destroyed"; }, problem: (status: string) => { capsuleStatus = status; }, failRetry: (failed: boolean) => { retryFailed = failed; } };
}

export function registerInstallDetailCases(mode: string, base: (page: Page, provider: boolean) => Promise<BaseFixture>) {
  test.describe("Inline app detail installation", () => {
    test.skip(mode !== "portable", "controlled API fixture; not production evidence");
    test("keeps settings through cloud connection and submits the verified binding", async ({ page }) => {
      const f = await detailFixture(page, base, true);
      await page.setViewportSize({ width: 390, height: 844 });
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.getByTestId("install-configuration")).toHaveCount(0);
      expect(f.initial.sourceCreateBodies ?? []).toEqual([]);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.getByLabel("Domain")).toHaveValue("default.example.com");
      await page.getByLabel("Domain").fill("chosen.example.com");
      expect(f.initial.installPlanBody).toBeUndefined();
      await page.locator(".iv-cloud-summary").getByRole("button", { name: "Connect", exact: true }).click();
      await expect(page.getByTestId("install-connections-panel")).toBeVisible();
      await expect(page.locator("#install-connections-title")).toBeFocused();
      await expect(page.locator('#connection-field-CLOUDFLARE_API_TOKEN')).toBeVisible();
      const heading = (await page.locator("#install-connections-title").boundingBox())!;
      const tabs = (await page.locator(".mobile-tabs").boundingBox())!;
      expect(heading.y).toBeGreaterThanOrEqual(56);
      expect(heading.y + heading.height).toBeLessThanOrEqual(tabs.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByTestId("install-connections-panel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: test.info().outputPath("install-connect-mobile.png") });
      await page.getByRole("button", { name: "Back to settings" }).click();
      await expect(page.locator(".iv-cloud-summary button")).toBeFocused();
      await expect(page.getByLabel("Domain")).toHaveValue("chosen.example.com");
      await page.locator(".iv-cloud-summary").getByRole("button", { name: "Connect", exact: true }).click();
      await page.locator('#connection-field-CLOUDFLARE_API_TOKEN').fill("fixture-only-token");
      await page.locator('#connection-field-CLOUDFLARE_ACCOUNT_ID').fill("fixture-account");
      await page.getByRole("button", { name: "Save connection", exact: true }).click();
      await expect(page.locator(".iv-cloud-summary")).toContainText("Connected. Ready to install.");
      await page.getByRole("button", { name: "Back to settings" }).click();
      await expect(page.locator(".iv-cloud-summary button")).toBeFocused();
      await expect(page.getByLabel("Domain")).toHaveValue("chosen.example.com");
      await page.getByTestId("install-configuration").getByRole("button", { name: "Install", exact: true }).click();
      await expect.poll(() => f.initial.installPlanBody?.variables).toEqual({ domain: "chosen.example.com" });
      expect(f.initial.installPlanBody?.options?.providerBindings?.[0]?.connectionId).toBe("conn_inline_fixture");
      const stored = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
      expect(stored).not.toContain("fixture-only-token"); expect(stored).not.toContain("chosen.example.com");
      expect(errors).toEqual([]);
    });
    test("installs inline, restores the real running Apply after reload, and opens the deployed app", async ({ page, context }) => {
      const f = await detailFixture(page, base);
      const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(sourceUrl);
      await expect(page.getByTestId("install-app-header")).toBeVisible();
      await page.screenshot({ path: test.info().outputPath("install-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: test.info().outputPath("install-mobile.png") });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByTestId("install-configuration").getByRole("button", { name: "Install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${planId}/apply`)).length).toBe(1);
      await page.reload();
      await expect(page.getByTestId("install-app-header")).toContainText("cloudflare-service");
      await expect(page.locator(".iv-execution")).toContainText("Installing");
      await page.getByText("Progress and logs", { exact: true }).click();
      await expect(page.getByTestId("install-run-logs")).toContainText("Installing fixture resources");
      f.finish();
      await expect(page.getByTestId("install-lifecycle")).toHaveAttribute("data-install-state", "installed", { timeout: 15000 });
      const open = page.getByRole("link", { name: "Open service", exact: true });
      await expect(open).toHaveAttribute("href", "https://apps.example.test/inline-app");
      const popupPromise = context.waitForEvent("page"); await open.click(); const popup = await popupPromise;
      await expect(popup.getByRole("heading")).toHaveText("Installed application"); await popup.close();
      await page.reload(); await expect(page.getByRole("link", { name: "Open service", exact: true })).toBeVisible();
      expect(f.mutations.filter((m) => m.endsWith(`/${planId}/apply`))).toHaveLength(1);
      expect(errors).toEqual([]);
    });
    test("failed Apply offers a new reviewed Plan without abandoning partial state or replaying Apply", async ({ page }) => {
      const f = await detailFixture(page, base);
      await page.goto(sourceUrl); await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByTestId("install-configuration").getByRole("button", { name: "Install", exact: true }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${planId}/apply`)).length).toBe(1);
      f.fail(true); f.failRetry(true); await page.reload();
      await expect(page.getByTestId("install-lifecycle").getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage app", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry installation" })).toBeVisible();
      await page.getByRole("button", { name: "Retry installation" }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(1);
      await expect(page.locator('.iv-error a[href="/runs/run_retry_fixture_1"]')).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry installation" })).toBeEnabled();
      f.failRetry(false);
      await page.getByRole("button", { name: "Retry installation" }).click();
      await expect.poll(() => f.mutations.filter((m) => m.endsWith(`/${capId}/plan`)).length).toBe(2);
      await expect(page.locator(".iv-execution").getByRole("button", { name: "Install", exact: true })).toBeVisible();
      expect(f.mutations.filter((m) => m.endsWith(`/${planId}/apply`))).toHaveLength(1);
      expect(f.mutations.some((m) => m.includes("/abandon"))).toBe(false);
    });
    test("Uninstall confirms once, restores its real reservation, and supports cancellation", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Schedule deletion", exact: true }).click();
      await expect(page.getByTestId("install-lifecycle")).toHaveAttribute("data-install-state", "uninstalling");
      await page.reload(); await expect(page.getByTestId("install-lifecycle")).toHaveAttribute("data-install-state", "uninstalling");
      expect(f.mutations.filter((m) => m === `DELETE /api/v1/capsules/${capId}`)).toHaveLength(1);
      await page.getByRole("button", { name: "Cancel deletion", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open service", exact: true })).toBeVisible();
      f.destroy(); await page.reload();
      await expect(page.getByTestId("install-lifecycle")).toHaveAttribute("data-install-state", "not-installed");
    });
    test("returning to Store exits the installed detail without replaying any action", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      await page.goto(`/new?capsule=${capId}`);
      await expect(page.getByRole("link", { name: "Open service", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Store", exact: true }).first().click();
      await expect(page).toHaveURL(/\/new$/u);
      await expect(page.getByTestId("install-app-header")).toHaveCount(0);
      await expect(page.locator('input[name="storeSearch"]')).toBeVisible();
      expect(f.mutations).toEqual([]);
    });
    test("launch read failure is retryable and a later failed update retains management", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish(); f.problem("error");
      let reads = 0;
      await page.route("**/workspaces/ws_alpha/ui-surfaces**", (route) => ++reads === 1
        ? route.fulfill({ status: 503, json: { error: "fixture_read_unavailable" } }) : route.fallback());
      await page.goto(`/new?capsule=${capId}`);
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage app", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Refresh launch URL", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Refresh launch URL", exact: true }).click();
      // The error Capsule still has a real applied state; expose its declared
      // surface when the server authorizes it, without claiming it is healthy.
      await expect(page.getByTestId("install-lifecycle")).toHaveAttribute("data-install-state", "installed");
      await expect(page.getByRole("link", { name: "Open service", exact: true })).toBeVisible();
      f.problem("disabled"); await page.reload();
      await expect(page.getByRole("button", { name: "Uninstall", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Manage app", exact: true })).toBeVisible();
      await expect(page.getByRole("link", { name: "Open service", exact: true })).toHaveCount(0);
    });
    test("deletion confirmation includes dependent apps and failed dependency reads", async ({ page }) => {
      const f = await detailFixture(page, base); f.finish();
      let failGraph = false;
      await page.route("**/workspaces/ws_alpha/graph", (route) => failGraph
        ? route.fulfill({ status: 503, json: { error: "fixture_graph_unavailable" } })
        : route.fulfill({ json: { nodes: [{ capsuleId: "cap_consumer", name: "Dependent app" }], edges: [{ id: "dep_fixture", producerCapsuleId: capId, consumerCapsuleId: "cap_consumer", outputs: {} }] } }));
      await page.goto(`/new?capsule=${capId}`);
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("Dependent app");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      failGraph = true;
      await page.getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("Connected services could not be checked");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      expect(f.mutations.some((m) => m.startsWith("DELETE"))).toBe(false);
    });
    test("an unconfirmed Apply is held and reload does not restore consent", async ({ page }) => {
      await detailFixture(page, base);
      let posts = 0;
      await page.route(`**/runs/${planId}/apply`, (route) => { posts += 1; return route.fulfill({ status: 503, json: { error: "fixture_indeterminate" } }); });
      await page.goto(sourceUrl); await page.getByRole("button", { name: "Install", exact: true }).click();
      await page.getByTestId("install-configuration").getByRole("button", { name: "Install", exact: true }).click();
      await expect(page.locator(".iv-execution").getByRole("button", { name: "Install", exact: true })).toBeDisabled();
      expect(posts).toBe(1);
      await page.reload();
      await expect(page.locator(".iv-execution").getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      expect(posts).toBe(1);
    });
  });
}
