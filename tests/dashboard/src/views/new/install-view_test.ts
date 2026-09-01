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

  test("authoritative refs stay exact and prepared state is invalidated by edits", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).not.toContain("refInputValue(");
    expect(view).toContain('createSignal(initial?.ref ?? "")');
    expect(view).toContain("setGitRef(ref);");
    // The ref that reaches the API is the EXACT revision, never a display
    // value: either what the user typed, or the resolved release commit.
    expect(view).toContain("const explicit = gitRef().trim();");
    expect(view).toContain("if (explicit) return explicit;");
    expect(view).toContain("ref: effectiveRef,");
    expect(view).toContain("setCapsuleId(undefined)");
    expect(view).toContain("setPlanRunId(undefined)");
    expect(view).toContain("resetPreparedSource();");
  });
  test("an unspecified revision resolves to the current release, not HEAD", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    // One rule for every entry point. A catalog install used to be the only
    // path with no ref field at all, so it silently took the default branch.
    expect(view).toContain("const resolveInstallRef = async");
    expect(view).toContain("resolveStableSourceTag(workspace, gitUrl().trim())");
    expect(view).toContain("setGitRef(resolved.commit);");
    // A repository publishing no stable tag keeps working: the resolver
    // throws, and an empty ref means HEAD server-side.
    expect(view).toContain("} catch {\n      return \"\";\n    }");
    // No listing-shaped special case reintroduced.
    expect(view).not.toContain('listing() ? "" : gitRef()');
  });


  test("workspace and provider discovery stay lazy until an explicit action", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain("const workspace = currentWorkspaceId();");
    expect(view).toContain("if (!workspace) {");
    expect(view).toContain('throw new Error(t("workspace.selectMessage"));');
    expect(view).not.toContain('phase() !== "configure" && connectionsLoaded()');
    expect(view).toContain("const prepareInstall = async () =>");
    expect(view).toContain("const providers = await loadConnections(workspace);");
  });

  test("only ready compatibility can reach Capsule creation", () => {
    const view = read("dashboard/src/views/new/InstallView.tsx");
    expect(view).toContain('if (result.level !== "ready")');
    expect(view).toContain('if (checked.level !== "ready")');
    expect(view.indexOf('if (result.level !== "ready")')).toBeLessThan(
      view.indexOf("const config = await getInstallConfig(configId)"),
    );
    expect(view.indexOf('if (checked.level !== "ready")')).toBeLessThan(
      view.indexOf("const capsule = await createCapsule"),
    );
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
