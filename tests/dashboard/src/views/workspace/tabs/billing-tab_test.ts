import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(
    import.meta.dir,
    "../../../../../../dashboard/src/views/workspace/tabs/BillingTab.tsx",
  ),
  "utf8",
);

test("BillingTab is provider-neutral and keeps usage/showback visible", () => {
  expect(source).toContain("getWorkspaceBilling");
  expect(source).toContain("listWorkspaceUsagePage");
  expect(source).toContain('"workspace.billing"');
  expect(source).toContain("loadPlatformContributions");
  expect(source).not.toContain("Stripe");
  expect(source).not.toContain("checkout");
  expect(source).not.toContain("portal");
  expect(source).not.toContain("invoice");
  expect(source).not.toContain("hasCommercialBillingCapability");
});

test("BillingTab lazy-loads bounded usage pages", () => {
  expect(source).toContain("USAGE_LEDGER_PAGE_SIZE = 25");
  expect(source).toContain("listWorkspaceUsagePage");
  expect(source).toContain("usageCursor");
  expect(source).toContain("loadUsage(true)");
});

test("BillingTab distinguishes unrated usage from rated zero cost", () => {
  expect(source).toContain('event.ratingStatus === "rated"');
  expect(source).toContain('t("billing.usage.unrated")');
});
