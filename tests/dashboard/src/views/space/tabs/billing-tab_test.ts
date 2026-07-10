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
  expect(source).toContain("rpc.billing.summary");
  expect(source).toContain("const canStartCheckout = createMemo");
  expect(source).toContain("cloudBilling() && hasBillingCatalog()");
  expect(source).toContain("listWorkspaceUsagePage");
  expect(source).toContain('"billing.usage.title"');
  expect(source).toContain('"billing.subscription.title"');
  expect(source).toContain('"billing.invoices.title"');
  expect(source).toContain('"billing.plans.title"');
  expect(source).toContain('"billing.subscription.manage"');
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
  const nonRefundableIndex = source.indexOf('t("billing.plans.nonRefundable")');
  const plansSwitchIndex = source.indexOf("<Switch>", nonRefundableIndex);
  const policyLinksIndex = source.indexOf('class="av-billing-policy-links"');
  const subscriptionListIndex = source.indexOf(
    '<ul class="av-plan-list">',
    nonRefundableIndex,
  );

  expect(checkoutMemoIndex).toBeGreaterThan(0);
  expect(portalMemoIndex).toBeGreaterThan(checkoutMemoIndex);
  expect(source).toContain("cloudBilling() && hasBillingCatalog()");
  expect(source).toContain("stripeBilling()?.configured === true");
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

test("BillingTab shows Cloud account USD balance instead of only a disabled status", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("billing.mode.cloudCredits");
  expect(source).toContain("balanceAvailableUsdMicros(balance()) > 0");
  expect(source).toContain('label: t("billing.balance.availableUsd")');
  expect(source).toMatch(
    /value: formatUsdMicros\(\s*balanceAvailableUsdMicros\(balance\(\)\),/,
  );
  expect(source).toContain('label: t("billing.balance.status")');
  expect(source).not.toContain(
    'if (currentMode === "disabled") return t("billing.balance.actionRequired");',
  );
  expect(en["billing.balance.availableUsd"]).toBe("Available balance");
  expect(ja["billing.balance.availableUsd"]).toBe("利用可能な残高");
  expect(en["billing.mode.cloudCredits"]).toContain(
    "shared across your account",
  );
  expect(ja["billing.mode.cloudCredits"]).toContain("アカウント全体");
});

test("BillingTab hides the capacity row while billing is disabled", () => {
  const source = readFileSync(sourcePath, "utf8");

  // Under `disabled` a "$0.00 available capacity" row reads as alarming
  // nonsense — capacity is only rendered for showback/enforce modes.
  expect(source).toContain("const quotaMeaningful = createMemo");
  expect(source).toMatch(
    /currentMode === "showback" \|\| currentMode === "enforce"/,
  );
  expect(source).toContain("cloudBilling() || quotaMeaningful()");
  expect(source).toContain('t("billing.quota.disabledHint")');
  expect(en["billing.quota.disabledHint"]).toContain("disabled");
  expect(ja["billing.quota.disabledHint"]).toContain("課金が無効");
});

test("/settings/billing titles itself like its settings-hub entry", () => {
  const settingsViewSource = readFileSync(
    resolve(
      import.meta.dir,
      "../../../../../../dashboard/src/views/workspace/WorkspaceSettingsView.tsx",
    ),
    "utf8",
  );
  const source = readFileSync(sourcePath, "utf8");

  // The hub links to /settings/billing as プランと支払い / "Plan & billing"; the
  // destination page must not retitle itself 使用量 / 上限 (that wording stays as
  // the section heading inside and as the workspace-settings tab label).
  expect(settingsViewSource).toContain('return t("settings.billing.title");');
  expect(settingsViewSource).not.toContain('? t("billing.title")');
  expect(source).toContain('t("billing.usageQuotaTitle")');
  expect(en["settings.billing.title"]).toBe("Plan & billing");
  expect(ja["settings.billing.title"]).toBe("プランと支払い");
  // The workspace-settings tab label stays usage/quota on self-host.
  expect(settingsViewSource).toContain('t("workspaceSettings.tab.usageQuota")');
  expect(ja["workspaceSettings.tab.usageQuota"]).toBe("使用量 / 上限");
});

test("BillingTab surfaces subscription status and invoice history", () => {
  const source = readFileSync(sourcePath, "utf8");

  expect(source).toContain("currentSubscription");
  expect(source).toContain("subscriptionStatusLabel");
  expect(source).toContain("invoiceColumns");
  expect(source).toContain("invoice.hostedInvoiceUrl");
  expect(source).toContain('"billing.subscription.manage"');
  expect(source).toContain('"billing.subscription.manageHint"');
  expect(en["billing.subscription.title"]).toBe("Subscription");
  expect(ja["billing.subscription.title"]).toBe("サブスクリプション");
  expect(en["billing.subscription.manage"]).toBe(
    "Manage or cancel subscription",
  );
  expect(ja["billing.subscription.manage"]).toBe("サブスク管理・解約");
  expect(en["billing.invoices.title"]).toBe("Billing history");
  expect(ja["billing.invoices.title"]).toBe("請求履歴");
});
