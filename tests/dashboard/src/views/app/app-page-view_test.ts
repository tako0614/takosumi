/**
 * Source-level invariants of the installed-app page (TASK-0115). These lock
 * the safety rules a refactor must not drop: every change is reviewed in
 * place and applies only from an explicit "Allow and …" click, requests keep
 * their idempotency keys, screens come only from authorized Interfaces, and
 * information the behavior does not need stays out of the UI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const page = read("views/app/AppManagePage.tsx");
const version = read("views/app/AppVersionSection.tsx");
const settings = read("views/app/AppSettingsSection.tsx");
const created = read("views/app/AppCreatedSection.tsx");
const history = read("views/app/AppHistorySection.tsx");
const ui = read("views/app/app-ui.tsx");
const route = read("views/apps/WorkloadDetailView.tsx");
const execution = read("views/new/InstallExecution.tsx");
const allAppSources = [page, version, settings, created, history, ui, route].join("\n");

describe("installed app page", () => {
  test("the route renders the one app page; the install page reuses it", () => {
    expect(route).toContain("<AppManagePage");
    expect(route).toContain("tab={params.tab}");
    expect(read("views/new/InstallLifecycle.tsx")).toContain("<AppManagePage");
  });

  test("sections follow the keep-an-app behaviors in order", () => {
    const order = [
      'data-testid="app-header"',
      "{problemsSection()}",
      "<AppVersionSection",
      "<AppSettingsSection",
      "<AppCreatedSection",
      "<AppLinkedSection",
      "<AppHistorySection",
      'id="app-uninstall"',
    ].map((marker) => page.indexOf(marker));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("every change is reviewed in place and applies only from the explicit click", () => {
    // Update, version, rollback, settings, retry and uninstall-now all open
    // the shared review; nothing navigates to the run page to apply.
    expect(page).toContain("<InstallExecution");
    expect(page).toContain("purpose={active().purpose}");
    expect(page).not.toMatch(/navigate\(`\/runs\//u);
    expect(allAppSources).not.toContain("auto=update");
    expect(allAppSources).not.toContain("autoApply");
    expect(allAppSources).not.toContain("sessionStorage");
    expect(allAppSources).not.toContain("createApplyRun");
    // The shared review applies only from its one Allow button.
    expect([...execution.matchAll(/void install\(\)/gu)]).toHaveLength(1);
    for (const key of ["app.review.allowUpdate", "app.review.allowApply", "app.review.allowUninstall"]) {
      expect(execution).toContain(`"${key}"`);
    }
  });

  test("version changes keep one idempotency key per requested ref", () => {
    expect(page).toContain("getOrCreateRevisionPlanAttempt(");
    expect(page).toContain("idempotencyKey: attempt.idempotencyKey");
    expect(page).toContain("createReviewableGitRevisionPlan(");
    expect(page).toContain("createStateVersionRollbackPlan(stateVersionId)");
    expect(version).toContain('t("app.version.rollback")');
    expect(version).toContain('t("app.version.pinReview")');
    expect(version).toContain("props.capsule.autoUpdate === true");
  });

  test("settings send one reviewed configuration with the repository's screens unchanged", () => {
    expect(settings).toContain("createCapsuleConfigurationPlan(");
    expect(settings).toContain("configurationAttempt?.requestJson === requestJson");
    expect(settings).toContain("interfaceBlueprints: config.interfaceBlueprints ?? []");
    expect(settings).toContain("buildConfigVariablePatch(variableRows())");
    // Only user edits mark a row dirty; untouched rows are never written.
    expect(settings).toContain("{ ...row, ...patch, dirty: true, resetToDefault: false }");
    expect(settings).toContain("useBeforeLeave");
    // No Interface JSON editor and no raw provider alias fields.
    expect(settings).not.toContain("parseInterfaceBlueprintsJson");
    expect(settings).not.toContain("formatInterfaceBlueprintsJson");
    expect(settings).not.toContain("setInterfaceBlueprintsText");
    expect(settings).not.toMatch(/onInput=\{[^}]*(childAlias|rootAlias|moduleLocalName)/u);
    // One row per provider, connecting in place.
    expect(settings).toContain("<ConnectionCreateForm");
    expect(settings).toContain("restrictToInitialProvider");
    expect(settings).toContain("providerRowLabels(rows())");
  });

  test("screens come only from authorized Interfaces, and every screen is reachable", () => {
    expect(page).toContain("listAuthorizedUiSurfaces(key.workspaceId, { capsuleId: key.capsuleId })");
    expect(page).toContain("isCapsuleRuntimeOpenable(");
    expect(page).toContain("<OpenAppButton surfaces={surfaceList()}");
    expect(ui).toContain("const others = () => props.surfaces.slice(1)");
    expect(ui).toContain('role="menuitem"');
    expect(ui).toContain('target="_blank"');
    expect(ui).toContain('rel="noreferrer noopener"');
  });

  test("problems belong to the app: failed run, unopenable screen, scheduled uninstall", () => {
    expect(page).toContain("latestFailedRun(appRuns())");
    expect(page).toContain("runFailureHint(run.errorCode)");
    // Raw server text is supporting detail, never the headline.
    expect(page).toContain('t("app.problem.serverSaid")');
    // Per-app screen recovery reuses the API, not the workspace-wide tab.
    expect(page).toContain("listInterfaceMaterializationFailures(");
    expect(page).toContain("retryInterfaceMaterializationFailure(workspace, failure.id, {");
    expect(page).not.toContain("InterfaceRecoveryTab");
    expect(page).toContain("capsuleUninstallBanner(");
    expect(page).toContain("uninstallCancellable(inst())");
  });

  test("uninstall is one implementation: scheduled, cancellable, naming affected apps", () => {
    expect(page).toContain("await deleteCapsule(inst.id);");
    expect(page).toContain("await cancelCapsuleUninstall(capsuleId());");
    expect(page).toContain('deleteCapsule(capsuleId(), { immediate: true })');
    expect(page).toContain('"uninstall",');
    expect(page).toContain("dependencyWarning(),");
    expect(page).toContain("dependencyCheck(),");
    expect(page).toContain('t("app.uninstall.impactTitle")');
    expect(page.match(/await confirm\(/gu)).toHaveLength(1);
  });

  test("what it created stays readable: no raw ids, addresses or export", () => {
    expect(created).toContain("groupInventoryResources(");
    expect(created).not.toContain("stateVersionId");
    expect(created).not.toContain("applyRunId");
    expect(created).not.toContain("planRunId");
    expect(created).not.toContain(".address");
    expect(created).toContain('cost().kind === "unavailable"');
    expect(allAppSources).not.toContain("createCapsuleBackup");
  });

  test("dates read relatively with the exact time on hover", () => {
    expect(ui).toContain("title={formatDateTime(props.iso)}");
    expect(ui).toContain("relativeTime(props.iso)");
    expect(history).toContain("<RelativeTime iso={event.at} />");
    expect(history).toContain("href={`/runs/${encodeURIComponent(runId())}`}");
  });
});
