import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

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
  expect(source).toContain("usageKindLabel(e.kind)");
  expect(source).toContain('"billing.usage.title"');
  expect(source).not.toContain('<code class="wc-code">{e.kind}</code>');
  expect(source).not.toContain("listSpaceCreditReservations");
  expect(source).not.toContain("CreditReservation");
  expect(source).not.toContain('"billing.reservations.title"');
  expect(source).not.toContain(
    '<CardHeader title={t("billing.reservations.title")} />',
  );
  expect(source).not.toContain(
    '<CardHeader title={t("billing.usage.title")} />',
  );
  expect(en["billing.ledger.title"]).toBe("Usage history");
  expect(ja["billing.ledger.title"]).toBe("使用履歴");
  expect(en["billing.usage.kind.runnerMinute"]).toBe("Runner time");
  expect(ja["billing.usage.kind.runnerMinute"]).toBe("実行時間");
});

test("BillingTab keeps checkout plans Cloud-only and leaves usage visible", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("isTakosumiCloudRuntime");
  expect(source).toContain("<Show when={cloudBilling()}>");
  expect(source).toContain("when={canStartCheckout()}");
  expect(source).toContain(
    'fallback={\n                    <p class="av-plan-policy av-plan-policy-disabled">',
  );
  expect(source).toContain("listSpaceUsage");
  expect(source).toContain('"billing.usage.title"');
  expect(source).toContain('"billing.plans.title"');
  expect(source).toContain('"billing.portal"');
  expect(source).not.toContain("createResource(listBillingPlans)");
});

test("BillingTab hides purchase cards while billing is disabled", () => {
  const source = readFileSync(sourcePath, "utf8");
  const disabledFallbackIndex = source.indexOf(
    'fallback={\n                    <p class="av-plan-policy av-plan-policy-disabled">',
  );
  const nonRefundableIndex = source.indexOf(
    '<p class="muted av-plan-policy">\n                    {t("billing.plans.nonRefundable")}',
  );
  const subscriptionListIndex = source.indexOf(
    "<Show when={subscriptions().length > 0}>",
  );

  expect(disabledFallbackIndex).toBeGreaterThan(0);
  expect(nonRefundableIndex).toBeGreaterThan(disabledFallbackIndex);
  expect(subscriptionListIndex).toBeGreaterThan(nonRefundableIndex);
  expect(en["billing.plans.disabled"]).toBe(
    "Purchases are not available for this workspace right now. Plans will appear here when checkout is open.",
  );
  expect(ja["billing.plans.disabled"]).toBe(
    "現在、このワークスペースでは購入できません。購入が必要になった場合は、この画面にプランが表示されます。",
  );
});
