import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "../../../../../dashboard/src");

function readDashboard(path: string): string {
  return readFileSync(resolve(dashboardRoot, path), "utf8");
}

test("OSS legal routes stay generic while hosted policies are contributions", () => {
  const index = readDashboard("index.tsx");
  const signIn = readDashboard("views/auth/SignInView.tsx");
  const legal = readDashboard("views/legal/LegalView.tsx");

  expect(index).toContain('path="/legal/:page"');
  expect(index).toContain('path="/support"');
  expect(signIn).toContain('"legal.terms"');
  expect(signIn).toContain('"legal.privacy"');
  expect(signIn).toContain("platformContributionsForSlot");
  expect(signIn).not.toContain("takosumi.com/docs/legal");

  expect(legal).toContain("operator");
  expect(legal).toContain("OSS Takosumi does not process payments");
  expect(legal).not.toContain("Takosumi Cloud");
  expect(legal).not.toContain("Stripe");
  expect(legal).not.toContain("takosumi.com/docs");
});
