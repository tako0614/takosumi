/**
 * Regression guard for the `/new` -> Provider Connections detour.
 *
 * Creating a Provider Connection happens on `/connections`, but
 * the user must be able to return to the exact `/new?git=...&ref=...&path=...`
 * add flow afterwards. These source assertions keep the view wired to the
 * shared, validated return-context helper instead of hard-coding bare settings
 * links.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const here = dirname(fileURLToPath(import.meta.url));
// The /new flow spans the view (state machine + render) and its pure helper
// module — string pins check the combined install-flow source.
const newAppViewSource =
  readFileSync(
    resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
    "utf8",
  ) +
  readFileSync(
    resolve(here, "../../../../../dashboard/src/views/new/install-helpers.ts"),
    "utf8",
  );
const connectionsTabSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/workspace/tabs/ConnectionsTab.tsx",
  ),
  "utf8",
);
const connectionsHelperSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/account/lib/connections.ts",
  ),
  "utf8",
);
const credentialRecipesSource = readFileSync(
  resolve(here, "../../../../../providers/credential-recipes.generated.ts"),
  "utf8",
);
const controlApiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/control-api.ts"),
  "utf8",
);
const connectionContractSource = readFileSync(
  resolve(here, "../../../../../contract/connections.ts"),
  "utf8",
);
const appDetailViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/apps/AppDetailView.tsx"),
  "utf8",
);
const runViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/runs/RunView.tsx"),
  "utf8",
);
const accountViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/account/AccountView.tsx"),
  "utf8",
);
const spaceSettingsViewSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/workspace/WorkspaceSettingsView.tsx",
  ),
  "utf8",
);
const installationsServiceSource = readFileSync(
  resolve(here, "../../../../../core/domains/capsules/mod.ts"),
  "utf8",
);
const controlRoutesSource = readFileSync(
  resolve(here, "../../../../../accounts/service/src/control-routes.ts"),
  "utf8",
);
// The control-error mapping (typed `error.details` passthrough + `isRecord`
// guard) lives in the shared control substrate after the P3 god-file split.
const controlSharedSource = readFileSync(
  resolve(here, "../../../../../accounts/service/src/control/shared.ts"),
  "utf8",
);

describe("/new Provider Connections return context", () => {
  test("all /new Provider Connections links use the return-context href", () => {
    expect(newAppViewSource).toContain("installReturnPathFromPrefill");
    expect(newAppViewSource).toContain(
      "providerConnectionsHrefForInstallReturn",
    );
    expect(newAppViewSource).toContain("name: name().trim()");
    expect(newAppViewSource).toContain("const providerConnectionsHref = () =>");
    expect(newAppViewSource).not.toContain(
      'href="/workspace/settings/connections"',
    );
    expect(
      newAppViewSource.match(/href=\{providerConnectionsHref\(\)\}/g) ?? [],
    ).toHaveLength(1);
  });

  test("connections tab renders and preserves a safe install return target", () => {
    expect(connectionsTabSource).toContain("installReturnContext");
    expect(connectionsTabSource).toContain("installReturnPathFromReturnParam");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_QUERY_PARAM");
    expect(connectionsTabSource).toContain("INSTALL_RETURN_STORAGE_KEY");
    expect(connectionsTabSource).toContain("sessionStorage");
    expect(connectionsTabSource).toContain('"conn.return.cta"');
  });

  test("connections tab restores OAuth-created connection readiness from callback query", () => {
    expect(connectionsTabSource).toContain('params.get("connection_id")');
    expect(connectionsTabSource).toContain(
      'params.get("connection_status") === "verified"',
    );
    expect(connectionsTabSource).toContain("setLastCreatedConnectionId");
    expect(connectionsTabSource).toContain("setLastCreatedVerifiedHint");
    expect(connectionsTabSource).toContain('params.delete("connection_id")');
    expect(connectionsTabSource).toContain(
      'params.delete("connection_status")',
    );
    expect(connectionsTabSource).toContain(
      'lastCreatedProviderConnection()?.status === "verified" ||',
    );
  });

  test("connections tab refreshes ProviderConnection projections after mutations", () => {
    expect(connectionsTabSource).toContain(
      "refetch: refetchProviderConnections",
    );
    expect(connectionsTabSource).toContain("const refreshConnections = async");
    expect(
      connectionsTabSource.match(/await refreshConnections\(\)/g) ?? [],
    ).toHaveLength(3);
    expect(
      connectionsTabSource.match(
        /await afterConnectionCreated\(connection\)/g,
      ) ?? [],
    ).toHaveLength(2);
    expect(
      connectionsTabSource.match(/await runTest\(connection\.id\)/g) ?? [],
    ).toHaveLength(2);
    expect(connectionsTabSource).toContain('"conn.saved.message"');
    expect(connectionsTabSource).toContain('"conn.saved.needsTest"');
    expect(connectionsTabSource).toContain('"conn.saved.testCta"');
    expect(connectionsTabSource).toContain('"conn.saved.returnCta"');
    expect(connectionsTabSource).toContain("lastCreatedReady()");
    expect(connectionsTabSource).toContain("shouldOfferInstallReturn()");
    expect(connectionsTabSource).toContain(
      "!lastCreatedConnectionId() || lastCreatedReady()",
    );
  });

  test("/new presents provider setup as connected accounts for normal add flows", () => {
    expect(newAppViewSource).not.toContain("rowRequiresOperatorManagedOnly");
    expect(newAppViewSource).not.toContain(
      "missingOperatorManagedProviderRows",
    );
    expect(newAppViewSource).not.toContain("missingOwnKeyProviderRows");
    expect(newAppViewSource).not.toContain("operator" + "Missing");
    expect(newAppViewSource).not.toContain("error" + "OperatorManaged");
    expect(en["new.providers.missingBody"]).toContain("connected account");
    expect(ja["new.providers.missingBody"]).toContain("接続済みアカウント");
    expect(en["conn.providerConnections.title"]).toBe("Connected accounts");
    expect(ja["conn.providerConnections.title"]).toBe("接続済みアカウント");
  });

  test("/new explains rejected external install links instead of silently opening the Store", () => {
    expect(newAppViewSource).toContain("hasInstallPrefillParams");
    expect(newAppViewSource).toContain("installPrefillRejected");
    expect(newAppViewSource).toContain('"new.deeplink.invalidTitle"');
    expect(newAppViewSource).toContain('"new.deeplink.invalidBody"');
    expect(en["new.deeplink.invalidBody"].toLowerCase()).toContain(
      "paste another link",
    );
    expect(en["new.deeplink.invalidBody"].toLowerCase()).not.toContain(
      "repository",
    );
    expect(ja["new.deeplink.invalidBody"]).toContain("別のリンク");
    expect(ja["new.deeplink.invalidBody"]).not.toContain("リポジトリ");
  });

  test("/new preserves App Handoff context through install and Provider Connections flows", () => {
    expect(newAppViewSource).toContain("appHandoffFromSearch");
    expect(newAppViewSource).toContain("appendAppHandoff");
    expect(newAppViewSource).toContain("appHandoffProductLabel");
    expect(newAppViewSource).toContain("wb-app-handoff");
    expect(newAppViewSource).toContain("handoff().returnUri");
    expect(newAppViewSource).toContain('"new.appHandoff.title"');
    expect(newAppViewSource).toContain('"new.appHandoff.body"');
    expect(newAppViewSource).toContain('"new.appHandoff.kicker"');
    expect(newAppViewSource).toContain('"new.appHandoff.return"');
    expect(en["new.appHandoff.title"]).toContain("{app}");
    expect(ja["new.appHandoff.title"]).toContain("{app}");
    // Consumer copy: the callout must not name OpenTofu / internal services.
    expect(en["new.appHandoff.body"]).not.toContain("OpenTofu");
    expect(ja["new.appHandoff.body"]).not.toContain("OpenTofu");
    expect(ja["new.appHandoff.body"]).not.toContain("Host Center");
    expect(ja["new.appHandoff.kicker"]).toBe("アプリからのリクエスト");
    expect(en["new.appHandoff.kicker"]).toBe("Requested by an app");
  });

  test("/runs can return successful App Handoff deploys back to the client", () => {
    expect(runViewSource).toContain("appHandoffFromSearch");
    expect(runViewSource).toContain("appendAppHandoff");
    expect(runViewSource).toContain("createAppHandoffConnectHref");
    expect(runViewSource).toContain("listAuthorizedUiSurfaces");
    expect(runViewSource).toContain("completedRunLaunchUrl()");
    expect(runViewSource).toContain('"run.appHandoff.open"');
    expect(en["run.appHandoff.open"]).toContain("{app}");
    expect(ja["run.appHandoff.open"]).toContain("{app}");
  });

  test("/new defaults a ready ProviderConnection after asynchronous loading", () => {
    expect(newAppViewSource).toContain(
      "defaultProviderRowsWithReadyConnections",
    );
    expect(newAppViewSource).toContain("loadProviderConnections");
    expect(newAppViewSource).toContain("const visibleProviderConnections = ()");
    expect(newAppViewSource).toContain("providerConnections() ?? []");
    expect(newAppViewSource).toContain("createEffect(() =>");
    expect(newAppViewSource).toContain("const defaultedRows =");
    expect(newAppViewSource).toContain(
      "candidates.some((connection) => connection.id === row.connectionId)",
    );
    expect(newAppViewSource).toContain("selected={!row.connectionId}");
    expect(newAppViewSource).toContain("connection.id === row.connectionId");
    expect(newAppViewSource).toContain("setProviderRows(defaultedRows)");
  });

  test("/new keeps ProviderConnection ordering independent of resource and variable names", () => {
    expect(newAppViewSource).toContain("const providerConnectionsForRow =");
    expect(newAppViewSource).toContain(
      "providerConnectionsForProvider(row.provider)",
    );
    expect(newAppViewSource).not.toContain("providerConnectionScore");
    expect(newAppViewSource).not.toContain("wantsWorkersSubdomain");
    expect(newAppViewSource).not.toContain(
      "cloudflare_workers_script_subdomain",
    );
    expect(newAppViewSource).not.toContain("cloudflare_workers_subdomain");
    expect(newAppViewSource).not.toContain("row.resourceTypes");
    expect(newAppViewSource).not.toContain("row.rootModuleVariables");
    expect(newAppViewSource).toContain(
      "const connectionId = defaultConnectionForRow(row)",
    );
    expect(newAppViewSource).toContain("const options = () =>");
    expect(newAppViewSource).toContain("providerConnectionsForRow(row)");
  });

  test("/new uses a managed provider connection and its public namespace without hard-coded app behavior", () => {
    expect(newAppViewSource).toContain("selectedManagedProviderConnection");
    expect(newAppViewSource).toContain(
      "return readyProviderConnections().find(",
    );
    expect(newAppViewSource).toContain("if (!row.connectionId) continue;");
    expect(newAppViewSource).toContain(
      "if (!managedStoreProviderForCurrentSource()) return;",
    );
    expect(newAppViewSource).toContain(
      "void loadProviderConnections().catch(() => {});",
    );
    expect(newAppViewSource).toContain("managedProviderVariableDefaults");
    expect(newAppViewSource).toContain("managedStoreProviderForCurrentSource");
    expect(newAppViewSource).toContain("managedProviderConnectionForRow");
    expect(newAppViewSource).toContain("rowCanUseManagedProviderFallback");
    expect(newAppViewSource).toContain("hasManagedProviderFallback");
    expect(newAppViewSource).toContain("rowHasManagedProviderDefault");
    expect(newAppViewSource).toContain(
      "const managed = managedProviderConnectionForRow(row)",
    );
    expect(newAppViewSource).toContain("const connectionId = managed?.id");
    expect(newAppViewSource).toContain(
      "if (rowCanUseManagedProviderFallback(row)) return false",
    );
    expect(newAppViewSource).toContain(
      "if (rowHasManagedProviderDefault(row)) return false",
    );
    expect(newAppViewSource).toContain(
      "if (rowCanUseManagedProviderFallback(row)) continue",
    );
    expect(newAppViewSource).toContain(
      ".filter((row) => row.connectionId.trim())",
    );
    expect(newAppViewSource).toContain("if (!connection) return {}");
    expect(newAppViewSource).toContain(
      "const isUsableManagedProviderConnection = (connection: ProviderConnection)",
    );
    expect(newAppViewSource).toContain('connection.status === "pending" &&');
    expect(newAppViewSource).toContain(
      "isPublicManagedProviderConnection(connection)",
    );
    expect(connectionContractSource).toContain(
      'connection.scope === "operator" &&',
    );
    expect(connectionContractSource).toContain(
      "connection.workspaceId === undefined &&",
    );
    expect(connectionContractSource).toContain(
      "connection.scopeHints?.managedProvider === true &&",
    );
    expect(connectionContractSource).toContain(
      "managedProviderProfile(connection.scopeHints) !== undefined",
    );
    expect(newAppViewSource).not.toContain(
      "connection.scopeHints.providerConfig?.base_url",
    );
    expect(newAppViewSource).toContain(
      "visibleProviderConnections().filter(isReadyProviderConnection)",
    );
    expect(newAppViewSource).toContain(
      "new Set(compatibility()?.rootModuleVariables ?? [])",
    );
    expect(newAppViewSource).toContain("installExperienceForCurrentSource");
    expect(newAppViewSource).toContain(
      "const publicEndpoint = installExperiencePublicEndpoint(installExperience)",
    );
    expect(newAppViewSource).toContain("publicEndpoint?.subdomainVariable");
    expect(newAppViewSource).toContain("publicEndpoint?.urlVariable");
    expect(newAppViewSource).not.toContain('variables.has("worker_name")');
    expect(newAppViewSource).not.toContain('variables.has("app_url")');
    expect(newAppViewSource).not.toContain('setDefault("worker_name"');
    expect(newAppViewSource).not.toContain('setDefault("app_url"');
    expect(newAppViewSource).toContain("managedBaseDomain");
    expect(newAppViewSource).toContain("effectiveManagedBaseDomain");
    expect(newAppViewSource).toContain("managedPublicBaseDomain");
    expect(newAppViewSource).toContain(
      "const managedAppLabel = currentSubdomain",
    );
    expect(newAppViewSource).toContain("managedServiceLabel(workspaceHandle()");
    expect(newAppViewSource).toContain("routePatternFromAppUrl");
    expect(newAppViewSource).toContain("const currentSubdomain =");
    expect(newAppViewSource).toContain("const currentAppUrl =");
    expect(newAppViewSource).toContain(
      "connection.scopeHints?.moduleInputDefaults ?? {}",
    );
    expect(newAppViewSource).not.toContain('"cloudflare_route_zone_id"');
    expect(newAppViewSource).not.toContain("connection.scopeHints?.zoneId");
  });

  test("/new only asks for Provider Connections from explicit compatibility data", () => {
    expect(newAppViewSource).not.toContain(
      'from "takosumi-contract/provider-env-rules"',
    );
    expect(newAppViewSource).toContain("const providerRequiresConnection =");
    expect(newAppViewSource).toContain("provider.credentialRequired === true");
    expect(newAppViewSource).toContain("sameProviderSource");
    expect(newAppViewSource).not.toContain("sameProviderFamily");
    expect(newAppViewSource).not.toContain("CREDENTIAL_FREE_PROVIDER_TAILS");
    expect(newAppViewSource).toContain(
      ".filter((row) => providerRequiresConnection(row))",
    );
  });

  test("guided fields do not create a dashboard-owned provider settings authority", () => {
    expect(connectionsTabSource).not.toContain(
      "providerSettingsFromConnectionValues",
    );
    expect(connectionsTabSource).not.toContain("helperValues");
    expect(connectionsTabSource).not.toContain("providerId ===");
    expect(connectionsTabSource).toContain("provider: option.providerSource");
    expect(connectionsTabSource).toContain("option.credentialRecipe");
    expect(connectionsHelperSource).toContain("definition.env");
    expect(connectionsHelperSource).toContain("definition.inputHints");
    expect(connectionsHelperSource).not.toContain("providerSettings");
  });

  test("compatibility adapter preserves backend resource summaries", () => {
    expect(controlApiSource).toContain("body.report.resources ?? []");
    expect(controlApiSource).not.toContain("resources: []");
  });

  test("/new only proceeds when the compatibility report is runnable", () => {
    expect(newAppViewSource).toContain("const compatibilityRunnable = () =>");
    expect(newAppViewSource).toContain('level === "ready"');
    expect(newAppViewSource).not.toContain("auto_capsulized");
    expect(newAppViewSource).toContain('"new.error.notRunnable"');
  });

  test("/new retries source-sync waits by rechecking when no compatibility report exists", () => {
    expect(newAppViewSource).toContain("sourceIdFromControlError");
    expect(newAppViewSource).toContain("onSourceCreated");
    expect(newAppViewSource).toContain("const retryAfterSyncWait = () =>");
    expect(newAppViewSource).toContain("else void runCompatibilityCheck()");
  });

  test("/new surfaces source-sync diagnostics instead of hiding ref errors", () => {
    expect(controlApiSource).toContain("sourceSyncFailureMessage");
    expect(controlApiSource).toContain("getRunLogsWithOptions");
    expect(newAppViewSource).toContain("sourceFetchErrorMessage");
    expect(newAppViewSource).toContain("addFlowErrorMessage");
    expect(newAppViewSource).toContain("apiError?.isAppHostnameUnavailable");
    expect(newAppViewSource).toContain('"new.error.appHostnameUnavailable"');
    expect(newAppViewSource).toContain("appHostnameConflict");
    expect(newAppViewSource).toContain("uniqueServiceIdCandidate");
    expect(newAppViewSource).toContain('"new.hostnameConflict.suggest"');
    expect(en["new.error.appHostnameUnavailable"]).toContain("already in use");
    expect(ja["new.error.appHostnameUnavailable"]).toContain(
      "既に使われています",
    );
    expect(en["new.hostnameConflict.body"]).not.toContain("workspace");
    expect(ja["new.hostnameConflict.body"]).not.toContain("ワークスペース");
    expect(en["new.error.alreadyExistsGeneric"]).not.toContain("workspace");
    expect(ja["new.error.alreadyExistsGeneric"]).not.toContain(
      "ワークスペース",
    );
    expect(newAppViewSource).toContain("force: options.force");
    expect(newAppViewSource).toContain("{ force: true }");
    expect(newAppViewSource).toContain('"new.error.nameReserved"');
    expect(en["new.error.nameReserved"]).toContain("not found");
    expect(ja["new.error.nameReserved"]).toContain("現在の一覧");
    expect(newAppViewSource).toContain('"new.error.genericWithDetails"');
    expect(en["new.error.genericWithDetails"]).toContain("{message}");
    expect(ja["new.error.genericWithDetails"]).toContain("{message}");
    expect(newAppViewSource).toContain(
      "source ref did not resolve to a commit",
    );
    expect(newAppViewSource).toContain('"new.error.sourceRefNotFound"');
    expect(en["new.error.sourceRefNotFound"]).toContain("{ref}");
    expect(ja["new.error.sourceRefNotFound"]).toContain("{ref}");
    expect(en["new.error.sourceFetchFailed"]).toContain("{message}");
    expect(ja["new.error.sourceFetchFailed"]).toContain("{message}");
  });

  test("/new can use a Source Git credential for private repositories", () => {
    expect(newAppViewSource).toContain("createSourceHttpsTokenConnection");
    expect(newAppViewSource).toContain("listConnections");
    expect(newAppViewSource).toContain("testConnection(connection.id)");
    expect(newAppViewSource).toContain('type SourceAccessMode = "public"');
    expect(newAppViewSource).toContain('"source_git_https_token"');
    expect(newAppViewSource).toContain(
      "authConnectionId: sourceAuthConnectionIdForRun()",
    );
    // 3 run-input sites + the Source-identity snapshot (edit-during-install
    // fix: retries reuse the created Source when the coordinates match).
    expect(
      newAppViewSource.match(/sourceAuthConnectionIdForRun\(\)/g) ?? [],
    ).toHaveLength(4);
    expect(controlApiSource).toContain(
      "export async function createSourceHttpsTokenConnection",
    );
    expect(controlApiSource).toContain('kind: "source_git_https_token"');
    expect(controlApiSource).toContain("readonly authConnectionId?: string");
    expect(
      controlApiSource.match(/authConnectionId: input.authConnectionId/g) ?? [],
    ).toHaveLength(2);
  });

  test("/new retry still saves Provider Connections after a partial install create", () => {
    const createIndex = newAppViewSource.indexOf("await createCapsule({");
    const setCreatedIndex = newAppViewSource.indexOf(
      "setCreatedCapsuleId(capsuleId);",
    );
    const payloadIndex = newAppViewSource.indexOf(
      "const providerBindingsForRun = providerBindingsPayload();",
    );
    const saveIndex = newAppViewSource.indexOf(
      "await putCapsuleProviderBindingSet(",
    );
    const doneIndex = newAppViewSource.indexOf('setStepInstall("done");');

    expect(createIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(payloadIndex);
    expect(setCreatedIndex).toBeGreaterThan(createIndex);
    expect(saveIndex).toBeGreaterThan(setCreatedIndex);
    expect(doneIndex).toBeGreaterThan(saveIndex);
    expect(
      newAppViewSource.match(/await putCapsuleProviderBindingSet\(/g) ?? [],
    ).toHaveLength(1);
  });

  test("/new carries the compatibility report into the first plan request", () => {
    expect(newAppViewSource).toContain(
      "compatibilityReportId: compatibility()?.reportId",
    );
    expect(newAppViewSource).toContain("const planOptions = {");
    expect(newAppViewSource).toContain(
      "compatibilityReportId: flowInput.compatibilityReportId",
    );
    expect(newAppViewSource).not.toContain("PLAN_REQUEST_TIMEOUT_MS");
    expect(newAppViewSource).not.toContain("isPlanRequestTimeout");
    expect(newAppViewSource).toContain(
      "const planEnvelope = await planCapsule(capsuleId, planOptions)",
    );
    expect(controlApiSource).toContain(
      "readonly compatibilityReportId?: string",
    );
    expect(controlApiSource).toContain("body: options.compatibilityReportId");
  });

  test("/new clears add-flow busy state when a stale flow is aborted", () => {
    expect(newAppViewSource).toContain(
      "const currentFlow = isCurrentFlow(flow);",
    );
    expect(newAppViewSource).toContain(
      "if (currentFlow || activeFlowAbort === undefined)",
    );
    expect(newAppViewSource).toContain("setBusy(false);");
  });

  test("/new guards stale async add flows and validates service slugs before backend submit", () => {
    expect(newAppViewSource).toContain("type FlowRun");
    expect(newAppViewSource).toContain("const throwIfStaleFlow =");
    expect(newAppViewSource).toContain("abortActiveFlow()");
    expect(newAppViewSource).toContain("const flowInput = {");
    expect(newAppViewSource).toContain(
      "const providerBindingsForRun = providerBindingsPayload();",
    );
    expect(newAppViewSource).not.toContain(
      "providerConnections: providerBindingsPayload()",
    );
    expect(newAppViewSource).toContain("await settleProviderConnectionRows();");
    expect(
      newAppViewSource.match(/await settleProviderConnectionRows\(\);/g) ?? [],
    ).toHaveLength(3);
    expect(newAppViewSource).toContain("throwIfStaleFlow(flow)");
    expect(newAppViewSource).toContain("CAPSULE_NAME_PATTERN");
    expect(newAppViewSource).toContain('"new.error.nameInvalid"');
    expect(en["new.error.nameInvalid"]).toContain("lowercase");
    expect(ja["new.error.nameInvalid"]).toContain("半角英小文字");
  });

  test("duplicate Capsule errors use typed details without message inference", () => {
    expect(controlApiSource).toContain("get isDuplicateService()");
    expect(controlApiSource).toContain("function controlErrorDetails");
    expect(controlApiSource).toContain('"duplicate_capsule"');
    expect(controlApiSource).not.toContain('"duplicate_installation"');
    expect(controlApiSource).not.toContain(".test(this.message)");
    expect(controlApiSource).not.toContain("this.message.includes(");
    expect(controlApiSource).not.toContain("this.message.startsWith(");
    expect(newAppViewSource).toContain("error?.isDuplicateService");
    expect(installationsServiceSource).toContain('reason: "duplicate_capsule"');
    expect(installationsServiceSource).toContain('"capsule already exists"');
    expect(installationsServiceSource).not.toContain(
      "`capsule @${workspace.handle}/${request.name}",
    );
    expect(installationsServiceSource).not.toContain("capsuleId: existing.id");
    expect(controlSharedSource).toContain("error.details");
    expect(controlSharedSource).toContain("function isRecord");
    // The thin shell still routes through the resource dispatch table.
    expect(controlRoutesSource).toContain("RESOURCE_HANDLERS");
  });

  test("/new translates known compatibility diagnostics into user-facing copy", () => {
    expect(controlApiSource).toContain("code: finding.code");
    expect(newAppViewSource).toContain("compatibilityDiagnosticDisplay");
    expect(newAppViewSource).toContain("compatibilitySummaryDisplay");
    expect(newAppViewSource).toContain("provider_credentials_in_source");
    expect(newAppViewSource).toContain("provider_configuration_preserved");
    expect(newAppViewSource).toContain("backend_state_isolated");
    expect(newAppViewSource).not.toContain("provider_block_lift_candidate");
    expect(newAppViewSource).not.toContain("backend_override_candidate");
    expect(newAppViewSource).toContain("dependency_lock_detected");
    expect(newAppViewSource).toContain(
      '"new.compat.summary.providerCredentials"',
    );
    expect(newAppViewSource).toContain(
      '"new.compat.issue.providerCredentials.message"',
    );
    expect(newAppViewSource).toContain('"new.compat.issue.lockfile.message"');
  });

  test("/new retries transient compatibility checks after source sync races", () => {
    expect(newAppViewSource).toContain("compatibilityCheckLooksTransient");
    expect(newAppViewSource).toContain("abortableDelay(1_500");
    expect(newAppViewSource).toContain(
      'diagnostic.code === "capsule_compatibility_check_failed"',
    );
    expect(newAppViewSource).not.toContain('text.includes("source sync")');
    expect(newAppViewSource).toContain(
      "sourceId: result.sourceId ?? createdSourceId() ?? undefined",
    );
  });

  test("connections tab gives form controls stable names", () => {
    expect(connectionsTabSource).toContain('name="provider"');
    expect(connectionsTabSource).toContain('name="displayName"');
    expect(connectionsTabSource).toContain('name="genericProvider"');
    expect(connectionsTabSource).toContain("name={`field:${field().envName}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvName:${index}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvValue:${index}`}");
  });

  test("recipe-described connection submit includes the typed display name", () => {
    expect(connectionsTabSource).toContain(
      "const createFromRecipe = createAction",
    );
    expect(connectionsTabSource).toContain(
      "displayName: displayName().trim() || option.label",
    );
  });

  test("provider setup copy and URLs come from service CredentialRecipes", () => {
    expect(connectionsHelperSource).toContain(
      "providerSetupOptionsFromCredentialRecipes",
    );
    expect(connectionsHelperSource).toContain("definition.presentation");
    expect(connectionsHelperSource).not.toContain("cloudflare");
    expect(connectionsHelperSource).not.toContain("hashicorp/aws");
    expect(connectionsHelperSource).not.toContain("https://");
    expect(connectionsTabSource).toContain("listCredentialRecipes");
  });

  test("reference guided fields are generated from provider recipe files", () => {
    for (const envName of [
      "CLOUDFLARE_API_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "HCLOUD_TOKEN",
      "AWS_ENDPOINT_URL_S3",
    ]) {
      expect(credentialRecipesSource).toContain(envName);
    }
    expect(credentialRecipesSource).toContain("showInConnectionSetup");
    expect(credentialRecipesSource).toContain("setupGuide");
    expect(connectionsHelperSource).toContain("credentialRecipe:");
    expect(connectionsTabSource).toContain("provider: option.providerSource");
  });

  test("custom ProviderConnection path asks for provider source and env variables", () => {
    expect(connectionsTabSource).toContain("GENERIC_ENV_PROVIDER_OPTION");
    expect(connectionsTabSource).toContain('"conn.byok.title"');
    expect(connectionsTabSource).toContain('"conn.byok.body"');
    expect(connectionsTabSource).toContain('"conn.byok.noBillingNote"');
    expect(connectionsTabSource).toContain('"conn.byok.usePreset"');
    // Installed recipes are the default surface; the raw BYOK editor sits behind
    // the quiet advanced control.
    expect(connectionsTabSource).toContain('"conn.add.genericEnvOption"');
    expect(connectionsTabSource).toContain(
      "providerSetupOptionsFromCredentialRecipes",
    );
    expect(connectionsTabSource).toContain("setProvider(options[0].id)");
    expect(connectionsTabSource).toContain(
      'placeholder={t("conn.genericEnv.providerPlaceholder")}',
    );
    expect(connectionsTabSource).toContain(
      '"conn.genericEnv.envNamePlaceholder"',
    );
    expect(connectionsTabSource).toContain('"conn.genericEnv.providerName"');
    expect(connectionsTabSource).toContain('"conn.genericEnv.envName"');
    expect(connectionsTabSource).toContain("isProviderEnvName(envName)");
    expect(connectionsTabSource).toContain(
      "isReservedProviderEnvName(envName)",
    );
    expect(connectionsTabSource).toContain("seenEnvNames.has(envName)");
    expect(connectionsTabSource).toContain("const value = pair.value;");
    expect(connectionsTabSource).not.toContain(
      "const value = pair.value.trim();",
    );
    expect(en["conn.genericEnv.providerName"]).toBe("Provider source");
    expect(en["conn.genericEnv.providerPlaceholder"]).toBe(
      "examplecorp/example",
    );
    expect(en["conn.genericEnv.envName"]).toBe("Env name");
    expect(en["conn.genericEnv.envNamePlaceholder"]).toBe("EXAMPLE_API_TOKEN");
    expect(en["conn.genericEnv.invalidName"]).toContain("uppercase env name");
    expect(en["conn.genericEnv.reservedName"]).toContain(
      "reserved for the runner",
    );
    expect(en["conn.genericEnv.duplicateName"]).toContain("already added");
    expect(ja["conn.genericEnv.envName"]).toBe("env 名");
    expect(ja["conn.genericEnv.reservedName"]).toContain("予約名");
    expect(connectionsTabSource).not.toContain('placeholder="private-api"');
    expect(connectionsTabSource).not.toContain('placeholder="API_TOKEN"');
    expect(connectionsTabSource).not.toContain(
      '"conn.genericEnv.cloudflareGuided"',
    );
    expect(en).not.toHaveProperty("conn.custom.summary");
    expect(ja).not.toHaveProperty("conn.custom.summary");
  });

  test("ProviderConnection list stays friendly and hides raw credential plumbing", () => {
    expect(connectionsTabSource).toContain("providerConnectionProviderLabel");
    expect(connectionsTabSource).toContain('class="wc-conn-actions"');
    expect(connectionsTabSource).toContain("providerConnections.loading");
    expect(connectionsTabSource).not.toContain(
      "providerConnectionOwnershipLabel",
    );
    expect(connectionsTabSource).not.toContain('class="wc-inline-details"');
    expect(connectionsTabSource).not.toContain(
      '<code class="wc-code">{connection.id}</code>',
    );
    expect(connectionsTabSource).not.toContain("{connection.providerSource}");
    expect(connectionsTabSource).not.toContain("c.envNames.join");
    expect(connectionsTabSource).not.toContain("providerConnectionColumns");
    expect(connectionsTabSource).not.toContain("<DataTable");
    expect(connectionsTabSource).not.toContain(
      '<summary>{t("conn.list.title")}</summary>',
    );
    expect(connectionsTabSource).not.toContain(
      'cell: (d) => <Badge tone="neutral">{t("conn.ownership.ownKey")}</Badge>',
    );
    expect(connectionsTabSource).not.toContain(
      'subtitle={t("conn.providerConnections.subtitle")}',
    );
    expect(connectionsTabSource).not.toContain(
      'subtitle={t("conn.add.subtitle")}',
    );
    expect(connectionsTabSource).not.toContain('"conn.guided.intro"');
    expect(connectionsTabSource).not.toContain('"conn.genericEnv.intro"');
    expect(en).not.toHaveProperty("conn.providerConnections.subtitle");
    expect(ja).not.toHaveProperty("conn.providerConnections.subtitle");
    expect(en).not.toHaveProperty("conn.add.subtitle");
    expect(ja).not.toHaveProperty("conn.add.subtitle");
    expect(en).not.toHaveProperty("conn.guided.intro");
    expect(ja).not.toHaveProperty("conn.guided.intro");
    expect(en).not.toHaveProperty("conn.genericEnv.intro");
    expect(ja).not.toHaveProperty("conn.genericEnv.intro");
  });

  test("provider connection labels fall back to friendly service names", () => {
    expect(newAppViewSource).toContain(
      "connection.displayName || providerLabel(connection.providerSource)",
    );
    expect(appDetailViewSource).toContain(
      "providerDisplayName(providerConnection.providerSource)",
    );
    expect(runViewSource).toContain(
      "connection.displayName || providerDisplayName(connection.providerSource)",
    );
    expect(newAppViewSource).not.toContain(
      "connection.displayName || connection.providerSource",
    );
    expect(appDetailViewSource).not.toContain(
      "providerConnection.displayName || providerConnection.providerSource",
    );
    expect(runViewSource).not.toContain(
      "connection?.displayName || connection?.providerSource",
    );
  });

  test("deep-linked detail views import their view CSS explicitly", () => {
    expect(appDetailViewSource).toContain('import "../../styles/wave-a.css"');
    expect(appDetailViewSource).toContain('import "../../styles/wave-b.css"');
    expect(appDetailViewSource).toContain(
      'import "../../styles/app-views.css"',
    );
    expect(accountViewSource).toContain('import "../../styles/wave-c.css"');
    expect(spaceSettingsViewSource).toContain(
      'import "../../styles/wave-a.css"',
    );
  });
});
