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
    "../../../../../dashboard/src/views/apps/AppDetailView.tsx",
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

describe("Capsule detail StateVersion surface", () => {
  test("renders public-surface and update-history sections via the dictionary", () => {
    expect(source).toContain('t("app.surfaces.title")');
    expect(source).toContain('t("app.surfaces.open")');
    expect(source).toContain('t("app.deploys.title")');
  });

  test("keeps update review in the update-history surface", () => {
    expect(source).toContain("function DeploysTab");
    expect(source).toContain("onReview={() => void plan.run()}");
    expect(source).toContain('t("apps.reviewChanges")');
    expect(source).toContain('t("app.deploys.advancedActions")');
    expect(source).toContain('t("app.settings.openCta")');
    expect(source).toContain('t("app.deploys.backup")');
    expect(source).not.toContain('t("app.deploys.generation")');
    expect(source).toContain(
      '{ href: `${base}/settings`, label: t("app.tab.settings") }',
    );
    expect(source.indexOf('t("apps.reviewChanges")')).toBeGreaterThan(
      source.indexOf("function DeploysTab"),
    );
    expect(source).toContain("icon={<Trash2 size={16} />}");
    expect(source).toContain('t("common.delete")');
    expect(source).toContain("deleteCapsule(capsuleId())");
    expect(source).toContain('navigate("/services")');
    expect(source.indexOf('t("common.delete")')).toBeLessThan(
      source.indexOf("<Tabs items={tabItems()}"),
    );
    expect(source.indexOf('t("app.deploys.backup")')).toBeGreaterThan(
      source.indexOf('t("app.deploys.advancedActions")'),
    );
    expect(source.indexOf('t("app.settings.openCta")')).toBeGreaterThan(
      source.indexOf('t("app.deploys.advancedActions")'),
    );
  });

  test("keeps backup identifiers out of the primary success notice", () => {
    expect(source).toContain('t("app.deploys.backupCreated")');
    expect(source).toContain('t("app.deploys.backupSupportRef")');
    expect(source).not.toContain('t("app.deploys.backupCreated", { id:');
  });

  test("keeps technical source details out of the default overview; deletion lives on the 削除 tab only", () => {
    expect(source).toContain("function OverviewTab");
    expect(source).toContain("function SettingsTab");
    // ONE delete flow: no duplicate delete section at the bottom of settings —
    // the tab strip and the header button both route to the danger tab.
    expect(source).not.toContain('t("app.settings.removeTitle")');
    expect(source).not.toContain('t("app.settings.removeCta")');
    expect(source).toContain(
      '{ href: `${base}/settings`, label: t("app.tab.settings") }',
    );
    expect(source).toContain(
      '{ href: `${base}/danger`, label: t("app.tab.danger") }',
    );
    expect(source).not.toContain('t("app.nextSteps.title")');
    expect(source.indexOf('t("app.source.title")')).toBeGreaterThan(
      source.indexOf("function SettingsTab"),
    );
    expect(source).toContain('t("app.settings.supportDetails")');
    expect(source.indexOf('t("app.source.title")')).toBeGreaterThan(
      source.indexOf('t("app.settings.supportDetails")'),
    );
    expect(source).toMatch(
      /<summary>\{t\("app\.settings\.supportDetails"\)\}<\/summary>[\s\S]*<summary>\{t\("app\.source\.title"\)\}<\/summary>/,
    );
  });

  test("delete is confirmed once — at destroy-apply, not with an upfront modal", () => {
    // Header: a link into the plan-first danger flow, not a duplicate modal.
    expect(source).toContain(
      "href={`/services/${encodeURIComponent(capsuleId())}/danger`}",
    );
    expect(source).toContain(
      'inst().status !== "destroyed" && tab() !== "danger"',
    );
    // The danger-tab CTA creates the destroy PLAN directly — no confirm modal.
    // Creating a plan removes nothing; the single confirmation lives on the run
    // screen at destroy-apply (RunView's destructive-confirm block), where the
    // plan (what will be removed) is visible.
    expect(source).toContain("onClick={() => void destroyPlan.run()}");
    expect(source).not.toContain("confirmDestroy");
    // useConfirmDialog now exists, but ONLY for the settings-tab unsaved-edits
    // leave guard — never for delete. The destroy CTA creates the plan directly
    // (asserted above); the sole confirm() dialog is the leaveConfirm guard.
    expect(source).toContain('title: t("app.settings.leaveConfirm.title")');
    expect(source.match(/await confirm\(/g)?.length).toBe(1);
    // The danger tab still names the service in its warning header.
    expect(source).toContain(
      't("app.danger.destroyBody", {\n                          name: serviceLabel(),\n                        })',
    );
    expect(ja["app.danger.destroyBody"]).toContain("{name}");
    expect(en["app.danger.destroyBody"]).toContain("{name}");
  });

  test("keeps provider binding editing behind advanced service settings", () => {
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
    expect(source).toContain("patchInstallConfig");
    expect(source).toContain('t("app.config.title")');
    expect(source).toContain('t("app.config.publicUrl")');
    expect(source).toContain('t("app.config.oidc")');
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
      't("app.config.undoResetAria", { name: row().name })',
    );
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

  test("saved-notes are per-form and cleared when a later save fails", () => {
    // One shared savedKind signal meant saving one form hid the other's
    // still-true pending-deploy note, and a failed save kept the stale note.
    expect(source).not.toContain("savedKind");
    expect(source).toContain("setConfigSavedNote(false);");
    expect(source).toContain("setBindingsSavedNote(false);");
    expect(source).toContain("<Show when={configSavedNote()}>");
    expect(source).toContain("<Show when={bindingsSavedNote()}>");
    // Cleared at the START of the save action so a throw leaves it cleared.
    expect(source.indexOf("setConfigSavedNote(false);")).toBeLessThan(
      source.indexOf("await patchInstallConfig"),
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
    expect(source).toContain("refreshSession");
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

  test("公開リンク rows use Interface display names, one primary button, and an inline URL", () => {
    expect(source).toContain("surface.name ??");
    expect(source).toContain('t("app.surfaces.defaultName"');
    expect(source).toContain("primary={index === 0}");
    expect(source).toContain(
      'variant={props.primary ? "primary" : "secondary"}',
    );
    expect(source).toContain('class="av-output-url-text"');
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
    expect(source).toContain("serviceOpenable");
    // capsuleData() is the crash-safe last-good accessor (never throws on a
    // failed refetch); the destroyed-status gate on openability is unchanged.
    expect(source).toContain('capsuleData()?.status !== "destroyed"');
    expect(source).toContain("isStateVersionRuntimeReady");
    expect(source).toContain('t("app.surfaces.deletedSubtitle")');
    expect(source).toContain("openable={props.serviceOpenable}");
    expect(source).toContain("props.openable !== false");
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
    expect(source).toContain('t("app.setupIncomplete.delete")');
    expect(source).toContain(
      'inst().status !== "destroyed" && !currentStateVersionId()',
    );
    expect(source).toContain(
      "href={`/services/${encodeURIComponent(capsuleId())}/deploys`}",
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
    // A store input's key renders as muted mono text, not an editable textbox,
    // and the value field carries the localized store label.
    expect(source).toContain('class="av-config-key"');
    expect(source).toMatch(/when=\{!row\(\)\.storeField\}/);
    expect(source).toContain(
      'label={row().storeField ? row().label : t("app.config.value")}',
    );
    // Free-form key+value rows never surface in the primary list.
    expect(source).toContain("row.storeField && (!row.advanced");
    // The clear/remove button names its variable for screen readers.
    expect(source).toContain('t("app.config.resetAria", { name: row().name })');
    expect(source).toContain('t("app.config.removeAria"');
    // 自動ログイン is projection-derived and not settable here — an unset value
    // is omitted instead of rendering a dead 未設定 row.
    expect(source).not.toContain('t("app.config.oidcOff")');
  });
});
