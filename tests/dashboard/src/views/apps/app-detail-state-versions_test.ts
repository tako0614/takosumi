/**
 * Source-assertion regression tests for the Capsule detail StateVersion surface.
 * Pure-source
 * assertions: they lock in the load-bearing wiring so a future edit that drops
 * the update-history surface, the restore→Run navigation, or the rule that
 * StateVersion never becomes runtime discovery authority fails loudly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  new URL(
    "../../../../../dashboard/src/views/apps/WorkloadDetailView.tsx",
    import.meta.url,
  ),
  "utf8",
);
// The config-editor row model (seeding + dirty-only save patch) lives in the
// shared lib so its write semantics are unit-testable
// (tests/dashboard/src/lib/config-variables_test.ts).
const capsulesUiSource = readFileSync(
  new URL("../../../../../dashboard/src/lib/capsules-ui.ts", import.meta.url),
  "utf8",
);

function section(startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return start >= 0 && end >= 0 ? source.slice(start, end) : "";
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("Capsule detail StateVersion surface", () => {
  test("renders public-surface and update-history sections via the dictionary", () => {
    expect(source).toContain('t("app.surfaces.title")');
    expect(source).toContain('t("app.surfaces.open")');
    expect(source).toContain('t("app.deploys.title")');
  });

  test("keeps update review in the update-history surface", () => {
    const deploys = section(
      "function DeploysTab",
      "function DeployedResourcesDisclosure",
    );
    expect(source).toContain("function DeploysTab");
    expect(source).toContain(
      "onReview={(revision) => void plan.run(revision)}",
    );
    expect(source).toContain('t("apps.reviewChanges")');
    expect(source).toContain('t("app.deploys.advancedActions")');
    expect(source).toContain('t("app.settings.openCta")');
    expect(source).toContain('t("app.deploys.backup")');
    expect(source).not.toContain('t("app.deploys.generation")');
    expect(source).toContain(
      '{ href: `${base}/settings`, label: t("app.tab.settings") }',
    );
    expect(deploys).toContain('t("app.deploys.sourceVersionTitle")');
    expect(deploys).toContain('t("app.deploys.sourceVersionChange")');
    expect(deploys).toContain('t("app.deploys.reviewTitle")');
    expect(deploys.indexOf('t("app.deploys.sourceVersionTitle")')).toBeLessThan(
      deploys.indexOf('t("app.deploys.sourceVersionChange")'),
    );
    expect(deploys.indexOf('t("app.deploys.sourceVersionChange")')).toBeLessThan(
      deploys.indexOf('t("app.deploys.reviewTitle")'),
    );
    expect(deploys.indexOf('t("app.deploys.backup")')).toBeGreaterThan(
      deploys.indexOf('t("app.deploys.advancedActions")'),
    );
    expect(deploys.indexOf('t("app.settings.openCta")')).toBeGreaterThan(
      deploys.indexOf('t("app.deploys.advancedActions")'),
    );
  });

  test("keeps backup identifiers out of the primary success notice", () => {
    expect(source).toContain('t("app.deploys.backupCreated")');
    expect(source).toContain('t("app.deploys.backupSupportRef")');
    expect(source).not.toContain('t("app.deploys.backupCreated", { id:');
  });

  test("keeps URLs collapsed in overview and redirects legacy deletion routes into settings", () => {
    const overview = section(
      "function OverviewTab",
      "function DependencyList",
    );
    const settings = section(
      "function SettingsTab",
      "function rowPresentsDefault",
    );
    expect(source).toContain("function OverviewTab");
    expect(source).toContain("function SettingsTab");
    expect(source).toContain('raw === "danger"');
    expect(source).toContain('`${base}/settings#delete`');
    expect(source).toContain(
      '{ href: `${base}/settings`, label: t("app.tab.settings") }',
    );
    expect(source).not.toContain('label: t("app.tab.danger")');
    expect(source).not.toContain('href: `${base}/danger`');
    expect(source).not.toContain('t("app.nextSteps.title")');
    expect(overview).toMatch(
      /<details class="wb-disclosure">\s*<summary>\{t\("app\.surfaces\.details"\)\}<\/summary>[\s\S]*<code class="av-output-url-text">\{surface\.url\}<\/code>/,
    );
    expect(settings).toContain('t("app.settings.supportDetails")');
    expect(settings).toContain('t("app.source.title")');
    expect(settings.indexOf('t("app.source.title")')).toBeGreaterThan(
      settings.indexOf('t("app.settings.supportDetails")'),
    );
  });

  test("delete is confirmed once — at destroy-apply, not with an upfront modal", () => {
    const headerActions = section(
      "<PageHeader",
      '<Show when={update.error()'
    );
    const settingsTabIndex = source.indexOf(
      '<Match when={tab() === "settings"}>',
    );
    const deleteFlowIndex = source.search(/<details\s+id="delete"/);
    const deleteGuardIndex = source.lastIndexOf(
      '<Show when={inst().status !== "destroyed"}>',
      deleteFlowIndex,
    );
    const deleteFlow = source.slice(
      deleteFlowIndex,
      source.indexOf("</details>", deleteFlowIndex),
    );

    // Header actions contain no deletion affordance. The only delete flow is
    // guarded inside Settings and the legacy /danger route redirects there.
    expect(headerActions).toMatch(
      /RuntimeSurfaceLink\s+surface=\{surface\(\)\}\s+primary/,
    );
    expect(headerActions).toContain("serviceOpenable() && uiSurfaceList()[0]");
    expect(headerActions).not.toContain('t("app.danger.destroyTitle")');
    expect(headerActions).not.toContain("confirmDestroy");
    expect(headerActions).not.toContain("deleteCapsule");
    expect(headerActions).not.toContain("settings#delete");
    expect(settingsTabIndex).toBeGreaterThan(-1);
    expect(deleteFlowIndex).toBeGreaterThan(settingsTabIndex);
    expect(deleteGuardIndex).toBeGreaterThan(settingsTabIndex);
    expect(deleteFlowIndex).toBeGreaterThan(deleteGuardIndex);
    expect(source.match(/<details\s+id="delete"/g)).toHaveLength(1);
    expect(deleteFlow).toContain('open={location.hash === "#delete"}');
    expect(deleteFlow).toContain('onClick={() => void confirmDestroy()}');
    expect(occurrences(source, 'onClick={() => void confirmDestroy()}')).toBe(1);
    expect(source).toContain('inst().status !== "destroyed"');
    expect(occurrences(source, 't("app.danger.destroyCta")')).toBe(2);
    expect(occurrences(source, "deleteCapsule(capsuleId())")).toBe(1);
    // Creating a plan removes nothing; for an APPLIED service the single
    // confirmation stays on the run screen at destroy-apply (RunView's
    // destructive-confirm block), where the plan is visible.
    expect(source).toContain("if (!destroyIsImmediate()) {");
    expect(source).toContain("await destroyPlan.run();");
    // The exception, and the ONLY reason a modal exists here: a service that
    // never applied is abandoned immediately by the backend, producing no run
    // — so that path would otherwise delete with no confirmation anywhere.
    expect(source).toContain(
      "const destroyIsImmediate = () => !currentStateVersionId();",
    );
    expect(source).toContain('title: t("app.danger.destroyConfirmTitle")');
    expect(ja["app.danger.destroyConfirmMessage"]).toContain("{name}");
    expect(en["app.danger.destroyConfirmMessage"]).toContain("{name}");
    // The shared Source revision gate is gone: revision selection is local to
    // this Capsule's coordinator. Only immediate delete and the settings-tab
    // unsaved-edits guard still use confirmation.
    expect(source).toContain('title: t("app.settings.leaveConfirm.title")');
    expect(source.match(/await confirm\(/g)?.length).toBe(2);
    // The guarded settings disclosure still names the service in its warning.
    expect(source).toMatch(
      /t\("app\.danger\.destroyBody",\s*\{\s*name:\s*serviceLabel\(\),\s*\}\)/,
    );
    expect(ja["app.danger.destroyBody"]).toContain("{name}");
    expect(en["app.danger.destroyBody"]).toContain("{name}");
  });

  test("keeps provider binding editing behind advanced service settings", () => {
    expect(source).toContain("providerConnectionDisplayName");
    expect(source).toContain("isProviderConnectionCandidate");
    expect(source).not.toContain("managedProvider");
    expect(source).toContain("function boundConnectionLabel");
    expect(source).toContain('t("app.bindings.none")');
    expect(source).toContain('t("app.bindings.editAdvanced")');
    expect(source).not.toContain("alias（任意）");
    expect(source).not.toContain("alias (optional)");
    expect(source).toContain('t("app.bindings.technicalTarget")');
    expect(source).toContain('t("app.bindings.providerPlaceholder")');
    expect(source).toContain("connection.id === row().connectionId");
    expect(source).not.toContain(
      'placeholder="registry.opentofu.org/cloudflare/cloudflare"',
    );
    expect(source).toMatch(
      /<summary>\{t\("app\.bindings\.editAdvanced"\)\}<\/summary>[\s\S]*<summary>\{t\("app\.bindings\.technicalTarget"\)\}<\/summary>/,
    );
    expect(source).not.toContain("conn.ownership.takosProvided");
    expect(source).not.toContain("conn.ownership.ownKey");
  });

  test("keeps service configuration editable from settings without exposing provider credentials", () => {
    expect(source).toContain("getInstallConfig");
    expect(source).toContain("createCapsuleConfigurationPlan");
    expect(source).toContain("configurationAttempt?.requestJson === requestJson");
    expect(source).toContain("configurationAttempt = { requestJson, idempotencyKey }");
    expect(source).not.toContain("patchInstallConfig");
    expect(source).not.toContain("putCapsuleProviderBindingSet");
    expect(source).toContain('t("app.config.title")');
    expect(source).toContain('t("app.config.publicUrl")');
    expect(source).not.toContain('t("app.config.oidc")');
    expect(source).toContain('t("app.config.advanced")');
    expect(source).toContain('t("app.config.addVariable")');
    // The row model lives in the shared lib; the view consumes it.
    expect(source).toContain("configRowsFromInstallConfig");
    expect(source).toContain("buildConfigVariablePatch");
    expect(capsulesUiSource).not.toContain("SYSTEM_CONFIG_VARIABLES");
    expect(capsulesUiSource).not.toContain("variableNameLooksSecret");
    expect(capsulesUiSource).toContain("secret: input.secret === true");
    expect(capsulesUiSource).toContain("advanced: input.advanced === true");
    expect(capsulesUiSource).toContain("removeVariables");
    expect(source).toContain("installExperienceOidcClient");
    expect(source).toContain("installExperienceArtifact");
    expect(source).not.toContain("takosumi_accounts_issuer_url");
    expect(source).not.toContain("takosumi_accounts_client_id");
    expect(source).not.toContain('"project_name"');
    expect(source).toContain("ConfigVariableInput");
    expect(source).toContain("VariableRows");
    expect(source).toContain('type={props.row.secret ? "password" : "text"}');
    expect(source.indexOf('t("app.config.title")')).toBeLessThan(
      source.indexOf('t("app.bindings.title")'),
    );
  });

  test("config saves are DIRTY-ONLY; a no-edit save writes nothing", () => {
    // Untouched rows must never be written: writing them pins listing
    // defaults as explicit values and overrides the module's HCL defaults
    // ("" / false / null) on the next deploy. Behavior is unit-tested in
    // tests/dashboard/src/lib/config-variables_test.ts; this pins the wiring.
    expect(capsulesUiSource).toContain("if (!row.dirty) continue;");
    // User edits (and only user edits) mark a row dirty, cancelling any
    // pending リセット.
    expect(source).toContain(
      "{ ...row, ...patch, dirty: true, resetToDefault: false }",
    );
    expect(source).toContain("onChange={editVariable}");
  });

  test("リセット restores the default-presented row (visible + marked 既定値) and stays undoable", () => {
    // A store-row reset no longer removes the row until save+refetch: it
    // presents the default and, when the value pre-existed in the mapping,
    // marks remove-on-save (undoable via 元に戻す before save).
    expect(source).toContain("resetToDefault: row.hasExistingValue");
    expect(source).toContain('t("app.config.undoReset")');
    expect(source).toContain(
      't("app.config.undoResetAria", { name: row().label })',
    );
    expect(source).toContain('t("app.config.resetAria", { name: row().label })');
    expect(source).toContain('t("app.config.resetPendingHint")');
    expect(source).toContain('t("app.config.defaultBadge")');
    expect(capsulesUiSource).toContain("row.storeField && row.resetToDefault");
    for (const key of [
      "app.config.undoReset",
      "app.config.undoResetAria",
      "app.config.resetPendingHint",
      "app.config.defaultBadge",
    ] as const) {
      expect(ja[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });

  test("submits one complete Configuration Plan and enters its returned Run review", () => {
    expect(source).not.toContain("savedKind");
    expect(source).not.toContain("SavedNote");
    expect(source).toContain("const reviewConfiguration = createAction");
    expect(source).toContain("variablePatch: {");
    expect(source).toContain("providerBindings: providerBindings.bindings");
    expect(source).toContain("interfaceBlueprints: parsed.value");
    expect(source).toContain("expected: { authorityGuard: props.authorityGuard }");
    expect(source).toContain(
      "await props.onPlanned(result.configurationPlan.planRunId)",
    );
  });

  test("sets a route-specific title instead of leaking the previous add-service title", () => {
    expect(source).toContain('<Page title={t("app.capsuleSub")}');
    expect(source).toContain("setDocumentTitle(displayName() ?? inst.name)");
  });

  test("reads the StateVersion ledger through the session client", () => {
    expect(source).toContain("const deploysCapsuleId");
    expect(source).toMatch(
      /createResource\(\s*deploysCapsuleId,\s*listStateVersions\s*\)/,
    );
    expect(source).toMatch(
      /createResource\(\s*currentStateVersionId,\s*getStateVersion,\s*\)/,
    );
    expect(source).toContain("const settingsWorkspaceId");
    expect(source).toMatch(
      /createResource\(\s*settingsWorkspaceId,\s*listSources\s*\)/,
    );
    expect(source).toMatch(
      /createResource\(\s*settingsWorkspaceId,\s*listProviderConnections,\s*\)/,
    );
    expect(source).toMatch(
      /createResource\(\s*installConfigId,\s*getInstallConfig,\s*\)/,
    );
  });

  test("gates public open actions on release activation evidence", () => {
    expect(source).toContain("releaseActivationStatusForStateVersion");
    expect(source).toContain("isStateVersionRuntimeReady");
    expect(source).toContain('t("app.surfaces.activationPending")');
    expect(source).toContain('t("app.surfaces.activationFailed")');
    expect(source).toContain("activityBelongsToCapsule");
  });

  test("does not infer runtime surfaces from StateVersion Output data", () => {
    expect(source).toContain(
      "StateVersion is readiness/provenance only. URL and presentation authority",
    );
    expect(source).toContain("listAuthorizedUiSurfaces");
    expect(source).not.toContain("refreshSession");
    expect(source).toContain("capsuleId: ownerId");
    expect(source).toContain("uiSurfaces.error ? []");
    expect(source).not.toContain("publicOutputs");
    expect(source).not.toContain("workspaceOutputs");
    expect(source).not.toContain('outputId"');
    expect(source).not.toMatch(/\bsensitive\b/);
  });

  test("a past StateVersion offers the restore action wired to a plan Run", () => {
    expect(source).toContain('t("app.deploys.restore")');
    expect(source).toContain('t("app.deploys.restoreDisclosure")');
    expect(source).toContain('class="wb-inline-details"');
    expect(source).toContain("createStateVersionRollbackPlan");
    // The button is hidden on the current StateVersion (no-op restore).
    expect(source).toMatch(/Show when=\{!isCurrent\(\)\}/);
  });

  test("rollback runs the normal review→approve→deploy flow via the Run screen", () => {
    // extractRunId on the plan-run envelope → navigate to /runs/:id, the same
    // path the review / delete-review buttons use.
    expect(source).toMatch(/extractRunId\(envelope\)/);
    expect(source).toMatch(/navigate\(`\/runs\/\$\{runId\}`\)/);
  });

  test("authorized Interface surfaces are rendered as prominent links", () => {
    expect(source).toContain("function RuntimeSurfaceLink");
    expect(source).toMatch(/href=\{props\.surface\.url\}/);
    expect(source).toContain("type AuthorizedUiSurface");
  });

  test("the header opens only the first authorized Interface and overview URLs stay disclosed", () => {
    const headerActions = section(
      "<PageHeader",
      '<Show when={update.error()'
    );
    const overview = section(
      "function OverviewTab",
      "function DependencyList",
    );
    const link = section("function RuntimeSurfaceLink", "function DeploysTab");
    expect(source).toContain("surface.name ??");
    expect(source).toContain('t("app.surfaces.defaultName"');
    expect(headerActions).toContain("!uiSurfaces.loading");
    expect(headerActions).toContain("!uiSurfaces.error");
    expect(headerActions).toContain("serviceOpenable() && uiSurfaceList()[0]");
    expect(headerActions).toMatch(
      /RuntimeSurfaceLink\s+surface=\{surface\(\)\}\s+primary/,
    );
    expect(link).toContain(
      'variant={props.primary ? "primary" : "secondary"}',
    );
    expect(link).toContain('aria-label={t("app.surfaces.openAria"');
    expect(link).toContain('t("app.surfaces.open")');
    expect(overview).toContain('<summary>{t("app.surfaces.details")}</summary>');
    expect(overview).toContain('class="av-output-url-text"');
    expect(overview).toContain("surface.url");
    expect(source).not.toContain("publicLinkRowLabels");
  });

  test("micro-cost amounts below one cent read as < $0.01 with the exact value in title", () => {
    expect(source).toContain("function UsageAmount");
    expect(source).toContain('t("app.usage.subCent")');
    expect(source).toMatch(/title=\{subCent\(\) \? formatUsdMicros/);
    expect(ja["app.usage.subCent"]).toContain("$0.01");
    expect(en["app.usage.subCent"]).toContain("$0.01");
  });

  test("distinguishes unrated usage from a rated zero-cost aggregate", () => {
    expect(source).toContain("ratedEventCount");
    expect(source).toContain("unratedEventCount");
    expect(source).toContain("allUnrated");
    expect(source).toContain('t("app.usage.unrated")');
    expect(source).toContain('t("app.usage.unratedCount"');
    expect(en["app.usage.unrated"]).toBe("Unrated");
    expect(ja["app.usage.unrated"]).toBe("未評価");
  });

  test("does not offer stale open links for deleted services", () => {
    const headerActions = section(
      "<PageHeader",
      '<Show when={update.error()'
    );
    const link = section("function RuntimeSurfaceLink", "function DeploysTab");
    expect(source).toContain("serviceOpenable");
    // capsuleData() is the crash-safe last-good accessor (never throws on a
    // failed refetch); the destroyed-status gate on openability is unchanged.
    expect(source).toContain('capsuleData()?.status !== "destroyed"');
    expect(source).toContain("isStateVersionRuntimeReady");
    expect(source).toContain('t("app.surfaces.deletedSubtitle")');
    expect(headerActions).toContain("serviceOpenable() && uiSurfaceList()[0]");
    expect(link).toContain("props.openable !== false");
    expect(link).toContain("props.openable === false");
    expect(link).toContain("<code>{props.surface.url}</code>");
  });

  test("公開リンク copy is one state machine: deleted / preparing / deployed are mutually exclusive", () => {
    // Driven by the actual capsule status, not by openability: a preparing
    // service must never read as deleted.
    expect(source).toContain('destroyed={inst().status === "destroyed"}');
    expect(source).toMatch(
      /props\.destroyed\s*\?\s*t\("app\.surfaces\.deletedSubtitle"\)/,
    );
    expect(source).not.toMatch(
      /props\.serviceOpenable\s*\?\s*t\("app\.surfaces\.subtitle"\)\s*:\s*t\("app\.surfaces\.deletedSubtitle"\)/,
    );
    // Body: never deployed uses setup copy; deployed/deleted with no authorized
    // Interface uses the explicit no-link copy.
    expect(source).toMatch(/props\.hasStateVersion \|\| props\.destroyed/);
  });

  test("a never-successfully-applied service shows the setup-incomplete guidance strip", () => {
    expect(source).toContain('class="av-setup-incomplete"');
    expect(source).toContain('t("app.setupIncomplete.body")');
    expect(source).toContain('t("app.setupIncomplete.review")');
    expect(source).toContain('t("app.settings.openCta")');
    expect(source).toContain(
      'inst().status !== "destroyed" && !currentStateVersionId()',
    );
    expect(source).toContain(
      "href={`/workloads/${encodeURIComponent(capsuleId())}/deploys`}",
    );
    expect(ja["app.setupIncomplete.body"]).toBeTruthy();
    expect(en["app.setupIncomplete.body"]).toBeTruthy();
  });

  test("the header leads with the store display name; instance name is a muted secondary", () => {
    expect(source).toContain("capsuleDisplayName");
    expect(source).toContain("{displayName() ?? inst().name}");
    expect(source).toContain('class="av-title-instance"');
    expect(source).toContain("displayName() !== inst().name");
  });

  test("listing-declared settings show localized labels with read-only keys; free-form rows stay advanced", () => {
    const settings = section(
      "function SettingsTab",
      "function rowPresentsDefault",
    );
    const variableRows = section(
      "function VariableRows",
      "function ConfigVariableInput",
    );
    const settingsRoute = section(
      '<Match when={tab() === "settings"}>',
      "</Switch>",
    );
    const support = settings.slice(
      settings.indexOf('t("app.settings.supportDetails")'),
    );

    // Listing-owned values lead the settings view. Their keys are not edited
    // alongside values; raw keys appear only in the explicit support disclosure.
    expect(variableRows).toMatch(/when=\{!row\(\)\.storeField\}/);
    expect(variableRows).toContain(
      'label={row().storeField ? row().label : t("app.config.value")}',
    );
    expect(settings).toContain("row.storeField && (!row.advanced");
    expect(settings.indexOf("rows={primaryVariableRows()}")).toBeLessThan(
      settings.indexOf('<summary>{t("app.config.advanced")}</summary>'),
    );
    expect(
      settings.indexOf('<summary>{t("app.config.advanced")}</summary>'),
    ).toBeLessThan(settings.indexOf('t("app.settings.supportDetails")'));
    expect(support).toContain('t("app.config.internalNames")');
    expect(support).toContain("value: <code>{row.name}</code>");
    expect(settings.indexOf("value: <code>{row.name}</code>")).toBeGreaterThan(
      settings.indexOf('t("app.config.internalNames")'),
    );
    expect(settingsRoute.indexOf("<SettingsTab")).toBeLessThan(
      settingsRoute.indexOf('<summary>{t("app.autoUpdate.title")}</summary>'),
    );
    expect(variableRows).toContain(
      't("app.config.resetAria", { name: row().label })',
    );
    expect(variableRows).toContain(
      't("app.config.undoResetAria", { name: row().label })',
    );
    expect(variableRows).toContain('t("app.config.removeAria"');
    expect(source).toContain("installExperienceOidcClient");
  });
});
