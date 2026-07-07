import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const sourcePath = resolve(
  import.meta.dir,
  "../../../../../../dashboard/src/views/workspace/tabs/BillingTab.tsx",
);
const controlApiSourcePath = resolve(
  import.meta.dir,
  "../../../../../../dashboard/src/lib/control-api.ts",
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
  expect(source).toContain("const canStartCheckout = createMemo");
  expect(source).toContain("cloudBilling() && hasBillingCatalog()");
  expect(source).toContain("listWorkspaceUsagePage");
  expect(source).toContain('"billing.usage.title"');
  expect(source).toContain('"billing.plans.title"');
  expect(source).toContain('"billing.portal"');
  expect(source).not.toContain("createResource(listBillingPlans)");
});

test("BillingTab billing plans use the shared control-api cache", () => {
  const source = readFileSync(sourcePath, "utf8");
  const controlApiSource = readFileSync(controlApiSourcePath, "utf8");

  expect(source).toContain("listBillingPlans");
  expect(controlApiSource).toContain("BILLING_PLANS_CACHE_TTL_MS");
  expect(controlApiSource).toContain("billingPlansRequest");
  expect(controlApiSource).toContain("billingPlansCache");
  expect(controlApiSource).toContain("if (billingPlansRequest)");
});

test("BillingTab lazy-loads usage history instead of fetching every usage page on first paint", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("const [usageRequested, setUsageRequested]");
  expect(source).toContain("usageRequested() ? props.workspaceId : undefined");
  expect(source).toContain("USAGE_LEDGER_PAGE_SIZE = 25");
  expect(source).toContain("{ limit: USAGE_LEDGER_PAGE_SIZE }");
  expect(source).toContain("onToggle={(event) =>");
  expect(source).toContain("setUsageRequested(true)");
  expect(source).toContain('"billing.usage.openHint"');
  expect(source).not.toContain(
    "createResource(() => props.workspaceId, listWorkspaceUsage)",
  );
});

test("BillingTab lets a new Cloud workspace start checkout before billing is active", () => {
  const source = readFileSync(sourcePath, "utf8");
  const checkoutMemoIndex = source.indexOf(
    "const canStartCheckout = createMemo",
  );
  const portalMemoIndex = source.indexOf("const canOpenPortal = createMemo");
  const nonRefundableIndex = source.indexOf(
    '<p class="muted av-plan-policy">\n            {t("billing.plans.nonRefundable")}',
  );
  const plansSwitchIndex = source.indexOf("<Switch>", nonRefundableIndex);
  const policyLinksIndex = source.indexOf('class="av-billing-policy-links"');
  const subscriptionListIndex = source.indexOf(
    '<ul class="av-plan-list">',
    nonRefundableIndex,
  );

  expect(checkoutMemoIndex).toBeGreaterThan(0);
  expect(portalMemoIndex).toBeGreaterThan(checkoutMemoIndex);
  expect(source).toContain("cloudBilling() && hasBillingCatalog()");
  expect(source).toContain(
    'cloudBilling() && mode() !== undefined && mode() !== "disabled"',
  );
  expect(source).not.toContain("billing.plans.disabled");
  expect(source).toContain('href="/legal/refund-policy"');
  expect(source).toContain('href="/legal/cancellation-policy"');
  expect(source).toContain('href="/legal/terms-of-service"');
  expect(source).toContain('href="/legal/privacy-policy"');
  expect(source).toContain('href="/support"');
  expect(nonRefundableIndex).toBeGreaterThan(0);
  expect(plansSwitchIndex).toBeGreaterThan(nonRefundableIndex);
  expect(policyLinksIndex).toBeGreaterThan(nonRefundableIndex);
  expect(subscriptionListIndex).toBeGreaterThan(nonRefundableIndex);
  expect(en["billing.plans.nonRefundable"]).toContain("TAKOSUMI");
  expect(ja["billing.plans.nonRefundable"]).toContain("返金");
});
