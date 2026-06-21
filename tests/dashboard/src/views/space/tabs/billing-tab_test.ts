import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../../dashboard/src/views/space/tabs/BillingTab.tsx",
);

test("BillingTab does not mask billing API failures as disabled or empty state", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("billing.error");
  expect(source).toContain("plans.error");
  expect(source).toContain("usage.error");
  expect(source).toContain("reservations.error");
  expect(source).not.toContain('billing()?.settings?.mode ?? "disabled"');
  expect(source).not.toContain("(plans() ?? []).length > 0");
  expect(source).not.toContain("(usage() ?? []).length > 0");
  expect(source).not.toContain("(reservations() ?? []).length > 0");
});
