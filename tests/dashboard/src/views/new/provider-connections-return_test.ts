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
    "../../../../../dashboard/src/views/space/tabs/ConnectionsTab.tsx",
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
const accountViewSource = readFileSync(
  resolve(here, "../../../../../dashboard/src/views/account/AccountView.tsx"),
  "utf8",
);
const spaceSettingsViewSource = readFileSync(
  resolve(
    here,
    "../../../../../dashboard/src/views/space/SpaceSettingsView.tsx",
  ),
  "utf8",
);
const installationsServiceSource = readFileSync(
  resolve(here, "../../../../../core/domains/installations/mod.ts"),
  "utf8",
);
const controlRoutesSource = readFileSync(
  resolve(here, "../../../../../accounts/service/src/control-routes.ts"),
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
      'href="/space/settings/connections"',
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
      'lastCreatedProviderConnection()?.status === "ready" ||',
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

  test("/new does not send operator-managed-only requirements to own-key setup", () => {
    expect(newAppViewSource).toContain("rowRequiresOperatorManagedOnly");
    expect(newAppViewSource).toContain("missingOperatorManagedProviderRows");
    expect(newAppViewSource).toContain("missingOwnKeyProviderRows");
    expect(newAppViewSource).toContain('"new.providers.operatorMissingTitle"');
    expect(newAppViewSource).toContain('"new.providers.errorOperatorManaged"');
    expect(newAppViewSource).toContain('"new.providers.operatorMissingNext"');
    expect(en["new.providers.operatorMissingBody"]).not.toContain(
      "Provider Connection",
    );
    expect(en["new.providers.operatorMissingBody"]).not.toContain("operator");
    expect(en["new.providers.operatorMissingBody"]).not.toContain(
      "Takosumi Cloud",
    );
    expect(en["new.providers.operatorMissingNext"]).toContain(
      "workspace admin",
    );
    expect(ja["new.providers.operatorMissingBody"]).not.toContain(
      "Provider Connection",
    );
    expect(ja["new.providers.operatorMissingBody"]).not.toContain("運営側");
    expect(ja["new.providers.operatorMissingBody"]).not.toContain(
      "Takosumi Cloud",
    );
  });

  test("/new explains rejected external install links instead of silently opening the catalog", () => {
    expect(newAppViewSource).toContain("hasInstallPrefillParams");
    expect(newAppViewSource).toContain("installPrefillRejected");
    expect(newAppViewSource).toContain('"new.deeplink.invalidTitle"');
    expect(newAppViewSource).toContain('"new.deeplink.invalidBody"');
    expect(en["new.deeplink.invalidBody"].toLowerCase()).toContain(
      "paste the git url manually",
    );
    expect(ja["new.deeplink.invalidBody"]).toContain("手動で貼り付け");
  });

  test("/new defaults a ready ProviderConnection after asynchronous loading", () => {
    expect(newAppViewSource).toContain(
      "defaultProviderRowsWithReadyConnections",
    );
    expect(newAppViewSource).toContain("const visibleProviderConnections = ()");
    expect(newAppViewSource).toContain(
      "providerConnections() ?? providerConnections.latest ?? []",
    );
    expect(newAppViewSource).toContain("createEffect(() =>");
    expect(newAppViewSource).toContain("const defaultedRows =");
    expect(newAppViewSource).toContain(
      "candidates.some((connection) => connection.id === row.connectionId)",
    );
    expect(newAppViewSource).toContain("selected={!row.connectionId}");
    expect(newAppViewSource).toContain("connection.id === row.connectionId");
    expect(newAppViewSource).toContain("setProviderRows(defaultedRows)");
  });

  test("Cloudflare connection form requires and forwards account id as a scope hint", () => {
    expect(connectionsTabSource).toContain("scopeHintsFromConnectionValues");
    expect(connectionsTabSource).toContain("helperCloudflareAccountId");
    expect(connectionsTabSource).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(connectionsTabSource).toContain(
      "submitValues.CLOUDFLARE_ACCOUNT_ID = cloudflareAccountId",
    );
    expect(connectionsTabSource).toContain(
      "scopeHints: scopeHintsFromConnectionValues(d.provider, submitValues)",
    );
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
    const createIndex = newAppViewSource.indexOf("await createInstallation({");
    const setCreatedIndex = newAppViewSource.indexOf(
      "setCreatedInstallationId(installationId);",
    );
    const saveIndex = newAppViewSource.indexOf(
      "await putInstallationProviderConnectionSet(",
    );
    const doneIndex = newAppViewSource.indexOf('setStepInstall("done");');

    expect(createIndex).toBeGreaterThan(-1);
    expect(setCreatedIndex).toBeGreaterThan(createIndex);
    expect(saveIndex).toBeGreaterThan(setCreatedIndex);
    expect(doneIndex).toBeGreaterThan(saveIndex);
    expect(
      newAppViewSource.match(/await putInstallationProviderConnectionSet\(/g) ??
        [],
    ).toHaveLength(1);
  });

  test("/new guards stale async add flows and validates service slugs before backend submit", () => {
    expect(newAppViewSource).toContain("type FlowRun");
    expect(newAppViewSource).toContain("const throwIfStaleFlow =");
    expect(newAppViewSource).toContain("abortActiveFlow()");
    expect(newAppViewSource).toContain("const flowInput = {");
    expect(newAppViewSource).toContain(
      "providerConnections: providerConnectionsPayload()",
    );
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
    expect(installationsServiceSource).toContain(
      'reason: "duplicate_installation"',
    );
    expect(installationsServiceSource).toContain("installationId: existing.id");
    expect(controlRoutesSource).toContain("error.details");
    expect(controlRoutesSource).toContain("function isRecord");
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

  test("Cloudflare OAuth start includes the typed display name", () => {
    expect(connectionsTabSource).toContain("const startOAuth = async () =>");
    expect(connectionsTabSource).toContain(
      "displayName: displayName().trim() || undefined",
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
