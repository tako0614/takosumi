/**
 * Installed app page and Home (TASK-0115), against a deterministic portable
 * fixture. The page is organised around keeping an installed app: open it,
 * see its state and problems, update or change its version, change its
 * settings and connections, see what it created and what it costs, read its
 * history, uninstall. Its state, primary action, problems and screens come
 * from the control plane's app view (`GET /capsules/:id/app`) and its history
 * from the app's own Runs (`GET /capsules/:id/runs`). Every change is
 * reviewed in place and applies only from the explicit "Allow and …" click.
 * `/apps/:id` is the canonical URL; older app URLs redirect there.
 */
import { expect, test, type Page } from "@playwright/test";
import {
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

    test("keeps an installed app: open, update, settings, what it created and history in place", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      let multipleSurfaces = false;
      let stale = false;
      let updateApplied = false;
      let autoUpdate = false;
      let failedLatest = false;
      const revisionPlanBodies: unknown[] = [];
      const configurationPlanBodies: unknown[] = [];
      const seenMutations: string[] = [];
      const historyQueries: string[] = [];
      const adopted = () => updateApplied
        ? { sourceSnapshotId: "snap_main_new", ref: "main", path: ".", resolvedCommit: NEW_COMMIT }
        : { sourceSnapshotId: "snap_main_1", ref: "main", path: ".", resolvedCommit: PORTABLE_SOURCE_COMMIT };
      const capsule = () => ({
        id: CAPSULE_ID, workspaceId: "ws_alpha", name: PORTABLE_EXPECTATIONS.appName,
        slug: "repository-office", sourceId: SOURCE_ID, installConfigId: INSTALL_CONFIG_ID,
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
          return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/app`) {
          const screen = (id: string, title: string, url: string) => ({ interfaceId: `if_${id}`, name: `app.${id}`, title, url });
          return route.fulfill({ json: { app: appView(CAPSULE_ID, PORTABLE_EXPECTATIONS.appName, {
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
        if (path === `/api/v1/capsule-configs/${INSTALL_CONFIG_ID}`) {
          return route.fulfill({ json: { installConfig: {
            id: INSTALL_CONFIG_ID, workspaceId: "ws_alpha", name: PORTABLE_EXPECTATIONS.appName,
            sourceSelector: { kind: "git", url: "https://github.com/example/repository-office.git", ref: "main", path: "." },
            policy: {}, variableMapping: { region: "initial" },
            variablePresentation: [{ name: "region", type: "string", required: true, label: { ja: "リージョン", en: "Region" } }],
            outputAllowlist: {}, interfaceBlueprints: [],
            createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
          } } });
        }
        if (path === `/api/v1/capsules/${CAPSULE_ID}/provider-bindings`) {
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
            configurationPlan: { replayed: false, previousInstallConfigId: INSTALL_CONFIG_ID, targetInstallConfigId: "cfg_configuration_e2e", sourceSnapshotId: "snap_main_1", planRunId: CONFIG_PLAN },
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
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Ready to use.");
      await expect(app).toHaveAttribute("data-app-state", "installed");
      // History is the app's own lifecycle Runs, not a Workspace window.
      await expect.poll(() => historyQueries.length).toBeGreaterThan(0);
      expect(new URLSearchParams(historyQueries[0]).getAll("type").sort()).toEqual(["apply", "destroy_apply", "destroy_plan", "plan", "state_recovery"]);
      const open = header.getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(open).toHaveAttribute("target", "_blank");
      await expect(open).toHaveAttribute("rel", "noreferrer noopener");
      // The sections follow keeping an app, and nothing is folded away. The
      // uninstall section states the grace period before anything is scheduled.
      await expect(app.getByTestId("app-uninstall")).toContainText("Its data stays for 7 days");
      await expect(app.getByTestId("app-linked")).toContainText("No apps are linked.");
      const sections = ["app-version", "app-settings", "app-created", "app-history", "app-uninstall"];
      const tops: number[] = [];
      for (const id of sections) {
        await expect(app.getByTestId(id)).toBeVisible();
        tops.push((await app.getByTestId(id).boundingBox())!.y);
      }
      expect([...tops].sort((a, b) => a - b)).toEqual(tops);
      await expect(app.getByTestId("app-problems")).toHaveCount(0);
      await expect(app.locator("details")).toHaveCount(0);
      await expect(app.getByTestId("app-current-version")).toHaveText("main · 0123456");
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
      await expect(app.getByTestId("app-uninstall")).not.toContainText("Team Wiki");
      // One connection row per provider; no alias inputs or screen JSON editor.
      const connectionRow = app.getByTestId("app-connection-row");
      await expect(connectionRow).toHaveCount(1);
      await expect(connectionRow).toContainText("Cloudflare");
      await expect(connectionRow.locator("select")).toHaveValue("pc_cloudflare_direct");
      await expect(app.getByTestId("app-settings").locator("input")).toHaveCount(1);
      await expect(app.getByTestId("app-settings").locator("textarea")).toHaveCount(0);
      // History: this app's events, each opening its run.
      const history = app.getByTestId("app-history-list");
      await expect(history.locator("li").first()).toContainText("Changed settings");
      await expect(history.locator("li").last()).toContainText("Installed");
      await expect(history.locator("li").last()).toContainText("main · 0123456");
      await expect(history.locator("li").first().getByRole("link", { name: /Details/u })).toHaveAttribute("href", "/runs/run_settings_apply");
      await capture(page, "app-page-healthy");
      await app.getByTestId("app-history").screenshot({ path: test.info().outputPath("app-history-desktop.png") });
      await page.setViewportSize({ width: 390, height: 844 });
      await app.getByTestId("app-history").screenshot({ path: test.info().outputPath("app-history-mobile.png") });
      await page.setViewportSize({ width: 1440, height: 900 });

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
      await app.getByRole("checkbox", { name: "Update automatically when a newer version is found" }).check();
      await expect.poll(() => autoUpdate).toBe(true);

      // A newer version: reviewed in place, applied only by Allow and update.
      stale = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Ready to use. A newer version is available.");
      const versionSection = app.getByTestId("app-version");
      await expect(versionSection.getByTestId("app-update")).toContainText("A newer version is available");
      await expect(versionSection.getByTestId("app-new-version")).toHaveText("main · fedcba9");
      await header.getByRole("button", { name: "Update", exact: true }).click();
      await expect.poll(() => revisionPlanBodies).toEqual([{ ref: "main" }]);
      const review = versionSection.getByTestId("app-review");
      await expect(review.getByRole("heading", { name: "What the update changes" })).toBeVisible();
      await expect(review.getByTestId("install-plan-resources")).toContainText("Cloudflare R2 Bucket");
      await expect(review.getByTestId("install-plan-cost")).toContainText("Takosumi doesn't calculate costs for this app.");
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}$`, "u"));
      await capture(page, "app-update-review");
      // A clean Plan waits for consent: no Apply across Run poll intervals.
      await page.waitForTimeout(3_500);
      expect(seenMutations.filter((entry) => entry.endsWith("/apply"))).toEqual([]);
      await review.getByRole("button", { name: "Allow and update", exact: true }).click();
      await expect(versionSection.getByRole("status").filter({ hasText: "Updated." })).toBeVisible({ timeout: 15_000 });
      await expect(versionSection.getByTestId("app-review")).toHaveCount(0);
      await expect(app.getByTestId("app-current-version")).toHaveText("main · fedcba9");
      await expect(history.locator("li").first()).toContainText("Updated");
      await expect(history.locator("li").first()).toContainText("main · fedcba9");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Ready to use.");

      // Settings: values and connections, reviewed in place.
      const settings = app.getByTestId("app-settings");
      await settings.getByRole("textbox", { name: /^Region/u }).fill("edited");
      await settings.getByRole("button", { name: "Review", exact: true }).click();
      await expect.poll(() => configurationPlanBodies.length).toBe(1);
      expect(configurationPlanBodies).toEqual([{
        variablePatch: { set: { region: "edited" }, remove: [] },
        providerBindings: [{ provider: CLOUDFLARE, moduleLocalName: "cloudflare", connectionId: "pc_cloudflare_direct" }],
        interfaceBlueprints: [],
        expected: { authorityGuard: AUTHORITY_GUARD },
      }]);
      const settingsReview = settings.getByTestId("app-review");
      await expect(settingsReview.getByRole("heading", { name: "What this changes" })).toBeVisible();
      await expect(settingsReview.getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}$`, "u"));
      await settings.scrollIntoViewIfNeeded();
      await capture(page, "app-settings-review");
      await settingsReview.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(settings.getByTestId("app-review")).toHaveCount(0);
      // Cancelled, so the form shows what the app runs, not the unapplied edit.
      await expect(settings.getByRole("textbox", { name: /^Region/u })).toHaveValue("initial");
      await expect(settings.getByRole("button", { name: "Review", exact: true })).toBeDisabled();

      // A problem appears on the app it belongs to; the server's one primary
      // action is the header's button, the card says what happened.
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

      // Old tab links land on their section of the one page, as a fragment.
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
      // The jump links are the same fragments.
      await app.getByRole("navigation", { name: "Sections on this page" }).getByRole("link", { name: "History" }).click();
      await expect(page).toHaveURL(new RegExp(`/apps/${CAPSULE_ID}#history$`, "u"));
      await expect(app.getByTestId("app-history")).toBeInViewport();

      expect(seenMutations).toEqual([
        `PATCH /api/v1/capsules/${CAPSULE_ID}`,
        `POST /api/v1/capsules/${CAPSULE_ID}/revision-plans`,
        `POST /api/v1/runs/${UPDATE_PLAN}/apply`,
        `POST /api/v1/capsules/${CAPSULE_ID}/configuration-plans`,
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
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
      // No screen: the primary action shows what the app created.
      await expect(page.getByTestId("app-header").getByRole("link", { name: "Open" })).toHaveCount(0);
      await page.getByTestId("app-header").getByRole("button", { name: "See what it created", exact: true }).click();
      await expect(app.getByTestId("app-created")).toBeInViewport();

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

      // A lost apply outcome is held — no retry — but the review can close,
      // and the rest of the page is usable again.
      await review.getByRole("button", { name: "Allow and update", exact: true }).click();
      await expect(review.getByRole("alert").filter({ hasText: "could not be confirmed" })).toBeVisible();
      await expect(review.getByRole("button", { name: "Allow and update", exact: true })).toBeDisabled();
      await review.getByRole("button", { name: "Close", exact: true }).click();
      await expect(version.getByTestId("app-review")).toHaveCount(0);
      await expect(app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true })).toBeEnabled();
      expect(seenMutations.filter((entry) => entry.endsWith("/apply"))).toHaveLength(1);

      // Settings work for an app without a provider binding set; a reviewed
      // change leaves a clean form, a cancelled one shows what the app runs,
      // and the next change is a new request.
      const settings = app.getByTestId("app-settings");
      await expect(settings.getByTestId("app-connections")).toContainText("This app doesn't use any connections.");
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
          runs.set("run_retry_rollback", retryPlanRun("run_retry_rollback"));
          return route.fulfill({ status: 201, json: { run: runs.get("run_retry_rollback") } });
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

      // Try again on an installed app repeats the change that failed — the
      // same version change, or the same rollback — never a plan of the
      // Source's default ref.
      await page.goto("/apps/cap_retry_d", { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("app-problems").locator('[data-problem="run_failed"]')).toContainText("The last change couldn't be applied");
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(revisionBodies).toEqual([{ ref: "v2" }]);
      runs.set("run_failed_retry_plan", failedPlan({ kind: "rollback", stateVersionId: "sv_retry_prev" }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByTestId("app-header").getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(planBodies).toEqual([]);
      expect(seenMutations).toEqual([
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "POST /api/v1/capsules/cap_retry_d/revision-plans",
        "POST /api/v1/state-versions/sv_retry_prev/rollback-plan",
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });

    test("each state the server reports reads as it is, with its one next step in place", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const origin = resolvePortableOrigin();
      const seenMutations: string[] = [];
      const ID = "cap_states_e";
      const NAME = "State Echo";
      const now = "2026-10-20T00:00:00.000Z";
      type Scene = "uninstall_scheduled" | "updating" | "policy_blocked" | "installing" | "install_stalled" | "awaiting_input" | "awaiting_your_input" | "revision_stalled" | "revision_stalled_behind_review" | "review_pending" | "incomplete" | "uninstalled";
      let scene: Scene = "uninstall_scheduled";
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
      const runsById = new Map<string, Record<string, unknown>>([
        [blockedPlan.id, blockedPlan], [updateApply.id, updateApply], [installPlan.id, installPlan],
        [revisionPlanRun.id, revisionPlanRun],
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
              problems: [{ code: "uninstall_scheduled", severity: "warning" }],
              uninstall: { mode: "scheduled", graceDays: 7, scheduled: { phase: "scheduled", requestedAt: now, deleteAfter, cancellable: true, blocked: false, preDestroyExport: { status: "skipped" } } },
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
            return appView(ID, NAME, { incomplete: ["screens", "version"] });
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
        if (path === `${base}/members`) return route.fulfill({ json: { owner: { accountId: "sub_portable_e2e", displayName: "Portable E2E", email: "portable-e2e@example.test" }, members: [] } });
        if (path === base) return route.fulfill({ json: { capsule: capsule(), installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
        if (path === `${base}/app`) {
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
          if (!suffix) return route.fulfill({ json: { run: runsById.get(id!) } });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      const app = page.getByTestId("app-page");
      const header = page.getByTestId("app-header");
      const problems = page.getByTestId("app-problems");

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
      await expect(app.getByRole("navigation", { name: "Sections on this page" }).getByRole("link", { name: "Uninstall" })).toHaveCount(0);
      await capture(page, "app-page-uninstall-scheduled");
      await header.getByRole("button", { name: "Cancel uninstall", exact: true }).click();
      await expect(app).toHaveAttribute("data-app-state", "installed");

      // Parts the server could not read say so instead of showing nothing.
      await expect(header.getByRole("alert")).toHaveText("Couldn't read its screens.");
      await expect(header.getByRole("button", { name: "Reload screens", exact: true })).toBeVisible();
      await expect(app.getByTestId("app-version")).toContainText("Couldn't read its version");
      // The grace period shows before anything is scheduled, and in the confirmation.
      await expect(app.getByTestId("app-uninstall")).toContainText("Its data stays for 7 days");
      await app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true }).click();
      await expect(page.getByRole("dialog")).toContainText("keeps its data for 7 days");
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

      // An update in progress is followed in place; nothing is applied from here.
      scene = "updating";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "updating");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Applying a change.");
      await expect(problems.getByTestId("app-review")).toContainText("Applying");
      await expect(header.getByRole("button")).toHaveCount(0);
      // Nothing else changes the app while the server applies a change.
      await expect(app.getByTestId("app-uninstall").getByRole("button", { name: "Uninstall", exact: true })).toBeDisabled();
      await expect(app.getByTestId("app-version").getByRole("button", { name: "Check for updates", exact: true })).toBeDisabled();
      await capture(page, "app-page-updating");

      // A policy block names its structured reasons on the card and in history;
      // Review opens the blocked plan in place.
      scene = "policy_blocked";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "needs_attention");
      const blocked = problems.locator('[data-problem="policy_blocked"]');
      await expect(blocked).toContainText("A policy stopped the last change");
      await expect(blocked.getByTestId("policy-reasons")).toContainText("This provider isn't allowed by policy.");
      await expect(blocked.getByTestId("policy-reasons")).toContainText("aws_s3_bucket");
      const historyList = app.getByTestId("app-history-list");
      const blockedRow = historyList.locator('[data-history-kind="policy_blocked"]');
      await expect(blockedRow).toContainText("Stopped by a policy");
      await expect(blockedRow).toContainText("This kind of resource isn't allowed by policy.");
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
      await expect(review.getByRole("button", { name: /^Allow and/u })).toHaveCount(0);
      await capture(page, "app-page-policy-blocked");
      // History reads the server's pages: Show more appends the next one.
      const historyRows = historyList.locator(":scope > li");
      await expect(historyRows).toHaveCount(20);
      await app.getByTestId("app-history").getByRole("button", { name: "Show more", exact: true }).click();
      await expect(historyRows).toHaveCount(33);
      await expect(app.getByTestId("app-history").getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);

      // A first install waiting for review shows its review in place; only
      // the explicit click would apply it.
      scene = "installing";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "installing");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("The install is waiting for your review.");
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Allow and install", exact: true })).toBeEnabled();
      await expect(header.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
      await expect(app.getByTestId("app-uninstall")).toContainText("hasn't created anything in your cloud yet");
      await page.waitForTimeout(3_500);

      // A stalled install is continued through the attempt that owns it, not
      // by planning beside it.
      scene = "install_stalled";
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(app).toHaveAttribute("data-app-state", "needs_attention");
      await header.getByRole("button", { name: "Continue installing", exact: true }).click();
      await expect(problems.getByTestId("app-review").getByRole("button", { name: "Allow and install", exact: true })).toBeEnabled();

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
      await expect(app.getByTestId("app-version").getByRole("button", { name: "Update", exact: true })).toBeDisabled();
      // Settings wait too, and say why.
      await expect(app.getByTestId("app-settings").locator("[data-settings-waits]"))
        .toHaveText("Another change is under way or waiting for review. You can change settings after it finishes.");
      await expect(app.getByTestId("app-settings").getByRole("button", { name: "Review", exact: true })).toBeDisabled();

      // An uninstalled app offers to install it again from its repository.
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

      expect(seenMutations).toEqual([
        `POST /api/v1/capsules/${ID}/cancel-uninstall`,
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

    test("Home shows every accessible app with its state and opens only apps with a screen", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const ids = ["cap_repository_office", "cap_storage", "cap_blog", "cap_mail", "cap_chat", "cap_old"] as const;
      const apps = [
        { capsuleId: ids[0], name: PORTABLE_EXPECTATIONS.appName, role: "owner", state: "installed", primaryAction: "open" },
        { capsuleId: ids[1], name: "Object Storage", role: "member", state: "stopped", primaryAction: "view_resources" },
        { capsuleId: ids[2], name: "Team Blog", role: "member", state: "installed", primaryAction: "open" },
        { capsuleId: ids[3], name: "Mail Relay", role: "owner", state: "needs_attention", primaryAction: "retry" },
        { capsuleId: ids[4], name: "Chat", role: "owner", state: "installing", primaryAction: "open" },
        { capsuleId: ids[5], name: "Old Wiki", role: "owner", state: "uninstall_scheduled", primaryAction: "open" },
      ];
      await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/v1/apps") return route.fulfill({ json: { apps } });
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
      const cards = page.getByTestId("home-app");
      await expect(cards).toHaveCount(6);
      // What needs the person comes first.
      await expect(cards.nth(0)).toHaveAttribute("data-app-state", "needs_attention");
      await expect(cards.nth(1)).toHaveAttribute("data-app-state", "update_available");
      await expect(cards.nth(2)).toHaveAttribute("data-app-state", "installing");
      await expect(cards.nth(3)).toHaveAttribute("data-app-state", "uninstalling");
      const card = (name: string) => cards.filter({ hasText: name });
      await expect(card("Mail Relay")).toContainText("Needs attention");
      await expect(card("Team Blog")).toContainText("Update available");
      await expect(card("Chat")).toContainText("Installing");
      await expect(card("Old Wiki")).toContainText("Uninstall scheduled");
      // Only the app with an authorized screen opens; every app links to its page.
      await expect(card(PORTABLE_EXPECTATIONS.appName).getByRole("link", { name: `Open ${PORTABLE_EXPECTATIONS.appName} in a new tab` })).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(card("Object Storage").getByRole("link", { name: /^Open\b/u })).toHaveCount(0);
      await expect(card("Object Storage").getByRole("link", { name: "Object Storage", exact: true })).toHaveAttribute("href", "/apps/cap_storage");
      await expect(card("Mail Relay").getByRole("link", { name: "Check", exact: true })).toHaveAttribute("href", "/apps/cap_mail");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await capture(page, "home-mixed");
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });
  });
}
