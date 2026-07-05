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
const newAppViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/new/NewAppView.tsx"),
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
const controlApiSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/lib/control-api.ts"),
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
    ).toHaveLength(3);
    expect(
      connectionsTabSource.match(/await runTest\(connection\.id\)/g) ?? [],
    ).toHaveLength(3);
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

  test("/new explains rejected external install links instead of silently opening the catalog", () => {
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
    expect(en["new.appHandoff.body"]).toContain("OpenTofu");
    expect(ja["new.appHandoff.body"]).toContain("OpenTofu");
    expect(en["new.appHandoff.kicker"]).toBe("App Handoff");
    expect(ja["new.appHandoff.kicker"]).toBe("App Handoff");
  });

  test("/runs can return successful App Handoff deploys back to the client", () => {
    expect(runViewSource).toContain("appHandoffFromSearch");
    expect(runViewSource).toContain("appendAppHandoff");
    expect(runViewSource).toContain("createAppHandoffConnectHref");
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

  test("/new prefers Cloudflare connections that can derive workers.dev launch URLs", () => {
    expect(newAppViewSource).toContain("const providerConnectionScore =");
    expect(newAppViewSource).toContain("const wantsWorkersSubdomain =");
    expect(newAppViewSource).toContain(
      'row.resourceTypes.includes("cloudflare_workers_script_subdomain")',
    );
    expect(newAppViewSource).toContain(
      'row.rootModuleVariables.includes("cloudflare")',
    );
    expect(newAppViewSource).toContain(
      'row.rootModuleVariables.includes("cloudflare_workers_subdomain")',
    );
    expect(newAppViewSource).toContain(
      'row.rootModuleVariables.includes("workersSubdomain")',
    );
    expect(newAppViewSource).toContain(
      "connection.scopeHints?.workersSubdomain",
    );
    expect(newAppViewSource).toContain("const providerConnectionsForRow =");
    expect(newAppViewSource).toContain(
      "providerConnectionScore(row, connection)",
    );
    expect(newAppViewSource).toContain(
      "const connectionId = defaultConnectionForRow(row)",
    );
    expect(newAppViewSource).toContain(
      "const options = () => providerConnectionsForRow(row)",
    );
    expect(newAppViewSource).toContain(
      "rootModuleVariables: result.rootModuleVariables",
    );
    expect(controlApiSource).toContain(
      "readonly rootModuleVariables: readonly string[]",
    );
    expect(controlApiSource).toContain(
      "rootModuleVariables: body.report.rootModuleVariables ?? []",
    );
  });

  test("/new only asks for Provider Connections when the provider has credential env rules", () => {
    expect(newAppViewSource).toContain(
      'from "takosumi-contract/provider-env-rules"',
    );
    expect(newAppViewSource).toContain("const providerRequiresConnection =");
    expect(newAppViewSource).toContain(
      "providerEnvRule(provider) !== undefined",
    );
    expect(newAppViewSource).toContain(
      "provider.allowed && providerRequiresConnection(provider.source)",
    );
    expect(newAppViewSource).toContain(
      ".filter((row) => providerRequiresConnection(row.provider))",
    );
  });

  test("Cloudflare connection form requires and forwards account id as a scope hint", () => {
    expect(connectionsTabSource).toContain("scopeHintsFromConnectionValues");
    expect(connectionsTabSource).toContain("helperCloudflareAccountId");
    expect(connectionsTabSource).toContain("helperCloudflareWorkersSubdomain");
    expect(connectionsTabSource).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(connectionsTabSource).toContain(
      "submitValues.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId",
    );
    expect(connectionsTabSource).toContain(
      "scopeHints: scopeHintsFromConnectionValues(",
    );
    expect(connectionsTabSource).toContain("d.providerSource ?? d.provider");
    expect(connectionsHelperSource).toContain(
      'envName: "CLOUDFLARE_ACCOUNT_ID"',
    );
    expect(connectionsHelperSource).toContain("required: true");
  });

  test("compatibility adapter preserves backend resource summaries", () => {
    expect(controlApiSource).toContain("body.report.resources ?? []");
    expect(controlApiSource).not.toContain("resources: []");
  });

  test("/new only proceeds when the compatibility report is runnable", () => {
    expect(newAppViewSource).toContain("const compatibilityRunnable = () =>");
    expect(newAppViewSource).toContain('level === "ready"');
    expect(newAppViewSource).toContain('level === "auto_capsulized"');
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
    expect(
      newAppViewSource.match(/sourceAuthConnectionIdForRun\(\)/g) ?? [],
    ).toHaveLength(2);
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
      "const providerConnectionsForRun = providerConnectionsPayload();",
    );
    const saveIndex = newAppViewSource.indexOf(
      "await putCapsuleProviderConnectionSet(",
    );
    const doneIndex = newAppViewSource.indexOf('setStepInstall("done");');

    expect(createIndex).toBeGreaterThan(-1);
    expect(payloadIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(payloadIndex);
    expect(setCreatedIndex).toBeGreaterThan(createIndex);
    expect(saveIndex).toBeGreaterThan(setCreatedIndex);
    expect(doneIndex).toBeGreaterThan(saveIndex);
    expect(
      newAppViewSource.match(/await putCapsuleProviderConnectionSet\(/g) ?? [],
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
    expect(controlApiSource).toContain(
      "body: options.compatibilityReportId",
    );
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
      "const providerConnectionsForRun = providerConnectionsPayload();",
    );
    expect(newAppViewSource).not.toContain(
      "providerConnections: providerConnectionsPayload()",
    );
    expect(newAppViewSource).toContain("await settleProviderConnectionRows();");
    expect(
      newAppViewSource.match(/await settleProviderConnectionRows\(\);/g) ?? [],
    ).toHaveLength(3);
    expect(newAppViewSource).toContain("throwIfStaleFlow(flow)");
    expect(newAppViewSource).toContain("INSTALLATION_NAME_PATTERN");
    expect(newAppViewSource).toContain('"new.error.nameInvalid"');
    expect(en["new.error.nameInvalid"]).toContain("lowercase");
    expect(ja["new.error.nameInvalid"]).toContain("半角小文字");
  });

  test("duplicate installation errors use typed details before message fallback", () => {
    expect(controlApiSource).toContain("get isDuplicateService()");
    expect(controlApiSource).toContain("function controlErrorDetails");
    expect(controlApiSource).toContain('"duplicate_installation"');
    expect(newAppViewSource).toContain("error?.isDuplicateService");
    expect(installationsServiceSource).toContain('reason: "duplicate_capsule"');
    expect(installationsServiceSource).toContain("capsuleId: existing.id");
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
    expect(newAppViewSource).toContain("provider_block_lift_candidate");
    expect(newAppViewSource).toContain("dependency_lock_detected");
    expect(newAppViewSource).toContain(
      '"new.compat.summary.providerCredentials"',
    );
    expect(newAppViewSource).toContain(
      '"new.compat.issue.providerCredentials.message"',
    );
    expect(newAppViewSource).toContain('"new.compat.issue.lockfile.message"');
  });

  test("connections tab gives form controls stable names", () => {
    expect(connectionsTabSource).toContain('name="provider"');
    expect(connectionsTabSource).toContain('name="displayName"');
    expect(connectionsTabSource).toContain('name="helperToken"');
    expect(connectionsTabSource).toContain('name="helperCloudflareAccountId"');
    expect(connectionsTabSource).toContain('name="genericProvider"');
    expect(connectionsTabSource).toContain("name={`field:${field().envName}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvName:${index}`}");
    expect(connectionsTabSource).toContain("name={`genericEnvValue:${index}`}");
  });

  test("guided provider connection submit includes the typed display name", () => {
    expect(connectionsTabSource).toContain(
      "const createFromHelper = createAction",
    );
    expect(connectionsTabSource).toContain(
      "displayName:\n        displayName().trim() || (d.providerSource ? d.label : undefined)",
    );
  });

  test("provider setup helper copy goes through dashboard i18n", () => {
    expect(connectionsHelperSource).toContain("providerCopy");
    expect(connectionsHelperSource).toContain(
      '"conn.provider.cloudflare.helper.stepOpen"',
    );
    expect(connectionsHelperSource).not.toContain(
      "下のボタンで Cloudflare のトークン作成画面を開きます。",
    );
    expect(connectionsHelperSource).not.toContain("API トークン");
    expect(connectionsHelperSource).not.toContain("アカウント ID");
  });

  test("connections tab exposes common OpenTofu provider env recipes before custom env", () => {
    for (const provider of [
      "cloudflare",
      "aws",
      "gcp",
      "hcloud",
      "s3-compatible",
    ]) {
      expect(connectionsHelperSource).toContain(`provider: "${provider}"`);
    }
    for (const envName of [
      "CLOUDFLARE_API_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GOOGLE_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "HCLOUD_TOKEN",
      "AWS_ENDPOINT_URL_S3",
    ]) {
      expect(connectionsHelperSource).toContain(`envName: "${envName}"`);
    }
    expect(en["conn.provider.aws.label"]).toBe("AWS");
    expect(ja["conn.provider.gcp.label"]).toBe("Google Cloud");
    expect(connectionsHelperSource).toContain(
      'providerSource: "hetznercloud/hcloud"',
    );
    expect(connectionsHelperSource).toContain(
      'providerSource: "hashicorp/aws"',
    );
    expect(connectionsTabSource).toContain(
      "provider: d.providerSource ?? d.provider",
    );
  });

  test("custom ProviderConnection path asks for provider source and env variables", () => {
    expect(connectionsTabSource).toContain("GENERIC_ENV_PROVIDER_OPTION");
    expect(connectionsTabSource).toContain('"conn.genericEnv.option"');
    expect(connectionsTabSource).toContain('"conn.genericEnv.summary"');
    expect(connectionsTabSource).toContain('"conn.genericEnv.body"');
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
    expect(en["conn.genericEnv.option"]).toBe("Set up other connection");
    expect(en["conn.genericEnv.providerName"]).toBe("Provider source");
    expect(en["conn.genericEnv.providerPlaceholder"]).toBe(
      "snowflake-labs/snowflake",
    );
    expect(en["conn.genericEnv.envName"]).toBe("Env name");
    expect(en["conn.genericEnv.envNamePlaceholder"]).toBe("SNOWFLAKE_PASSWORD");
    expect(en["conn.genericEnv.invalidName"]).toContain("uppercase env name");
    expect(en["conn.genericEnv.reservedName"]).toContain(
      "reserved for the runner",
    );
    expect(en["conn.genericEnv.duplicateName"]).toContain("already added");
    expect(ja["conn.genericEnv.option"]).toBe("その他の接続を設定");
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
