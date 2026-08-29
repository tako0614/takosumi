import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installModuleCatalogFromSnapshot } from "../../../../../dashboard/src/views/new/install-helpers.ts";

const root = resolve(import.meta.dir, "../../../../../");
const read = (path: string): string =>
  readFileSync(resolve(root, path), "utf8");

describe("single-screen install surface", () => {
  test("normalizes the bounded module projection without exposing files", () => {
    expect(
      installModuleCatalogFromSnapshot({
        status: "ready",
        sourceSnapshotId: "snap_modules",
        scopePath: ".",
        modules: [
          {
            path: "deploy/takoform",
            providerPackages: [
              {
                source: "registry.opentofu.org/cloudflare/cloudflare",
                version: "4.0.0",
              },
            ],
            rootProviderRequirements: [
              {
                source: "registry.opentofu.org/cloudflare/cloudflare",
                moduleLocalName: "cloudflare",
                childAlias: "default",
                version: "4.0.0",
              },
            ],
          },
          {
            path: ".",
            providerPackages: [],
            rootProviderRequirements: [],
          },
        ],
      }),
    ).toEqual({
      status: "ready",
      sourceSnapshotId: "snap_modules",
      scopePath: ".",
      modules: [
        {
          path: ".",
          providerPackages: [],
          rootProviderRequirements: [],
        },
        {
          path: "deploy/takoform",
          providerPackages: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              version: "4.0.0",
            },
          ],
          rootProviderRequirements: [
            {
              source: "registry.opentofu.org/cloudflare/cloudflare",
              moduleLocalName: "cloudflare",
              childAlias: "default",
              version: "4.0.0",
            },
          ],
        },
      ],
    });
    expect(
      installModuleCatalogFromSnapshot({
        status: "ready",
        sourceSnapshotId: "snap_one",
        scopePath: ".",
        modules: [
          {
            path: "deploy/takoform",
            providerPackages: [],
            rootProviderRequirements: [],
          },
        ],
      }),
    ).toMatchObject({ status: "ready", modules: [{ path: "deploy/takoform" }] });
    expect(
      installModuleCatalogFromSnapshot({
        status: "ready",
        sourceSnapshotId: "snap_file",
        scopePath: ".",
        modules: [
          {
            path: "main.tf",
            providerPackages: [],
            rootProviderRequirements: [],
          },
        ],
      }),
    ).toEqual({ status: "invalid", modules: [] });
  });

  test("distinguishes an empty scan from an invalid scan", () => {
    expect(
      installModuleCatalogFromSnapshot({
        status: "ready",
        sourceSnapshotId: "snap_empty",
        scopePath: ".",
        modules: [],
      }),
    ).toEqual({
      status: "ready",
      sourceSnapshotId: "snap_empty",
      scopePath: ".",
      modules: [],
    });
    expect(
      installModuleCatalogFromSnapshot({
        status: "invalid",
        sourceSnapshotId: "snap_invalid",
        scopePath: ".",
        reason: "scan_unavailable",
        modules: [],
      }),
    ).toEqual({ status: "invalid", modules: [] });
  });

  test("routes every install entry to the one /new view", () => {
    const router = read("dashboard/src/index.tsx");
    expect(router).toContain(
      'const InstallView = lazy(() => import("./views/new/InstallView.tsx"))',
    );
    expect(router).toContain('<Route path="/new" component={InstallView} />');
    expect(router).not.toContain("NewAppView");
    expect(router).not.toContain("CapsuleSourceOptionsInstallView");
    expect(router).not.toContain('path="/composition/install"');
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
    expect(view).toContain("setGitRef(prepared.snapshot.resolvedCommit);");
    expect(view).toContain("ref: gitRef().trim()");
    expect(view).toContain("setCapsuleId(undefined)");
    expect(view).toContain("setPlanRunId(undefined)");
    expect(view).toContain("setSourceCreateReconciliationToken(undefined)");
    expect(view).toContain("resetPreparedSource();");
  });

  test("a failed initial Plan can abandon the unapplied Capsule and start fresh", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const execution = read("dashboard/src/views/new/InstallExecution.tsx");
    const restartStart = view.indexOf("const restartFailedInstall = async () =>");
    const restartEnd = view.indexOf("const providerBindings =", restartStart);
    const restart = view.slice(restartStart, restartEnd);

    expect(restart).toContain("await abandonUnappliedCapsule(failedCapsuleId)");
    expect(restart).toContain("capsuleAbandonmentCompleted(deleted, {");
    expect(restart).toContain(
      "resetPreparedSource({ preserveModuleSelection: true });",
    );
    expect(restart).toContain("await prepareInstall();");
    expect(restart.indexOf("await abandonUnappliedCapsule")).toBeLessThan(
      restart.indexOf("resetPreparedSource"),
    );
    expect(restart.indexOf("resetPreparedSource")).toBeLessThan(
      restart.indexOf("await prepareInstall()"),
    );
    expect(execution).toContain('current().type === "plan"');
    expect(execution).toContain('t("installStore.restartWithLatestSource")');
    expect(execution).toContain("await props.onRestart();");
  });

  test("workspace and provider discovery stay lazy until an explicit action", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("const workspace = currentWorkspaceId();");
    expect(view).toContain("const workspace = await ensureWorkspace();");
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

  test("validates a query module hint against the scan before using its path", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain(
      "const initialModulePathExplicit = Boolean(initial?.path);",
    );
    expect(view).toContain(
      "const [modulePathExplicit, setModulePathExplicit] = createSignal(",
    );
    expect(view).toContain("setModulePathExplicit(false);");
    expect(view).toContain("setModulePathExplicit(true);");
    expect(view).toContain(
      "...(modulePathExplicit() ? { path: modulePath() } : {}),",
    );
    expect(view).toContain("path: selectedModulePath,");
    expect(view).toContain("modulePath: modulePath().trim(),");
  });

  test("keeps the Source subtree separate from the scanned module selection", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain(
      'const [sourcePath, setSourcePath] = createSignal(initial?.sourcePath ?? ".")',
    );
    expect(view).toContain("sourcePath: sourcePath(),");
    expect(view).toContain('setSourcePath(".");');
    expect(view).toContain('t("installStore.sourcePath")');
    expect(view).not.toContain("join(sourcePath(), modulePath())");
    expect(view).not.toContain("`${sourcePath()}/${modulePath()}`");
  });

  test("uses the strict shared Git URL guard before Source creation", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("isSafeHttpsGitUrl,");
    expect(view).toContain("if (!isSafeHttpsGitUrl(gitUrl().trim()))");
  });

  test("does not consult source-URL deployment profiles", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).not.toContain("listSourceSnapshotDeploymentProfiles");
    expect(view).not.toContain("selectedDeploymentProfile");
    expect(view).not.toContain("deploymentProfileConfirmed");
  });

  test("chooses scanned module directories before compatibility", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("listSourceSnapshotInstallModules(");
    expect(view).toContain("installModuleCatalogFromSnapshot");
    expect(view).toContain('phase() === "module-select"');
    expect(view).toContain('data-testid="install-module-chooser"');
    expect(view).toContain("confirmInstallModule");
    expect(view).toContain("setModuleSelectionConfirmed(false)");
    expect(view).toContain("setModulePathExplicit(true)");
    expect(
      view.indexOf("listSourceSnapshotInstallModules("),
    ).toBeLessThan(view.indexOf("await checkCapsuleCompatibility("));
    expect(view).not.toContain("moduleFiles");
  });

  test("module changes clear every compiled and planned artifact", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const chooserStart = view.indexOf("const chooseInstallModule =");
    const chooserEnd = view.indexOf("const confirmInstallModule =", chooserStart);
    const chooser = view.slice(chooserStart, chooserEnd);
    expect(chooser).toContain("resetCompiledPreparation();");
    for (const reset of [
      "setCompatibility(undefined)",
      "setInstallConfig(undefined)",
      "setProviderRows([])",
      "setStoreEntry(undefined)",
      "setCapsuleId(undefined)",
      "setPlanRunId(undefined)",
    ]) {
      expect(view).toContain(reset);
    }
  });

  test("keeps direct Git preparation independent of profile rows", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("listSourceSnapshotInstallModules(");
    expect(view).toContain("setPreparationStage(\"compatibility\")");
    expect(view).not.toContain("listSourceSnapshotDeploymentProfiles");
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

  test("retains typed Store setup and displays scanned provider requirements", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    for (const token of [
      "storeInitialSecretField",
      "storeInstallFeatures",
      "storeFeatureSelections",
      "setupProjectionInvalid",
      "selectedModuleProviderRequirements",
      'data-testid="install-module-requirements"',
      't("installStore.moduleRequirement"',
    ]) {
      expect(view).toContain(token);
    }
    expect(view).not.toContain("CapsuleSourceOptions");
    expect(view).not.toContain("readSnapshotDocument");
    expect(view).not.toContain("entryEvidence");
    expect(view).not.toContain("managedPublicHostname");
    expect(view).not.toContain("storePublicEndpoint");
    expect(view).not.toContain("storeSupportsOidc");
    expect(view).not.toContain("disabled={field.secret}");
  });

  test("uses three conceptual steps and no external document chooser", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain('data-testid="install-steps"');
    expect(view).toContain('t("installStore.stepSource")');
    expect(view).toContain('t("installStore.stepConfigure")');
    expect(view).toContain('t("installStore.stepReview")');
    expect(view).not.toContain("entry-confirm");
    expect(view).not.toContain("entryChoices");
    expect(view).not.toContain("parseCapsuleSourceOptions");
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

  test("makes the provider/module then Host/account boundary explicit", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain('t("installStore.moduleTitle")');
    expect(view).toContain('data-testid="install-module-chooser"');
    expect(view).toContain('t("installStore.providerModule")');
    expect(view).toContain("providerModuleLabel(row)");
    expect(view).toContain("providerConnectionDisplayName(connection)");
    expect(view).not.toContain("deploymentProfile");
  });

  test("only auto-selects exactly one eligible Host/account", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    const helper = read("dashboard/src/lib/provider-connections.ts");
    expect(view).toContain("preferredProviderConnection(");
    expect(helper).toContain("return candidates.length === 1 ? candidates[0] : undefined;");
    expect(helper).not.toContain("const managed = candidates.filter");
  });

  test("keeps provider selection fail-closed until Workspace policy is merged", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("WorkspacePolicyState");
    expect(view).toContain("mergeProviderConnectionPolicies");
    expect(view).toContain(
      'if (workspacePolicyState().status !== "ready") return [];',
    );
    expect(view).toContain(
      'if (workspacePolicyState().status !== "ready") return false;',
    );
    expect(view).toContain("const matches = candidatesFor(row.provider, config.policy);");
    expect(view).toContain(
      "!candidatesFor(row.provider, config.policy).some(",
    );
  });

  test("keeps TCS handoffs in the same install surface", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("parseInitialTcsHandoff(location.search)");
    expect(view).toContain("await fetchTcsListing(tcs.base, tcs.listingId)");
    expect(view).toContain("chooseListing(selected)");
    expect(view).toContain(
      "resolveAbsentRefToStableSemver: listing() !== null",
    );
    expect(view).toContain("setGitRef(prepared.snapshot.resolvedCommit)");
  });

  test("legacy install screens and cross-route progress state are deleted", () => {
    for (const path of [
      "dashboard/src/views/new/NewAppView.tsx",
      "dashboard/src/views/new/CapsuleSourceOptionsInstallView.tsx",
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
