import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");

describe("single-screen install surface", () => {
  test("routes every install entry to the one /new view", () => {
    const router = read("dashboard/src/index.tsx");
    expect(router).toContain(
      'const InstallView = lazy(() => import("./views/new/InstallView.tsx"))',
    );
    expect(router).toContain('<Route path="/new" component={InstallView} />');
    expect(router).not.toContain("NewAppView");
    expect(router).not.toContain("CapsuleSourceOptionsInstallView");
    expect(router).not.toContain("CompositionInstallView");
    expect(router).not.toContain(
      '<Route path="/composition/install" component={CompositionInstallView} />',
    );
    expect(router).toMatch(
      /path="\/composition\/install"[\s\S]*?<RedirectWithQuery to="\/new"/,
    );
  });

  test("Add starts preparation before compatibility or providers are known", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("StoreBrowser");
    expect(view).toContain("const prepareInstall = async () =>");
    expect(view).toContain("await checkCapsuleCompatibility(");
    expect(view.indexOf("setPhase(\"preparing\")")).toBeLessThan(
      view.indexOf("await checkCapsuleCompatibility("),
    );
    expect(view).toContain('t("installStore.add")');
    expect(view).not.toContain("canContinue");
    expect(view).not.toContain("checkingCompatibility() || !provider");
  });

  test("preparation is bounded, names its current stage, and can be cancelled", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("INSTALL_PREPARATION_TIMEOUT_MS");
    expect(view).toContain("const preparationTimeout = setTimeout(");
    expect(view).toContain("preparationTimedOut = true;");
    expect(view).toContain("const preparationDeadlineAt =");
    expect(view).toContain("timeoutMs: INSTALL_PREPARATION_TIMEOUT_MS");
    expect(view).toContain("deadlineAt: preparationDeadlineAt");
    expect(view).toContain("sourceAuthConnectionId().length > 0");
    expect(view).toContain("includeSourceConnections");
    expect(view).toContain("Promise.resolve([] as ProviderConnection[])");
    expect(view).toContain("listConnectionsWithSignal(workspace, signal)");
    expect(view).toContain(
      "listReleaseOwnedProviderConnectionsWithSignal(workspace, signal)",
    );
    expect(view).toContain("...all.filter(isProviderConnectionCandidate)");
    expect(view).toContain("...releaseOwnedProviders");
    expect(view).toContain("onSourceSyncProgress:");
    expect(view).toContain("await prepareCapsuleSourceSnapshot({");
    expect(view).toContain("onSourceCreated:");
    expect(view).toContain("preparationStageHint()");
    expect(view).toContain("activePreparationController?.abort()");
    expect(view).toContain("clearTimeout(preparationTimeout)");
    expect(view).toContain('t("common.cancel")');
  });

  test("does not claim no Source exists after an indeterminate Source create", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("SourceCreateIndeterminateError");
    expect(view).toContain("ControlApiIndeterminateError");
    expect(view).toContain('cause.operation === "source_create"');
    expect(view).toContain("setSourceCreateReconciliationToken(cause.reconciliationToken)");
    expect(view).toContain("sourceCreateReconciliationToken:");
    expect(view).toContain('t("installStore.sourceRegistrationUnconfirmed")');
    expect(view).toContain('t("installStore.sourceBaselineUnavailable")');
  });

  test("public Git discovery never waits for the optional source credential inventory", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain(
      "sourceAuthConnectionId().length > 0",
    );
    expect(view).not.toContain(
      "listing() === null,\n      );",
    );
  });

  test("authoritative refs stay exact and prepared state is invalidated by edits", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).not.toContain("refInputValue(");
    expect(view).toContain('createSignal(initial?.ref ?? "")');
    expect(view).toContain("setGitRef(ref);");
    expect(view).toContain("ref: gitRef().trim()");
    expect(view).toContain("setCapsuleId(undefined)");
    expect(view).toContain("setPlanRunId(undefined)");
    expect(view).toContain("setSourceCreateReconciliationToken(undefined)");
    expect(view).toContain("resetPreparedSource();");
  });

  test("workspace and provider discovery stay lazy until an explicit action", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("const workspace = currentWorkspaceId();");
    expect(view).toContain("if (!workspace) {");
    expect(view).toContain('throw new Error(t("workspace.selectMessage"));');
    expect(view).not.toContain('phase() !== "configure" && connectionsLoaded()');
    expect(view).toContain("const prepareInstall = async () =>");
    expect(view).toContain("const providersResult = loadConnections(");
    expect(view).toContain("const providerResult = await providersResult;");
  });

  test("validates persisted Workspace selection before scoped connection reads", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const ensureStart = view.indexOf("const ensureWorkspace = async");
    const ensureEnd = view.indexOf("const loadConnections = async", ensureStart);
    const ensureSource = view.slice(ensureStart, ensureEnd);
    expect(ensureSource).toContain("const workspaces = await listWorkspacesCached()");
    expect(ensureSource).toContain("selectAvailableWorkspaceId(");
    expect(ensureSource).toContain("currentWorkspaceId(),");
    expect(ensureSource).not.toContain("if (workspaceId()) {");
  });

  test("only ready compatibility can reach Capsule creation", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain('if (result.level !== "ready")');
    expect(view).toContain('if (checked.level !== "ready")');
    expect(view.indexOf('if (result.level !== "ready")')).toBeLessThan(
      view.indexOf("const config = await getInstallConfig(configId"),
    );
    expect(view.indexOf('if (checked.level !== "ready")')).toBeLessThan(
      view.indexOf("const capsule = await createCapsule"),
    );
  });

  test("aborted InstallConfig preparation returns to configure before mutations", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const configRead =
      'const config = await getInstallConfig(configId, {\n        signal: controller.signal,\n      });';
    expect(view).toContain(configRead);
    expect(view).toContain(
      'preparationTimedOut ? t("installStore.preparingTimeout") : undefined',
    );
    expect(view.indexOf(configRead)).toBeLessThan(
      view.indexOf("const capsule = await createCapsule"),
    );
    expect(view.indexOf(configRead)).toBeLessThan(
      view.indexOf("const envelope = await planCapsule"),
    );
  });

  test("repository install compilation is independent from Store discovery", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("compileInstallUx: true");
    expect(view).not.toContain("compileInstallUx: listing() !== null");
    expect(view).not.toContain(
      "!listing()\n          ? { installConfigId: DEFAULT_CAPSULE_INSTALL_CONFIG_ID }",
    );
  });

  test("requires visible confirmation of the DB-owned deployment profile", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("listSourceSnapshotDeploymentProfiles(");
    expect(view).toContain("storeDeploymentProfileCatalogFromSnapshot");
    expect(view).toContain('catalog.status === "ready" ? (catalog.preselectedKey ?? "") : ""');
    expect(view).toContain("selectedDeploymentProfile()?.management");
    expect(view.indexOf("await prepareCapsuleSourceSnapshot({")).toBeLessThan(
      view.indexOf("listSourceSnapshotDeploymentProfiles("),
    );
    expect(view).toContain("selectedDeploymentProfileKey");
    expect(view).toContain("deploymentProfileConfirmed");
    expect(view).toContain('t("installStore.deploymentProfileConfirm")');
    expect(view).toContain("deploymentProfileKey:");
    expect(view).not.toContain("profile.modulePath");
    expect(view).not.toContain("profile.provider");
  });

  test("discovers the snapshot-bound deployment profile for direct Git installs", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const profileDiscoveryStart = view.indexOf(
      "const response = await listSourceSnapshotDeploymentProfiles(",
    );
    const profileDiscoveryEnd = view.indexOf(
      "setPreparationStage(\"compatibility\")",
      profileDiscoveryStart,
    );
    const profileDiscovery = view.slice(profileDiscoveryStart, profileDiscoveryEnd);
    expect(profileDiscoveryStart).toBeGreaterThanOrEqual(0);
    expect(profileDiscovery).not.toContain("if (listing())");
    expect(view).toContain(
      "<Show when={deploymentProfileCatalog().status === \"ready\"}>",
    );
    expect(view).not.toContain(
      "<Show when={listing() && deploymentProfileCatalog().status === \"ready\"}>",
    );
  });

  test("switching deployment profile preserves the snapshot and clears compiled authority", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const switchStart = view.indexOf("const switchDeploymentProfile =");
    const switchEnd = view.indexOf("const prepareInstall =", switchStart);
    const switchSource = view.slice(switchStart, switchEnd);
    expect(switchSource).toContain("resetCompiledPreparation();");
    expect(switchSource).not.toContain("resetPreparedSource();");
    for (const reset of [
      "setCompatibility(undefined)",
      "setInstallConfig(undefined)",
      "setProviderRows([])",
      "setStoreValues({})",
      "setStoreInputTouched({})",
    ]) {
      expect(view).toContain(reset);
    }
  });

  test("discloses persisted sourceBuild before the Plan starts", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("sourceBuildPreview(installConfig()?.sourceBuild)");
    expect(view).toContain('t("installStore.sourceBuildTitle")');
    expect(view).toContain('t("installStore.sourceBuildWorkingDirectory")');
    expect(view).toContain('t("installStore.sourceBuildOutputs")');
    expect(view).toContain("sourceBuild()");
    expect(view.indexOf("sourceBuild()")) .toBeLessThan(
      view.indexOf("await preparePlan(workspace, result, config, rows, undefined)"),
    );
    expect(view).not.toContain("sourceBuild.env");
  });

  test("retains typed Store setup and immutable chooser evidence", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    for (const token of [
      "storePublicEndpoint",
      "storeSupportsOidc",
      "storeInitialSecretField",
      "storeInstallFeatures",
      "storeFeatureSelections",
      "managedPublicHostname",
      "setupProjectionInvalid",
      "entryEvidence",
      "readSnapshotDocument",
      "commit",
      "digest",
    ]) {
      expect(view).toContain(token);
    }
    expect(view).not.toContain("disabled={field.secret}");
  });

  test("preserves app handoff and Interface-first completion", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("appHandoffFromSearch");
    expect(view).toContain("appHandoffProductLabel");
    expect(view).toContain("createAppHandoffConnectHref");
    expect(view).toContain("appendAppHandoff");
    expect(view).toContain("listAuthorizedUiSurfaces");
    expect(view).toContain("interfaceUrl()");
    expect(view).toContain("Open in");
  });

  test("does not declare a UI service complete before its launcher is readable", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain('"finishing"');
    expect(view).toContain("installConfigRequiresUiSurface");
    expect(view).toContain("UI_SURFACE_READBACK_ATTEMPTS");
    expect(view).toContain("await listAuthorizedUiSurfaces");
    expect(view.indexOf('setPhase("finishing")')).toBeLessThan(
      view.indexOf('setPhase("done")'),
    );
    expect(view).toContain('t("installStore.launchNotReady")');
    expect(view).toContain('t("common.retry")');
  });

  test("matches resolved repository launcher bindings to the authenticated Principal", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("installingPrincipalId={session.subject}");
    expect(view).toContain("installingPrincipalId: props.installingPrincipalId");
    expect(view).toContain("repositoryInstallUxAccepted:");
    expect(view).toContain("config?.installExperience?.repositoryInstallUx");
  });

  test("review and apply stay inside /new", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const execution = read("dashboard/src/views/new/InstallExecution.tsx");
    expect(view).toContain("<InstallExecution");
    expect(execution).toContain("createApplyRun(");
    expect(execution).toContain("openRunStream(");
    expect(execution).toContain("stateVersionReadinessAfterApply(");
    expect(execution).toContain('t("installStore.install")');
    expect(execution).not.toContain('navigate(`/runs/');
    expect(execution).not.toContain("auto=install");
  });

  test("shows the exact auto-selected destination as read-only review evidence", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("autoSelectedDestination");
    expect(view).toContain('t("installStore.destinationSummary"');
    expect(view).toContain('data-install-provider-destination="auto-selected"');
    expect(view).toContain("data-provider-connection-id");
    expect(view).toContain("providerConnectionDisplayName(destination())");
    expect(view).toContain("setAutoSelectedProviderRows");
    expect(view).toContain("setAutoSelectedProviderRows(new Set<string>());");
  });

  test("keeps TCS handoffs in the same install surface", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("parseInitialTcsHandoff(location.search)");
    expect(view).toContain("await fetchTcsListing(tcs.base, tcs.listingId)");
    expect(view).toContain("chooseListing(selected)");
  });

  test("legacy install screens and cross-route progress state are deleted", () => {
    for (const path of [
      "dashboard/src/views/new/NewAppView.tsx",
      "dashboard/src/views/new/CapsuleSourceOptionsInstallView.tsx",
      "dashboard/src/views/new/CompositionInstallView.tsx",
      "dashboard/src/components/install/InstallProgress.tsx",
      "dashboard/src/lib/install-steps.ts",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
    const runView = read("dashboard/src/views/runs/RunView.tsx");
    expect(runView).not.toContain("auto=install");
    expect(runView).not.toContain("InstallProgressCard");
    expect(runView).not.toContain("installScreen");
  });
});
