/**
 * Source-assertion regression tests for the Installation detail deployment surface
 * (AppDetailView — successor of ControlInstallationDetailView). Pure-source
 * assertions: they lock in the load-bearing wiring so a future edit that drops
 * the outputs / deploy-history surface, the rollback→run navigation, or the
 * public-outputs-only guard fails loudly instead of silently regressing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../../../../../dashboard/src/views/apps/AppDetailView.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("Installation detail deployment surface", () => {
  test("renders the outputs and deploy-history sections via the dictionary", () => {
    expect(source).toContain('t("app.outputs.title")');
    expect(source).toContain('t("app.outputs.valuesTitle")');
    expect(source).toContain('t("app.deploys.title")');
  });

  test("keeps update review out of the everyday service header", () => {
    expect(source).toContain('t("apps.openApp")');
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
    expect(source.indexOf('t("apps.openApp")')).toBeLessThan(
      source.indexOf("function DeploysTab"),
    );
    expect(source.indexOf('t("apps.reviewChanges")')).toBeGreaterThan(
      source.indexOf("function DeploysTab"),
    );
    expect(source).toContain('icon={<Trash2 size={16} />}');
    expect(source).toContain('t("common.delete")');
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

  test("keeps technical source details out of the default overview while showing deletion in settings", () => {
    expect(source).toContain("function OverviewTab");
    expect(source).toContain("function SettingsTab");
    expect(source).toContain('t("app.settings.removeTitle")');
    expect(source).toContain('t("app.settings.removeCta")');
    expect(source).toContain(
      '{ href: `${base}/settings`, label: t("app.tab.settings") }',
    );
    expect(source).not.toContain(
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
    expect(source.indexOf('t("app.settings.removeTitle")')).toBeGreaterThan(
      source.indexOf('t("app.settings.supportDetails")'),
    );
  });

  test("keeps provider binding editing behind advanced service settings", () => {
    expect(source).toContain("function boundConnectionLabel");
    expect(source).toContain('t("app.bindings.none")');
    expect(source).toContain('t("app.bindings.editAdvanced")');
    expect(source).not.toContain("alias（任意）");
    expect(source).not.toContain("alias (optional)");
    expect(source).toContain('t("app.bindings.technicalTarget")');
    expect(source).toContain('t("app.bindings.providerPlaceholder")');
    expect(source).toContain("selected={connection.id === row.connectionId}");
    expect(source).not.toContain(
      'placeholder="registry.opentofu.org/cloudflare/cloudflare"',
    );
    expect(source).toMatch(
      /<summary>\{t\("app\.bindings\.editAdvanced"\)\}<\/summary>[\s\S]*<summary>\{t\("app\.bindings\.technicalTarget"\)\}<\/summary>/,
    );
    expect(source).not.toContain("conn.ownership.takosProvided");
    expect(source).not.toContain("conn.ownership.ownKey");
  });

  test("sets a route-specific title instead of leaking the previous add-service title", () => {
    expect(source).toContain('<Page title={t("app.capsuleSub")}');
    expect(source).toContain("setDocumentTitle(inst.name)");
  });

  test("reads the Deployment ledger through the session client fn", () => {
    expect(source).toContain("const deploysCapsuleId");
    expect(source).toMatch(
      /createResource\(\s*deploysCapsuleId,\s*listDeployments\s*\)/,
    );
    expect(source).toMatch(
      /createResource\(\s*currentStateVersionId,\s*getDeployment,\s*\)/,
    );
    expect(source).toContain("const settingsWorkspaceId");
    expect(source).toMatch(
      /createResource\(\s*settingsWorkspaceId,\s*listSources\s*\)/,
    );
    expect(source).toMatch(
      /createResource\(\s*settingsWorkspaceId,\s*listProviderConnections,\s*\)/,
    );
  });

  test("gates public open actions on release activation evidence", () => {
    expect(source).toContain("releaseActivationStatusForDeployment");
    expect(source).toContain("isDeploymentPubliclyOpenable");
    expect(source).toContain("launchUrlFromDeployment");
    expect(source).toContain('t("app.outputs.activationPending")');
    expect(source).toContain('t("app.outputs.activationFailed")');
    expect(source).toContain("activityBelongsToCapsule");
  });

  test("surfaces ONLY allowlist-projected public outputs (no sensitive)", () => {
    // The outputs section reads outputsPublic; it must never reference a raw
    // output snapshot pointer or a `sensitive` field.
    expect(source).toContain("outputsPublic");
    expect(source).toContain("publicLinkOutputs");
    expect(source).toContain("otherPublicOutputs");
    expect(source).not.toContain('outputSnapshotId"');
    expect(source).not.toMatch(/\bsensitive\b/);
  });

  test("a past deployment offers the restore action wired to the rollback fn", () => {
    expect(source).toContain('t("app.deploys.restore")');
    expect(source).toContain('t("app.deploys.restoreMenu")');
    expect(source).toContain('class="wb-inline-details"');
    expect(source).toContain("createDeploymentRollbackPlan");
    // The button is hidden on the current deployment (no-op rollback).
    expect(source).toMatch(/Show when=\{!isCurrent\(\)\}/);
  });

  test("rollback runs the normal review→approve→deploy flow via the Run screen", () => {
    // extractRunId on the plan-run envelope → navigate to /runs/:id, the same
    // path the review / delete-review buttons use.
    expect(source).toMatch(/extractRunId\(envelope\)/);
    expect(source).toMatch(/navigate\(`\/runs\/\$\{runId\}`\)/);
  });

  test("http(s) outputs (launch_url) are surfaced as a prominent link", () => {
    // The well-known output-key labels live in lib/installations-ui.ts; the
    // view renders url-shaped values through the OutputValue link button.
    expect(source).toContain("outputLabel");
    expect(source).toMatch(/href=\{props\.value as string\}/);
  });

  test("does not offer stale open links for deleted services", () => {
    expect(source).toContain("serviceOpenable");
    expect(source).toContain('capsule()?.status !== "destroyed"');
    expect(source).toContain("isDeploymentPubliclyOpenable");
    expect(source).toContain('t("app.outputs.deletedSubtitle")');
    expect(source).toContain("openable={props.serviceOpenable}");
    expect(source).toContain("props.openable !== false");
  });
});
