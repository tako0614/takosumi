import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { en } from "../../../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../../../dashboard/src/i18n/ja.ts";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/tabs/BillingTab.tsx",
  ),
  "utf8",
);

test("BillingTab is provider-neutral and keeps usage/showback visible", () => {
  expect(source).toContain("readonly workspaceId?: string");
  expect(source).toContain("getWorkspaceBilling");
  expect(source).toContain("listWorkspaceUsagePage");
  expect(source).toContain("listPersonalUsagePage(currentWorkspaceId() || undefined, options)");
  expect(source).toContain('"workspace.billing"');
  expect(source).toContain("loadPlatformContributions");
  expect(source).toContain('"native"');
  expect(source).toContain("CommercialBillingPanel");
  expect(source).toContain(
    'hasPlatformExtensionCapability("billing.commercial.v1")',
  );
  expect(source).toContain('"inline-frame"');
  expect(source).toContain("InlinePlatformContribution");
  expect(source).toContain('"takosumi.platform-contribution-resize@v1"');
  expect(source).toContain('rel="external"');
  expect(source).not.toContain("Stripe");
  expect(source).not.toContain("checkout");
  expect(source).not.toContain("portal");
  expect(source).not.toContain("invoice");
  expect(source).not.toContain("hasCommercialBillingCapability");
  expect(source).toContain("props.workspaceId && current() && !commercialBillingEnabled()");
  expect(source).toContain('<Show when={props.workspaceId} keyed>');
});

test("BillingTab shows usage directly, as cards, with paging", () => {
  // This section exists to show use: it reads on open instead of hiding the
  // list behind a disclosure.
  expect(source).toContain("USAGE_PAGE_SIZE = 25");
  expect(source).toContain("onMount(() => void loadUsage(false))");
  expect(source).not.toContain("<details");
  expect(source).not.toContain("<DataTable");
  expect(source).toContain('class="acct-row tg-card"');
  expect(source).toContain("usageCursor");
  expect(source).toContain("loadUsage(true)");
  // Usage rows name the app, falling back for removed apps.
  expect(source).toContain("createServiceNames(() => props.workspaceId)");
  expect(source).toContain('t("billing.usage.removedApp")');
});

test("BillingTab distinguishes unpriced usage from a rated zero, and says unknown", () => {
  expect(source).toContain('event.ratingStatus === "rated"');
  expect(source).toContain('t("billing.usage.amountUnknown")');
  expect(ja["billing.usage.amountUnknown"]).toContain("不明");
});

test("billing copy is plain: no showback, recording mode or provider-neutral jargon", () => {
  for (const [key, value] of Object.entries(ja)) {
    if (!key.startsWith("billing.") || key.startsWith("billing.commercial.")) continue;
    expect({ key, value }).not.toEqual(
      expect.objectContaining({ value: expect.stringMatching(/ショーバック|記録モード|プロバイダー非依存|ワークスペース/u) }),
    );
  }
  for (const [key, value] of Object.entries(en)) {
    if (!key.startsWith("billing.") || key.startsWith("billing.commercial.")) continue;
    expect({ key, value }).not.toEqual(
      expect.objectContaining({ value: expect.stringMatching(/showback|provider-neutral/iu) }),
    );
  }
  // Members and viewers learn who can see charges instead of an error.
  expect(source).toContain('t("billing.ownersOnly")');
});
