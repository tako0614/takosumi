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
      await expect(settings.getByRole("textbox", { name: /^Region/u })).toHaveValue("edited");

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
