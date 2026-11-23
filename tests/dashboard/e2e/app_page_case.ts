/**
 * Installed app page and Home (TASK-0115), against a deterministic portable
 * fixture. The page is organised around keeping an installed app: open it,
 * see its state and problems, update or change its version, change its
 * settings and connections, see what it created and what it costs, read its
 * history, uninstall. Its state, primary action, problems and screens come
 * from the control plane's app view (`GET /capsules/:id/app`) and its history
 * from the app's own Runs (`GET /capsules/:id/runs`). Every change is
 * reviewed in place and applies only from the explicit approval click.
 * `/apps/:id` is the canonical URL; older app URLs redirect there.
 */
import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { REFERENCE_CREDENTIAL_RECIPES } from "../../../providers/credential-recipes.generated.ts";
import reAdoptionCoreSeam from "../fixtures/re-adoption-core-seam.json" with { type: "json" };
import {
  PORTABLE_APPS,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  PORTABLE_SHARED_APP_MEMBERS,
  PORTABLE_SOURCE_COMMIT,
  portableAppConnectionLabels,
} from "./fixture-data.ts";
import { monitorDashboardTraffic } from "./traffic-monitor.ts";
import { resolvePortableOrigin } from "./portable-origin.ts";
import {
  shouldRecordControlPlaneMutation,
  type DashboardE2EMode,
} from "./traffic-policy.ts";

const CAPSULE_ID = "cap_repository_office";
const INSTALL_CONFIG_ID = `cfg_${CAPSULE_ID}`;
const SOURCE_ID = `src_${CAPSULE_ID}`;
const AUTHORITY_GUARD = `sha256:${"a".repeat(64)}`;
const NEW_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const UPDATE_PLAN = "run_update_plan_e2e";
const UPDATE_APPLY = "run_update_apply_e2e";
const CONFIG_PLAN = "run_configuration_plan_e2e";

type AppPane = "settings" | "version" | "connections" | "links" | "created" | "history" | "sharing" | "phone" | "danger";

function appOverviewRow(page: Page, section: AppPane) {
  return page.getByTestId("app-management").locator(`[data-app-section-link="${section}"]`);
}

async function showAppOverview(page: Page): Promise<void> {
  await page.getByTestId("app-section-back").click();
  await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", "overview");
}

async function openAppPane(page: Page, section: AppPane): Promise<void> {
  await appOverviewRow(page, section).click();
  await expect(page).toHaveURL(new RegExp(`#${section}$`, "u"));
  await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", section);
}

function pageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  return errors;
}

async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    `${label} must not overflow horizontally`,
  ).toBeLessThanOrEqual(1);
}

/** Desktop 1440×900 and mobile 390×844 full-page captures. */
async function capture(page: Page, name: string): Promise<void> {
  const original = page.viewportSize();
  for (const [suffix, size] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]] as const) {
    await page.setViewportSize(size);
    await expectNoHorizontalOverflow(page, `${name} at ${size.width}px`);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: test.info().outputPath(`${name}-${suffix}.png`), fullPage: true });
  }
  if (original) await page.setViewportSize(original);
}

function snapshot(id: string, commit: string, fetchedAt: string) {
  return {
    id, origin: "git", workspaceId: "ws_alpha", sourceId: SOURCE_ID,
    url: "https://github.com/example/repository-office.git", ref: "main",
    resolvedCommit: commit, path: ".", archiveRef: "fixture",
    archiveDigest: `sha256:${"e".repeat(64)}`, archiveSizeBytes: 1,
    fetchedByRunId: "run_sync_e2e", fetchedAt,
  };
}

function lifecycleRun(id: string, type: string, status: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return { id, workspaceId: "ws_alpha", capsuleId: CAPSULE_ID, type, status, createdBy: "portable-e2e", createdAt, ...extra };
}

/** A control-plane app view; tests override the state they exercise. */
function appView(capsuleId: string, name: string, patch: Record<string, unknown> = {}) {
  return {
    kind: "takosumi.capsule-app@v1", capsuleId, workspaceId: "ws_alpha", projectId: "prj_alpha", name,
    environment: "production", status: "active", applied: true, state: "installed", primaryAction: "open",
    problems: [], screens: [], links: { uses: [], usedBy: [] }, version: { updateAvailable: false, stale: false, autoUpdate: false },
    progress: { revisionPreparing: false }, uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } },
    observedAt: "2026-10-28T00:00:00.000Z", ...patch,
  };
}

