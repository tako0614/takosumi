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
  expect(source).not.toContain('billing()?.settings?.mode ?? "disabled"');
  expect(source).not.toContain("(plans() ?? []).length > 0");
  expect(source).not.toContain("(usage() ?? []).length > 0");
  expect(source).not.toContain("reservations()");
});

test("BillingTab folds usage history and removes reservation ledgers from the UI", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain('summary>{t("billing.ledger.title")}</summary>');
  expect(source).toContain('class="wb-disclosure av-billing-ledger"');
  expect(source).toContain('"billing.usage.title"');
  expect(source).not.toContain("listSpaceCreditReservations");
  expect(source).not.toContain("CreditReservation");
  expect(source).not.toContain('"billing.reservations.title"');
  expect(source).not.toContain(
    '<CardHeader title={t("billing.reservations.title")} />',
  );
  expect(source).not.toContain(
    '<CardHeader title={t("billing.usage.title")} />',
  );
});

test("BillingTab keeps checkout plans Cloud-only and leaves usage visible", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("isTakosumiCloudRuntime");
  expect(source).toContain("<Show when={cloudBilling()}>");
  expect(source).toContain("listSpaceUsage");
  expect(source).toContain('"billing.usage.title"');
  expect(source).toContain('"billing.plans.title"');
  expect(source).toContain('"billing.portal"');
  expect(source).not.toContain("createResource(listBillingPlans)");
});
