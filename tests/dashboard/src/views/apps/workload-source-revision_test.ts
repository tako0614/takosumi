import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { en } from "../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../dashboard/src/i18n/ja.ts";

const viewSource = readFileSync(
  new URL(
    "../../../../../dashboard/src/views/apps/WorkloadDetailView.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Workload revision changes are explicit, progressive, and readback-gated", () => {
  expect(viewSource).toContain("updateCapsuleSourceRevision(");
  expect(viewSource).toContain("isImmutableSourceRevision");
  expect(viewSource).toContain("sourceRevisionReady");
  expect(viewSource).toContain(
    'disabled={props.reviewBusy || !props.sourceRevisionReady}',
  );
  expect(viewSource).toContain(
    '<summary>{t("app.deploys.sourceVersionChange")}</summary>',
  );
  expect(viewSource).toContain("affectedSourceCapsules");
  expect(viewSource).toContain("affectedCapsuleIds");
  expect(viewSource).toContain("sourceImpactConfirmTitle");
  expect(viewSource).toContain("if (!confirmed) return undefined;");
  expect(viewSource).toContain("source_membership_changed");
  expect(viewSource).toContain('t("app.deploys.sourceVersionCurrent")');
  expect(viewSource).toContain('t("app.deploys.sourceVersionApply")');
  expect(viewSource).not.toContain("authConnectionId");
  expect(viewSource).not.toContain("credential");
});

test("revision copy requires immutable commits and avoids mutable ref language", () => {
  for (const dictionary of [en, ja]) {
    expect(dictionary["app.deploys.sourceVersionHint"]).toMatch(/40/iu);
    expect(dictionary["app.deploys.sourceVersionHint"]).toMatch(/Git/iu);
    expect(dictionary["app.deploys.sourceVersionChange"]).toBeTruthy();
    expect(dictionary["app.deploys.sourceVersionApply"]).toBeTruthy();
  }
});
