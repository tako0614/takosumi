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
    expect(source).toContain('t("app.deploys.backup")');
    expect(source).not.toContain('t("app.deploys.generation")');
    expect(source.indexOf('t("apps.openApp")')).toBeLessThan(
      source.indexOf("function DeploysTab"),
    );
    expect(source.indexOf('t("apps.reviewChanges")')).toBeGreaterThan(
      source.indexOf("function DeploysTab"),
    );
    expect(source.indexOf('t("app.deploys.backup")')).toBeGreaterThan(
      source.indexOf('t("app.deploys.advancedActions")'),
    );
  });

  test("keeps technical source details and deletion out of the default overview", () => {
    expect(source).toContain("function OverviewTab");
    expect(source).toContain("function SettingsTab");
    expect(source).toContain('t("app.settings.removeTitle")');
    expect(source).toContain('t("app.settings.removeCta")');
    expect(source).not.toContain(
      '{ href: `${base}/danger`, label: t("app.tab.danger") }',
    );
    expect(source).not.toContain('t("app.nextSteps.title")');
    expect(source.indexOf('t("app.source.title")')).toBeGreaterThan(
      source.indexOf("function SettingsTab"),
    );
    expect(source).toMatch(
      /<summary>\{t\("app\.source\.title"\)\}<\/summary>[\s\S]*<Card>/,
    );
    expect(source).toMatch(
      /<summary>\{t\("app\.tab\.danger"\)\}<\/summary>[\s\S]*t\("app\.settings\.removeTitle"\)/,
    );
  });

  test("keeps provider binding editing behind advanced service settings", () => {
    expect(source).toContain("function boundConnectionLabel");
    expect(source).toContain('t("app.bindings.none")');
    expect(source).toContain('t("app.bindings.editAdvanced")');
    expect(source).toMatch(
      /<summary>\{t\("app\.bindings\.editAdvanced"\)\}<\/summary>[\s\S]*placeholder="registry\.opentofu\.org\/cloudflare\/cloudflare"/,
    );
    expect(source).not.toContain("conn.ownership.takosProvided");
    expect(source).not.toContain("conn.ownership.ownKey");
  });

  test("sets a route-specific title instead of leaking the previous add-service title", () => {
    expect(source).toContain('<Page title={t("app.installationSub")}');
    expect(source).toContain("setDocumentTitle(inst.name)");
  });

  test("reads the Deployment ledger through the session client fn", () => {
    expect(source).toMatch(
      /createResource\(installationId,\s*listDeployments\)/,
    );
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
});
