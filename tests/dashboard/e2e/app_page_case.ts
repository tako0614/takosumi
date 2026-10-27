/**
 * Installed app page and Home (TASK-0115), against a deterministic portable
 * fixture. The page is organised around keeping an installed app: open it,
 * see its state and problems, update or change its version, change its
 * settings and connections, see what it created and what it costs, read its
 * history, uninstall. Every change is reviewed in place and applies only from
 * the explicit "Allow and …" click.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  PORTABLE_CAPSULES,
  PORTABLE_CLOUDFLARE_PROVIDER_CONNECTIONS,
  PORTABLE_EXPECTATIONS,
  PORTABLE_SOURCE_COMMIT,
  PORTABLE_UI_SURFACES,
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

export function registerAppPageCases(mode: DashboardE2EMode) {
  test.describe("Installed app page", () => {
    test.skip(mode !== "portable", "deterministic app page fixture; not production evidence");

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
        ...(failedLatest ? [lifecycleRun("run_failed_apply", "apply", "failed", "2099-01-01T00:00:00.000Z", { errorCode: "apply_failed" })] : []),
      ];
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
        if (path === `/api/v1/capsules/${CAPSULE_ID}/state-versions`) return route.fulfill({ json: { stateVersions: stateVersions() } });
        if (path === "/api/v1/workspaces/ws_alpha/runs") return route.fulfill({ json: { runs: runs() } });
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
        if (path === "/api/v1/workspaces/ws_alpha/ui-surfaces" && multipleSurfaces) {
          const original = PORTABLE_UI_SURFACES.ws_alpha[0];
          const surface = (id: string, title: string, sortOrder: number) => ({
            ...original,
            metadata: { ...original.metadata, id: `if_${id}`, name: `app.${id}` },
            spec: {
              ...original.spec,
              document: { launcher: true, display: { title, sortOrder } },
              inputs: { url: { source: "capsule_output", capsuleId: CAPSULE_ID, outputName: `${id}_url` } },
            },
            status: { ...original.status, resolvedInputs: { url: `https://apps.example.test/${id}` } },
          });
          // The API order differs from the screens' declared order.
          return route.fulfill({ json: { interfaces: [surface("documentation", "Documentation", 20), surface("control", "Control panel", 10)] } });
        }
        if (path === "/api/v1/workspaces/ws_alpha/graph") {
          return route.fulfill({ json: {
            nodes: [
              { capsuleId: CAPSULE_ID, name: PORTABLE_EXPECTATIONS.appName, environment: "production", status: "active" },
              { capsuleId: "cap_team_wiki", name: "Team Wiki", environment: "production", status: "active" },
            ],
            edges: [{ id: "dep_wiki", producerCapsuleId: CAPSULE_ID, consumerCapsuleId: "cap_team_wiki", outputs: {} }],
          } });
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
        for (const run of [updatePlan, updateApply, configPlan]) {
          if (path === `/api/v1/runs/${run.id}`) return route.fulfill({ json: { run } });
          if (path === `/api/v1/runs/${run.id}/cost`) return route.fulfill({ json: notApplicableCost(run.id) });
          if (path === `/api/v1/runs/${run.id}/logs`) return route.fulfill({ json: { diagnostics: [], auditEvents: [] } });
          if (path === `/api/v1/runs/${run.id}/stream`) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "" });
        }
        return route.fallback();
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/workloads/${CAPSULE_ID}`, { waitUntil: "domcontentloaded" });
      const app = page.getByTestId("app-page");
      const header = page.getByTestId("app-header");
      await expect(header.getByRole("heading", { level: 1 })).toHaveText(PORTABLE_EXPECTATIONS.appName);
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Ready to use.");
      const open = header.getByRole("link", { name: "Open", exact: true });
      await expect(open).toHaveAttribute("href", PORTABLE_EXPECTATIONS.appUrl);
      await expect(open).toHaveAttribute("target", "_blank");
      await expect(open).toHaveAttribute("rel", "noreferrer noopener");
      // The sections follow keeping an app, and nothing is folded away.
      const sections = ["app-version", "app-settings", "app-created", "app-linked", "app-history", "app-uninstall"];
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
      await expect(app.getByTestId("app-linked")).toContainText("Team Wiki");
      await expect(app.getByTestId("app-uninstall")).toContainText("Team Wiki");
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
      await expect(review.getByTestId("install-plan-cost")).toContainText("Takosumi doesn't calculate costs in this workspace.");
      await expect(page).toHaveURL(new RegExp(`/workloads/${CAPSULE_ID}$`, "u"));
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
      await expect(page).toHaveURL(new RegExp(`/workloads/${CAPSULE_ID}$`, "u"));
      await settings.scrollIntoViewIfNeeded();
      await capture(page, "app-settings-review");
      await settingsReview.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(settings.getByTestId("app-review")).toHaveCount(0);
      // Cancelled, so the form shows what the app runs, not the unapplied edit.
      await expect(settings.getByRole("textbox", { name: /^Region/u })).toHaveValue("initial");
      await expect(settings.getByRole("button", { name: "Review", exact: true })).toBeDisabled();

      // A problem appears on the app it belongs to, with the next step first.
      failedLatest = true;
      await page.reload({ waitUntil: "domcontentloaded" });
      const problem = app.getByTestId("app-problems").locator('[data-problem="failed-run"]');
      await expect(problem).toContainText("The last change couldn't be applied");
      await expect(problem.getByRole("button", { name: "Review again", exact: true })).toBeVisible();
      await expect(problem.getByRole("link", { name: "See reason and logs" })).toHaveAttribute("href", "/runs/run_failed_apply");
      await expect(page.getByTestId("app-state-sentence")).toContainText("Something needs your attention");
      await capture(page, "app-page-problem");
      failedLatest = false;

      // An old tab link lands on its section of the one page.
      await page.goto(`/workloads/${CAPSULE_ID}/danger`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveURL(new RegExp(`/workloads/${CAPSULE_ID}/danger$`, "u"));
      await expect(app.getByTestId("app-uninstall")).toBeInViewport();

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
        const app = (Object.keys(apps) as AppId[]).find((id) => path.startsWith(`/api/v1/capsules/${id}`));
        if (app) {
          const rest = path.slice(`/api/v1/capsules/${app}`.length);
          if (rest === "") return route.fulfill({ json: { capsule: capsule(app), installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
          if (rest === "/state-versions") return route.fulfill({ json: { stateVersions: [{ id: `sv_${app}`, workspaceId: "ws_alpha", capsuleId: app, environment: "production", generation: 1, createdByRunId: `run_install_${app}`, createdAt: now }] } });
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
        if (path === "/api/v1/workspaces/ws_alpha/runs") return route.fulfill({ json: { runs: [] } });
        if (path === "/api/v1/workspaces/ws_alpha/graph") {
          return route.fulfill({ json: {
            nodes: [{ capsuleId: "cap_keep_a", name: "Keep Alpha", environment: "production", status: "active" }, { capsuleId: "cap_keep_b", name: "Keep Beta", environment: "production", status: "active" }],
            edges: [{ id: "dep_keep", producerCapsuleId: "cap_keep_a", consumerCapsuleId: "cap_keep_b", outputs: {} }],
          } });
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
      await page.goto("/workloads/cap_keep_a", { waitUntil: "domcontentloaded" });
      const app = page.getByTestId("app-page");
      const version = app.getByTestId("app-version");
      await expect(page.getByTestId("app-header").getByRole("heading", { level: 1 })).toHaveText("Keep Alpha");

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

      // Following a linked app mounts that app's own page: no review,
      // notice or values of the previous app carry over.
      await version.getByRole("button", { name: "Update", exact: true }).click();
      await expect(version.getByTestId("app-review")).toBeVisible();
      await app.getByTestId("app-linked").getByRole("link", { name: "Keep Beta" }).click();
      await expect(page).toHaveURL(/\/workloads\/cap_keep_b$/u);
      await expect(page.getByTestId("app-header").getByRole("heading", { level: 1 })).toHaveText("Keep Beta");
      await expect(page.getByTestId("app-review")).toHaveCount(0);
      await expect(page.getByTestId("app-settings").getByRole("textbox", { name: /^Region/u })).toHaveValue("beta-region");
      await expect(page.getByTestId("app-state-sentence")).toHaveText("Ready to use.");
      await page.goBack();
      await expect(page.getByTestId("app-header").getByRole("heading", { level: 1 })).toHaveText("Keep Alpha");
      await expect(page.getByTestId("app-review")).toHaveCount(0);

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
      const runs = new Map<string, unknown>([
        ["run_sync_retry", { ...lifecycleRun("run_sync_retry", "source_sync", "succeeded", now), capsuleId: undefined, sourceId: "src_retry_d", sourceSnapshotId: "snap_retry_2", ref: "main" }],
      ]);
      const failedApply = { ...lifecycleRun("run_failed_retry", "apply", "failed", "2026-10-02T00:00:00.000Z", { errorCode: "apply_failed", baseStateGeneration: 1 }), capsuleId: "cap_retry_d" };
      const configFor = (id: string) => ({ installConfig: { id: `cfg_${id}`, workspaceId: "ws_alpha", name: id, policy: {}, variableMapping: {}, variablePresentation: [], outputAllowlist: {}, interfaceBlueprints: [], createdAt: now, updatedAt: now } });

      await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (shouldRecordControlPlaneMutation(mode, origin, request.url(), request.method())) {
          seenMutations.push(`${request.method()} ${path}${url.search}`);
        }
        for (const app of [removeApp, retryApp]) {
          const base = `/api/v1/capsules/${app.id}`;
          if (!path.startsWith(base)) continue;
          const rest = path.slice(base.length);
          if (rest === "" && request.method() === "DELETE" && url.searchParams.get("immediate") === "true") {
            removals += 1;
            runs.set(`run_destroy_plan_${removals}`, destroyPlan(removals));
            return route.fulfill({ json: { run: destroyPlan(removals) } });
          }
          if (rest === "") return route.fulfill({ json: { capsule: app, installConfigReAdoption: { authorityGuard: AUTHORITY_GUARD } } });
          if (rest === "/state-versions") return route.fulfill({ json: { stateVersions: [{ id: app.currentStateVersionId, workspaceId: "ws_alpha", capsuleId: app.id, environment: "production", generation: 1, createdByRunId: `run_install_${app.id}`, createdAt: now }] } });
          if (rest === "/provider-bindings") return route.fulfill({ json: { providerBindingSet: null } });
          if (rest === "/current-resource-inventory") return route.fulfill({ json: { inventory: { kind: "takosumi.capsule-current-resource-inventory@v1", capsuleId: app.id, workspaceId: "ws_alpha", environment: "production", stateVersionId: app.currentStateVersionId, generation: 1, applyRunId: "run_x", planRunId: "run_y", recordedAt: now, availability: "legacy_unavailable" } } });
          if (rest === "/usage-summary") return route.fulfill({ json: { summary: { capsuleId: app.id, usdMicros: 0, eventCount: 0, ratedEventCount: 0, unratedEventCount: 0 } } });
          if (rest === "/plan" && request.method() === "POST") {
            planBodies.push(request.postDataJSON());
            const retryPlan = { ...lifecycleRun("run_retry_plan", "plan", "succeeded", now), capsuleId: app.id, summary: { add: 0, change: 1, destroy: 0 }, policyStatus: "pass", planResources: [{ address: "cloudflare_workers_script.app", type: "cloudflare_workers_script", actions: ["update"] }] };
            runs.set("run_retry_plan", retryPlan);
            return route.fulfill({ json: { run: retryPlan } });
          }
        }
        if (path === "/api/v1/capsule-configs/cfg_cap_remove_c") return route.fulfill({ json: configFor("cap_remove_c") });
        if (path === "/api/v1/capsule-configs/cfg_cap_retry_d") return route.fulfill({ json: configFor("cap_retry_d") });
        if (path === "/api/v1/workspaces/ws_alpha/runs") return route.fulfill({ json: { runs: [failedApply] } });
        if (path === "/api/v1/workspaces/ws_alpha/graph") return route.fulfill({ json: { nodes: [], edges: [] } });
        if (path === "/api/v1/provider-connections") return route.fulfill({ json: { providerConnections: [] } });
        if (path === "/api/v1/sources" && request.method() === "GET") return route.fulfill({ json: { sources: [] } });
        // Try again on an installed app re-reads the latest source first.
        if (path === "/api/v1/sources/src_retry_d/sync" && request.method() === "POST") return route.fulfill({ json: { run: { id: "run_sync_retry" } } });
        if (path === "/api/v1/sources/src_retry_d/snapshots") {
          return route.fulfill({ json: { snapshots: [{
            id: "snap_retry_2", origin: "git", workspaceId: "ws_alpha", sourceId: "src_retry_d", url: "https://github.com/example/retry.git",
            ref: "main", resolvedCommit: PORTABLE_SOURCE_COMMIT, path: ".", archiveRef: "fixture", archiveDigest: `sha256:${"e".repeat(64)}`,
            archiveSizeBytes: 1, fetchedByRunId: "run_sync_retry", fetchedAt: now,
          }] } });
        }
        if (path === "/api/v1/sources/src_retry_d/compatibility-check" && request.method() === "POST") return route.fulfill({ json: { report: { id: "rep_retry_2" } } });
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
      await page.goto("/workloads/cap_remove_c", { waitUntil: "domcontentloaded" });
      const problems = page.getByTestId("app-problems");
      const scheduled = problems.locator('[data-problem="uninstall"]');
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

      // Try again on an installed app's failed change re-reads the latest
      // source and plans an update, exactly like the run page.
      await page.goto("/workloads/cap_retry_d", { waitUntil: "domcontentloaded" });
      const failed = page.getByTestId("app-problems").locator('[data-problem="failed-run"]');
      await failed.getByRole("button", { name: "Review again", exact: true }).click();
      await expect(page.getByTestId("app-problems").getByTestId("app-review").getByRole("button", { name: "Allow and apply", exact: true })).toBeVisible();
      expect(planBodies).toEqual([{ compatibilityReportId: "rep_retry_2" }]);
      expect(seenMutations).toEqual([
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "DELETE /api/v1/capsules/cap_remove_c?immediate=true",
        "POST /api/v1/sources/src_retry_d/sync",
        "POST /api/v1/sources/src_retry_d/compatibility-check",
        "POST /api/v1/capsules/cap_retry_d/plan",
      ]);
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });

    test("Home shows every installed app with its state and opens only apps with a screen", async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem("tg_lang", "en"));
      const errors = pageErrors(page);
      const traffic = monitorDashboardTraffic(page, mode);
      const base = PORTABLE_CAPSULES.ws_alpha[0];
      const app = (id: string, name: string, patch: Record<string, unknown>) => ({
        ...base, id, name, slug: id, sourceId: `src_${id}`, installConfigId: `cfg_${id}`,
        currentStateVersionId: `sv_${id}`, ...patch,
      });
      await page.route((url) => url.pathname === "/api/v1/workspaces/ws_alpha/capsules", (route) => route.fulfill({ json: { capsules: [
        { ...base, currentStateVersionId: "sv_office" },
        app("cap_storage", "Object Storage", {}),
        app("cap_blog", "Team Blog", { freshness: "stale" }),
        app("cap_mail", "Mail Relay", { status: "error" }),
        app("cap_chat", "Chat", { status: "pending", currentStateGeneration: 0, currentStateVersionId: undefined, updatedAt: new Date().toISOString() }),
        app("cap_old", "Old Wiki", { status: "uninstalled" }),
      ] } }));
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
      await expect(card("Object Storage").getByRole("link", { name: "Object Storage", exact: true })).toHaveAttribute("href", "/workloads/cap_storage");
      await expect(card("Mail Relay").getByRole("link", { name: "Check", exact: true })).toHaveAttribute("href", "/workloads/cap_mail");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await capture(page, "home-mixed");
      expect(errors).toEqual([]);
      traffic.assertNoFailures();
    });
  });
}
