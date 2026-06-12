/**
 * Source-assertion regression tests for the app detail deployment surface
 * (AppDetailView — successor of ControlInstallationDetailView). Pure-source
 * assertions: they lock in the load-bearing wiring so a future edit that drops
 * the outputs / deploy-history surface, the rollback→run navigation, or the
 * public-outputs-only guard fails loudly instead of silently regressing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./AppDetailView.tsx", import.meta.url),
  "utf8",
);

describe("AppDetailView deployment surface", () => {
  test("renders the outputs and deploy-history sections via the dictionary", () => {
    expect(source).toContain('t("app.outputs.title")');
    expect(source).toContain('t("app.deploys.title")');
  });

  test("reads the Deployment ledger through the session client fn", () => {
    expect(source).toMatch(/createResource\(installationId,\s*listDeployments\)/);
  });

  test("surfaces ONLY allowlist-projected public outputs (no sensitive)", () => {
    // The outputs section reads outputsPublic; it must never reference a raw
    // output snapshot pointer or a `sensitive` field.
    expect(source).toContain("outputsPublic");
    expect(source).not.toContain("outputSnapshotId\"");
    expect(source).not.toMatch(/\bsensitive\b/);
  });

  test("a past deployment offers the restore action wired to the rollback fn", () => {
    expect(source).toContain('t("app.deploys.restore")');
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
