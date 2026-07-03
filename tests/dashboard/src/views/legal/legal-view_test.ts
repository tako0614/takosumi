import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboardRoot = resolve(import.meta.dir, "../../../../../dashboard/src");

function readDashboard(path: string): string {
  return readFileSync(resolve(dashboardRoot, path), "utf8");
}

test("legal and support pages live on app routes instead of OSS docs", () => {
  const index = readDashboard("index.tsx");
  const signIn = readDashboard("views/auth/SignInView.tsx");
  const legal = readDashboard("views/legal/LegalView.tsx");

  expect(index).toContain('path="/legal/:page"');
  expect(index).toContain('path="/support"');
  expect(signIn).toContain('href="/legal/terms-of-service"');
  expect(signIn).toContain('href="/legal/privacy-policy"');
  expect(signIn).not.toContain("takosumi.com/docs/legal");

  expect(legal).toContain("Takosumi Cloud");
  expect(legal).toContain("support@takosumi.com");
  expect(legal).toContain("TAKOSUMI");
  expect(legal).toContain("Stripe");
  expect(legal).toContain("digital service");
  expect(legal).not.toContain("takosumi.com/docs");
});