/** One page of an app's Runs, newest first, as the server lists them. */
function runPage(runs: readonly { readonly createdAt: string }[]) {
  return { runs: [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
}

export function registerAppPageCases(mode: DashboardE2EMode) {
  test.describe("Installed app page", () => {
    test.skip(mode !== "portable", "deterministic app page fixture; not production evidence");

    test("a reopened app links its owner to the accepted uninstall Run", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const now = "2026-11-21T00:00:00.000Z";
      const plan = lifecycleRun("run_saved_removal_review", "destroy_plan", "succeeded", now);
      const apply = lifecycleRun("run_accepted_removal", "destroy_apply", "running", now, { planRunId: plan.id });
      let scene: "no-run" | "review" | "member" | "owner" = "no-run";
      let runReads = 0;
      const mutations: string[] = [];
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
        if (path === "/api/v1/apps") {
          return route.fulfill({ json: { apps: PORTABLE_APPS.map((app) => app.capsuleId === CAPSULE_ID
            ? { ...app, role: scene === "member" ? "member" : "owner" }
            : app) } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/app`) {
          const progress = scene === "review" ? { review: { runId: plan.id, runType: plan.type } }
            : scene === "no-run" ? {} : { run: apply };
          return route.fulfill({ json: { app: appView(CAPSULE_ID, "Repository Office", {
            state: "uninstalling", primaryAction: scene === "review" ? "review" : "none",
            progress: { revisionPreparing: false, ...progress },
          }) } });
        }
        if (path === `/api/v1/runs/${apply.id}`) {
          runReads += 1;
          return route.fulfill({ json: { run: apply } });
        }
        if (path === `/api/v1/runs/${apply.id}/stream`) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (path === `/api/v1/runs/${apply.id}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (path === `/api/v1/runs/${apply.id}/cost`) return route.fulfill({ json: { cost: {
          runId: apply.id, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [],
        } } });
        return route.fallback();
      });
      await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      const actions = page.getByTestId("app-primary");
      const progressLink = actions.getByRole("link", { name: "View uninstall progress", exact: true });
      for (const state of ["no-run", "review", "member", "owner"] as const) {
        scene = state;
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(appOverviewRow(page, "sharing")).toBeVisible();
        await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-state", "uninstalling");
        if (state === "owner") {
          await expect(progressLink).toHaveAttribute("href", `/runs/${apply.id}`);
        } else {
          await expect(progressLink).toHaveCount(0);
        }
        expect(runReads).toBe(0);
      }
      await progressLink.click();
      await expect(page).toHaveURL(new RegExp(`/runs/${apply.id}$`, "u"));
      await expect.poll(() => runReads).toBeGreaterThan(0);
      expect(mutations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("a member can choose only marked owner connection labels in app settings", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const requests: string[] = [];
      const configurationBodies: unknown[] = [];
      const capsuleId = "cap_beta_office";
      const configId = `cfg_${capsuleId}`;
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/v1/connections") requests.push(`${request.method()} ${url.pathname}${url.search}`);
      });
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path === "/api/v1/apps") {
          return route.fulfill({ json: { apps: [{
            capsuleId, name: "Beta Office", displayName: "Beta Office", role: "member",
            ownerDisplayName: "Hanako Sato", state: "installed", primaryAction: "open",
          }] } });
        }
        if (path === "/api/v1/connections" && url.searchParams.get("projection") === "labels") {
          return route.fulfill({ json: portableAppConnectionLabels(capsuleId) });
        }
        if (path === `/api/v1/capsules/${capsuleId}/members`) {
          return route.fulfill({ json: PORTABLE_SHARED_APP_MEMBERS });
        }
        if (path === `/api/v1/capsules/${capsuleId}`) {
          return route.fulfill({ json: { capsule: {
            id: capsuleId, workspaceId: "ws_beta", name: "Beta Office", slug: "beta-office",
            sourceId: `src_${capsuleId}`, installConfigId: configId, environment: "production",
            currentStateVersionId: "sv_member", currentStateGeneration: 1, status: "active",
            freshness: "fresh", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          }, installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
        }
        if (path === `/api/v1/capsules/${capsuleId}/app`) {
          return route.fulfill({ json: { app: appView(capsuleId, "Beta Office", {
            version: { updateAvailable: false, stale: false, autoUpdate: false },
            uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } },
          }) } });
        }
        if (path === `/api/v1/capsules/${capsuleId}/provider-bindings`) {
          return route.fulfill({ json: { providerBindingSet: {
            id: "pbs_member_e2e", workspaceId: "ws_beta", capsuleId, environment: "production",
            bindings: [
              { provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "pc_hanako_cloudflare" },
              { provider: "registry.opentofu.org/hashicorp/aws", moduleLocalName: "aws", connectionId: "pc_hanako_aws" },
            ],
            createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          } } });
        }
        if (path === `/api/v1/capsule-configs/${configId}`) {
          return route.fulfill({ json: { installConfig: {
            id: configId, workspaceId: "ws_beta", name: "Beta Office",
            sourceSelector: { kind: "git", url: "https://github.com/example/beta-office.git", ref: "main", path: "." },
            policy: {}, variableMapping: {}, outputAllowlist: {}, interfaceBlueprints: [],
            createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          } } });
        }
        if (path === `/api/v1/capsules/${capsuleId}/state-versions`) return route.fulfill({ json: { stateVersions: [] } });
        if (path === `/api/v1/capsules/${capsuleId}/runs`) return route.fulfill({ json: { runs: [] } });
        if (path === `/api/v1/capsules/${capsuleId}/current-resource-inventory`) return route.fulfill({ json: { inventory: null } });
        if (path === `/api/v1/capsules/${capsuleId}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
        if (path === `/api/v1/capsules/${capsuleId}/configuration-plans` && request.method() === "POST") {
          configurationBodies.push(request.postDataJSON());
          return route.fulfill({ status: 201, json: {
            capsule: { id: capsuleId, workspaceId: "ws_beta", name: "Beta Office", installConfigId: configId },
            configurationPlan: { replayed: false, previousInstallConfigId: configId, targetInstallConfigId: `${configId}_next`, sourceSnapshotId: "snap_member", planRunId: "run_member_configuration_plan" },
            links: { run: "/api/v1/runs/run_member_configuration_plan" },
          } });
        }
        if (path === "/api/v1/runs/run_member_configuration_plan") return route.fulfill({ json: { run: { id: "run_member_configuration_plan", type: "plan", status: "succeeded", capsuleId, summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass", planResources: [] } } });
        if (path === "/api/v1/runs/run_member_configuration_plan/cost") return route.fulfill({ json: { cost: { runId: "run_member_configuration_plan", billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
        if (path === "/api/v1/runs/run_member_configuration_plan/logs") return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        return route.fallback();
      });

      await page.goto(`/apps/${capsuleId}`, { waitUntil: "domcontentloaded" });
      await openAppPane(page, "connections");
      const settings = page.getByTestId("app-settings");
      await expect(settings.getByTestId("app-connection-row").nth(0).locator("select")).toHaveValue("pc_hanako_cloudflare");
      await expect(settings.locator('option[value="pc_hanako_cloudflare"]')).toHaveCount(1);
      await expect(settings.getByRole("button", { name: /Connect|Add connection/u })).toHaveCount(0);
      await expect.poll(() => requests.length).toBeGreaterThan(0);
      expect(requests).toEqual([`GET /api/v1/connections?capsuleId=${capsuleId}&projection=labels`]);
      const cloudflare = settings.getByTestId("app-connection-row").nth(0).locator("select");
      await cloudflare.selectOption("pc_hanako_cloudflare_alt");
      await settings.getByRole("button", { name: "Review", exact: true }).click();
      await expect.poll(() => configurationBodies.length).toBe(1);
      expect(configurationBodies[0]).toEqual({
        variablePatch: { set: {}, remove: [] },
        providerBindings: [
          { provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "pc_hanako_cloudflare_alt" },
          { provider: "registry.opentofu.org/hashicorp/aws", moduleLocalName: "aws", connectionId: "pc_hanako_aws" },
        ],
        interfaceBlueprints: [],
        expected: { authorityGuard: AUTHORITY_GUARD },
      });
    });

    test("target user inputs recover a failed update and stop at explicit Plan review", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      // Captured provider-free actual Core public responses; no live provider.
      const core = reAdoptionCoreSeam;
      const context = core.contextBody.installConfigReAdoptionContext;
      const id = context.capsuleId, sourceId = context.sourceId;
      const base = `/api/v1/capsules/${id}`;
      const adoptedConfig = core.currentBody.capsule.installConfigId;
      let failed = false, adopted = false, contextReads = 0;
      const writes: Array<{ path: string; key: string | undefined; body: unknown }> = [];
      const capsule = () => ({ ...core.currentBody.capsule,
        installConfigId: adopted ? adoptedConfig : context.currentInstallConfigId,
      });
      const failedRun = core.failedRunBody.run;
      const targetPlan = { ...lifecycleRun(core.targetRevisionResponse.revisionPlan.planRunId, "plan", "succeeded", "2026-10-03T00:00:00.000Z", { capsuleId: id }),
        summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: "fixture_resource.entry", type: "fixture_resource", actions: ["update"] }],
      };
      const revision = (ready: boolean) => ready ? core.targetRevisionResponse : core.failedRevisionResponse;
      await page.route("**/api/v1/**", async route => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (request.method() !== "GET") writes.push({ path, key: request.headers()["idempotency-key"], body: request.postDataJSON() });
        if (path === "/api/v1/apps") return route.fulfill({ json: { apps: [{ capsuleId: id, name: "Input recovery fixture", role: "owner", state: "installed", primaryAction: "retry", screens: [] }] } });
        if (path === base) return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: { authorityGuard: context.authorityGuard } } });
        if (path === `${base}/app`) return route.fulfill({ json: failed
          ? adopted ? core.appAfterAdoption : core.appBefore
          : { app: { ...core.appBefore.app, state: "installed", primaryAction: "none", problems: [], latestRun: undefined } },
        });
        if (path === `${base}/install-config-re-adoption-context`) {
          expect(url.searchParams.get("revisionPlanId")).toBe(context.revisionPlanId);
          contextReads++;
          return route.fulfill({ json: { installConfigReAdoptionContext: context } });
        }
        if (path === `${base}/install-config-re-adoptions`) {
          adopted = true;
          return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: {
            replayed: false, targetInstallConfigId: adoptedConfig, sourceSnapshotId: context.sourceSnapshotId,
          } } });
        }
        if (path === `${base}/revision-plans`) {
          failed = true;
          return route.fulfill({ status: 201, json: revision(adopted) });
        }
        if (path === `${base}/runs`) return route.fulfill({ json: { runs: failed ? [failedRun] : [] } });
        if (path === `${base}/state-versions`) return route.fulfill({ json: { stateVersions: [] } });
        if (path === `${base}/current-resource-inventory`) return route.fulfill({ json: { inventory: null } });
        if (path === `${base}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId: id, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
        if (path === `${base}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: { id: "pbs_inputs", capsuleId: id, workspaceId: "ws_alpha", environment: "production", bindings: [] } } });
        if (path === `/api/v1/capsule-configs/${capsule().installConfigId}`) return route.fulfill({ json: { installConfig: {
          id: capsule().installConfigId, name: "Input recovery fixture", workspaceId: "ws_alpha", policy: {}, variableMapping: {}, outputAllowlist: {}, interfaceBlueprints: [],
          createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
        } } });
        for (const run of [failedRun, targetPlan]) {
          if (path === `/api/v1/runs/${run.id}`) return route.fulfill({ json: { run } });
          if (path === `/api/v1/runs/${run.id}/cost`) return route.fulfill({ json: { cost: { runId: run.id, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
          if (path === `/api/v1/runs/${run.id}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (path === `/api/v1/runs/${run.id}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
        }
        return route.fallback();
      });
      await page.goto(`/apps/${id}`, { waitUntil: "domcontentloaded" });
      await openAppPane(page, "version");
      const version = page.getByTestId("app-version");
      await version.locator(".ap-version-form input").fill(context.targetRef);
      await version.locator(".ap-version-form button[type=submit]").click();
      const form = page.getByTestId("app-target-inputs");
      await expect(form.getByRole("button", { name: "Read target inputs", exact: true })).toBeVisible();
      expect(contextReads).toBe(0);
      // Fresh reload loses local catch state; the separate failed-Plan hint remains.
      await page.reload({ waitUntil: "domcontentloaded" });
      await form.getByRole("button", { name: "Read target inputs", exact: true }).click();
      await expect(form.getByRole("combobox", { name: "How to use Release note", exact: true })).toHaveValue("unresolved");
      await form.getByRole("button", { name: "Adopt settings and review changes", exact: true }).click();
      expect(writes).toHaveLength(1);
      await form.getByRole("combobox", { name: "How to use Release note", exact: true }).selectOption("set");
      await form.getByRole("textbox", { name: "Release note", exact: true }).fill(core.adoptionRequest.reviewedUserVariables.release_note);
      await form.getByRole("combobox", { name: "How to use Clear optional", exact: true }).selectOption("unset");
      await form.getByRole("button", { name: "Adopt settings and review changes", exact: true }).click();
      await expect(page.getByTestId("app-review").getByRole("button", { name: "Allow and update", exact: true })).toBeEnabled();
      expect(contextReads).toBe(1);
      expect(writes.map(write => write.path)).toEqual([`${base}/revision-plans`, `${base}/install-config-re-adoptions`, `${base}/revision-plans`]);
      expect(writes[1]!.body).toEqual({ baseInstallConfigId: context.baseInstallConfigId, sourceSnapshotId: context.sourceSnapshotId,
        reason: "Review declared target user inputs", expected: { authorityGuard: context.authorityGuard },
        reviewedUserVariables: core.adoptionRequest.reviewedUserVariables });
      expect(writes[2]!.body).toEqual({ ref: context.targetRef });
      expect(writes[1]!.key).toBeTruthy();
      expect(writes[2]!.key).not.toBe(writes[1]!.key);
      expect(writes.some(write => /\/(apply|approve)$/u.test(write.path))).toBe(false);
      expect(errors).toEqual([]);
    });

    test("keeps an installed app: open, update, settings, what it created and history in place", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      await page.clock.install();
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      let multipleSurfaces = false;
      let stale = false;
      let updateApplied = false;
      let autoUpdate = false;
      let failedLatest = false;
      let configReadUnavailable = true;
      let bindingsReadUnavailable = false;
      let changedConfiguration = false;
      const latestConfigId = `${INSTALL_CONFIG_ID}_external`;
      const latestGuard = `sha256:${"b".repeat(64)}`;
      const bindingsPath = `/api/v1/capsules/${CAPSULE_ID}/provider-bindings`;
      const configPath = (id: string) => `/api/v1/capsule-configs/${id}`;
      const revisionPlanBodies: unknown[] = [];
      const configurationPlanBodies: unknown[] = [];
      const seenMutations: string[] = [];
      const historyQueries: string[] = [];
      const detailReads: string[] = [];
      page.on("request", (request) => {
        if (request.method() !== "GET") return;
        const path = new URL(request.url()).pathname;
        const prefix = `/api/v1/capsules/${CAPSULE_ID}/`;
        if (path === configPath(INSTALL_CONFIG_ID)) detailReads.push("capsule-config");
        if (path.startsWith(prefix) && /^(runs|state-versions|current-resource-inventory|usage-summary|provider-bindings|members)$/u.test(path.slice(prefix.length))) {
          detailReads.push(path.slice(prefix.length));
        }
      });
      const adopted = () => updateApplied
        ? { sourceSnapshotId: "snap_main_new", ref: "main", path: ".", resolvedCommit: NEW_COMMIT }
        : { sourceSnapshotId: "snap_main_1", ref: "main", path: ".", resolvedCommit: PORTABLE_SOURCE_COMMIT };
      const capsule = () => ({
        id: CAPSULE_ID, workspaceId: "ws_alpha", name: PORTABLE_EXPECTATIONS.appName,
        slug: "repository-office", sourceId: SOURCE_ID,
        installConfigId: changedConfiguration ? latestConfigId : INSTALL_CONFIG_ID,
        environment: "production",
        currentStateVersionId: updateApplied ? "sv_3" : "sv_2",
        currentStateGeneration: updateApplied ? 3 : 2,
        status: "active", freshness: stale && !updateApplied ? "stale" : "fresh",
        autoUpdate, adoptedSourceRevision: adopted(),
        createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z",
      });
      const stateVersions = () => [
        { id: "sv_1", workspaceId: "ws_alpha", capsuleId: CAPSULE_ID, environment: "production", generation: 1, createdByRunId: "run_install_apply", createdAt: "2026-10-01T00:05:00.000Z" },
        { id: "sv_2", workspaceId: "ws_alpha", capsuleId: CAPSULE_ID, environment: "production", generation: 2, createdByRunId: "run_settings_apply", createdAt: "2026-10-10T00:05:00.000Z" },
        ...(updateApplied ? [{ id: "sv_3", workspaceId: "ws_alpha", capsuleId: CAPSULE_ID, environment: "production", generation: 3, createdByRunId: UPDATE_APPLY, createdAt: new Date().toISOString() }] : []),
      ];
      const runs = () => [
        lifecycleRun("run_install_apply", "apply", "succeeded", "2026-10-01T00:04:00.000Z", { sourceSnapshotId: "snap_main_1" }),
        lifecycleRun("run_settings_apply", "apply", "succeeded", "2026-10-10T00:04:00.000Z", { sourceSnapshotId: "snap_main_1" }),
        ...(updateApplied ? [lifecycleRun(UPDATE_APPLY, "apply", "succeeded", new Date().toISOString(), { planRunId: UPDATE_PLAN, sourceSnapshotId: "snap_main_new" })] : []),
        ...(failedLatest ? [failedApply] : []),
      ];
      // A settings change whose apply failed: its plan records that origin.
      const failedApply = lifecycleRun("run_failed_apply", "apply", "failed", "2099-01-01T00:00:00.000Z", { errorCode: "apply_failed", planRunId: "run_failed_settings_plan" });
      const failedSettingsPlan = lifecycleRun("run_failed_settings_plan", "plan", "succeeded", "2098-12-31T23:59:00.000Z", { policyStatus: "pass", origin: { kind: "configuration" } });
      const updatePlan = {
        ...lifecycleRun(UPDATE_PLAN, "plan", "succeeded", "2026-10-20T00:00:00.000Z", { sourceSnapshotId: "snap_main_new" }),
        summary: { add: 1, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [
          { address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] },
          { address: "cloudflare_r2_bucket.files", type: "cloudflare_r2_bucket", actions: ["create"] },
        ],
      };
      const updateApply = { ...lifecycleRun(UPDATE_APPLY, "apply", "succeeded", "2026-10-20T00:01:00.000Z", { planRunId: UPDATE_PLAN }) };
      const configPlan = {
        ...lifecycleRun(CONFIG_PLAN, "plan", "succeeded", "2026-10-20T00:02:00.000Z"),
        summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] }],
      };
      const notApplicableCost = (runId: string) => ({ cost: { runId, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } });

      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (shouldRecordControlPlaneMutation(mode, origin, request.url(), request.method())) {
          seenMutations.push(`${request.method()} ${path}`);
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}`) {
          if (request.method() === "PATCH") autoUpdate = (request.postDataJSON() as { autoUpdate: boolean }).autoUpdate;
          return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: {
            authorityGuard: changedConfiguration ? latestGuard : AUTHORITY_GUARD,
          } } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/app`) {
          const screen = (id: string, title: string, url: string) => ({ interfaceId: `if_${id}`, name: `app.${id}`, title, url });
          return route.fulfill({ json: { app: appView(CAPSULE_ID, "internal-office-deployment", {
            displayName: { ja: PORTABLE_EXPECTATIONS.appName, en: PORTABLE_EXPECTATIONS.appName },
            screens: multipleSurfaces
              // The server returns every screen in its declared order.
              ? [screen("control", "Control panel", "https://apps.example.test/control"), screen("documentation", "Documentation", "https://apps.example.test/documentation")]
              : [screen("launcher", PORTABLE_EXPECTATIONS.appName, PORTABLE_EXPECTATIONS.appUrl)],
            version: {
              repository: { url: "https://github.com/example/repository-office.git", defaultRef: "main" },
              current: { sourceSnapshotId: adopted().sourceSnapshotId, ref: "main", path: ".", commit: adopted().resolvedCommit },
              ...(stale && !updateApplied ? { latest: { sourceSnapshotId: "snap_main_new", ref: "main", commit: NEW_COMMIT, fetchedAt: "2026-10-19T00:00:00.000Z" } } : {}),
              updateAvailable: stale && !updateApplied, stale: stale && !updateApplied, autoUpdate,
            },
            ...(failedLatest
              ? {
                  state: "needs_attention", primaryAction: "retry",
                  problems: [{ code: "run_failed", severity: "error", runId: "run_failed_apply", runType: "apply", errorCode: "apply_failed" }],
                }
              : {}),
          }) } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/runs`) {
          historyQueries.push(url.search);
          return route.fulfill({ json: runPage(runs()) });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/state-versions`) return route.fulfill({ json: { stateVersions: stateVersions() } });
        if (path === `/api/v1/capsules/${CAPSULE_ID}/current-resource-inventory`) {
          return route.fulfill({ json: { inventory: {
            kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: CAPSULE_ID, workspaceId: "ws_alpha",
            environment: "production", stateVersionId: "sv_2", generation: 2, applyRunId: "run_settings_apply",
            planRunId: "run_settings_plan", recordedAt: "2026-10-10T00:05:00.000Z", availability: "recorded",
            resources: [
              { address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", providerSource: CLOUDFLARE },
              { address: "cloudflare_d1_database.data", type: "cloudflare_d1_database", providerSource: CLOUDFLARE },
              { address: "cloudflare_d1_database.cache", type: "cloudflare_d1_database", providerSource: CLOUDFLARE },
            ],
          } } });
        }
        if (path === configPath(INSTALL_CONFIG_ID) || path === configPath(latestConfigId)) {
          if (configReadUnavailable) return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
          const external = path === configPath(latestConfigId);
          return route.fulfill({ json: { installConfig: {
            id: external ? latestConfigId : INSTALL_CONFIG_ID, workspaceId: "ws_alpha", name: PORTABLE_EXPECTATIONS.appName,
            sourceSelector: { kind: "git", url: "https://github.com/example/repository-office.git", ref: "main", path: "." },
            policy: {}, variableMapping: { region: external ? "server-latest" : "initial", multiplier: 1 },
            variablePresentation: [
              { name: "region", type: "string", required: true, label: { ja: "リージョン", en: "Region" } },
              { name: "multiplier", type: "number", required: true, label: { ja: "倍率", en: "Multiplier" } },
            ],
            outputAllowlist: {}, interfaceBlueprints: [],
            createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          } } });
        }
        if (path === bindingsPath) {
          if (bindingsReadUnavailable) return route.fulfill({ status: 503, json: { error: { code: "unavailable" } } });
          return route.fulfill({ json: { providerBindingSet: {
            id: "pbs_app_page_e2e", workspaceId: "ws_alpha", capsuleId: CAPSULE_ID, environment: "production",
            bindings: [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "pc_cloudflare_direct" }],
            createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          } } });
        }
        if (path === "/api/v1/connections") return route.fulfill({ json: { connections: PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS } });
        if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS } });
        if (path === `/api/v1/capsules/${CAPSULE_ID}/usage-summary`) {
          return route.fulfill({ json: { summary: { capsuleId: CAPSULE_ID, usdMicros: 1_230_000, eventCount: 5, ratedEventCount: 5, unratedEventCount: 0 } } });
        }
        if (path === "/api/v1/sources" && request.method() === "GET") {
          return route.fulfill({ json: { sources: [{
            id: SOURCE_ID, workspaceId: "ws_alpha", name: PORTABLE_EXPECTATIONS.appName,
            url: "https://github.com/example/repository-office.git", defaultRef: "main", defaultPath: ".",
            status: "active", autoSync: true, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          }] } });
        }
        if (path === `/api/v1/sources/${SOURCE_ID}/snapshots`) {
          return route.fulfill({ json: { snapshots: [
            snapshot("snap_main_1", PORTABLE_SOURCE_COMMIT, "2026-10-01T00:00:00.000Z"),
            ...(stale || updateApplied ? [snapshot("snap_main_new", NEW_COMMIT, "2026-10-19T00:00:00.000Z")] : []),
          ] } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/revision-plans` && request.method() === "POST") {
          revisionPlanBodies.push(request.postDataJSON());
          return route.fulfill({ status: 201, json: {
            revisionPlan: { id: "grp_update_e2e", operation: "revision", phase: "review_ready", generation: 1, capsuleId: CAPSULE_ID, planRunId: UPDATE_PLAN },
            nextAction: "review_run",
            links: { self: "/api/v1/revision-plans/grp_update_e2e", run: `/api/v1/runs/${UPDATE_PLAN}` },
          } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/configuration-plans` && request.method() === "POST") {
          configurationPlanBodies.push(request.postDataJSON());
          return route.fulfill({ status: 201, json: {
            capsule: capsule(),
            configurationPlan: { replayed: false, previousInstallConfigId: capsule().installConfigId, targetInstallConfigId: "cfg_configuration_e2e", sourceSnapshotId: "snap_main_1", planRunId: CONFIG_PLAN },
            links: { run: `/api/v1/runs/${CONFIG_PLAN}` },
          } });
        }
        if (path === `/api/v1/runs/${UPDATE_PLAN}/apply` && request.method() === "POST") {
          updateApplied = true;
          return route.fulfill({ status: 201, json: { run: updateApply } });
        }
        for (const run of [updatePlan, updateApply, configPlan, failedApply, failedSettingsPlan]) {
          if (path === `/api/v1/runs/${run.id}`) return route.fulfill({ json: { run } });
          if (path === `/api/v1/runs/${run.id}/cost`) return route.fulfill({ json: notApplicableCost(run.id) });
          if (path === `/api/v1/runs/${run.id}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (path === `/api/v1/runs/${run.id}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      // An old app URL lands on the canonical page.
      await page.goto(`/workloads/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}$`, "u"));
      const app = page.getByTestId("app-page");
      const header = page.getByTestId("app-header");
      await expect(header.getByRole("heading", { level: 1 })).toHaveText(PORTABLE_EXPECTATIONS.appName);
      await expect(page.getByTestId("app-state-sentence")).toHaveCount(0);
      await expect(app).toHaveAttribute("data-app-state", "installed");
      const open = header.getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(open).toHaveAttribute("target", "_blank");
      await expect(open).toHaveAttribute("rel", "noreferrer noopener");
      await expect(app.getByTestId("app-problems")).toHaveCount(0);
      await expect(appOverviewRow(page, "history")).toBeVisible();
      await expect(app.getByTestId("app-version")).toHaveCount(0);
      await expect(app.getByTestId("app-history")).toHaveCount(0);
      // The ready overview does not prefetch the separate management panes.
      await capture(page, "app-page-healthy");
      expect(detailReads).toEqual([]);

      await openAppPane(page, "danger");
      await expect(app.getByTestId("app-uninstall")).toContainText("Its data stays for 7 days");
      await expect(app.getByTestId("app-uninstall")).not.toContainText("Team Wiki");
      await showAppOverview(page);
      await expect(appOverviewRow(page, "danger")).toBeFocused();

      await openAppPane(page, "links");
      await expect(app.getByTestId("app-linked")).toContainText("No apps are linked.");
      await showAppOverview(page);

      await openAppPane(page, "created");
      // What it created: per cloud, readable names and counts, never raw addresses.
      const created = app.getByTestId("app-created");
      await expect(created.locator('[data-provider="cloudflare"]')).toContainText("Cloudflare");
      await expect(created).toContainText("Workers Script");
      await expect(created).toContainText("D1 Database");
      await expect(created).toContainText("×2");
      await expect(created).toContainText("Through Cloudflare (direct)");
      await expect(created).not.toContainText("cloudflare_workers_script");
      await expect(created).not.toContainText("run_settings");
      await expect(app.getByTestId("app-cost")).toContainText("$1.23");
      expect(detailReads).toContain("current-resource-inventory");
      expect(detailReads).not.toContain("runs");
      await showAppOverview(page);
      await openAppPane(page, "connections");
      const settings = app.getByTestId("app-settings");
      const reviewSettings = settings.getByRole("button", { name: "Review", exact: true });
      const retryReads = settings.getByRole("button", { name: "Retry", exact: true });
      const configReadError = settings.locator('[data-settings-read-error="config"]');
      // Connections cannot review against settings it could not read.
      await expect(configReadError).toBeVisible();
      await expect(reviewSettings).toBeDisabled();
      configReadUnavailable = false;
      await retryReads.click();
      await expect(configReadError).toHaveCount(0);
      // One connection row per provider; no alias inputs or screen JSON editor.
      const connectionRow = app.getByTestId("app-connection-row");
      const connection = connectionRow.locator("select");
      await expect(connectionRow).toHaveCount(1);
      await expect(connectionRow).toContainText("Cloudflare");
      await expect(connection).toHaveValue("pc_cloudflare_direct");
      await showAppOverview(page);
      await openAppPane(page, "settings");
      await expect(app.getByTestId("app-settings").getByRole("textbox", { name: /^Region/u })).toHaveValue("initial");
      await expect(app.getByTestId("app-settings").locator("textarea")).toHaveCount(0);
      await showAppOverview(page);

      // History is the app's own lifecycle Runs; each event opens its run.
      await openAppPane(page, "history");
      await expect.poll(() => historyQueries.length).toBeGreaterThan(0);
      expect(new URLSearchParams(historyQueries[0]).getAll("type").sort()).toEqual(["apply", "destroy_apply", "destroy_plan", "plan", "state_recovery"]);
      const history = app.getByTestId("app-history-list");
      await expect(history.locator("li").first()).toContainText("Changed settings");
      await expect(history.locator("li").last()).toContainText("Installed");
      await expect(history.locator("li").last()).toContainText("main · 0123456");
      await expect(history.locator("li").first().getByRole("link", { name: /Details/u })).toHaveAttribute("href", "/runs/run_settings_apply");
      await app.getByTestId("app-history").screenshot({ path: test.info().outputPath("app-history-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await app.getByTestId("app-history").screenshot({ path: test.info().outputPath("app-history-mobile.png") });
      await page.setViewportSize({ width: 1440, height: 900 });

      await showAppOverview(page);
      await openAppPane(page, "version");
      await expect(app.getByTestId("app-current-version")).toHaveText("main · 0123456");
      await showAppOverview(page);
      await expect(app.getByTestId("app-version")).not.toBeVisible();

      // Several screens: the declared primary opens from the button, every
      // other screen from its menu.
      multipleSurfaces = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      const primary = header.getByRole("link", { name: /^Open\b.*Control panel/u });
      await expect(primary).toHaveAttribute("href", "https://apps.example.test/control");
      await header.getByRole("button", { name: "Other screens" }).click();
      await expect(header.getByRole("menuitem", { name: "Documentation" })).toHaveAttribute("href", "https://apps.example.test/documentation");
      await page.keyboard.press("Escape");
      await expect(header.getByRole("menuitem")).toHaveCount(0);
      for (const width of [320, 375, 414, 768]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(primary).toBeVisible();
        await expectNoHorizontalOverflow(page, `app page with several screens at ${width}px`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      multipleSurfaces = false;

      // Automatic updates are a plain switch.
      await openAppPane(page, "version");
      const [autoUpdateResponse] = await Promise.all([
        page.waitForResponse((response) =>
          response.url() === `${origin}/api/v1/capsules/${CAPSULE_ID}` &&
          response.request().method() === "PATCH",
        ),
        app.getByRole("checkbox", { name: "Update automatically when a newer version is found" }).check(),
      ]);
      expect(autoUpdateResponse.status()).toBe(200);
      expect(await autoUpdateResponse.finished()).toBeNull();
      await expect.poll(() => autoUpdate).toBe(true);

      // A newer version: reviewed in place, applied only by Allow and update.
      stale = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-section", "version");
      const versionSection = app.getByTestId("app-version");
      await expect(versionSection.getByTestId("app-update")).toContainText("A newer version is available");
      await expect(versionSection.getByTestId("app-new-version")).toHaveText("main · fedcba9");
      await showAppOverview(page);
      await openAppPane(page, "connections");
      await connection.selectOption("pc_takosumi_cloud");
      await showAppOverview(page);
      await openAppPane(page, "version");
      await expect(connection).not.toBeVisible();
      await versionSection.getByRole("button", { name: "Update", exact: true }).click();
      await expect.poll(() => revisionPlanBodies).toEqual([{ ref: "main" }]);
      const review = versionSection.getByTestId("app-review");
      await expect(review.getByRole("heading", { name: "What the update changes" })).toBeVisible();
      await expect(review.getByTestId("install-plan-resources")).toContainText("Cloudflare R2 Bucket");
      await expect(review.getByTestId("install-plan-cost")).toContainText("No estimate. Cloud usage charges may apply.");
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#version$`, "u"));
      await capture(page, "app-update-review");
      // A clean Plan waits for consent: no Apply across Run poll intervals.
      const mutationsBeforeApprovalWindow = [...seenMutations];
      await page.clock.runFor(3_500);
      expect(seenMutations).toEqual(mutationsBeforeApprovalWindow);
      expect(seenMutations.filter((entry) => entry.endsWith("/apply"))).toEqual([]);
      await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toBeEnabled();
      // Completing the update refetches bindings while its unchanged settings draft is hidden.
      const rereadBindings = page.waitForResponse((response) =>
        new URL(response.url()).pathname === bindingsPath && response.ok());
      await review.getByRole("button", { name: "Allow and update", exact: true }).click();
      await rereadBindings;
      await expect(versionSection.getByRole("status").filter({ hasText: "Updated." })).toBeVisible({ timeout: 15_000 });
      await expect(versionSection.getByTestId("app-review")).toHaveCount(0);
      await expect(app.getByTestId("app-current-version")).toHaveText("main · fedcba9");
      await showAppOverview(page);
      await openAppPane(page, "connections");
      await expect(connection).toBeEnabled();
      await expect(connection).toHaveValue("pc_takosumi_cloud");
      await expect(reviewSettings).toBeEnabled();

      // A later context read returns a different saved config and authority receipt.
      await showAppOverview(page);
      await openAppPane(page, "version");
      changedConfiguration = true;
      const readLatest = page.waitForResponse((response) =>
        new URL(response.url()).pathname === configPath(latestConfigId) && response.ok());
      await versionSection.getByRole("checkbox", { name: "Update automatically when a newer version is found" }).uncheck();
      await readLatest;
      await showAppOverview(page);
      await openAppPane(page, "connections");
      const conflict = settings.getByTestId("app-settings-draft-conflict");
      await expect(conflict.getByRole("alert")).toBeVisible();
      await expect(connection).toHaveValue("pc_takosumi_cloud");
      await expect(reviewSettings).toBeDisabled();
      expect(configurationPlanBodies).toEqual([]);
      await conflict.getByRole("button", { name: "Discard edits and reload", exact: true }).click();
      await expect(conflict).toHaveCount(0);
      await expect(connection).toHaveValue("pc_cloudflare_direct");

      await showAppOverview(page);
      await openAppPane(page, "history");
      await expect(history.locator("li").first()).toContainText("Updated");
      await expect(history.locator("li").first()).toContainText("main · fedcba9");
      await expect(page.getByTestId("app-state-sentence")).toHaveCount(0);

      // Settings: values and connections, reviewed in place.
      await showAppOverview(page);
      await openAppPane(page, "settings");
      const region = settings.getByRole("textbox", { name: /^Region/u });
      await expect(region).toHaveValue("server-latest");
      await region.fill("edited");

      // Same-app pane navigation, including browser history, keeps the draft.
      await showAppOverview(page);
      await openAppPane(page, "connections");
      await page.goBack();
      await expect(app).toHaveAttribute("data-app-section", "overview");
      await page.goBack();
      await expect(app).toHaveAttribute("data-app-section", "settings");
      await expect(region).toHaveValue("edited");
      await page.goForward();
      await expect(app).toHaveAttribute("data-app-section", "overview");
      await page.goForward();
      await expect(app).toHaveAttribute("data-app-section", "connections");
      await showAppOverview(page);
      await openAppPane(page, "settings");
      await expect(region).toHaveValue("edited");
      const discardDialog = page.getByRole("dialog");
      await expect(discardDialog).toHaveCount(0);
      expect(configurationPlanBodies).toEqual([]);

      // Leaving the app still asks before losing the draft.
      await page.locator(".sidebar").getByRole("link", { name: "Home", exact: true }).click();
      await expect(discardDialog).toContainText("Discard your changes?");
      await discardDialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#settings$`, "u"));
      await expect(region).toHaveValue("edited");

      // A valid fractional input still goes into the one Plan from Connections.
      const multiplier = settings.getByRole("spinbutton", { name: /^Multiplier/u });
      await multiplier.fill("0.5");
      expect(await multiplier.evaluate((input) => (input as HTMLInputElement).validity.valid)).toBe(true);
      await showAppOverview(page);
      await openAppPane(page, "connections");
      await expect(region).not.toBeVisible();
      await reviewSettings.click();
      await expect.poll(() => configurationPlanBodies.length).toBe(1);
      expect(configurationPlanBodies).toEqual([{
        variablePatch: { set: { region: "edited", multiplier: 0.5 }, remove: [] },
        providerBindings: [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "pc_cloudflare_direct" }],
        interfaceBlueprints: [],
        expected: { authorityGuard: latestGuard },
      }]);
      const settingsReview = settings.getByTestId("app-review");
      await expect(settingsReview.getByRole("heading", { name: "What this changes" })).toBeVisible();
      await expect(settingsReview.getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#connections$`, "u"));
      await settings.scrollIntoViewIfNeeded();
      await capture(page, "app-settings-review");
      await settingsReview.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(settings.getByTestId("app-review")).toHaveCount(0);
      // Cancelled, so the form shows what the app runs, not the unapplied edit.
      await showAppOverview(page);
      await openAppPane(page, "settings");
      await expect(region).toHaveValue("server-latest");
      await expect(multiplier).toHaveValue("1");
      await expect(reviewSettings).toBeDisabled();

      // Settings cannot review while its hidden Connections read has failed.
      bindingsReadUnavailable = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      const bindingsReadError = settings.locator('[data-settings-read-error="bindings"]');
      await expect(bindingsReadError).toBeVisible();
      await expect(reviewSettings).toBeDisabled();
      bindingsReadUnavailable = false;
      await retryReads.click();
      await expect(bindingsReadError).toHaveCount(0);
      await showAppOverview(page);
      await openAppPane(page, "connections");
      await expect(connection).toBeEnabled();
      await expect(connection).toHaveValue("pc_cloudflare_direct");

      // A problem appears on the app it belongs to; the server's one primary
      // action is the header's button, the card says what happened.
      await showAppOverview(page);
      failedLatest = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "needs_attention");
      const problem = app.getByTestId("app-problems").locator('[data-problem="run_failed"]');
      await expect(problem).toContainText("The last change couldn't be applied");
      await expect(header.getByRole("button", { name: "Review again", exact: true })).toBeVisible();
      await expect(problem.getByRole("button", { name: "Review again", exact: true })).toHaveCount(0);
      // The screen the server still lists stays openable beside the primary action.
      await expect(header.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(problem.getByRole("link", { name: "See reason and logs" })).toHaveAttribute("href", "/runs/run_failed_apply");
      await expect(page.getByTestId("app-state-sentence")).toContainText("Something needs your attention");
      await capture(page, "app-page-needs-attention");
      failedLatest = false;

      // Old tab links open their detail view at its canonical fragment.
      for (const [from, section, testId] of [
        [`/workloads/${CAPSULE_ID}/danger`, "danger", "app-uninstall"],
        [`/workloads/${CAPSULE_ID}/settings`, "settings", "app-settings"],
        [`/capsules/${CAPSULE_ID}/history`, "history", "app-history"],
      ] as const) {
        await page.goto(from, { waitUntil: "domcontentloaded" });
        await expect(page, from).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#${section}$`, "u"));
        await expect(app.getByTestId(testId)).toBeInViewport();
      }
      for (const from of [`/services/${CAPSULE_ID}`, `/apps/${CAPSULE_ID}/overview`, `/new?capsule=${CAPSULE_ID}`]) {
        await page.goto(from, { waitUntil: "domcontentloaded" });
        await expect(page, from).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}$`, "u"));
        await expect(header.getByRole("heading", { level: 1 })).toHaveText(PORTABLE_EXPECTATIONS.appName);
      }
      // The same fragment opens from the overview with the keyboard.
      const historyLink = appOverviewRow(page, "history");
      await historyLink.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#history$`, "u"));
      await expect(app.getByTestId("app-history")).toBeInViewport();
      await showAppOverview(page);
      await expect(historyLink).toBeFocused();

      expect(seenMutations).toEqual([
        `PATCH /api/v1/capsules/${CAPSULE_ID}`,
        `POST /api/v1/capsules/${CAPSULE_ID}/revision-plans`,
        `POST /api/v1/runs/${UPDATE_PLAN}/apply`,
        `PATCH /api/v1/capsules/${CAPSULE_ID}`,
        `POST /api/v1/capsules/${CAPSULE_ID}/configuration-plans`,
      ]);
      expect(errors).toEqual([]);
      expect(traffic.failures.map(({ kind, url, status }) => ({ kind, path: new URL(url).pathname, status }))).toEqual([
        { kind: "response", path: configPath(INSTALL_CONFIG_ID), status: 503 },
        { kind: "response", path: bindingsPath, status: 503 },
      ]);
    });

    test("an embedded Update recovers its accepted Apply after lost responses without another mutation", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const now = "2026-11-17T00:00:00.000Z";
      const planId = "plan_embedded_update";
      const applyId = "apply_embedded_update";
      const plan = {
        ...lifecycleRun(planId, "plan", "succeeded", now),
        capsuleId: CAPSULE_ID, summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: "fixture_resource.embedded", type: "fixture_resource", actions: ["update"] }],
      };
      const apply = { ...lifecycleRun(applyId, "apply", "failed", now), capsuleId: CAPSULE_ID, planRunId: planId };
      let attempts = 0, effects = 0, historyReads = 0, applyReads = 0;
      const held: { release?: () => Promise<void> } = {};
      const mutations: string[] = [];
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request(), url = new URL(request.url()), path = url.pathname;
        if (request.method() !== "GET") mutations.push(`${request.method()} ${path}`);
        if (path === `/api/v1/capsules/${CAPSULE_ID}/app`) return route.fulfill({ json: { app: appView(CAPSULE_ID, "Repository Office", {
          primaryAction: "view_resources",
          version: { current: { sourceSnapshotId: "snap_embedded", ref: "main", path: ".", commit: PORTABLE_SOURCE_COMMIT }, updateAvailable: false, stale: false, autoUpdate: false },
        }) } });
        if (path === `/api/v1/capsules/${CAPSULE_ID}/revision-plans` && request.method() === "POST") {
          return route.fulfill({ status: 201, json: { revisionPlan: { id: "revision_embedded", phase: "review_ready", generation: 1, planRunId: planId }, nextAction: "review_run", links: { self: "/api/v1/revision-plans/revision_embedded" } } });
        }
        if (path === `/api/v1/runs/${planId}/apply` && request.method() === "POST") {
          attempts += 1;
          if (effects === 0) effects += 1;
          return route.abort("failed");
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/runs`) {
          if (attempts >= 2 && url.searchParams.getAll("type").join() === "apply") {
            historyReads += 1;
            return route.fulfill({ json: { runs: [apply] } });
          }
          return route.fulfill({ json: { runs: [] } });
        }
        if (path === `/api/v1/runs/${planId}`) return route.fulfill({ json: { run: plan } });
        if (path === `/api/v1/runs/${applyId}`) {
          applyReads += 1;
          // The recovery authorizes the exact Run first; hold the separate
          // in-place resource read after that identity has been accepted.
          if (applyReads === 1) return route.fulfill({ json: { run: apply } });
          await new Promise<void>((resolve) => {
            held.release = async () => { await route.fulfill({ json: { run: apply } }); resolve(); };
          });
          return;
        }
        if (path === `/api/v1/runs/${planId}/cost`) return route.fulfill({ json: { cost: { runId: planId, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
        if (path.endsWith("/stream") && path.startsWith("/api/v1/runs/")) return route.fulfill({ contentType: "text/event-stream", body: "" });
        if (path.endsWith("/logs") && path.startsWith("/api/v1/runs/")) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        return route.fallback();
      });
      await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      await openAppPane(page, "version");
      const version = page.getByTestId("app-version");
      await version.getByRole("button", { name: "Check for updates", exact: true }).click();
      const review = version.getByTestId("app-review");
      await review.getByRole("button", { name: "Allow and update", exact: true }).click();
      await expect.poll(() => attempts).toBe(2);
      await expect.poll(() => historyReads).toBe(1);
      await expect.poll(() => applyReads).toBe(2);
      await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toHaveCount(0);
      await expect(review.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
      await held.release?.();
      await expect(review).toContainText("The update couldn't finish");
      await expect(review.locator(`a[href="/runs/${applyId}"]`)).toBeVisible();
      expect(effects).toBe(1);
      expect(mutations).toEqual([`POST /api/v1/capsules/${CAPSULE_ID}/revision-plans`, `POST /api/v1/runs/${planId}/apply`, `POST /api/v1/runs/${planId}/apply`]);
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#version$`, "u"));
      expect(errors).toEqual([]);
    });

    for (const action of ["update", "retireUpdate", "rollback"] as const) test({
      update: "a lost Update response reads the same app once and recovers only its existing review",
      retireUpdate: "leaving a version check lets the user continue its accepted request from the app",
      rollback: "a lost rollback response reads the same app once and recovers only its existing review",
    }[action], async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const now = "2026-10-01T00:00:00.000Z";
      const retireUpdate = action === "retireUpdate";
      const rollback = action === "rollback";
      const previousState = "sv_lost_response_previous";
      const actionPath = rollback ? `/api/v1/state-versions/${previousState}/rollback-plan` : `/api/v1/capsules/${CAPSULE_ID}/revision-plans`;
      const actionName = rollback ? "Go back to this version" : "Check for updates";
      const resourceName = rollback ? "existing_rollback" : "existing_update";
      const planId = `run_${action}_response_lost`;
      const plan = {
        ...lifecycleRun(planId, "plan", "succeeded", now),
        capsuleId: CAPSULE_ID, baseStateGeneration: 1,
        origin: rollback ? { kind: "rollback", stateVersionId: previousState } : { kind: "revision", ref: "main" },
        summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: `cloudflare_workers_script.${resourceName}`, type: "cloudflare_workers_script", actions: ["update"] }],
      };
      let acceptUpdate = true;
      let definiteRejection = false;
      let holdReadback = false;
      let releaseReadback: (() => Promise<void>) | undefined;
      let committed = false;
      let releaseCreation: (() => Promise<void>) | undefined;
      const revisionId = "grp_retired_version_check";
      const revision = { id: revisionId, capsuleId: CAPSULE_ID, revision: { targetRef: "main" } };
      let submitted = false;
      let appReadsAfterSubmit = 0;
      const mutations: string[] = [];
      const appReadIds: string[] = [];
      const rollbackKeys: (string | undefined)[] = [];
      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
          mutations.push(`${request.method()} ${path}`);
        }
        if (path.endsWith("/app") && path.startsWith("/api/v1/capsules/")) {
          appReadIds.push(path);
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/app`) {
          if (submitted) appReadsAfterSubmit += 1;
          if (submitted && holdReadback) {
            return await new Promise<void>((resolve) => {
              releaseReadback = async () => { await route.abort("failed"); resolve(); };
            });
          }
          return route.fulfill({ json: { app: appView(CAPSULE_ID, "Repository Office", {
            primaryAction: committed && !rollback ? "review" : retireUpdate && submitted ? "none" : "view_resources",
            ...(retireUpdate && submitted && !committed ? { state: "updating" } : {}),
            version: {
              current: { sourceSnapshotId: "snap_update_response", ref: "main", path: ".", commit: PORTABLE_SOURCE_COMMIT },
              updateAvailable: false, stale: false, autoUpdate: false,
            },
            progress: committed
              ? { revisionPreparing: false, review: { runId: planId, runType: "plan" } }
              : {
                revisionPreparing: retireUpdate && submitted,
                ...(retireUpdate && submitted ? { revisionPlanId: revisionId } : {}),
              },
          }) } });
        }
        if (rollback && path === `/api/v1/capsules/${CAPSULE_ID}/state-versions`) {
          return route.fulfill({ json: { stateVersions: [{
            id: previousState, capsuleId: CAPSULE_ID, workspaceId: "ws_alpha", environment: "production",
            generation: 1, createdByRunId: "run_previous_apply", createdAt: now,
          }] } });
        }
        if (path === actionPath && request.method() === "POST") {
          if (rollback) {
            rollbackKeys.push(request.headers()["idempotency-key"]);
            if (rollbackKeys.length === 2) return route.fulfill({ status: 201, json: { run: plan } });
          } else {
            expect(request.postDataJSON()).toEqual({ ref: "main" });
            expect(request.headers()["idempotency-key"]).toBeTruthy();
          }
          // Model server acceptance independently of the response observed by
          // the actual browser fetch. No second operation is manufactured.
          committed = acceptUpdate && !retireUpdate;
          submitted = true;
          if (retireUpdate) {
            return await new Promise<void>((resolve) => {
              releaseCreation = async () => {
                await route.fulfill({ status: 201, json: {
                  revisionPlan: { ...revision, phase: "planning" }, nextAction: "reconcile",
                } });
                resolve();
              };
            });
          }
          if (definiteRejection) {
            return route.fulfill({ status: 409, json: { error: { code: "fixture_update_refused", message: "The update was refused." } } });
          }
          return route.abort("failed");
        }
        if (path === `/api/v1/revision-plans/${revisionId}/reconcile` && request.method() === "POST") {
          committed = true;
          return route.fulfill({ json: {
            revisionPlan: { ...revision, phase: "reviewable", planRunId: planId }, nextAction: "review_run",
          } });
        }
        if (path === `/api/v1/runs/${planId}`) return route.fulfill({ json: { run: plan } });
        if (path === `/api/v1/runs/${planId}/cost`) return route.fulfill({ json: { cost: { runId: planId, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
        if (path === `/api/v1/runs/${planId}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
        if (path === `/api/v1/runs/${planId}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
        return route.fallback();
      });

      if (retireUpdate) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "version");
        await page.getByTestId("app-version").getByRole("button", { name: "Check for updates", exact: true }).click();
        await expect.poll(() => Boolean(releaseCreation)).toBe(true);
        await page.locator(".sidebar").getByRole("link", { name: "Home", exact: true }).click();
        await expect(page).toHaveURL(/\/$/u);
        await expect(page.getByTestId("app-page")).toHaveCount(0);

        const accepted = page.waitForResponse((response) => response.status() === 201 &&
          response.url().endsWith(`/capsules/${CAPSULE_ID}/revision-plans`));
        await releaseCreation!();
        await (await accepted).finished();
        // Reload a fresh owner view rather than relying on local controller state.
        await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", "overview");

        await expect(page.locator('[data-progress="preparing"]')).toBeVisible();
        const resume = page.getByRole("button", { name: "Continue", exact: true });
        await expect(resume).toBeVisible();
        expect(mutations).toEqual([`POST /api/v1/capsules/${CAPSULE_ID}/revision-plans`]);
        await resume.click();
        const review = page.getByTestId("app-review");
        await expect(review).toContainText("existing_update");
        await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toBeVisible();
        expect(mutations).toEqual([
          `POST /api/v1/capsules/${CAPSULE_ID}/revision-plans`,
          `POST /api/v1/revision-plans/${revisionId}/reconcile`,
        ]);
        expect(errors).toEqual([]);
        return;
      }

      for (const scene of ["accepted", "not-accepted", "definite-rejection", "readback-pending"] as const) {
        const accepted = scene === "accepted";
        acceptUpdate = accepted || (rollback && scene === "readback-pending");
        definiteRejection = scene === "definite-rejection";
        holdReadback = scene === "readback-pending";
        releaseReadback = undefined;
        committed = false;
        submitted = false;
        appReadsAfterSubmit = 0;
        mutations.length = 0;
        appReadIds.length = 0;
        rollbackKeys.length = 0;
        await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "version");
        const rejected = definiteRejection
          ? page.waitForResponse((response) => response.url().endsWith(actionPath) && response.status() === 409)
          : undefined;
        const start = page.getByTestId("app-version").getByRole("button", { name: actionName, exact: true });
        await start.click();
        if (rejected) {
          await rejected;
          await expect(start).toBeEnabled();
          expect(appReadsAfterSubmit).toBe(0);
        } else {
          await expect.poll(() => appReadsAfterSubmit).toBe(1);
          if (holdReadback) {
            // The recovery read has no new deadline and cannot keep the
            // original action's busy state locked while it remains pending.
            await expect(start).toBeEnabled();
          }
        }
        expect(appReadIds.every((path) => path === `/api/v1/capsules/${CAPSULE_ID}/app`)).toBe(true);
        if (accepted) {
          // An installed app keeps its normal primary action. Its pending
          // rollback review is shown in the app's attention section.
          const reviewHost = rollback ? page.locator('[data-problem="review-waiting"]') : page.getByTestId("app-header");
          const openReview = reviewHost.getByRole("button", { name: "Review", exact: true });
          await expect(openReview).toBeVisible();
          if (rollback) await expect(start).toBeDisabled();
          await openReview.click();
          const review = page.getByTestId("app-review");
          await expect(review).toContainText(resourceName);
          await expect(review.getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
          if (rollback) {
            await expect(reviewHost).toHaveCount(0);
            await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#version$`, "u"));
          }
        } else {
          await expect(page.locator('[data-problem="review-waiting"]')).toHaveCount(0);
          await expect(page.getByTestId("app-review")).toHaveCount(0);
          await expect(page.getByTestId("app-header").getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
        }
        expect(mutations).toEqual([`POST ${actionPath}`]);
        expect(appReadsAfterSubmit).toBe(definiteRejection ? 0 : 1);
        await (releaseReadback as (() => Promise<void>) | undefined)?.();
        if (rollback) {
          expect(rollbackKeys).toHaveLength(1);
          expect(rollbackKeys[0]).toBeTruthy();
          if (holdReadback) {
            // The original Plan is durable but neither the create response
            // nor the first read reached the browser. Retrying is explicit.
            await start.click();
            const review = page.getByTestId("app-review");
            await expect(review).toContainText(resourceName);
            await expect(review.getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
            expect(rollbackKeys).toEqual([rollbackKeys[0], rollbackKeys[0]]);
            expect(mutations).toEqual([`POST ${actionPath}`, `POST ${actionPath}`]);
          }
        }
      }
      expect(errors).toEqual([]);
    });

    test("reviews never replay a returned plan, retry through their own request, and never leak to another app", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      const seenMutations: string[] = [];
      const revisionKeys: string[] = [];
      const configurationKeys: string[] = [];
      const configurationBodies: unknown[] = [];
      const now = "2026-10-01T00:00:00.000Z";
      const apps = {
        cap_keep_a: { name: "Keep Alpha", freshness: "stale", source: "src_keep_a" },
        cap_keep_b: { name: "Keep Beta", freshness: "fresh", source: "src_keep_b" },
      } as const;
      type AppId = keyof typeof apps;
      const capsule = (id: AppId) => ({
        id, workspaceId: "ws_alpha", name: apps[id].name, slug: id, sourceId: apps[id].source,
        installConfigId: `cfg_${id}`, environment: "production", currentStateVersionId: `sv_${id}`,
        currentStateGeneration: 1, status: "active", freshness: apps[id].freshness,
        adoptedSourceRevision: { sourceSnapshotId: `snap_${id}`, ref: "main", path: ".", resolvedCommit: PORTABLE_SOURCE_COMMIT },
        createdAt: now, updatedAt: now,
      });
      const plan = (n: number) => ({
        ...lifecycleRun(`run_rev_plan_${n}`, "plan", n === 2 ? "failed" : "succeeded", now, n === 2 ? { errorCode: "plan_failed" } : {}),
        capsuleId: "cap_keep_a", summary: { add: 1, change: 0, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: `cloudflare_r2_bucket.revision_${n}`, type: "cloudflare_r2_bucket", actions: ["create"] }],
      });
      const configPlan = (n: number) => ({
        ...lifecycleRun(`run_config_plan_${n}`, "plan", "succeeded", now), capsuleId: "cap_keep_a",
        summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass",
        planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] }],
      });
      const runs = new Map<string, unknown>();

      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (shouldRecordControlPlaneMutation(mode, origin, request.url(), request.method())) {
          seenMutations.push(`${request.method()} ${path}`);
        }
        if (path === "/api/v1/apps") {
          return route.fulfill({ json: { apps: (Object.keys(apps) as AppId[]).map((id) => ({
            capsuleId: id,
            name: apps[id].name,
            role: "owner",
            ownerDisplayName: "Portable E2E",
            state: "installed",
            primaryAction: "open",
          })) } });
        }
        const app = (Object.keys(apps) as AppId[]).find((id) => path.startsWith(`/api/v1/capsules/${id}`));
        if (app) {
          const rest = path.slice(`/api/v1/capsules/${app}`.length);
          if (rest === "") return route.fulfill({ json: { capsule: capsule(app), installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
          if (rest === "/members") return route.fulfill({ json: { owner: { accountId: "sub_portable_e2e", displayName: "Portable E2E", email: "portable-e2e@example.test" }, members: [] } });
          if (rest === "/state-versions") return route.fulfill({ json: { stateVersions: [{ id: `sv_${app}`, workspaceId: "ws_alpha", capsuleId: app, environment: "production", generation: 1, createdByRunId: `run_install_${app}`, createdAt: now }] } });
          if (rest === "/app") {
            return route.fulfill({ json: { app: appView(app, apps[app].name, {
              // Neither app has a screen: the primary action shows what it created.
              primaryAction: "view_resources",
              version: {
                repository: { url: `https://github.com/example/${app}.git`, defaultRef: "main" },
                current: { sourceSnapshotId: `snap_${app}`, ref: "main", path: ".", commit: PORTABLE_SOURCE_COMMIT },
                updateAvailable: false, stale: apps[app].freshness === "stale", autoUpdate: false,
              },
            }) } });
          }
          if (rest === "/runs") return route.fulfill({ json: { runs: [] } });
          // Keep Alpha has no provider binding set at all.
          if (rest === "/provider-bindings") return route.fulfill({ json: { providerBindingSet: null } });
          if (rest === "/current-resource-inventory") return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: app, workspaceId: "ws_alpha", environment: "production", stateVersionId: `sv_${app}`, generation: 1, applyRunId: `run_install_${app}`, planRunId: `run_install_plan_${app}`, recordedAt: now, availability: "legacy_unavailable" } } });
          if (rest === "/usage-summary") return route.fulfill({ json: { summary: { capsuleId: app, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
          if (rest === "/revision-plans" && request.method() === "POST") {
            revisionKeys.push(request.headers()["idempotency-key"] ?? "");
            const n = revisionKeys.length;
            runs.set(`run_rev_plan_${n}`, plan(n));
            return route.fulfill({ status: 201, json: { revisionPlan: { id: `grp_${n}`, phase: "review_ready", generation: 1, planRunId: `run_rev_plan_${n}` }, nextAction: "review_run", links: { self: `/api/v1/revision-plans/grp_${n}` } } });
          }
          if (rest === "/configuration-plans" && request.method() === "POST") {
            configurationKeys.push(request.headers()["idempotency-key"] ?? "");
            configurationBodies.push(request.postDataJSON());
            const n = configurationKeys.length;
            runs.set(`run_config_plan_${n}`, configPlan(n));
            return route.fulfill({ status: 201, json: { capsule: capsule(app), configurationPlan: { replayed: false, previousInstallConfigId: `cfg_${app}`, targetInstallConfigId: `cfg_next_${n}`, sourceSnapshotId: `snap_${app}`, planRunId: `run_config_plan_${n}` }, links: { run: `/api/v1/runs/run_config_plan_${n}` } } });
          }
        }
        const config = (Object.keys(apps) as AppId[]).find((id) => path === `/api/v1/capsule-configs/cfg_${id}`);
        if (config) {
          return route.fulfill({ json: { installConfig: {
            id: `cfg_${config}`, workspaceId: "ws_alpha", name: apps[config].name, policy: {},
            variableMapping: { region: config === "cap_keep_a" ? "alpha-region" : "beta-region" },
            variablePresentation: [{ name: "region", type: "string", required: true, label: { ja: "リージョン", en: "Region" } }],
            outputAllowlist: {}, interfaceBlueprints: [], createdAt: now, updatedAt: now,
          } } });
        }
        if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: [] } });
        if (path === "/api/v1/sources" && request.method() === "GET") {
          return route.fulfill({ json: { sources: (Object.keys(apps) as AppId[]).map((id) => ({
            id: apps[id].source, workspaceId: "ws_alpha", name: apps[id].name, url: `https://github.com/example/${id}.git`,
            defaultRef: "main", defaultPath: ".", status: "active", autoSync: true, createdAt: now, updatedAt: now,
          })) } });
        }
        if (path.startsWith("/api/v1/sources/") && path.endsWith("/snapshots")) return route.fulfill({ json: { snapshots: [] } });
        const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)(\/[a-z]+)?$/u);
        if (runMatch && runs.has(runMatch[1]!)) {
          const [, id, suffix] = runMatch;
          // The apply's outcome is lost: the review must hold it, not retry.
          if (suffix === "/apply") return route.fulfill({ status: 503, json: { error: "fixture_outcome_unknown" } });
          if (suffix === "/cost") return route.fulfill({ json: { cost: { runId: id, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
          if (suffix === "/logs") return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (suffix === "/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
          return route.fulfill({ json: { run: runs.get(id!) } });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/apps/cap_keep_a", { waitUntil: "domcontentloaded" });
      const app = page.getByTestId("app-page");
      const version = app.getByTestId("app-version");
      await expect(page.getByTestId("app-header").getByRole("heading", { level: 1 })).toHaveText("Keep Alpha");
      // An app without a screen still offers its resource details.
      await expect(page.getByTestId("app-header").getByRole("link", { name: "Open" })).toHaveCount(0);
      await openAppPane(page, "created");
      await expect(app.getByTestId("app-created")).toBeInViewport();
      await showAppOverview(page);
      await openAppPane(page, "version");

      // Update → Cancel → Update: the second Update is a new request, not a
      // replay of the plan that was already returned.
      await version.getByRole("button", { name: "Update", exact: true }).click();
      await expect(version.getByTestId("app-review")).toContainText("revision_1");
      await version.getByTestId("app-review").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(version.getByTestId("app-review")).toHaveCount(0);
      await version.getByRole("button", { name: "Update", exact: true }).click();
      // The second plan failed: Review again goes back through the revision
      // request with a fresh key, never through a plain re-plan of the app.
      const review = version.getByTestId("app-review");
      await expect(review).toContainText("The update couldn't finish");
      await review.getByRole("button", { name: "Review again", exact: true }).click();
      await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toBeVisible();
      await expect(review).toContainText("revision_3");
      expect(revisionKeys).toHaveLength(3);
      expect(new Set(revisionKeys).size).toBe(3);
      expect(seenMutations.some((entry) => entry.endsWith("/plan"))).toBe(false);

      // An unconfirmed Apply stays held while the review can still close.
      await review.getByRole("button", { name: "Allow and update", exact: true }).click();
      await expect(review.getByRole("alert").filter({ hasText: "We couldn't confirm the result." })).toBeVisible();
      await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toBeDisabled();
      await review.getByRole("button", { name: "Close", exact: true }).click();
      await expect(version.getByTestId("app-review")).toHaveCount(0);
      await showAppOverview(page);
      await openAppPane(page, "danger");
      await expect(app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true })).toBeEnabled();
      expect(seenMutations.filter((entry) => entry.endsWith("/apply"))).toHaveLength(1);

      // Settings work for an app without a provider binding set; a reviewed
      // change leaves a clean form, a cancelled one shows what the app runs,
      // and the next change is a new request.
      await showAppOverview(page);
      await openAppPane(page, "connections");
      const settings = app.getByTestId("app-settings");
      await expect(settings.getByTestId("app-connections")).toContainText("This app doesn't use any connections.");
      await showAppOverview(page);
      await openAppPane(page, "settings");
      const region = settings.getByRole("textbox", { name: /^Region/u });
      await expect(region).toHaveValue("alpha-region");
      await region.fill("first-edit");
      await settings.getByRole("button", { name: "Review", exact: true }).click();
      await expect(settings.getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      await settings.getByTestId("app-review").getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(settings.getByTestId("app-review")).toHaveCount(0);
      await expect(region).toHaveValue("alpha-region");
      await expect(settings.getByRole("button", { name: "Review", exact: true })).toBeDisabled();
      await region.fill("first-edit");
      await settings.getByRole("button", { name: "Review", exact: true }).click();
      await expect(settings.getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(configurationKeys).toHaveLength(2);
      expect(new Set(configurationKeys).size).toBe(2);
      expect(configurationBodies[0]).toEqual(configurationBodies[1]);
      expect((configurationBodies[0] as { providerBindings: unknown }).providerBindings).toEqual([]);
      await settings.getByTestId("app-review").getByRole("button", { name: "Cancel", exact: true }).click();

      expect(errors).toEqual([]);
      // The only failed request is the Apply whose outcome the fixture lost.
      expect(traffic.failures.map(({ kind, url, status }) => ({ kind, path: new URL(url).pathname, status }))).toEqual([
        { kind: "response", path: "/api/v1/runs/run_rev_plan_3/apply", status: 503 },
      ]);
    });

    test("uninstall now keeps the removal confirmation, and try again keeps the failed operation", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      const seenMutations: string[] = [];
      const planBodies: unknown[] = [];
      const rollbackPlansByKey = new Map<string | undefined, string>();
      let loseRollbackAck = false;
      const now = "2026-10-01T00:00:00.000Z";
      let removals = 0;
      const removeApp = {
        id: "cap_remove_c", workspaceId: "ws_alpha", name: "Remove Gamma", slug: "remove-gamma", sourceId: "src_remove_c",
        installConfigId: "cfg_cap_remove_c", environment: "production", currentStateVersionId: "sv_remove_c",
        currentStateGeneration: 1, status: "uninstalled",
        uninstall: { phase: "destroying", requestedAt: now, scheduledDestroyAt: now, blockedReason: "teardown_unconfirmed" },
        createdAt: now, updatedAt: now,
      };
      const retryApp = {
        ...removeApp, id: "cap_retry_d", name: "Retry Delta", slug: "retry-delta", sourceId: "src_retry_d",
        installConfigId: "cfg_cap_retry_d", currentStateVersionId: "sv_retry_d", status: "error", uninstall: undefined,
      };
      const destroyPlan = (n: number) => ({
        ...lifecycleRun(`run_destroy_plan_${n}`, "destroy_plan", n === 1 ? "succeeded" : "waiting_approval", now),
        capsuleId: "cap_remove_c", summary: { add: 0, change: 0, destroy: 0 }, policyStatus: "pass",
      });
      const failedApply = { ...lifecycleRun("run_failed_retry", "apply", "failed", "2026-10-02T00:00:00.000Z", { errorCode: "apply_failed", baseStateGeneration: 1, planRunId: "run_failed_retry_plan" }), capsuleId: "cap_retry_d" };
      // The failed apply's plan records the change it was made for.
      const failedPlan = (origin: Record<string, unknown>) => ({
        ...lifecycleRun("run_failed_retry_plan", "plan", "succeeded", "2026-10-01T23:59:00.000Z", { baseStateGeneration: 1, policyStatus: "pass", origin }),
        capsuleId: "cap_retry_d",
      });
      const revisionBodies: unknown[] = [];
      const runs = new Map<string, unknown>([
        [failedApply.id, failedApply],
        ["run_failed_retry_plan", failedPlan({ kind: "revision", ref: "v2" })],
      ]);
      const retryPlanRun = (id: string) => ({ ...lifecycleRun(id, "plan", "succeeded", now), capsuleId: "cap_retry_d", summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass", planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] }] });
      const configFor = (id: string) => ({ installConfig: { id: `cfg_${id}`, workspaceId: "ws_alpha", name: id, policy: {}, variableMapping: {}, variablePresentation: [], outputAllowlist: {}, interfaceBlueprints: [], createdAt: now, updatedAt: now } });

      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (shouldRecordControlPlaneMutation(mode, origin, request.url(), request.method())) {
          seenMutations.push(`${request.method()} ${path}${url.search}`);
        }
        if (path === "/api/v1/apps") {
          return route.fulfill({ json: { apps: [removeApp, retryApp].map((app) => ({
            capsuleId: app.id,
            name: app.name,
            role: "owner",
            ownerDisplayName: "Portable E2E",
            state: "needs_attention",
            primaryAction: "retry",
          })) } });
        }
        for (const app of [removeApp, retryApp]) {
          const base = `/api/v1/capsules/${app.id}`;
          if (!path.startsWith(base)) continue;
          const rest = path.slice(base.length);
          if (rest === "/members") return route.fulfill({ json: { owner: { accountId: "sub_portable_e2e", displayName: "Portable E2E", email: "portable-e2e@example.test" }, members: [] } });
          if (rest === "" && request.method() === "DELETE" && url.searchParams.get("immediate") === "true") {
            removals += 1;
            runs.set(`run_destroy_plan_${removals}`, destroyPlan(removals));
            return route.fulfill({ json: { run: destroyPlan(removals) } });
          }
          if (rest === "") return route.fulfill({ json: { capsule: app, installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
          if (rest === "/app") {
            return route.fulfill({ json: { app: app.id === removeApp.id
              // The stopped teardown can still be cancelled: that is the
              // primary action, and uninstalling now stays on the card.
              ? appView(app.id, app.name, {
                  status: "uninstalled", state: "needs_attention", primaryAction: "cancel_uninstall",
                  problems: [{ code: "uninstall_blocked", severity: "error", reason: "teardown_unconfirmed" }],
                  uninstall: { mode: "scheduled", graceDays: 7, scheduled: { phase: "destroying", requestedAt: now, deleteAfter: now, cancellable: true, blocked: true } },
                })
              : appView(app.id, app.name, {
                  status: "error", state: "needs_attention", primaryAction: "retry",
                  problems: [{ code: "run_failed", severity: "error", runId: failedApply.id, runType: "apply", errorCode: "apply_failed" }],
                }) } });
          }
          if (rest === "/runs") return route.fulfill({ json: runPage(app.id === retryApp.id ? [failedApply] : []) });
          if (rest === "/state-versions") return route.fulfill({ json: { stateVersions: [{ id: app.currentStateVersionId, workspaceId: "ws_alpha", capsuleId: app.id, environment: "production", generation: 1, createdByRunId: `run_install_${app.id}`, createdAt: now }] } });
          if (rest === "/provider-bindings") return route.fulfill({ json: { providerBindingSet: null } });
          if (rest === "/current-resource-inventory") return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: app.id, workspaceId: "ws_alpha", environment: "production", stateVersionId: app.currentStateVersionId, generation: 1, applyRunId: "run_x", planRunId: "run_y", recordedAt: now, availability: "legacy_unavailable" } } });
          if (rest === "/usage-summary") return route.fulfill({ json: { summary: { capsuleId: app.id, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
          if (rest === "/plan" && request.method() === "POST") {
            planBodies.push(request.postDataJSON());
            return route.fulfill({ status: 500, json: { error: "retry_must_not_plan_the_default_ref" } });
          }
          // A failed version change is retried as the same version change.
          if (rest === "/revision-plans" && request.method() === "POST") {
            revisionBodies.push(request.postDataJSON());
            runs.set("run_retry_revision", retryPlanRun("run_retry_revision"));
            return route.fulfill({ status: 201, json: {
              revisionPlan: { id: "grp_retry", operation: "revision", phase: "review_ready", generation: 1, capsuleId: app.id, planRunId: "run_retry_revision" },
              nextAction: "review_run", links: { self: "/api/v1/revision-plans/grp_retry", run: "/api/v1/runs/run_retry_revision" },
            } });
          }
        }
        if (path === "/api/v1/capsule-configs/cfg_cap_remove_c") return route.fulfill({ json: configFor("cap_remove_c") });
        if (path === "/api/v1/capsule-configs/cfg_cap_retry_d") return route.fulfill({ json: configFor("cap_retry_d") });
        if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: [] } });
        if (path === "/api/v1/sources" && request.method() === "GET") return route.fulfill({ json: { sources: [] } });
        // A failed rollback is retried as a rollback to the same version.
        if (path === "/api/v1/state-versions/sv_retry_prev/rollback-plan" && request.method() === "POST") {
          const key = request.headers()["idempotency-key"];
          const id = rollbackPlansByKey.get(key) ?? `run_retry_rollback_${rollbackPlansByKey.size + 1}`;
          rollbackPlansByKey.set(key, id);
          runs.set(id, retryPlanRun(id));
          if (loseRollbackAck) {
            loseRollbackAck = false;
            return route.fulfill({ status: 502, json: { error: "test_response_lost" } });
          }
          return route.fulfill({ status: 201, json: { run: runs.get(id) } });
        }
        const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)(\/[a-z]+)?$/u);
        if (runMatch && runs.has(runMatch[1]!)) {
          const [, id, suffix] = runMatch;
          if (suffix === "/approve") return route.fulfill({ json: { run: runs.get(id!) } });
          if (suffix === "/cost") return route.fulfill({ json: { cost: { runId: id, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
          if (suffix === "/logs") return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (suffix === "/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
          return route.fulfill({ json: { run: runs.get(id!) } });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/apps/cap_remove_c", { waitUntil: "domcontentloaded" });
      const problems = page.getByTestId("app-problems");
      const scheduled = problems.locator('[data-problem="uninstall"]');
      await expect(scheduled).toContainText("was stopped because it couldn't be confirmed safe");
      await expect(scheduled).toContainText("teardown_unconfirmed");
      await expect(page.getByTestId("app-header").getByRole("button", { name: "Cancel uninstall", exact: true })).toBeVisible();
      await expect(scheduled.getByRole("button", { name: "Cancel uninstall", exact: true })).toHaveCount(0);
      await expect(page.getByTestId("app-uninstall")).toHaveCount(0);
      await scheduled.getByRole("button", { name: "Uninstall now", exact: true }).click();
      const review = problems.getByTestId("app-review");
      await expect(review.getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
      // A removal that recorded no deletions has unknown counts, not 0/0/0,
      // and always needs the explicit check before it can run.
      await expect(review.getByRole("definition")).toHaveCount(0);
      const allow = review.getByRole("button", { name: "Allow and uninstall", exact: true });
      await expect(allow).toBeDisabled();
      await review.getByRole("checkbox", { name: "I reviewed these changes" }).check();
      await expect(allow).toBeEnabled();
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(problems.getByTestId("app-review")).toHaveCount(0);

      // A removal that waits for approval asks before approving.
      await scheduled.getByRole("button", { name: "Uninstall now", exact: true }).click();
      await problems.getByTestId("app-review").getByRole("button", { name: "Approve this change", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("Run this deletion?");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(seenMutations.some((entry) => entry.endsWith("/approve"))).toBe(false);
      expect(seenMutations.some((entry) => entry.endsWith("/apply"))).toBe(false);

      // A global confirmation cannot outlive this embedded removal review.
      await problems.getByTestId("app-review").getByRole("button", { name: "Approve this change", exact: true }).click();
      await expect(dialog).toContainText("Run this deletion?");
      await page.evaluate(() => {
        history.pushState(null, "", "/apps/cap_retry_d");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.getByTestId("app-header")).toContainText("Retry Delta");
      await dialog.getByRole("button", { name: "Approve this change", exact: true }).click();
      // The newly mounted app's normal review is the completion witness.
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review")).toBeVisible();
      expect(seenMutations.some((entry) => entry.endsWith("/approve"))).toBe(false);

      // Try again on an installed app repeats the change that failed — the
      // same version change, or the same rollback — never a plan of the
      // Source's default ref.
      await page.goto("/apps/cap_retry_d", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("app-problems").locator('[data-problem="run_failed"]')).toContainText("The last change couldn't be applied");
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(revisionBodies).toEqual([{ ref: "v2" }, { ref: "v2" }]);
      runs.set("run_failed_retry_plan", failedPlan({ kind: "rollback", stateVersionId: "sv_retry_prev" }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(planBodies).toEqual([]);
      expect(seenMutations).toEqual([
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "POST /api/v1/capsules/cap_retry_d/revision-plans",
        "POST /api/v1/capsules/cap_retry_d/revision-plans",
        "POST /api/v1/state-versions/sv_retry_prev/rollback-plan",
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();

      // The server accepts a retry from the failed Run, but the acknowledgement
      // is lost before the browser reloads. The next explicit retry must open
      // the accepted Plan without creating or applying another one.
      const failedRollbackId = "run_failed_rollback_plan";
      runs.set(failedRollbackId, {
        ...failedPlan({ kind: "rollback", stateVersionId: "sv_retry_prev" }),
        id: failedRollbackId,
        status: "failed",
        errorCode: "opentofu_plan_failed",
      });
      const rollbackPath = "/api/v1/state-versions/sv_retry_prev/rollback-plan";
      const retry = page.getByRole("button", { name: "Review changes again", exact: true });
      const mutationFloor = seenMutations.length;
      await page.goto(`/runs/${failedRollbackId}`, { waitUntil: "domcontentloaded" });
      loseRollbackAck = true;
      const lost = page.waitForResponse((response) => new URL(response.url()).pathname === rollbackPath && response.status() === 502);
      await retry.click();
      await lost;
      const acceptedPlan = [...rollbackPlansByKey.values()].at(-1);
      expect(acceptedPlan).toBe("run_retry_rollback_2");
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(retry).toBeEnabled();
      expect(seenMutations.slice(mutationFloor)).toEqual([`POST ${rollbackPath}`]);
      await retry.click();
      await expect(page).toHaveURL(new RegExp(`/runs/${acceptedPlan}$`, "u"));
      expect(rollbackPlansByKey.size).toBe(2);
      expect(seenMutations.slice(mutationFloor)).toEqual([`POST ${rollbackPath}`, `POST ${rollbackPath}`]);
      expect(errors).toEqual([]);
    });

    for (const scenario of ["states", "staleReview", "lostReplacementResponse", "lostReplacementOnInstalledApp", "partialRecovery", "unusedUnavailable", "unusedOnlyUnavailable", "firstRemovalRefusal", "failedOpenReview", "indeterminateOpenReview", "noReplacement"] as const) test({
      states: "each state the server reports reads as it is, with its one next step in place",
      staleReview: "a refused uninstall Apply can open a fresh review with another connection",
      lostReplacementResponse: "a lost replacement Plan response leaves its saved uninstall review reachable",
      lostReplacementOnInstalledApp: "a lost replacement Plan response leaves its saved uninstall review reachable on an installed app",
      partialRecovery: "a partial uninstall can replace more than the unavailable original connection",
      unusedUnavailable: "uninstall replacement only asks for unavailable connections used by the applied plan",
      unusedOnlyUnavailable: "ordinary uninstall proceeds when only an unused saved alias is unavailable",
      firstRemovalRefusal: "a refused first uninstall refreshes the app and offers a replacement connection",
      failedOpenReview: "a failed uninstall offers another connection inside its open review",
      indeterminateOpenReview: "an indeterminate uninstall offers no new removal from its open review",
      noReplacement: "uninstall recovery opens connections when no verified replacement is available",
    }[scenario], async ({ page }) => {
      const lostReplacementOnInstalledApp = scenario === "lostReplacementOnInstalledApp";
      const startsAwaitingApproval = scenario === "staleReview";
      const installedUninstallReview = startsAwaitingApproval || lostReplacementOnInstalledApp;
      const lostReplacementResponse = scenario === "lostReplacementResponse" || lostReplacementOnInstalledApp;
      const staleUninstallReview = scenario === "staleReview" || lostReplacementResponse;
      const partialRecovery = scenario === "partialRecovery";
      const unusedUnavailable = scenario === "unusedUnavailable";
      const unusedOnlyUnavailable = scenario === "unusedOnlyUnavailable";
      const firstRemovalRefusal = scenario === "firstRemovalRefusal";
      const replacementAccountId = "a".repeat(32);
      const otherAccountId = "b".repeat(32);
      const cloudflareAccount = (accountId: string, workersSubdomain: string) => ({
        credentialVerification: {
          kind: "takosumi.credential-verification@v1",
          capabilities: ["cloudflare.account-workers-subdomain.v1"],
          verifierId: "cloudflare/account-workers-subdomain@v1",
        },
        scopeHints: {
          providerSettings: { accountId, workersSubdomain },
          moduleInputDefaults: {
            cloudflare_account_id: accountId,
            cloudflare_workers_subdomain: workersSubdomain,
          },
        },
      });
      const indeterminateOpenReview = scenario === "indeterminateOpenReview";
      const openReviewFailure = scenario === "failedOpenReview" || indeterminateOpenReview;
      const noReplacement = scenario === "noReplacement";
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      if (scenario === "states") await page.clock.install();
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      const seenMutations: string[] = [];
      const ID = "cap_states_e";
      const NAME = "State Echo";
      const now = "2026-10-20T00:00:00.000Z";
      type Scene = "uninstall_scheduled" | "uninstall_immediate" | "uninstall_failed" | "uninstall_stale_review" | "updating" | "policy_blocked" | "installing" | "install_stalled" | "awaiting_input" | "awaiting_your_input" | "revision_stalled" | "revision_stalled_behind_review" | "review_pending" | "incomplete" | "uninstalled";
      let scene: Scene = partialRecovery ? "uninstall_failed"
        : firstRemovalRefusal || unusedUnavailable || unusedOnlyUnavailable || noReplacement ? "uninstall_immediate"
          : staleUninstallReview || openReviewFailure ? "uninstall_stale_review" : "uninstall_scheduled";
      let connectionRemoved = noReplacement;
      let replacementAvailable = !noReplacement;
      let replacementVerified = !noReplacement;
      let replacementTesting = false;
      let releaseReplacementVerification = () => {};
      const replacementVerification = noReplacement
        ? new Promise<void>((resolve) => { releaseReplacementVerification = resolve; })
        : Promise.resolve();
      const replacementPlanBodies: unknown[] = [];
      let failedUninstallBindingReads = 0;
      let firstRemovalAttempts = 0;
      let appReadsAfterFirstRemoval = 0;
      const connectionProblem = {
        code: "connection_unavailable", severity: "error", provider: "registry.opentofu.org/cloudflare/cloudflare", connectionId: "conn_removed", connectionStatus: "revoked",
      } as const;
      const unusedConnectionProblem = {
        ...connectionProblem, connectionId: "conn_unused", connectionStatus: "expired" as const,
      };
      let attemptAwaitsInput = false;
      let viewUnavailable = false;
      const capsule = () => ({
        id: ID, workspaceId: "ws_alpha", name: NAME, slug: "state-echo", sourceId: "src_states_e", installConfigId: "cfg_states_e",
        environment: "production",
        ...(scene === "installing" || scene === "install_stalled" || scene === "awaiting_input" || scene === "awaiting_your_input" || scene === "uninstalled" ? { currentStateGeneration: 0 } : { currentStateVersionId: "sv_states_e", currentStateGeneration: 1 }),
        status: scene === "uninstall_scheduled" ? "uninstalled" : scene === "uninstalled" ? "destroyed" : scene === "installing" || scene === "install_stalled" || scene === "awaiting_input" || scene === "awaiting_your_input" ? "pending" : "active",
        // The version it last ran, kept on the record after uninstalling.
        ...(scene === "uninstalled"
          ? { adoptedSourceRevision: { sourceSnapshotId: "snap_states_e", ref: "v1.4.2", path: ".", resolvedCommit: PORTABLE_SOURCE_COMMIT } }
          : {}),
        createdAt: now, updatedAt: now,
      });
      const deleteAfter = "2099-01-08T00:00:00.000Z";
      const blockedPlan = {
        ...lifecycleRun("run_blocked_plan", "plan", "succeeded", "2026-10-21T00:00:00.000Z", { capsuleId: ID }),
        policyStatus: "deny", summary: { add: 1, change: 0, destroy: 0 },
        planResources: [{ address: "aws_s3_bucket.files", type: "aws_s3_bucket", actions: ["create"] }],
        policyReasons: [
          { code: "provider_not_allowed", layer: "provider", provider: "registry.opentofu.org/hashicorp/aws" },
          { code: "resource_type_not_allowed", layer: "resource", resourceType: "aws_s3_bucket" },
        ],
      };
      const updateApply = { ...lifecycleRun("run_states_apply", "apply", "running", "2026-10-22T00:00:00.000Z", { capsuleId: ID, planRunId: "run_states_plan" }) };
      const installPlan = {
        ...lifecycleRun("run_install_plan", "plan", "succeeded", "2026-10-23T00:00:00.000Z", { capsuleId: ID }),
        policyStatus: "pass", summary: { add: 1, change: 0, destroy: 0 },
        planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["create"] }],
      };
      const revisionPlanRun = {
        ...lifecycleRun("run_revision_continued", "plan", "succeeded", "2026-10-24T00:00:00.000Z", { capsuleId: ID }),
        policyStatus: "pass", summary: { add: 0, change: 1, destroy: 0 }, origin: { kind: "revision", ref: "v2" },
        planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] }],
      };
      const failedRemoval = lifecycleRun("run_failed_removal", "destroy_apply", "failed", now, {
        capsuleId: ID, planRunId: "run_refused_uninstall",
        errorCode: indeterminateOpenReview ? "runner_mutation_indeterminate" : "apply_failed",
      });
      const recoveryPlan = {
        ...lifecycleRun("run_states_destroy_recovery", "destroy_plan", "waiting_approval", now, { capsuleId: ID }),
        policyStatus: "pass", requiresApproval: true, summary: { add: 0, change: 0, destroy: 1 },
        planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["delete"] }],
      };
      const refusedPlan = {
        ...recoveryPlan, id: "run_refused_uninstall",
        status: startsAwaitingApproval ? "waiting_approval" as const : "succeeded" as const,
      };
      let currentUninstallReview: Pick<typeof recoveryPlan, "id" | "status"> = refusedPlan;
      let staleReviewApplyAttempts = 0;
      const runsById = new Map<string, Record<string, unknown>>([
        [blockedPlan.id, blockedPlan], [updateApply.id, updateApply], [installPlan.id, installPlan],
        [revisionPlanRun.id, revisionPlanRun], [recoveryPlan.id, recoveryPlan], [failedRemoval.id, failedRemoval], [refusedPlan.id, refusedPlan],
      ]);
      // Older history: thirty-two applied changes, read twenty at a time.
      const olderRuns = Array.from({ length: 32 }, (_, index) =>
        lifecycleRun(`run_old_${String(index).padStart(2, "0")}`, "apply", "succeeded", new Date(Date.parse("2026-09-01T00:00:00.000Z") + index * 3_600_000).toISOString(), { capsuleId: ID }));
      const screen = { interfaceId: "if_states_e", name: "app.launcher", title: NAME, url: "https://apps.example.test/state-echo" };
      const view = () => {
        switch (scene) {
          case "uninstall_scheduled":
            return appView(ID, NAME, {
              status: "uninstalled", state: "uninstall_scheduled", primaryAction: "cancel_uninstall", screens: [screen],
              problems: [...(connectionRemoved ? [connectionProblem] : []), { code: "uninstall_scheduled", severity: "warning" }],
              uninstall: { mode: "scheduled", graceDays: 7, scheduled: { phase: "scheduled", requestedAt: now, deleteAfter, cancellable: true, blocked: false, preDestroyExport: { status: "skipped" } } },
            });
          case "uninstall_immediate":
            return appView(ID, NAME, {
              screens: [screen],
              ...(unusedUnavailable
                ? { problems: [connectionProblem, unusedConnectionProblem], state: "needs_attention", primaryAction: "fix_connection" }
                : unusedOnlyUnavailable
                  ? { problems: [unusedConnectionProblem], state: "needs_attention", primaryAction: "fix_connection" }
                : connectionRemoved ? { problems: [connectionProblem] } : {}),
              uninstall: {
                mode: "none", impact: { usedBy: [] },
                ...(unusedUnavailable ? { recoveryConnectionIds: ["conn_removed"] } : {}),
                ...(unusedOnlyUnavailable ? { requiredConnectionIds: ["conn_removed"] } : {}),
              },
            });
          case "uninstall_failed":
            return appView(ID, NAME, {
              state: "needs_attention", primaryAction: "retry", screens: [screen],
              latestRun: failedRemoval,
              problems: [
                ...(partialRecovery ? [connectionProblem] : []),
                { code: "run_failed", severity: "error", runId: failedRemoval.id, runType: "destroy_apply" },
              ],
              uninstall: { mode: "none", impact: { usedBy: [] } },
            });
          case "uninstall_stale_review":
            return appView(ID, NAME, {
              ...(installedUninstallReview
                ? { status: "active", state: "installed", primaryAction: "open", screens: [screen] }
                : { status: "uninstalled", state: "uninstalling", primaryAction: "review" }),
              latestRun: { ...recoveryPlan, ...currentUninstallReview },
              progress: { revisionPreparing: false, review: { runId: currentUninstallReview.id, runType: "destroy_plan" } },
              uninstall: installedUninstallReview
                ? { mode: "none", impact: { usedBy: [] } }
                : { mode: "scheduled", graceDays: 7, scheduled: { phase: "destroying", requestedAt: now, deleteAfter, cancellable: false, blocked: true } },
            });
          case "updating":
            return appView(ID, NAME, {
              state: "updating", primaryAction: "none",
              progress: { revisionPreparing: false, run: { id: updateApply.id, type: "apply", status: "running", createdAt: updateApply.createdAt } },
            });
          case "policy_blocked":
            return appView(ID, NAME, {
              state: "needs_attention", primaryAction: "review", screens: [screen, { ...screen, interfaceId: "if_states_docs", name: "app.docs", title: "Docs", url: "https://apps.example.test/state-echo-docs" }],
              problems: [{ code: "policy_blocked", severity: "error", runId: blockedPlan.id, runType: "plan" }],
            });
          case "installing":
            return appView(ID, NAME, {
              status: "pending", applied: false, state: "installing", primaryAction: "review",
              progress: { revisionPreparing: false, review: { runId: installPlan.id, runType: "plan" } },
              uninstall: { mode: "discard" },
            });
          case "install_stalled":
            // The install attempt that owns this app stopped moving.
            return appView(ID, NAME, {
              status: "pending", applied: false, state: "needs_attention", primaryAction: "continue_install",
              problems: [{ code: "install_incomplete", severity: "error" }],
              progress: { revisionPreparing: false, installPlanId: "gip_00000000005ea7e5" },
              uninstall: { mode: "discard" },
            });
          case "awaiting_input":
            // Someone else's install attempt waits for their input.
            return appView(ID, NAME, {
              status: "pending", applied: false, state: "installing", primaryAction: "none",
              progress: { revisionPreparing: true, installPlanId: "gip_states_e", installPlanAwaitingInput: "other" },
              uninstall: { mode: "discard" },
            });
          case "awaiting_your_input":
            // The viewer's own install attempt waits for their input.
            return appView(ID, NAME, {
              status: "pending", applied: false, state: "installing", primaryAction: "none",
              progress: { revisionPreparing: true, installPlanId: "gip_00000000005ea7e5", installPlanAwaitingInput: "viewer" },
              uninstall: { mode: "discard" },
            });
          case "revision_stalled":
            return appView(ID, NAME, {
              screens: [screen],
              version: { current: { sourceSnapshotId: "snap_e", ref: "v1", path: ".", commit: PORTABLE_SOURCE_COMMIT }, updateAvailable: true, stale: false, autoUpdate: false },
              progress: { revisionPreparing: false, revisionPlanId: "grp_states_e" },
            });
          case "revision_stalled_behind_review":
            // A newer change waits for its review while an older one stopped.
            return appView(ID, NAME, {
              screens: [screen],
              version: { current: { sourceSnapshotId: "snap_e", ref: "v1", path: ".", commit: PORTABLE_SOURCE_COMMIT }, updateAvailable: true, stale: false, autoUpdate: false },
              progress: { revisionPreparing: false, revisionPlanId: "grp_states_e", review: { runId: revisionPlanRun.id, runType: "plan" } },
            });
          case "review_pending":
            return appView(ID, NAME, {
              screens: [screen],
              version: { current: { sourceSnapshotId: "snap_e", ref: "v1", path: ".", commit: PORTABLE_SOURCE_COMMIT }, updateAvailable: true, stale: false, autoUpdate: false },
              progress: { revisionPreparing: false, review: { runId: revisionPlanRun.id, runType: "plan" } },
            });
          case "incomplete":
            return appView(ID, NAME, { incomplete: ["screens", "version"], ...(connectionRemoved ? { problems: [connectionProblem] } : {}) });
          case "uninstalled":
            return appView(ID, NAME, {
              // A screen listed for a removed app is never offered.
              status: "destroyed", applied: false, state: "uninstalled", primaryAction: "reinstall", screens: [screen],
              version: { repository: { url: "https://github.com/example/state-echo.git", defaultRef: "main" }, updateAvailable: false, stale: false, autoUpdate: false },
              uninstall: { mode: "none" },
            });
        }
      };

      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (shouldRecordControlPlaneMutation(mode, origin, request.url(), request.method())) {
          seenMutations.push(`${request.method()} ${path}`);
        }
        if (path === "/api/v1/apps") {
          return route.fulfill({ json: { apps: [{
            capsuleId: ID,
            name: NAME,
            role: "owner",
            ownerDisplayName: "Portable E2E",
            state: "installed",
            primaryAction: "open",
          }] } });
        }
        const base = `/api/v1/capsules/${ID}`;
        if (noReplacement && path === "/api/v1/credential-recipes") {
          return route.fulfill({ json: { recipes: REFERENCE_CREDENTIAL_RECIPES } });
        }
        if (noReplacement && path === "/api/v1/connections" && request.method() === "POST") {
          expect(request.postDataJSON()).toMatchObject({
            provider: "cloudflare/cloudflare",
            credentialRecipe: { id: "cloudflare", authMode: "api_token", secretPartition: "provider-credentials" },
            displayName: "Existing Cloudflare connection",
            values: { CLOUDFLARE_API_TOKEN: "fixture-only-token", CLOUDFLARE_ACCOUNT_ID: "fixture-account" },
          });
          replacementAvailable = true;
          return route.fulfill({ status: 201, json: { connection: {
            id: "conn_saved", displayName: "Existing Cloudflare connection", providerSource: connectionProblem.provider,
            scope: "personal", status: "pending",
          } } });
        }
        if (noReplacement && path === "/api/v1/connections/conn_saved/test" && request.method() === "POST") {
          replacementTesting = true;
          await replacementVerification;
          replacementVerified = true;
          return route.fulfill({ json: { status: "verified" } });
        }
        if (path === "/api/v1/connections") return route.fulfill({ json: { connections: [
          { id: "conn_removed", displayName: "Original Cloudflare connection", providerSource: connectionProblem.provider, scope: "personal", status: partialRecovery || (firstRemovalRefusal && connectionRemoved) || unusedUnavailable || noReplacement ? "revoked" : "verified" },
          ...(replacementAvailable ? [{ id: "conn_saved", displayName: "Existing Cloudflare connection", providerSource: connectionProblem.provider, scope: "personal", status: replacementVerified ? "verified" : "pending",
            ...(firstRemovalRefusal ? cloudflareAccount(replacementAccountId, "fixture-team") : {}),
          }] : []),
          ...(firstRemovalRefusal ? [{
            id: "conn_other_account", displayName: "Existing Cloudflare connection", providerSource: connectionProblem.provider,
            scope: "personal", status: "verified", ...cloudflareAccount(otherAccountId, "other-team"),
          }, {
            id: "conn_legacy", displayName: "Older Cloudflare connection", providerSource: connectionProblem.provider,
            scope: "personal", status: "verified", scopeHints: cloudflareAccount(otherAccountId, "other-team").scopeHints,
          }] : []),
          { id: "conn_expired", displayName: "Expired connection", providerSource: connectionProblem.provider, scope: "personal", status: "expired" },
          { id: "conn_aws", displayName: "AWS connection", providerSource: "registry.opentofu.org/hashicorp/aws", scope: "personal", status: "verified" },
          ...(unusedUnavailable || unusedOnlyUnavailable ? [{ id: "conn_unused", displayName: "Unused alias connection", providerSource: connectionProblem.provider, scope: "personal", status: "expired" }] : []),
          ...(scene === "uninstall_failed" ? [{
            id: "conn_second", displayName: "Secondary Cloudflare connection", providerSource: connectionProblem.provider, scope: "personal", status: "verified",
          }] : []),
        ] } });
        if (path === `${base}/destroy-plan` && request.method() === "POST") {
          replacementPlanBodies.push(request.postDataJSON());
          if (scene === "uninstall_stale_review") currentUninstallReview = recoveryPlan;
          if (lostReplacementResponse) {
            return route.fulfill({ status: 502, json: { error: { code: "unavailable", message: "The Plan response was lost." } } });
          }
          return route.fulfill({ status: 201, json: { run: recoveryPlan } });
        }
        if (path === `${base}/members`) return route.fulfill({ json: { owner: { accountId: "sub_portable_e2e", displayName: "Portable E2E", email: "portable-e2e@example.test" }, members: [] } });
        if (firstRemovalRefusal && path === base && request.method() === "DELETE" && url.searchParams.get("immediate") === "true") {
          firstRemovalAttempts += 1;
          connectionRemoved = firstRemovalAttempts === 2;
          return route.fulfill({ status: 409, json: { error: {
            code: "failed_precondition",
            message: connectionRemoved ? "Provider Connection conn_removed status revoked is not verified" : "An unrelated conflict.",
            details: { reason: connectionRemoved ? "provider_connection_not_ready" : "unrelated_conflict" },
          } } });
        }
        if (unusedOnlyUnavailable && path === base && request.method() === "DELETE" && url.searchParams.get("immediate") === "true") {
          return route.fulfill({ status: 201, json: { run: recoveryPlan } });
        }
        if (path === base) return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
        if (path === `${base}/app`) {
          if (firstRemovalAttempts > 0) appReadsAfterFirstRemoval += 1;
          return viewUnavailable
            ? route.fulfill({ status: 404, json: { error: "fixture_route_not_found" } })
            : route.fulfill({ json: { app: view() } });
        }
        if (path === `${base}/runs`) {
          const all = scene === "policy_blocked" ? [blockedPlan, ...[...olderRuns].reverse()] : [];
          const start = Number(url.searchParams.get("cursor") ?? "0");
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const end = start + limit;
          return route.fulfill({ json: { runs: all.slice(start, end), ...(end < all.length ? { nextCursor: String(end) } : {}) } });
        }
        if (attemptAwaitsInput && path.startsWith("/api/v1/install-plans/gip_00000000005ea7e5")) {
          // The attempt waits for the person: it answers the same way to the
          // app page's reconcile and to the install page's read.
          return route.fulfill({ json: {
            installPlan: {
              id: "gip_00000000005ea7e5", workspaceId: "ws_alpha", createdBy: "sub_portable_e2e", operation: "install", mode: "attempt",
              requestDigest: "sha256:states", source: { name: "state-echo", url: "https://github.com/example/state-echo.git", ref: "v1.4.2", path: "." },
              capsule: { name: "state-echo", environment: "production" }, options: {}, phase: "awaiting_input", awaitingInput: "inputs",
              generation: 4, createdAt: now, updatedAt: now,
            },
            nextAction: "none",
            userAction: {
              kind: "provide_inputs", modulePath: ".", resources: [], connections: [], interfaces: [], variables: [],
              name: { current: "state-echo", proposed: "state-echo", conflict: false }, missing: [],
            },
            links: { self: "/api/v1/install-plans/gip_00000000005ea7e5" },
          } });
        }
        if (path === "/api/v1/install-plans/gip_00000000005ea7e5/reconcile" && request.method() === "POST") {
          return route.fulfill({ json: {
            installPlan: {
              id: "gip_00000000005ea7e5", workspaceId: "ws_alpha", phase: "reviewable", generation: 3,
              capsuleId: ID, planRunId: installPlan.id, createdAt: now, updatedAt: now,
            },
            nextAction: "review_run",
            userAction: { kind: "review_run", planRunId: installPlan.id },
            links: { self: "/api/v1/install-plans/gip_00000000005ea7e5", run: `/api/v1/runs/${installPlan.id}` },
          } });
        }
        if (path === "/api/v1/revision-plans/grp_states_e/reconcile" && request.method() === "POST") {
          return route.fulfill({ json: {
            revisionPlan: { id: "grp_states_e", operation: "revision", phase: "reviewable", generation: 4, capsuleId: ID, planRunId: revisionPlanRun.id },
            nextAction: "review_run",
            links: { self: "/api/v1/revision-plans/grp_states_e", run: `/api/v1/runs/${revisionPlanRun.id}` },
          } });
        }
        if (path === `${base}/cancel-uninstall` && request.method() === "POST") {
          scene = "incomplete";
          return route.fulfill({ json: { capsule: capsule() } });
        }
        if (path === `${base}/state-versions`) {
          return route.fulfill({ json: { stateVersions: scene === "installing" || scene === "uninstalled" ? [] : [{ id: "sv_states_e", workspaceId: "ws_alpha", capsuleId: ID, environment: "production", generation: 1, createdByRunId: "run_old_00", createdAt: now }] } });
        }
        if (path === `${base}/provider-bindings` && scene === "uninstall_stale_review") {
          return route.fulfill({ json: { providerBindingSet: {
            id: "pbs_fixture", capsuleId: ID, workspaceId: "ws_alpha", environment: "production",
            bindings: [{ connectionId: "conn_old_missing", provider: connectionProblem.provider }],
          } } });
        }
        if (path === `${base}/provider-bindings` && scene === "uninstall_failed") {
          failedUninstallBindingReads += 1;
          return route.fulfill({ json: { providerBindingSet: {
            id: "pbs_fixture", capsuleId: ID, workspaceId: "ws_alpha", environment: "production",
            bindings: [
              { connectionId: "conn_removed", provider: connectionProblem.provider },
              { connectionId: "conn_second", provider: connectionProblem.provider, rootAlias: "secondary" },
            ],
          } } });
        }
        if (path === `${base}/provider-bindings`) return route.fulfill({ json: { providerBindingSet: null } });
        if (path === `${base}/current-resource-inventory`) return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: ID, workspaceId: "ws_alpha", environment: "production", stateVersionId: "sv_states_e", generation: 1, applyRunId: "run_old_00", planRunId: "run_old_plan", recordedAt: now, availability: "legacy_unavailable" } } });
        if (path === `${base}/usage-summary`) return route.fulfill({ json: { summary: { capsuleId: ID, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
        if (path === "/api/v1/capsule-configs/cfg_states_e") {
          return route.fulfill({ json: { installConfig: { id: "cfg_states_e", workspaceId: "ws_alpha", name: NAME, sourceSelector: { url: "https://github.com/example/state-echo.git", path: "." }, modulePath: "deploy/opentofu", policy: {}, variableMapping: {}, variablePresentation: [], outputAllowlist: {}, interfaceBlueprints: [], createdAt: now, updatedAt: now } } });
        }
        if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: [] } });
        const runMatch = path.match(/^\/api\/v1\/runs\/([^/]+)(\/[a-z]+)?$/u);
        if (runMatch && runsById.has(runMatch[1]!)) {
          const [, id, suffix] = runMatch;
          if (suffix === "/cost") return route.fulfill({ json: { cost: { runId: id, billingMode: "disabled", estimatedUsdMicros: 0, ratingStatus: "not_applicable", blocked: false, reasons: [] } } });
          if (suffix === "/logs") return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (suffix === "/stream") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
          if (startsAwaitingApproval && suffix === "/approve" && id === refusedPlan.id && request.method() === "POST") {
            const approved = { ...refusedPlan, status: "succeeded" as const };
            currentUninstallReview = approved;
            runsById.set(approved.id, approved);
            return route.fulfill({ json: { run: approved } });
          }
          if (suffix === "/apply" && id === refusedPlan.id && request.method() === "POST") {
            if (openReviewFailure) {
              scene = "uninstall_failed";
              return route.fulfill({ status: 201, json: { run: failedRemoval } });
            }
            staleReviewApplyAttempts += 1;
            return route.fulfill({ status: 409, json: { error: {
              code: "failed_precondition",
              message: staleReviewApplyAttempts === 1 ? "An unrelated conflict." : "connection conn_old_missing is revoked (not verified)",
              details: { reason: staleReviewApplyAttempts === 1 ? "unrelated_conflict" : "provider_connection_not_ready" },
            } } });
          }
          if (!suffix) return route.fulfill({ json: { run: runsById.get(id!) } });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      const app = page.getByTestId("app-page");
      const header = page.getByTestId("app-header");
      const problems = page.getByTestId("app-problems");

      if (noReplacement) {
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "danger");
        const danger = page.getByTestId("app-uninstall");
        const choose = danger.getByRole("button", { name: "Choose connection for uninstall" });
        const reviewRemoval = danger.getByRole("button", { name: "Review removal" });
        await choose.click();
        await expect(danger.getByText("No verified connection is available to select.")).toBeVisible();
        await expect(reviewRemoval).toHaveCount(0);
        const viewConnections = danger.getByRole("link", { name: "View cloud connections" });
        await expect(viewConnections).toHaveAttribute("href", `/connections?uninstallApp=${ID}`);
        await viewConnections.click();
        await expect(page).toHaveURL(new RegExp(`/connections\\?uninstallApp=${ID}$`, "u"));
        const backToUninstall = page.getByRole("link", { name: "Back to uninstall", exact: true });
        await expect(backToUninstall).toHaveCount(0);
        // This explicit uninstall intent opens the ordinary connection form.
        // Saving does not make its still-unverified connection a return choice.
        await page.locator("#connection-provider").selectOption({ label: "Cloudflare — API token" });
        await expect(page.locator("#connection-field-CLOUDFLARE_API_TOKEN")).toBeVisible();
        expect(seenMutations).toEqual([]);
        await page.locator("#connection-display-name").fill("Existing Cloudflare connection");
        await page.locator("#connection-field-CLOUDFLARE_API_TOKEN").fill("fixture-only-token");
        await page.locator("#connection-field-CLOUDFLARE_ACCOUNT_ID").fill("fixture-account");
        try {
          await page.getByRole("button", { name: "Save connection", exact: true }).click();
          await expect.poll(() => replacementTesting).toBe(true);
          await expect(backToUninstall).toHaveCount(0);
          await expect(page).toHaveURL(new RegExp(`/connections\\?uninstallApp=${ID}$`, "u"));
          expect(replacementPlanBodies).toEqual([]);
          expect(seenMutations).toEqual(["POST /api/v1/connections", "POST /api/v1/connections/conn_saved/test"]);
        } finally {
          releaseReplacementVerification();
        }
        await expect(backToUninstall).toHaveAttribute("href", `/apps/${ID}`);
        // Verification offers an explicit navigation action; it never returns
        // or chooses the replacement on the person's behalf.
        await expect(page).toHaveURL(new RegExp(`/connections\\?uninstallApp=${ID}$`, "u"));
        await page.getByRole("link", { name: "Connections", exact: true }).click();
        await expect(page).toHaveURL(/\/connections$/u);
        await expect(backToUninstall).toHaveCount(0);
        await page.goBack();
        await expect(page).toHaveURL(new RegExp(`/connections\\?uninstallApp=${ID}$`, "u"));
        await expect(backToUninstall).toHaveAttribute("href", `/apps/${ID}`);
        await backToUninstall.click();
        await expect(page).toHaveURL(new RegExp(`/apps/${ID}$`, "u"));
        await openAppPane(page, "danger");
        await choose.click();
        const choices = danger.getByRole("combobox", { name: "Cloudflare" });
        await expect(choices).toHaveValue("");
        await expect(reviewRemoval).toBeDisabled();
        await choices.selectOption("conn_saved");
        await reviewRemoval.click();
        await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
        expect(replacementPlanBodies).toEqual([{
          destroyProviderConnectionReplacements: [{ connectionId: "conn_removed", replacementConnectionId: "conn_saved" }],
        }]);
        expect(seenMutations).toEqual([
          "POST /api/v1/connections", "POST /api/v1/connections/conn_saved/test",
          `POST /api/v1/capsules/${ID}/destroy-plan`,
        ]);
        expect(errors).toEqual([]);
        traffic.assertNoFailures();
        return;
      }

      if (unusedOnlyUnavailable) {
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "danger");
        await expect(problems.locator('[data-problem="connection_unavailable"]')).toHaveCount(1);
        await expect(problems.locator('[data-problem="connection_unavailable"]')).toContainText("has expired");
        const danger = page.getByTestId("app-uninstall");
        const uninstall = danger.getByRole("button", { name: "Uninstall now", exact: true });
        await expect(uninstall).toBeEnabled();
        await uninstall.click();
        await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
        expect(replacementPlanBodies).toEqual([]);
        expect(seenMutations).toEqual([`DELETE /api/v1/capsules/${ID}`]);
        expect(errors).toEqual([]);
        traffic.assertNoFailures();
        return;
      }

      if (unusedUnavailable) {
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "danger");
        await expect(problems.locator('[data-problem="connection_unavailable"]')).toHaveCount(2);
        const danger = page.getByTestId("app-uninstall");
        await danger.getByRole("button", { name: "Choose connection for uninstall" }).click();
        const choices = danger.getByRole("combobox", { name: "Cloudflare" });
        await expect(choices).toHaveCount(1);
        await choices.selectOption("conn_saved");
        await danger.getByRole("button", { name: "Review removal" }).click();
        await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
        expect(replacementPlanBodies).toEqual([{
          destroyProviderConnectionReplacements: [{ connectionId: "conn_removed", replacementConnectionId: "conn_saved" }],
        }]);
        expect(seenMutations).toEqual([`POST /api/v1/capsules/${ID}/destroy-plan`]);
        expect(errors).toEqual([]);
        traffic.assertNoFailures();
        return;
      }

      if (firstRemovalRefusal) {
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        await openAppPane(page, "danger");
        const danger = page.getByTestId("app-uninstall");
        const uninstall = danger.getByRole("button", { name: "Uninstall now", exact: true });
        const choose = danger.getByRole("button", { name: "Choose connection for uninstall" });
        await uninstall.click();
        await expect(problems.getByRole("alert")).toContainText("An unrelated conflict.");
        await expect(choose).toHaveCount(0);
        expect(appReadsAfterFirstRemoval).toBe(0);

        await uninstall.click();
        await expect(choose).toBeVisible();
        expect(appReadsAfterFirstRemoval).toBe(1);
        expect(seenMutations).toEqual(Array(2).fill(`DELETE /api/v1/capsules/${ID}`));
        await expect(problems.getByRole("alert")).not.toContainText("conn_removed");
        await choose.click();
        const viewConnections = danger.getByRole("link", { name: "View cloud connections" });
        await expect(viewConnections).toBeVisible();
        await expect(viewConnections).toHaveAttribute("href", `/connections?uninstallApp=${ID}`);
        const choices = danger.getByRole("combobox", { name: "Cloudflare" });
        await expect(choices.getByRole("option", { name: `Existing Cloudflare connection · Cloudflare account ${otherAccountId}`, exact: true })).toHaveCount(1);
        await expect(choices.getByRole("option", { name: "Older Cloudflare connection", exact: true })).toHaveCount(1);
        await choices.selectOption({ label: `Existing Cloudflare connection · Cloudflare account ${replacementAccountId}` });
        await danger.getByRole("button", { name: "Review removal" }).click();
        await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
        expect(replacementPlanBodies).toEqual([{
          destroyProviderConnectionReplacements: [{ connectionId: "conn_removed", replacementConnectionId: "conn_saved" }],
        }]);
        expect(seenMutations).toEqual([
          `DELETE /api/v1/capsules/${ID}`, `DELETE /api/v1/capsules/${ID}`, `POST /api/v1/capsules/${ID}/destroy-plan`,
        ]);
        expect(errors).toEqual([]);
        expect(traffic.failures.map(({ kind, url, status }) => ({ kind, path: new URL(url).pathname, status }))).toEqual(
          Array.from({ length: 2 }, () => ({ kind: "response", path: `/api/v1/capsules/${ID}`, status: 409 })),
        );
        return;
      }

      if (partialRecovery) {
        // App issues describe the applied bindings. A different key may
        // have been used for the failed removal of the secondary binding.
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        const failed = problems.locator('[data-problem="uninstall"]');
        await failed.getByRole("button", { name: "Choose connection for uninstall" }).click();
        const original = failed.getByRole("combobox", { name: /Original Cloudflare connection/ });
        const secondary = failed.getByRole("combobox", { name: /Secondary Cloudflare connection/ });
        await expect(secondary).toBeVisible();
        await original.selectOption("conn_saved");
        await secondary.selectOption("conn_saved");
        await failed.getByRole("button", { name: "Review removal" }).click();
        await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
        expect(failedUninstallBindingReads).toBe(1);
        expect(seenMutations).toEqual([`POST /api/v1/capsules/${ID}/destroy-plan`]);
        expect(replacementPlanBodies).toEqual([{
          destroyProviderConnectionReplacements: [
            { connectionId: "conn_removed", replacementConnectionId: "conn_saved" },
            { connectionId: "conn_second", replacementConnectionId: "conn_saved" },
          ],
        }]);
        expect(errors).toEqual([]);
        traffic.assertNoFailures();
        return;
      }

      if (openReviewFailure) {
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        await header.getByRole("button", { name: "Review", exact: true }).click();
        const review = page.getByTestId("app-review");
        await review.getByRole("checkbox").check();
        await review.getByRole("button", { name: "Allow and uninstall" }).click();
        await expect(review.locator(".iv-error")).toBeVisible();
        const choose = review.getByRole("button", { name: "Choose connection for uninstall" });
        expect(failedUninstallBindingReads).toBe(0);
        expect(seenMutations).toEqual([`POST /api/v1/runs/${refusedPlan.id}/apply`]);
        if (indeterminateOpenReview) {
          await expect(app).toHaveAttribute("data-app-state", "needs_attention");
          await expect(choose).toHaveCount(0);
        } else {
          await expect(choose).toBeVisible();
          await expect(problems.getByRole("button", { name: "Choose connection for uninstall" })).toHaveCount(1);
          await choose.click();
          await review.getByRole("combobox", { name: /Original Cloudflare connection/ }).selectOption("conn_saved");
          await review.getByRole("button", { name: "Review removal" }).click();
          await expect(review.getByRole("button", { name: "Approve this change", exact: true })).toBeVisible();
          expect(failedUninstallBindingReads).toBe(1);
          expect(replacementPlanBodies).toEqual([{
            destroyProviderConnectionReplacements: [{ connectionId: "conn_removed", replacementConnectionId: "conn_saved" }],
          }]);
          expect(seenMutations).toEqual([
            `POST /api/v1/runs/${refusedPlan.id}/apply`,
            `POST /api/v1/capsules/${ID}/destroy-plan`,
          ]);
        }
        expect(errors).toEqual([]);
        traffic.assertNoFailures();
        return;
      }

      if (staleUninstallReview) {
        // The reviewed connection was revoked before this Apply was admitted.
        // The server still names the old Plan as the latest review. A new
        // connection can only start a fresh deletion review.
        await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
        const reviewEntry = installedUninstallReview ? problems : header;
        await reviewEntry.getByRole("button", { name: "Review", exact: true }).click();
        const rejectedReview = page.getByTestId("app-review");
        const allowUninstall = rejectedReview.getByRole("button", { name: "Allow and uninstall" });
        await expect(rejectedReview.getByRole("button", { name: "Choose connection for uninstall" })).toHaveCount(0);
        const initialMutations: string[] = [];
        if (startsAwaitingApproval) {
          await rejectedReview.getByRole("button", { name: "Approve this change", exact: true }).click();
          await page.getByRole("dialog", { name: "Run this deletion?" }).getByRole("button", { name: "Approve this change", exact: true }).click();
          initialMutations.push(`POST /api/v1/runs/${refusedPlan.id}/approve`);
        }
        await rejectedReview.getByRole("checkbox").check();
        await allowUninstall.click();
        await expect(rejectedReview.getByRole("alert")).toContainText("An unrelated conflict.");
        const chooseAgain = rejectedReview.getByRole("button", { name: "Choose connection for uninstall" });
        await expect(chooseAgain).toHaveCount(0);

        await allowUninstall.click();
        await expect(rejectedReview.getByRole("alert")).toContainText(
          "The connection used for this review is no longer available. Choose a verified connection for the same cloud account to review removal again.",
        );
        await expect(rejectedReview.getByRole("alert")).not.toContainText("conn_old_missing");
        await expect(allowUninstall).toHaveCount(0);
        expect(seenMutations).toEqual([
          ...initialMutations,
          `POST /api/v1/runs/${refusedPlan.id}/apply`, `POST /api/v1/runs/${refusedPlan.id}/apply`,
        ]);
        await expect(chooseAgain).toBeVisible();
        await chooseAgain.click();
        await rejectedReview.getByRole("combobox", { name: /Cloudflare/ }).selectOption("conn_saved");
        await rejectedReview.getByRole("button", { name: "Review removal" }).click();
        if (lostReplacementResponse) {
          // The old review stays open after the uncertain response, while a
          // read-only app refresh sees the server's new waiting Plan.
          const openSavedReview = reviewEntry.getByRole("button", { name: "Review", exact: true });
          await expect(openSavedReview).toBeEnabled();
          await openSavedReview.click();
        }
        await expect(rejectedReview.getByRole("button", { name: "Approve this change", exact: true })).toBeVisible();
        expect(seenMutations).toEqual([
          ...initialMutations,
          `POST /api/v1/runs/${refusedPlan.id}/apply`, `POST /api/v1/runs/${refusedPlan.id}/apply`,
          `POST /api/v1/capsules/${ID}/destroy-plan`,
        ]);
        expect(replacementPlanBodies.at(-1)).toEqual({
          destroyProviderConnectionReplacements: [{ connectionId: "conn_old_missing", replacementConnectionId: "conn_saved" }],
        });

        expect(errors).toEqual([]);
        expect(traffic.failures.map(({ kind, url, status }) => ({ kind, path: new URL(url).pathname, status }))).toEqual([
          { kind: "response", path: `/api/v1/runs/${refusedPlan.id}/apply`, status: 409 },
          { kind: "response", path: `/api/v1/runs/${refusedPlan.id}/apply`, status: 409 },
          ...(lostReplacementResponse ? [{ kind: "response", path: `/api/v1/capsules/${ID}/destroy-plan`, status: 502 }] : []),
        ]);
        return;
      }

      // Uninstall scheduled: its date, the export note, cancel as the one
      // primary action; uninstalling now stays a secondary choice.
      await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "uninstall_scheduled");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Uninstall is scheduled.");
      await expect(problems.getByRole("heading", { level: 2 })).toHaveText("Uninstall");
      const scheduled = problems.locator('[data-problem="uninstall"]');
      await expect(scheduled).toContainText(`${NAME} will be uninstalled on`);
      await expect(scheduled).toContainText("This server can't export data");
      await expect(scheduled.getByRole("button", { name: "Uninstall now", exact: true })).toBeVisible();
      // During the grace period the app keeps running and stays openable.
      await expect(header.getByRole("link", { name: "Open", exact: true })).toHaveAttribute("href", "https://apps.example.test/state-echo");
      await expect(app.getByTestId("app-uninstall")).toHaveCount(0);
      await expect(appOverviewRow(page, "danger")).toHaveCount(0);
      await capture(page, "app-page-uninstall-scheduled");
      connectionRemoved = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(scheduled).toContainText(`Uninstalling ${NAME} is on hold.`);
      await expect(scheduled).toContainText("The cloud connection for this uninstall was removed.");
      await expect(scheduled.getByRole("link", { name: "View cloud connections" })).toHaveCount(0);
      await expect(scheduled.getByRole("button", { name: "Uninstall now", exact: true })).toHaveCount(0);
      await expect(problems.locator('[data-problem="connection_unavailable"]')).toHaveCount(0);
      await scheduled.getByRole("button", { name: "Choose connection for uninstall" }).click();
      const choices = scheduled.getByRole("combobox", { name: "Cloudflare" });
      await expect(choices.getByRole("option")).toHaveCount(2);
      const preview = scheduled.getByRole("button", { name: "Review removal" });
      await expect(preview).toBeDisabled();
      await choices.selectOption("conn_saved");
      await preview.click();
      await expect(problems.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
      expect(replacementPlanBodies).toEqual([{ destroyProviderConnectionReplacements: [{ connectionId: "conn_removed", replacementConnectionId: "conn_saved" }] }]);
      expect(seenMutations).toEqual([`POST /api/v1/capsules/${ID}/destroy-plan`]);
      await page.reload({ waitUntil: "domcontentloaded" });
      await header.getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(app).toHaveAttribute("data-app-state", "installed");

      // An immediate-mode app with a revoked binding can still start a reviewed
      // recovery plan; it does not skip directly to destructive uninstall.
      scene = "uninstall_immediate";
      await page.reload({ waitUntil: "domcontentloaded" });
      await openAppPane(page, "danger");
      const immediate = page.getByTestId("app-uninstall");
      await expect(immediate.getByRole("button", { name: "Choose connection for uninstall" })).toBeVisible();
      await expect(immediate.getByRole("button", { name: "Uninstall now", exact: true })).toBeDisabled();
      const immediateChoices = immediate.getByRole("combobox", { name: "Cloudflare" });
      await immediate.getByRole("button", { name: "Choose connection for uninstall" }).click();
      await immediateChoices.selectOption("conn_saved");
      const mutationCountBeforeImmediateRecovery = seenMutations.length;
      await immediate.getByRole("button", { name: "Review removal" }).click();
      await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
      expect(seenMutations.slice(mutationCountBeforeImmediateRecovery)).toEqual([`POST /api/v1/capsules/${ID}/destroy-plan`]);

      // A provider-rejected key may still be shown as verified. The
      // chooser lets both bindings use the same verified replacement.
      scene = "uninstall_failed";
      await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });
      const failed = problems.locator('[data-problem="uninstall"]');
      await expect(failed).toContainText("didn't finish");
      expect(failedUninstallBindingReads).toBe(0);
      const mutationCountBeforeRetry = seenMutations.length;
      await failed.getByRole("button", { name: "Choose connection for uninstall" }).click();
      const original = failed.getByRole("combobox", { name: /Original Cloudflare connection/ });
      const secondary = failed.getByRole("combobox", { name: /Secondary Cloudflare connection/ });
      await expect(secondary).toHaveValue("");
      const recovery = failed.getByRole("button", { name: "Review removal" });
      await expect(recovery).toBeDisabled();
      await expect(original.getByRole("option", { name: "Original Cloudflare connection" })).toHaveCount(0);
      await original.selectOption("conn_saved");
      await secondary.selectOption("conn_saved");
      await recovery.click();
      await expect(page.getByTestId("app-review").getByRole("heading", { name: "What uninstalling removes" })).toBeVisible();
      expect(failedUninstallBindingReads).toBe(1);
      expect(seenMutations.slice(mutationCountBeforeRetry)).toEqual([`POST /api/v1/capsules/${ID}/destroy-plan`]);
      expect(replacementPlanBodies.at(-1)).toEqual({
        destroyProviderConnectionReplacements: [
          { connectionId: "conn_removed", replacementConnectionId: "conn_saved" },
          { connectionId: "conn_second", replacementConnectionId: "conn_saved" },
        ],
      });

      scene = "incomplete";
      await page.reload({ waitUntil: "domcontentloaded" });

      // Parts the server could not read say so instead of showing nothing.
      await expect(header.getByRole("alert")).toHaveText("Couldn't read its screens.");
      await expect(header.getByRole("button", { name: "Reload screens", exact: true })).toBeVisible();
      await openAppPane(page, "version");
      await expect(app.getByTestId("app-version")).toContainText("Couldn't read its version");
      await showAppOverview(page);
      await openAppPane(page, "danger");
      // The grace period shows before anything is scheduled, and in the confirmation.
      await expect(app.getByTestId("app-uninstall")).toContainText("Its data stays for 7 days");
      await app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("keeps its data for 7 days");
      await expect(page.getByRole("dialog")).toContainText("The cloud connection for this uninstall was removed.");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
      connectionRemoved = false;

      // An update in progress is followed in place; nothing is applied from here.
      await showAppOverview(page);
      scene = "updating";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "updating");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Applying a change.");
      await expect(problems.getByTestId("app-review")).toContainText("Applying");
      await expect(header.getByRole("button")).toHaveCount(0);
      await capture(page, "app-page-updating");
      // Nothing else changes the app while the server applies a change.
      await openAppPane(page, "danger");
      await expect(app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true })).toBeDisabled();
      await showAppOverview(page);
      await openAppPane(page, "version");
      await expect(app.getByTestId("app-version").getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
      await showAppOverview(page);

      // A policy block names its structured reasons on the card and in history;
      // Review opens the blocked plan in place.
      scene = "policy_blocked";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "needs_attention");
      const blocked = problems.locator('[data-problem="policy_blocked"]');
      await expect(blocked).toContainText("A policy stopped the last change");
      await expect(blocked.getByTestId("policy-reasons")).toContainText("This provider isn't allowed by policy.");
      await expect(blocked.getByTestId("policy-reasons")).toContainText("aws_s3_bucket");
      // Every screen stays reachable as a secondary action beside Review.
      await expect(header.getByRole("link", { name: /^Open\b.*State Echo/u })).toHaveAttribute("href", "https://apps.example.test/state-echo");
      await header.getByRole("button", { name: "Other screens" }).click();
      await expect(header.getByRole("menuitem", { name: "Docs" })).toHaveAttribute("href", "https://apps.example.test/state-echo-docs");
      await page.keyboard.press("Escape");
      await header.getByRole("button", { name: "Review", exact: true }).click();
      const review = problems.getByTestId("app-review");
      await expect(review).toContainText("This can't be applied");
      // The card already names the reasons; the review does not repeat them.
      await expect(review.getByTestId("policy-reasons")).toHaveCount(0);
      await expect(blocked.getByTestId("policy-reasons")).toContainText("Why it was stopped");
      await expect(review.getByRole("button", { name: /^(?:Allow and|Install$)/u })).toHaveCount(0);
      await capture(page, "app-page-policy-blocked");
      await openAppPane(page, "history");
      const historyList = app.getByTestId("app-history-list");
      const blockedRow = historyList.locator('[data-history-kind="policy_blocked"]');
      await expect(blockedRow).toContainText("Stopped by a policy");
      await expect(blockedRow).toContainText("This kind of resource isn't allowed by policy.");
      // History reads the server's pages: Show more appends the next one.
      const historyRows = historyList.locator(":scope > li");
      await expect(historyRows).toHaveCount(20);
      await app.getByTestId("app-history").getByRole("button", { name: "Show more", exact: true }).click();
      await expect(historyRows).toHaveCount(33);
      await expect(app.getByTestId("app-history").getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);

      // A first install waiting for review shows its review in place; only
      // the explicit click would apply it.
      await showAppOverview(page);
      scene = "installing";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "installing");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("The install is waiting for your review.");
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Install", exact: true })).toBeEnabled();
      await expect(header.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
      await openAppPane(page, "danger");
      await expect(app.getByTestId("app-uninstall")).toContainText("hasn't created anything in your cloud yet");
      await showAppOverview(page);
      const mutationsBeforeApprovalWindow = [...seenMutations];
      await page.clock.runFor(3_500);
      expect(seenMutations).toEqual(mutationsBeforeApprovalWindow);
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Install", exact: true })).toBeEnabled();

      // A stalled install is continued through the attempt that owns it, not
      // by planning beside it.
      scene = "install_stalled";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "needs_attention");
      await header.getByRole("button", { name: "Continue installing", exact: true }).click();
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Install", exact: true })).toBeEnabled();

      // An install that waits for the person continues on its own install
      // page, where its sheet asks for what is missing.
      attemptAwaitsInput = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await header.getByRole("button", { name: "Continue installing", exact: true }).click();
      await expect(page).toHaveURL(/\/new\?installPlan=gip_00000000005ea7e5$/u);
      await expect(page.getByTestId("install-configuration")).toBeVisible();
      attemptAwaitsInput = false;
      await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });

      // The person who started an install waiting for input continues it on
      // its install page; the notice links there.
      scene = "awaiting_your_input";
      attemptAwaitsInput = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(problems.locator('[data-progress="awaiting-input"]')).toHaveText("This install still needs your input. Continue it from the install page.");
      await expect(header.getByRole("button")).toHaveCount(0);
      await problems.getByRole("link", { name: "Continue installing", exact: true }).click();
      await expect(page).toHaveURL(/\/new\?installPlan=gip_00000000005ea7e5$/u);
      await expect(page.getByTestId("install-configuration")).toBeVisible();
      attemptAwaitsInput = false;
      await page.goto(`/apps/${ID}`, { waitUntil: "domcontentloaded" });

      // Someone else's install waiting for input says whose input it needs,
      // and offers nothing that cannot advance it.
      scene = "awaiting_input";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "installing");
      await expect(problems.locator('[data-progress="awaiting-input"]')).toHaveText("This install is waiting for input from the person who started it.");
      await expect(header.getByRole("button")).toHaveCount(0);
      await expect(problems.getByRole("link", { name: "Continue installing", exact: true })).toHaveCount(0);

      // A version change whose preparation stopped is continued through its
      // own coordinator and reviewed in place.
      scene = "revision_stalled";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "installed");
      const stalledRevision = problems.locator('[data-problem="revision-stalled"]');
      await expect(stalledRevision).toContainText("Getting an update ready stopped partway");
      await stalledRevision.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Allow and update", exact: true })).toBeEnabled();

      // A stopped version change waits behind a change under review instead
      // of racing it to a second plan.
      scene = "revision_stalled_behind_review";
      await page.reload({ waitUntil: "domcontentloaded" });
      const behindReview = problems.locator('[data-problem="revision-stalled"]');
      await expect(behindReview).toContainText("Another change is under way or waiting for review.");
      await expect(behindReview.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();

      // While a change waits for its review, no second version change starts.
      scene = "review_pending";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(problems.locator('[data-problem="review-waiting"]')).toBeVisible();
      await expect(header.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
      await openAppPane(page, "version");
      await expect(app.getByTestId("app-version").getByRole("button", { name: "Update", exact: true })).toBeDisabled();
      // Settings wait too, and say why.
      await showAppOverview(page);
      await openAppPane(page, "settings");
      await expect(app.getByTestId("app-settings").locator("[data-settings-waits]"))
        .toHaveText("Another change is under way or waiting for review. You can change settings after it finishes.");
      await expect(app.getByTestId("app-settings").getByRole("button", { name: "Review", exact: true })).toBeDisabled();

      // An uninstalled app offers to install it again from its repository.
      await showAppOverview(page);
      scene = "uninstalled";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "uninstalled");
      await expect(header.getByRole("link", { name: /^Open\b/u })).toHaveCount(0);
      const again = header.getByRole("link", { name: "Install again", exact: true });
      const target = new URL((await again.getAttribute("href"))!, "https://dashboard.test");
      expect(target.pathname).toBe("/new");
      expect(target.searchParams.get("git")).toBe("https://github.com/example/state-echo.git");
      // The version it last ran and its module path — not the Source's default ref.
      expect(target.searchParams.get("ref")).toBe("v1.4.2");
      expect(target.searchParams.get("sourcePath")).toBe(".");
      expect(target.searchParams.get("path")).toBe("deploy/opentofu");
      const removedMenu = app.getByTestId("app-management");
      await expect(removedMenu.locator("[data-app-section-link]")).toHaveCount(1);
      await openAppPane(page, "history");
      await expect(app.getByTestId("app-history")).toBeVisible();
      await expect(app.getByTestId("app-uninstall")).toHaveCount(0);
      await showAppOverview(page);

      expect(seenMutations).toEqual([
        `POST /api/v1/capsules/${ID}/destroy-plan`,
        `POST /api/v1/capsules/${ID}/cancel-uninstall`,
        `POST /api/v1/capsules/${ID}/destroy-plan`,
        `POST /api/v1/capsules/${ID}/destroy-plan`,
        "POST /api/v1/install-plans/gip_00000000005ea7e5/reconcile",
        "POST /api/v1/install-plans/gip_00000000005ea7e5/reconcile",
        "POST /api/v1/revision-plans/grp_states_e/reconcile",
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();

      // A server that cannot serve the app view (a skewed deploy) leaves the
      // app unreadable, not missing: only the app's own record says "not found".
      viewUnavailable = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Couldn't load this app" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "App not found" })).toHaveCount(0);
    });

    test("Home preserves app icons and opens only authorized screens", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const ids = ["cap_repository_office", "cap_storage", "cap_blog", "cap_mail", "cap_chat", "cap_old", "cap_failed_preview"] as const;
      let chatDeployed = false;
      const apps = [
        { capsuleId: ids[0], name: PORTABLE_EXPECTATIONS.appName, role: "owner", state: "installed", primaryAction: "open" },
        { capsuleId: ids[1], name: "Object Storage", role: "member", state: "stopped", primaryAction: "view_resources" },
        { capsuleId: ids[2], name: "Team Blog", role: "member", state: "installed", primaryAction: "open" },
        { capsuleId: ids[3], name: "Mail Relay", role: "owner", state: "needs_attention", primaryAction: "retry" },
        { capsuleId: ids[4], name: "Chat", role: "owner", applied: false, state: "installing", primaryAction: "review" },
        { capsuleId: ids[5], name: "Old Wiki", role: "owner", state: "uninstall_scheduled", primaryAction: "open" },
        { capsuleId: ids[6], name: "Failed preview", role: "owner", applied: false, state: "needs_attention", primaryAction: "retry" },
      ];
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/v1/apps") {
          return route.fulfill({ json: { apps: apps.map((app) => app.capsuleId === ids[4] && chatDeployed
            ? { ...app, applied: true, state: "installed", primaryAction: "view_resources", screens: [] } : app) } });
        }
        const appId = ids.find((id) => url.pathname === `/api/v1/capsules/${id}/app`);
        if (appId) {
          const row = apps[ids.indexOf(appId)]!;
          return route.fulfill({ json: { app: appView(appId, row.name, {
            screens: appId === "cap_repository_office" ? [{ interfaceId: "if_launcher", name: "app.launcher", title: PORTABLE_EXPECTATIONS.appName, url: PORTABLE_EXPECTATIONS.appUrl }] : [],
            state: row.state,
            primaryAction: row.primaryAction,
            ...(appId === "cap_blog" ? { version: { updateAvailable: true, stale: true, autoUpdate: false } } : {}),
            uninstall: { mode: "scheduled", graceDays: 7, impact: { usedBy: [] } },
          }) } });
        }
        return route.fallback();
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tiles = page.getByTestId("home-app");
      await expect(tiles).toHaveCount(5);
      // Deployed but stopped or unhealthy apps remain manageable.
      await expect(tiles.nth(0)).toContainText(PORTABLE_EXPECTATIONS.appName);
      await expect(tiles.nth(0)).toHaveAttribute("data-app-opens", "true");
      await expect(tiles.nth(1)).toHaveAttribute("data-app-state", "update_available");
      await expect(tiles.nth(2)).toHaveAttribute("data-app-state", "needs_attention");
      await expect(tiles.nth(3)).toHaveAttribute("data-app-state", "uninstalling");
      await expect(tiles.nth(4)).toHaveAttribute("data-app-state", "stopped");
      const tile = (name: string) => tiles.filter({ hasText: name });
      await expect(tile("Mail Relay")).toContainText("Needs attention");
      await expect(tile("Team Blog")).toContainText("Update available");
      await expect(tile("Chat")).toHaveCount(0);
      await expect(tile("Failed preview")).toHaveCount(0);
      await expect(tile("Old Wiki")).toContainText("Uninstall scheduled");
      // Only the app with an authorized screen opens; it keeps a link to its page.
      const office = tile(PORTABLE_EXPECTATIONS.appName);
      await expect(office.getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in a new tab` })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(office.getByRole("link", { name: `Settings for ${PORTABLE_EXPECTATIONS.appName}` })).toHaveAttribute("href", "/apps/cap_repository_office#settings");
      await expect(office.locator(".av-tile-icon")).toHaveCSS("opacity", "1");
      // Every other tile opens the app page; the state is its description.
      const mail = tile("Mail Relay").getByRole("link", { name: "Mail Relay", exact: true });
      await expect(mail).toHaveAttribute("href", "/apps/cap_mail");
      await expect(mail).toHaveAccessibleDescription("Needs attention");
      // A tile that cannot be used yet is muted; an installed one without a screen is not.
      await expect(tile("Mail Relay").locator(".av-tile-icon")).toHaveCSS("opacity", "0.5");
      await expect(tile("Team Blog").locator(".av-tile-icon")).toHaveCSS("opacity", "1");
      await expect(page.getByTestId("home-apps").getByRole("link", { name: "Find apps", exact: true })).toHaveAttribute("href", "/new");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(tile("Object Storage")).toContainText("Stopped");
      await expect(tile("Object Storage").getByRole("link", { name: /^Open\b/u })).toHaveCount(0);
      await expect(tile("Object Storage").getByRole("link", { name: "Object Storage", exact: true })).toHaveAttribute("href", "/apps/cap_storage");
      await expect(tile("Mail Relay").locator(".av-tile-dot")).toBeVisible();
      await page.setViewportSize({ width: 1200, height: 800 });
      const officeIcon = await office.locator(".av-tile-icon").boundingBox();
      const blogIcon = await tile("Team Blog").locator(".av-tile-icon").boundingBox();
      expect(officeIcon!.width).toBeGreaterThan(96);
      expect(officeIcon!.width).toBe(officeIcon!.height);
      expect(officeIcon!.y).toBe(blogIcon!.y);
      expect(officeIcon!.x).toBeLessThan(blogIcon!.x);
      await capture(page, "home-mixed");
      chatDeployed = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(tile("Chat")).toHaveAttribute("data-app-state", "ready");
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });

    test("Home scrolls continuously across 300 apps without detail requests", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const ids = Array.from({ length: 300 }, (_, i) => `cap_library_${String(i).padStart(3, "0")}`);
      const apps = ids.map((capsuleId, i) => ({
        capsuleId, name: i === 299 ? "Aardvark" : `Library app ${String(i).padStart(3, "0")}`, role: "owner", state: "installed", primaryAction: "open",
        screens: [{ interfaceId: `if_${capsuleId}`, name: "app.launcher", title: `Library app ${String(i).padStart(3, "0")}`, url: PORTABLE_EXPECTATIONS.appUrl }],
      }));
      const pages = new Map<string, number[]>();
      const details: string[] = [];
      const writes: string[] = [];
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/v1/") && request.method() !== "GET") writes.push(request.method());
        if (/\/capsules\/[^/]+\/app$/u.test(path)) details.push(path);
      });
      let releaseTail!: () => void;
      const tailReady = new Promise<void>((resolve) => { releaseTail = resolve; });
      await page.route("**/api/v1/apps**", async (route) => {
        const params = new URL(route.request().url()).searchParams;
        const query = params.get("q") ?? "";
        const offset = Number(params.get("cursor") ?? 0);
        pages.set(query, [...(pages.get(query) ?? []), offset]);
        if (!query && offset === 50) await tailReady;
        const matches = query ? apps.filter((app) => app.name.toLowerCase().includes(query)) : apps;
        await route.fulfill({ json: {
          apps: matches.slice(offset, offset + 50),
          ...(query ? { appliedQuery: query } : {}),
          ...(offset + 50 < matches.length ? { nextCursor: String(offset + 50) } : {}),
        } });
      });
      const rows = page.getByTestId("home-app");
      try {
        await page.goto("/", { waitUntil: "domcontentloaded" });
        const first = rows.filter({ hasText: "Library app 000" });
        await expect(first.getByRole("link", { name: "Open Library app 000 in a new tab" })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
        expect(pages.get("")).toEqual([0]);
        await expect(page.getByRole("button", { name: "More apps", exact: true })).toHaveCount(0);
        const before = await first.boundingBox();
        await first.locator("a").first().focus();
        await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
        await expect.poll(() => pages.get("")).toEqual([0, 50]);
        expect(await rows.count()).toBeLessThan(60);
        await expect(first.locator("a").first()).toBeFocused();
        releaseTail();
        await expect(rows.filter({ hasText: "Library app 050" })).toHaveCount(1);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        await expect(first).toBeVisible();
        await expect.poll(() => first.boundingBox()).toEqual(before);

        const search = page.getByRole("searchbox", { name: "Search your apps" });
        await search.fill("Aardvark");
        await expect(rows).toHaveCount(1);
        await expect(rows.getByRole("link", { name: "Open Aardvark in a new tab" })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
        expect(pages.get("aardvark")).toEqual([0]);
        expect(pages.get("")).not.toContain(250);
        await page.getByRole("button", { name: "Clear search" }).click();
        await expect(first).toBeVisible();
        expect(await rows.count()).toBeLessThan(60);
        expect(details).toEqual([]);
        expect(writes).toEqual([]);
      } finally { releaseTail(); }
    });

    test("Home retries an incomplete collection without requesting app details", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      let reads = 0;
      const details: string[] = [];
      page.on("request", (request) => { if (/\/capsules\/[^/]+\/app$/u.test(new URL(request.url()).pathname)) details.push(request.url()); });
      await page.route("**/api/v1/apps", (route) => route.fulfill({ json: { apps: [{
        capsuleId: "cap_partial_collection", name: "Fixture", role: "owner", state: "installed", primaryAction: "open",
        screens: ++reads === 1 ? [] : [{ interfaceId: "if_fixture", name: "app.launcher", url: PORTABLE_EXPECTATIONS.appUrl }],
        ...(reads === 1 ? { incomplete: ["screens"] } : {}),
      }] } }));
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Some launch links couldn't be loaded.")).toBeVisible();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(page.getByRole("link", { name: "Open Fixture in a new tab" })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(page.getByText("Some launch links couldn't be loaded.")).toHaveCount(0);
      expect(reads).toBe(2);
      expect(details).toEqual([]);
    });

    test("Home keeps long localized names and captions inside their rows", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const apps = Array.from({ length: 60 }, (_, i) => ({
        capsuleId: `cap_long_${i}`, name: `共有されたアプリのとても長い名前を持つテスト ${i}`, role: "member", ownerDisplayName: "とても長い名前の共有元チームの担当者",
        state: "needs_attention", primaryAction: "retry", screens: [{ interfaceId: `if_long_${i}`, name: "app.launcher", url: PORTABLE_EXPECTATIONS.appUrl }],
      }));
      await page.route("**/api/v1/apps", (route) => route.fulfill({ json: { apps } }));
      await page.goto("/", { waitUntil: "domcontentloaded" });
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(size);
        const columns = () => page.locator(".av-home-grid").evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length);
        await expect.poll(columns).toBeGreaterThanOrEqual(3);
        await expect.poll(() => page.getByTestId("home-app").evaluateAll((tiles) => tiles.every((tile) => {
          const row = tile.getBoundingClientRect();
          const content = tile.querySelector(".av-tile-wrap")!.getBoundingClientRect();
          return content.bottom <= row.bottom + 1 && content.top >= row.top - 1;
        }))).toBe(true);
        await expectNoHorizontalOverflow(page, "long Home names");
      }
    });

    test("Home keeps a usable screen during a partial read and retries only that app", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      let inventoryReads = 0;
      let appReads = 0;
      const id = "cap_library_partial";
      await page.route("**/api/v1/apps", (route) => {
        inventoryReads++;
        return route.fulfill({ json: { apps: [
          { capsuleId: id, name: "Fixture app", role: "owner", state: "installed", primaryAction: "open" },
        ] } });
      });
      await page.route(`**/api/v1/capsules/${id}/app`, (route) => {
        appReads++;
        return route.fulfill({ json: { app: appView(id, "Fixture app", {
          incomplete: appReads === 1 ? ["screens"] : ["version"],
          screens: [
            { interfaceId: "if_invalid", name: "invalid", url: "not-a-url" },
            { interfaceId: "if_fixture", name: "app.launcher", title: "Fixture app", url: PORTABLE_EXPECTATIONS.appUrl },
          ],
        }) } });
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const open = page.getByRole("link", { name: "Open Fixture app in a new tab" });
      await expect(open).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(page.getByText("Some launch links couldn't be loaded.")).toBeVisible();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => appReads).toBe(2);
      await expect(page.getByText("Some launch links couldn't be loaded.")).toHaveCount(0);
      await expect(open).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      expect(inventoryReads).toBe(1);
    });

    test("Home keeps app icons, searches without app detail reads and goes straight to settings", async ({ page, baseURL }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "ja"));
      const errors = pageErrors(page);
      const reads: string[] = [];
      const mutations: string[] = [];
      page.on("request", (request) => {
        if (!new URL(request.url()).pathname.startsWith("/api/v1/")) return;
        (request.method() === "GET" ? reads : mutations).push(request.url());
      });
      const iconUrl = `${baseURL}/__e2e/home-icon.svg`;
      const brokenIcon = `${baseURL}/__e2e/missing-icon.svg`;
      await page.route(iconUrl, (route) => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#264b69"/><path d="M18 16h28v32H18z" fill="#ffffff"/></svg>' }));
      await page.route(brokenIcon, (route) => route.fulfill({ status: 404, body: "missing" }));
      const appSearches: string[] = [];
      await page.route("**/api/v1/apps**", async (route) => {
        const query = new URL(route.request().url()).searchParams.get("q") ?? "";
        appSearches.push(query);
        const apps = PORTABLE_APPS.map((app) => ({
          ...app,
          ...(app.capsuleId !== CAPSULE_ID ? { iconUrl: brokenIcon } : {}),
          screens: [{
            interfaceId: `if_${app.capsuleId}`, name: "app.launcher", title: app.name, url: PORTABLE_EXPECTATIONS.appUrl,
            icon: app.capsuleId === CAPSULE_ID ? { kind: "image", url: iconUrl } : { kind: "glyph", glyph: "📚" },
          }],
        })).filter((app) => [app.name, app.ownerDisplayName].some((value) => value.toLowerCase().includes(query)));
        await route.fulfill({ json: { apps, ...(query ? { appliedQuery: query } : {}) } });
      });
      await page.goto("/");
      const tiles = page.getByTestId("home-app");
      const office = tiles.filter({ hasText: PORTABLE_EXPECTATIONS.appName });
      const shared = tiles.filter({ hasText: "Beta Office" });
      await expect(office.locator("img")).toHaveAttribute("src", iconUrl);
      await expect(office.locator("img")).toHaveJSProperty("naturalWidth", 64);
      await expect(office.locator("img")).toHaveAttribute("referrerpolicy", "no-referrer");
      await expect(shared.locator(".av-tile-emoji")).toHaveText("📚");
      await expect(shared.locator("img")).toHaveCount(0);
      const search = page.getByRole("searchbox", { name: "アプリを検索" });
      for (const [typed, query, match] of [
        ["  repository  ", "repository", office], ["hanako", "hanako", shared],
      ] as const) {
        const response = page.waitForResponse((candidate) => {
          const url = new URL(candidate.url());
          return url.pathname === "/api/v1/apps" && url.searchParams.get("q") === query;
        });
        await search.fill(typed);
        await response;
        await expect(tiles).toHaveCount(1);
        await expect(match).toBeVisible();
      }
      await search.fill("見つからない名前");
      await expect(tiles).toHaveCount(0);
      await expect(page.getByRole("status")).toContainText("該当するアプリがありません");
      await page.getByRole("button", { name: "検索をクリア" }).click();
      await expect(search).toBeFocused();
      await expect(tiles).toHaveCount(2);
      // Clearing search restores the cached browse page without an extra read.
      expect(appSearches).toEqual(["", "repository", "hanako", "見つからない名前"]);
      expect(reads.filter((request) => /\/capsules\/[^/]+\/app$/u.test(new URL(request).pathname))).toEqual([]);
      await search.blur();
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        await expectNoHorizontalOverflow(page, `Home at ${width}px`);
        const settings = office.getByRole("link", { name: `${PORTABLE_EXPECTATIONS.appName} の設定` });
        const box = await settings.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        await page.screenshot({ path: test.info().outputPath(`home-clarity-${width}.png`), fullPage: true, animations: "disabled" });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
      await page.screenshot({ path: test.info().outputPath("home-clarity-light-390.png"), fullPage: true, animations: "disabled" });
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await office.getByRole("link", { name: `${PORTABLE_EXPECTATIONS.appName} の設定` }).click();
      await expect(page).toHaveURL(/#settings$/u);
      await expect(page.locator("#settings")).toBeInViewport();
      await expect(page.getByTestId("app-page")).toHaveAttribute("data-app-section", "settings");
      await expect(page.getByTestId("app-phone")).not.toBeVisible();
      await showAppOverview(page);
      await expect(appOverviewRow(page, "settings")).toBeFocused();
      expect(mutations).toEqual([]);
      expect(errors).toEqual([]);
    });

    test("use on your phone: QR code, share and copy of the screen Open offers, and both phones' steps", async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem("tg_lang", "en");
        // A share sheet and clipboard the test can read, on any host browser.
        const record = window as unknown as { phoneShares: unknown[]; phoneCopies: string[] };
        record.phoneShares = [];
        record.phoneCopies = [];
        Object.defineProperty(Navigator.prototype, "share", {
          configurable: true,
          value: async (data: unknown) => { record.phoneShares.push(data); },
        });
        Object.defineProperty(Navigator.prototype, "canShare", { configurable: true, value: () => true });
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (text: string) => { record.phoneCopies.push(text); } },
        });
      });
      // The portable fixture's own app view and screen. The fixture does not
      // answer every per-app read, so this case checks page errors only.
      const errors = pageErrors(page);
      await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      await openAppPane(page, "phone");
      const phone = page.getByTestId("app-phone");
      await expect(phone.getByRole("heading", { name: "Use on your phone" })).toBeVisible();
      await expect(phone.getByRole("img", { name: `QR code that opens ${PORTABLE_EXPECTATIONS.appName}` })).toBeVisible();
      await expect(phone.getByTestId("app-phone-url")).toHaveText(PORTABLE_EXPECTATIONS.appUrl);
      await expect(phone).toContainText("People who only use this app just need this URL.");
      // Both phones' steps are on screen; nothing waits behind a disclosure.
      await expect(phone.getByText("iPhone and iPad (Safari)", { exact: true })).toBeVisible();
      await expect(phone.getByText("Android (Chrome)", { exact: true })).toBeVisible();
      await expect(phone.locator("details, summary, [aria-expanded]")).toHaveCount(0);
      await expect(phone.locator(".tg-btn-primary")).toHaveCount(0);

      await phone.getByRole("button", { name: "Copy URL", exact: true }).click();
      await expect(phone.getByRole("status")).toHaveText("URL copied.");
      expect(await page.evaluate(() => (window as unknown as { phoneCopies: string[] }).phoneCopies))
        .toEqual([PORTABLE_EXPECTATIONS.appUrl]);
      await phone.getByRole("button", { name: "Share URL", exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as unknown as { phoneShares: unknown[] }).phoneShares))
        .toEqual([{ title: PORTABLE_EXPECTATIONS.appName, url: PORTABLE_EXPECTATIONS.appUrl }]);

      await phone.scrollIntoViewIfNeeded();
      await capture(page, "app-phone-section");
      expect(errors).toEqual([]);
    });

    registerPhoneOpenCases();
  });
}

// --- how a screen opens on a phone (TASK-0119 step 4) --------------------------------

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const PHONE_VIEWPORT = { width: 390, height: 844 };
const APP_ORIGIN_ENCODED = encodeURIComponent(new URL(PORTABLE_EXPECTATIONS.appUrl).origin);
const YURUCOMMU_OPEN = `yurucommu://connect?host_url=${APP_ORIGIN_ENCODED}&product=yurucommu`;
const OPEN_CHOICE_KEY_PREFIX = "takosumi.openChoice.v1";

/** `screens[].clients` as the server returns them for a trusted app. */
const VERIFIED_CLIENTS = {
  preferred: "native",
  ios: {
    verified: true, trustedClientId: "yurucommu-mobile", target: { scheme: "yurucommu" }, name: "Yurucommu",
    appStoreId: "1234567890", bundleId: "com.yurucommu", open: YURUCOMMU_OPEN,
    storeUrl: "https://apps.apple.com/app/id1234567890",
  },
  android: {
    verified: true, trustedClientId: "yurucommu-mobile", target: { package: "com.yurucommu", scheme: "yurucommu" },
    name: "Yurucommu", package: "com.yurucommu", open: YURUCOMMU_OPEN,
    storeUrl: "https://play.google.com/store/apps/details?id=com.yurucommu",
  },
};

/** An app no operator registered: unverified, without a name. */
const UNVERIFIED_CLIENTS = {
  preferred: "web",
  android: {
    verified: false, target: { package: "com.example.notes", scheme: "notes" }, package: "com.example.notes",
    open: `notes://open?u=${APP_ORIGIN_ENCODED}`,
    storeUrl: "https://play.google.com/store/apps/details?id=com.example.notes",
  },
};

/**
 * The portable fixture's own app view of the office app, with `clients` on
 * its launcher screen (read on every request when given as a function, so a
 * test can change it between loads). Resolves to that screen's interface id.
 */
async function withScreenClients(page: Page | BrowserContext, clients: unknown): Promise<() => string> {
  let interfaceId = "";
  await page.route(`**/api/v1/capsules/${CAPSULE_ID}/app`, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { app: { screens: { interfaceId: string; clients?: unknown }[] } };
    const screen = body.app.screens[0]!;
    interfaceId = screen.interfaceId;
    screen.clients = typeof clients === "function" ? (clients as () => unknown)() : clients;
    await route.fulfill({ response, json: body });
  });
  return () => interfaceId;
}

/** English, the app's web page answered offline, and native links never actually followed. */
async function preparePhone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("tg_lang", "en");
    // Following an intent: or custom-scheme link would leave the test; the
    // click still reaches the page's own handlers.
    window.addEventListener("click", (event) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href") ?? "";
      if (/^(intent|yurucommu|notes):/u.test(href)) event.preventDefault();
    }, true);
  });
  await page.context().route(`${new URL(PORTABLE_EXPECTATIONS.appUrl).origin}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>app</title>" }));
}

async function storedChoice(page: Page, interfaceId: string): Promise<unknown> {
  return await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, `${OPEN_CHOICE_KEY_PREFIX}:${CAPSULE_ID}:${interfaceId}`);
}

function registerPhoneOpenCases() {
  test.describe("on an Android phone", () => {
    test.use({ userAgent: ANDROID_UA, viewport: PHONE_VIEWPORT, hasTouch: true });

    test("a verified native app opens from Home and Open through an intent link pinned to its package, back to the chooser when missing", async ({ page, baseURL }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      const screenId = await withScreenClients(page, VERIFIED_CLIENTS);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tile = page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName });
      const tileOpen = tile.getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` });
      await expect(tileOpen).toHaveAttribute("data-open-route", "native");
      const fallbackPath = `/apps/${CAPSULE_ID}?open=${encodeURIComponent(screenId())}&missing=1#phone`;
      const intent = `intent://connect?host_url=${APP_ORIGIN_ENCODED}&product=yurucommu` +
        `#Intent;scheme=yurucommu;package=com.yurucommu;S.browser_fallback_url=${encodeURIComponent(new URL(fallbackPath, baseURL).href)};end`;
      await expect(tileOpen).toHaveAttribute("href", intent);
      // A link the person taps in place; the web opens in a new tab only.
      expect(await tileOpen.getAttribute("target")).toBeNull();

      // Chrome's fallback when the app is missing: the chooser, saying so.
      await page.goto(fallbackPath, { waitUntil: "domcontentloaded" });
      const phone = page.getByTestId("app-phone");
      await expect(phone.getByRole("heading", { name: "Use on your phone" })).toBeVisible();
      await expect(phone.getByTestId("app-phone-missing")).toHaveText(
        "Yurucommu didn't open. If it isn't installed, get it from the store or open the app in your browser.",
      );
      // The notice stays; the URL no longer claims the app failed to open.
      await expect(page).toHaveURL(new URL(`/apps/${CAPSULE_ID}#phone`, baseURL).href);
      await expect(phone.getByTestId("app-phone-missing")).toBeVisible();
      const native = phone.getByTestId("app-phone-native");
      await expect(native).toHaveAttribute("data-verified", "true");
      await expect(native).toContainText("Notifications: the native app receives them.");
      await expect(native).toContainText(`Connects to: ${new URL(PORTABLE_EXPECTATIONS.appUrl).host}`);
      await expect(native.getByRole("link", { name: "Open in Yurucommu", exact: true })).toHaveAttribute("href", intent);
      await expect(native.getByRole("link", { name: "Get it on Google Play", exact: true }))
        .toHaveAttribute("href", "https://play.google.com/store/apps/details?id=com.yurucommu");
      // The design's order: native app, web, QR and sharing, remember.
      expect(await phone.evaluate((root) =>
        ["app-phone-native", "app-phone-web", "app-phone-share", "app-phone-remember"]
          .map((id) => root.querySelector(`[data-testid="${id}"]`))
          .every((node, index, nodes) => node !== null && (index === 0 || (nodes[index - 1]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)),
      )).toBe(true);
      await expect(phone.locator("details, summary, [aria-expanded]")).toHaveCount(0);
      await expectNoHorizontalOverflow(page, "the Android chooser at 390px");
      await phone.screenshot({ path: test.info().outputPath("app-phone-chooser-android.png") });

      // Remember "Open in browser": Home and Open follow it until it is forgotten.
      await phone.getByRole("checkbox", { name: "Remember on this device" }).check();
      const popup = page.context().waitForEvent("page");
      await phone.getByTestId("app-phone-web").getByRole("link", { name: "Open in browser", exact: true }).click();
      await (await popup).close();
      expect(await storedChoice(page, screenId())).toEqual({ choice: "web" });
      await expect(phone.getByTestId("app-phone-remembered")).toContainText("This device remembers “Open in browser”.");
      const headerOpen = page.getByTestId("app-primary").locator(".ap-open");
      await expect(headerOpen).toHaveAttribute("data-open-route", "web");
      await expect(page.getByTestId("app-open-change")).toBeVisible();
      await phone.getByRole("button", { name: "Forget this choice", exact: true }).click();
      expect(await storedChoice(page, screenId())).toBeNull();
      await expect(headerOpen).toHaveAttribute("data-open-route", "native");
      expect(errors).toEqual([]);
    });

    test("an unverified native app shows where it goes, opens only after confirming, and is never remembered", async ({ page }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      const screenId = await withScreenClients(page, UNVERIFIED_CLIENTS);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tile = page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName });
      const tileOpen = tile.getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in a new tab` });
      await expect(tileOpen).toHaveAttribute("data-open-route", "web");
      await expect(tileOpen).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);

      await page.goto(`/apps/${CAPSULE_ID}#phone`, { waitUntil: "domcontentloaded" });
      const native = page.getByTestId("app-phone-native");
      await expect(native).toHaveAttribute("data-verified", "false");
      // A neutral label naming where it goes, never the screen's title.
      await expect(native.getByRole("heading")).toContainText("Unverified app (com.example.notes)");
      await expect(native.getByRole("heading")).not.toContainText(PORTABLE_EXPECTATIONS.appName);
      const target = native.getByTestId("app-phone-target");
      await expect(target).toContainText("Android package: com.example.notes");
      await expect(target).toContainText("Link scheme: notes:");
      await expect(target).toContainText("Store link goes to: play.google.com/store/apps/details?id=com.example.notes");
      // No link reaches the app until the person confirms.
      await expect(page.locator('a[href^="intent:"]')).toHaveCount(0);
      await page.getByRole("checkbox", { name: "Remember on this device" }).check();
      await native.getByRole("button", { name: "Open in unverified app (com.example.notes)", exact: true }).click();
      const confirm = native.getByTestId("app-phone-confirm");
      await expect(confirm).toContainText("Open the unverified app (com.example.notes)?");
      const confirmed = confirm.getByRole("link", { name: "Open", exact: true });
      await expect(confirmed).toBeFocused();
      const href = await confirmed.getAttribute("href");
      expect(href?.startsWith(`intent://open?u=${APP_ORIGIN_ENCODED}#Intent;scheme=notes;package=com.example.notes;`)).toBe(true);
      await confirmed.click();
      // Confirming opened it once; nothing was remembered.
      expect(await storedChoice(page, screenId())).toBeNull();
      await expect(page.getByTestId("app-primary").locator(".ap-open")).toHaveAttribute("data-open-route", "web");
      await expectNoHorizontalOverflow(page, "the unverified chooser at 390px");
      expect(errors).toEqual([]);
    });
  });

  test.describe("on an Android phone, more", () => {
    test.use({ userAgent: ANDROID_UA, viewport: PHONE_VIEWPORT, hasTouch: true });

    test("an App Link alone still opens through an intent link pinned to the package, keeping its fragment", async ({ page, baseURL }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      const appLink = `https://open.yurucommu.example/connect#host_url=${APP_ORIGIN_ENCODED}`;
      const { open: _open, ...android } = VERIFIED_CLIENTS.android;
      const screenId = await withScreenClients(page, {
        preferred: "native",
        android: { ...android, target: { package: "com.yurucommu", host: "open.yurucommu.example" }, appLink },
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tileOpen = page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName })
        .getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` });
      await expect(tileOpen).toHaveAttribute("data-open-route", "native");
      const fallback = new URL(`/apps/${CAPSULE_ID}?open=${encodeURIComponent(screenId())}&missing=1#phone`, baseURL).href;
      await expect(tileOpen).toHaveAttribute(
        "href",
        `intent://open.yurucommu.example/connect#host_url=${APP_ORIGIN_ENCODED}` +
          `#Intent;scheme=https;package=com.yurucommu;S.browser_fallback_url=${encodeURIComponent(fallback)};end`,
      );
      expect(errors).toEqual([]);
    });

    test("a remembered native app is ignored once the app is no longer verified, and can be forgotten", async ({ page }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      let clients: unknown = VERIFIED_CLIENTS;
      const screenId = await withScreenClients(page, () => clients);
      await page.goto(`/apps/${CAPSULE_ID}#phone`, { waitUntil: "domcontentloaded" });
      const phone = page.getByTestId("app-phone");
      await phone.getByRole("checkbox", { name: "Remember on this device" }).check();
      await phone.getByTestId("app-phone-native").getByRole("link", { name: "Open in Yurucommu", exact: true }).click();
      expect(await storedChoice(page, screenId())).toEqual({
        choice: "native", platform: "android", trustedClientId: "yurucommu-mobile",
        target: { package: "com.yurucommu", scheme: "yurucommu" },
      });

      // The operator no longer trusts it: the same declaration comes back unverified.
      clients = {
        preferred: "web",
        android: {
          ...VERIFIED_CLIENTS.android, verified: false, trustedClientId: undefined, name: undefined,
        },
      };
      await page.reload({ waitUntil: "domcontentloaded" });
      const native = phone.getByTestId("app-phone-native");
      await expect(native).toHaveAttribute("data-verified", "false");
      await expect(page.getByTestId("app-primary").locator(".ap-open")).toHaveAttribute("data-open-route", "web");
      await expect(phone.getByTestId("app-phone-remembered"))
        .toContainText("The native app this device remembered no longer matches this screen, so it isn't used.");
      await expect(page.locator('a[href^="intent:"]')).toHaveCount(0);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName })
        .getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in a new tab` })).toHaveAttribute("data-open-route", "web");
      await page.goto(`/apps/${CAPSULE_ID}#phone`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("app-open-change").click();
      await phone.getByRole("button", { name: "Forget this choice", exact: true }).click();
      expect(await storedChoice(page, screenId())).toBeNull();
      expect(errors).toEqual([]);
    });

    test("two tabs showing the chooser do not wake each other: no probe writes after loading, and a choice reaches the other tab", async ({ context }) => {
      await context.addInitScript(() => {
        const record = window as unknown as { probeWrites: number };
        record.probeWrites = 0;
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (String(key) === "takosumi.openChoice.v1:probe") record.probeWrites += 1;
          return setItem.call(this, key, value);
        };
      });
      const screenId = await withScreenClients(context, VERIFIED_CLIENTS);
      const pages: Page[] = [];
      for (let index = 0; index < 2; index += 1) {
        const tab = await context.newPage();
        await preparePhone(tab);
        await tab.goto(`/apps/${CAPSULE_ID}#phone`, { waitUntil: "domcontentloaded" });
        await expect(tab.getByTestId("app-phone-remember")).toBeVisible();
        pages.push(tab);
      }
      const probes = () => Promise.all(pages.map((tab) => tab.evaluate(() => (window as unknown as { probeWrites: number }).probeWrites)));
      const settled = await probes();
      expect(settled.every((count) => count <= 1)).toBe(true);
      await pages[0]!.waitForTimeout(1500);
      expect(await probes()).toEqual(settled);

      // A real choice in one tab still reaches the other.
      const [first, second] = pages as [Page, Page];
      await first.getByRole("checkbox", { name: "Remember on this device" }).check();
      await first.getByTestId("app-phone-native").getByRole("link", { name: "Open in Yurucommu", exact: true }).click();
      expect(await storedChoice(first, screenId())).not.toBeNull();
      await expect(second.getByTestId("app-phone-remembered")).toContainText("This device remembers “Open in Yurucommu”.");
      await first.waitForTimeout(500);
      expect(await probes()).toEqual(settled);
    });
  });

  test.describe("on an iPhone", () => {
    test.use({ userAgent: IPHONE_UA, viewport: PHONE_VIEWPORT, hasTouch: true });

    test("a custom scheme opens the chooser until the person chooses and remembers the native app", async ({ page }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      const screenId = await withScreenClients(page, VERIFIED_CLIENTS);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tile = page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName });
      const tileOpen = tile.getByRole("link", { name: `Choose how to open ${PORTABLE_EXPECTATIONS.appName}` });
      await expect(tileOpen).toHaveAttribute("data-open-route", "choose");
      await expect(tileOpen).toHaveAttribute("href", `/apps/${CAPSULE_ID}?open=${encodeURIComponent(screenId())}#phone`);
      await tileOpen.click();
      // The chooser opened for that screen; its query then leaves the URL.
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#phone$`, "u"));
      const phone = page.getByTestId("app-phone");
      await expect(phone.getByTestId("app-phone-native")).toBeInViewport();
      await expect(phone.getByTestId("app-phone-missing")).toHaveCount(0);
      const native = phone.getByTestId("app-phone-native");
      await expect(native.getByRole("link", { name: "Open in Yurucommu", exact: true })).toHaveAttribute("href", YURUCOMMU_OPEN);
      await expect(native.getByRole("link", { name: "Get it on the App Store", exact: true }))
        .toHaveAttribute("href", "https://apps.apple.com/app/id1234567890");
      // The header's Open goes to the same chooser while nothing is chosen.
      const headerOpen = page.getByTestId("app-primary").locator(".ap-open");
      await expect(headerOpen).toHaveAttribute("data-open-route", "choose");
      await expectNoHorizontalOverflow(page, "the iPhone chooser at 390px");
      await phone.screenshot({ path: test.info().outputPath("app-phone-chooser-iphone.png") });

      await phone.getByRole("checkbox", { name: "Remember on this device" }).check();
      await native.getByRole("link", { name: "Open in Yurucommu", exact: true }).click();
      expect(await storedChoice(page, screenId()))
        .toEqual({ choice: "native", platform: "ios", trustedClientId: "yurucommu-mobile", target: { scheme: "yurucommu" } });
      await expect(phone.getByTestId("app-phone-remembered")).toContainText("This device remembers “Open in Yurucommu”.");
      // From now on Open and the tile open the app directly.
      await expect(headerOpen).toHaveAttribute("data-open-route", "native");
      await expect(headerOpen.getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` }))
        .toHaveAttribute("href", YURUCOMMU_OPEN);
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName })
        .getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` })).toHaveAttribute("href", YURUCOMMU_OPEN);
      expect(errors).toEqual([]);
    });

    test("a universal link opens directly from Home and Open as a plain tapped link", async ({ page }) => {
      await preparePhone(page);
      const errors = pageErrors(page);
      const universalLink = `https://open.yurucommu.example/connect#host_url=${APP_ORIGIN_ENCODED}`;
      await withScreenClients(page, {
        ...VERIFIED_CLIENTS,
        ios: { ...VERIFIED_CLIENTS.ios, target: { scheme: "yurucommu", host: "open.yurucommu.example" }, universalLink },
      });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      const tileOpen = page.getByTestId("home-app").filter({ hasText: PORTABLE_EXPECTATIONS.appName })
        .getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` });
      await expect(tileOpen).toHaveAttribute("data-open-route", "native");
      await expect(tileOpen).toHaveAttribute("href", universalLink);
      expect(await tileOpen.getAttribute("target")).toBeNull();
      await page.goto(`/apps/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      const headerOpen = page.getByTestId("app-primary").locator(".ap-open");
      await expect(headerOpen).toHaveAttribute("data-open-route", "native");
      await expect(headerOpen.getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in Yurucommu` }))
        .toHaveAttribute("href", universalLink);
      await openAppPane(page, "phone");
      await expect(page.getByTestId("app-phone-native").getByRole("link", { name: "Open in Yurucommu", exact: true }))
        .toHaveAttribute("href", universalLink);
      expect(errors).toEqual([]);
    });

    test("without storage nothing is remembered and each tap uses the default", async ({ page }) => {
      await page.addInitScript(() => {
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (String(key).startsWith("takosumi.openChoice")) throw new DOMException("blocked", "SecurityError");
          return setItem.call(this, key, value);
        };
      });
      await preparePhone(page);
      const errors = pageErrors(page);
      await withScreenClients(page, VERIFIED_CLIENTS);
      await page.goto(`/apps/${CAPSULE_ID}#phone`, { waitUntil: "domcontentloaded" });
      const phone = page.getByTestId("app-phone");
      await expect(phone.getByTestId("app-phone-no-storage"))
        .toHaveText("This browser can't remember how to open apps, so the default is used each time.");
      await expect(phone.getByRole("checkbox")).toHaveCount(0);
      await phone.getByRole("link", { name: "Open in Yurucommu", exact: true }).click();
      await expect(page.getByTestId("app-primary").locator(".ap-open")).toHaveAttribute("data-open-route", "choose");
      expect(errors).toEqual([]);
    });
  });
}
