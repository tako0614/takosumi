/**
 * Source-assertion regression tests for the Installation 詳細 GUI deployment
 * surface (TASK Y). Pure-source assertions (no DOM / SolidJS), in the same style
 * as `dashboard/src/router-fallbacks_test.ts`: they read the view source and
 * lock in the load-bearing wiring so a future edit that drops the 出力 /
 * デプロイ履歴 surface, the rollback→run navigation, or the sensitive-output
 * guard fails loudly instead of silently regressing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./ControlInstallationDetailView.tsx", import.meta.url),
  "utf8",
);

describe("ControlInstallationDetailView deployment surface", () => {
  test("renders the 出力 and デプロイ履歴 sections in plain Japanese", () => {
    // The sections are now rendered as titled Cards (the dark UI rebuild moved
    // the headings into the shared Card `title` prop); the surface must still exist.
    expect(source).toContain('title="出力"');
    expect(source).toContain('title="デプロイ履歴"');
  });

  test("reads the Deployment ledger through the session client fn", () => {
    expect(source).toMatch(/createResource\(installationId,\s*listDeployments\)/);
  });

  test("surfaces ONLY allowlist-projected public outputs (no sensitive)", () => {
    // The outputs section reads outputsPublic; it must never reference a raw
    // output snapshot pointer or a `sensitive` field.
    expect(source).toContain("outputsPublic");
    expect(source).not.toContain("outputSnapshotId");
    expect(source).not.toMatch(/\bsensitive\b/);
  });

  test("a past deployment offers 「この状態に戻す」 wired to the rollback fn", () => {
    expect(source).toContain("この状態に戻す");
    expect(source).toContain("createDeploymentRollbackPlan");
    // The button is hidden on the current deployment (no-op rollback).
    expect(source).toMatch(/Show when=\{!isCurrent\(\)\}/);
  });

  test("rollback runs the normal plan→approve→apply flow via the Run screen", () => {
    // extractRunId on the plan-run envelope → navigate to /runs/:id, the same
    // path the existing Plan / Destroy plan buttons use.
    expect(source).toMatch(/extractRunId\(envelope\)/);
    expect(source).toMatch(/navigate\(`\/runs\/\$\{runId\}`\)/);
  });

  test("http(s) outputs (launch_url) are surfaced as a prominent link", () => {
    expect(source).toContain("launch_url");
    expect(source).toMatch(/href=\{props\.value as string\}/);
  });
});
