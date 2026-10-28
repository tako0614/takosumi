/**
 * Source-level invariants of the installed-app page (TASK-0115). These lock
 * the safety rules a refactor must not drop: the app's state, primary action,
 * problems, screens and history come from the control plane's own per-app
 * reads (never a Workspace-wide window), every change is reviewed in place
 * and applies only from an explicit "Allow and …" click, a removal keeps its
 * confirmation, requests keep their idempotency keys, and information the
 * behavior does not need stays out of the UI.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../dashboard/src");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const page = read("views/app/AppManagePage.tsx");
const attention = read("views/app/AppAttentionSection.tsx");
const version = read("views/app/AppVersionSection.tsx");
const settings = read("views/app/AppSettingsSection.tsx");
const created = read("views/app/AppCreatedSection.tsx");
const history = read("views/app/AppHistorySection.tsx");
const ui = read("views/app/app-ui.tsx");
const route = read("views/app/AppPage.tsx");
const execution = read("views/new/InstallExecution.tsx");
const allAppSources = [page, attention, version, settings, created, history, ui, route].join("\n");

describe("installed app page", () => {
  test("the canonical route renders the one app page", () => {
    expect(route).toContain("<AppManagePage");
    expect(route).toContain("appPageSectionFromHash(location.hash)");
  });

  test("sections follow the keep-an-app behaviors in order", () => {
    const order = [
      'data-testid="app-header"',
      "<AppAttentionSection",
      "<AppVersionSection",
      "<AppSettingsSection",
      "<AppCreatedSection",
      "<AppLinkedSection",
      "<AppHistorySection",
      'id="danger"',
    ].map((marker) => page.indexOf(marker));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Section fragments the URL may name exist on the page.
    expect(attention).toContain('id="attention"');
    expect(version).toContain('id="version"');
    expect(settings).toContain('id="settings"');
    expect(settings).toContain('id="connections"');
    expect(created).toContain('id="created"');
    expect(history).toContain('id="history"');
  });

  test("state, problems, screens and history come from the server's per-app reads", () => {
    expect(page).toContain("createResource(capsuleId, getCapsuleApp)");
    expect(page).toContain("listCapsuleRuns(id, { limit: APP_HISTORY_PAGE_SIZE, types: APP_HISTORY_RUN_TYPES })");
    expect(page).toContain("data-app-state={view().state}");
    expect(page).toContain("t(appStateSentence(view()))");
    // No Workspace-wide window decides anything on this page any more.
    for (const banned of [
      "listRuns(",
      "listActivity(",
      "listAuthorizedUiSurfaces(",
      "listInterfaceMaterializationFailures(",
      "isCapsuleRuntimeOpenable(",
      "appState(",
      "latestFailedRun(",
      "APP_RUN_LOOKUP_LIMIT",
    ]) {
      expect({ banned, found: allAppSources.includes(banned) }).toEqual({ banned, found: false });
    }
  });

  test("history pages through the app's own Runs with Show more", () => {
    expect(page).toContain("const historyCursor = () =>");
    expect(page).toContain("cursor,\n        types: APP_HISTORY_RUN_TYPES,");
    expect(page).toContain("hasMore={historyCursor() !== undefined}");
    expect(history).toContain('t("app.history.more")');
    expect(history).toContain("<PolicyReasonList reasons={reasons()} title={false}");
  });

  test("a part the server could not read says so instead of showing nothing", () => {
    expect(page).toContain('appViewIncomplete(view(), "screens")');
    expect(page).toContain('t("app.incomplete.screens")');
    expect(page).toContain('appViewIncomplete(view(), "display")');
    expect(page).toContain('versionIncomplete={appViewIncomplete(view(), "version")}');
    expect(version).toContain('t("app.incomplete.version")');
    expect(attention).toContain('appViewIncomplete(app(), "screen_problems")');
  });

  test("every change is reviewed in place and applies only from the explicit click", () => {
    // Update, version, rollback, settings, retry, continue and uninstall-now
    // all open the shared review; nothing navigates to the run page to apply.
    expect(page).toContain("<InstallExecution");
    expect(page).toContain("purpose={active().purpose}");
    expect(page).not.toMatch(/navigate\(`\/runs\//u);
    expect(allAppSources).not.toContain("auto=update");
    expect(allAppSources).not.toContain("autoApply");
    expect(allAppSources).not.toContain("sessionStorage");
    expect(allAppSources).not.toContain("createApplyRun");
    expect(allAppSources).not.toContain("approveRun");
    // The shared review applies only from its one Allow button.
    expect([...execution.matchAll(/void install\(\)/gu)]).toHaveLength(1);
    for (const key of ["app.review.allowUpdate", "app.review.allowApply", "app.review.allowUninstall"]) {
      expect(execution).toContain(`"${key}"`);
    }
  });

  test("every primary action the server names maps to an in-page flow", () => {
    // The mapping itself is lib/app-page.ts appPrimaryStep (behavior-tested);
    // the page runs one handler per step.
    const run = page.slice(page.indexOf("const runPrimary = (view: CapsuleAppView) =>"), page.indexOf("const primaryOpenInPlace"));
    expect(run).toContain("const step = appPrimaryStep(view);");
    for (const kind of [
      "show_created",
      "review",
      "retry",
      "retry_screen",
      "fix_connection",
      "continue_install",
      "cancel_uninstall",
      "uninstall_now",
    ]) {
      expect(run).toContain(`case "${kind}":`);
    }
    expect(run).toContain("openRunReview(step.runId, step.runType)");
    // Open shows every screen; Install again goes to the app's install page.
    expect(page).toContain('<Match when={view().primaryAction === "open" && screens().length > 0}>');
    expect(page).toContain("<OpenAppButton surfaces={screens()}");
    // Screens the server still lists stay openable as a secondary action
    // while another action is primary (an app needing attention may still
    // serve its last successful version), except while it is removed.
    expect(page).toContain('<OpenAppButton surfaces={screens()} appName={displayName()} variant="secondary" />');
    const secondary = page.slice(page.indexOf("const secondaryScreens = "), page.indexOf("const showUpdate = "));
    expect(secondary).toContain('view.primaryAction !== "open" && screens().length > 0');
    expect(secondary).toContain('view.state !== "uninstalling" && view.state !== "uninstalled"');
    expect(page).toContain('<Match when={view().primaryAction === "reinstall"}>');
    expect(page).toContain("href={reinstallHref(reinstallInput(view(), inst()))}");
    // A connection problem goes to the connections this app uses.
    expect(page).toContain('if (managed()) scrollToSection("connections");');
    // In-progress work the server reports is followed in place, never applied.
    expect(page).toContain("auto: true,");
    expect(page).toContain("dismissedRuns.has(target.runId)");
  });

  test("version changes keep one idempotency key per requested ref", () => {
    expect(page).toContain("getOrCreateRevisionPlanAttempt(");
    expect(page).toContain("idempotencyKey: attempt.idempotencyKey");
    expect(page).toContain("createReviewableGitRevisionPlan(");
    expect(page).toContain("createStateVersionRollbackPlan(stateVersionId)");
    expect(version).toContain('t("app.version.rollback")');
    expect(version).toContain('t("app.version.pinReview")');
    expect(version).toContain("props.version.autoUpdate === true");
    expect(version).toContain("props.version.updateAvailable || props.version.stale");
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

  test("every screen is reachable from Open", () => {
    expect(page).toContain("const screens = () => openableScreens(app()?.screens ?? []);");
    expect(ui).toContain("const others = () => props.surfaces.slice(1)");
    expect(ui).toContain('role="menuitem"');
    expect(ui).toContain('target="_blank"');
    expect(ui).toContain('rel="noreferrer noopener"');
  });

  test("problems are the server's, each told in words with its own next step", () => {
    expect(read("lib/app-page.ts")).toContain("const problem = primaryProblem(app);");
    for (const code of ["connection_unavailable", "policy_blocked", "run_failed", "capsule_error", "install_incomplete", "screen_unavailable"]) {
      expect(attention).toContain(`problem().code === "${code}"`);
    }
    expect(attention).toContain("runFailureHint(problem().errorCode)");
    // Raw server text is supporting detail, never the headline.
    expect(attention).toContain('t("app.problem.serverSaid")');
    // A policy block names its structured reasons.
    expect(attention).toContain("<RunPolicyReasons runId={runId()} capsuleId={app().capsuleId} reportLoadFailure />");
    // A card repeats an action only when it is not the header's primary one,
    // and cards are keyed by what each problem is so a poll keeps them.
    expect(attention).toContain("if (!action || isPrimary(problem, action)) return null;");
    expect(attention).toContain("<For each={cardKeys()}>");
    // Screen recovery retries the exact failure the server named.
    expect(page).toContain("const failure = problem?.screenFailure;");
    expect(page).toContain("retryInterfaceMaterializationFailure(workspace, failure.id, {");
    expect(attention).toContain("appUninstallBanner(app(), props.displayName)");
  });

  test("uninstall is one implementation: grace period stated first, cancellable, naming affected apps", () => {
    expect(page).toContain("await deleteCapsule(inst.id);");
    expect(page).toContain("await cancelCapsuleUninstall(capsuleId());");
    expect(page).toContain("deleteCapsule(capsuleId(), { immediate: true })");
    expect(page).toContain("dependencyWarning(),");
    expect(page).toContain("dependencyCheck(),");
    expect(page).toContain('t("app.uninstall.impactTitle")');
    // The grace days the server reports are shown before anything is scheduled.
    expect(page).toContain('t("app.uninstall.bodyGrace", { name: displayName(), days: graceDays()! })');
    expect(page).toContain('t("app.uninstall.confirmGrace", { name: displayName(), days })');
    // Scheduling is confirmed once as a dangerous action; an immediate
    // teardown is a reviewed removal plan, never one click.
    expect(page.match(/await confirm\(/gu)).toHaveLength(1);
    expect(page).toContain("danger: true,");
    const now = page.slice(page.indexOf("const uninstallNow = () =>"), page.indexOf("// --- the one primary action"));
    expect(now).toContain('"uninstall",');
    expect(now).toContain("restartable: false");
    expect(execution).toContain("// Approving a removal starts removing live resources: never one click.");
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
    expect(history).toContain("href={`/runs/${encodeURIComponent(event.runId)}`}");
  });

  test("a returned Plan releases its idempotency key; a failed or unknown outcome keeps it", () => {
    expect(page).toContain("if (planRunId) releaseRevisionPlanAttempt(revisionAttempts, forCapsule, requestJson);");
    expect(page.indexOf("releaseRevisionPlanAttempt(revisionAttempts")).toBeGreaterThan(
      page.indexOf("await createReviewableGitRevisionPlan(forCapsule"),
    );
    // Settings: the key is released and the form is clean once the Plan exists.
    const create = settings.slice(settings.indexOf("props.onReview(async () => {"), settings.indexOf("return result.configurationPlan.planRunId;"));
    expect(create).toContain("configurationAttempt = undefined");
    expect(create).toContain("setBindingsDirty(false)");
    expect(create).toContain("dirty: false, deleted: false, resetToDefault: false");
    // An unapplied settings review re-reads the form from what the app runs.
    expect(page).toContain('if (active.section === "settings") setSettingsSeed((value) => value + 1);');
    expect(settings).toContain("[() => props.installConfig, () => props.seed]");
  });

  test("continuing an install advances the attempt that owns the app instead of planning beside it", () => {
    const continueInstall = page.slice(page.indexOf("const continueInstall = () =>"), page.indexOf("const [screenRetryBusy"));
    expect(continueInstall).toContain("const attempt = app()?.progress.installPlanId;");
    expect(continueInstall).toContain("await advanceGitInstallPlan(attempt)");
    // An install that waits for the person continues on its own install page,
    // which only whoever started it can answer.
    expect(continueInstall).toContain("navigate(installAttemptHref(attempt));");
    expect(continueInstall).toContain("advanced.installPlan.createdBy !== props.principalId");
    expect(continueInstall).toContain('throw new Error(t("app.problem.installNeedsInput"));');
    expect(continueInstall).toContain("if (!attempt) return extractRunId(await planCapsule(capsuleId()));");
  });

  test("a stalled version change is continued through its own coordinator; updates wait while one is under way", () => {
    const continueRevision = page.slice(page.indexOf("const continueRevision = (revisionPlanId: string) =>"), page.indexOf("const [screenRetryBusy"));
    expect(continueRevision).toContain("(await advanceGitRevisionPlan(revisionPlanId)).revisionPlan.planRunId");
    expect(continueRevision).toContain('"update",');
    expect(attention).toContain("props.actions.continueRevision(revisionPlanId())");
    // Continuing a stopped one waits too while another change is under way
    // or waiting for review.
    expect(attention).toContain("const revisionWaits = () => appVersionChangeBusy(app());");
    expect(attention).toContain("disabled={props.busy || revisionWaits()}");
    // Update, check, choose a version and go back all wait.
    expect(page).toContain("reviewBusy={reviewBusy() || versionChangeBusy(view())}");
    // Settings wait too, and say why: a settings change beside a running or
    // pending version change would make that change fail when applied.
    expect(page.split("reviewBusy={reviewBusy() || versionChangeBusy(view())}").length).toBe(3);
    expect(page).toContain("changeWaits={!reviewBusy() && versionChangeBusy(view())}");
    expect(settings).toContain('t("app.settings.changeWaits")');
    expect(page).toContain('view.state === "installed" && !versionChangeBusy(view);');
    // An attempt waiting for input says whose input it needs.
    expect(attention).toContain('who() === "viewer" ? t("app.progress.awaitingYourInput") : t("app.progress.awaitingStarterInput")');
    // Only the person who started it gets a way to its install page.
    expect(attention).toContain('if (awaitingInput() !== "viewer" || !attempt) return undefined;');
    expect(attention).toContain("return installAttemptHref(attempt);");
  });

  test("a re-plan of the installed version is labelled as such, not as a retry of the failed change", () => {
    expect(page).toContain('return preview?.kind === "installed" && !preview.recorded');
    expect(page).toContain('if (!primaryProblem(view)?.runId) return "app.problem.retryInstalled";');
    expect(attention).toContain('!problem.runId && app().applied ? "app.problem.retryInstalled" : "app.problem.retry"');
  });

  test("try again repeats the failed change the way the run page does, or the installed version as configured", () => {
    expect(page).toContain("const fresh = await getCapsule(run.capsuleId ?? capsuleId());");
    expect(page).toContain("return await retryPlanForRun(run, fresh, retryApi);");
    // A version change keeps this page's per-ref idempotency key.
    expect(page).toContain("planRevision: (_capsuleId, ref) => createRevisionRun(ref),");
    // A problem that names no run re-plans the installed version (never the
    // Source's default ref); only an unapplied app plans its saved settings.
    expect(page).toContain("if (!applied()) return extractRunId(await planCapsule(capsuleId()));");
    expect(page).toContain("return extractRunId(await createStateVersionRollbackPlan(installed));");
    expect(page).toContain('const purpose: ReviewPurpose = removal ? "uninstall" : applied() ? "apply" : "install";');
    // The installed ref never falls back to the Source's default ref.
    expect(page).toContain("const currentRef = () => appInstalledRef(app(), capsule());");
    expect(page).not.toContain("version.repository?.defaultRef");
  });

  test("another app never shows this app's review, notices or reads", () => {
    // The route mounts a fresh page per app.
    expect(route).toContain("<Show when={params.id ?? \"\"} keyed>");
    // Defense in depth inside the page.
    expect(page).toContain("const forCapsule = capsuleId();");
    expect(page).toContain("if (capsuleId() !== forCapsule) return;");
    const reset = page.slice(page.indexOf("on(\n      capsuleId,"), page.indexOf("{ defer: true }", page.indexOf("on(\n      capsuleId,")));
    for (const signal of [
      "setReview(undefined)",
      "setStarting(undefined)",
      "setSectionError(undefined)",
      "setNotice(undefined)",
      "setOlderRuns(undefined)",
      "dismissedRuns.clear()",
    ]) {
      expect(reset).toContain(signal);
    }
  });

  test("settings read from the configuration the app runs, and an app without bindings can still change settings", () => {
    expect(page).toContain("bindings={isSettled(bindingSet) ? (settledValue(bindingSet)?.bindings ?? []) : undefined}");
    expect(page).toContain("capsuleInstallConfigId={inst().installConfigId}");
    expect(settings).toContain("props.installConfig.id === props.capsuleInstallConfigId");
    expect(settings).toContain("!props.installConfigLoading &&");
    expect(settings).toMatch(/disabled=\{\s*props\.reviewBusy \|\|\s*!configCurrent\(\)/u);
  });
});
