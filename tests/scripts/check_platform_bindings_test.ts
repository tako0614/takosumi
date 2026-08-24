import { expect, test } from "bun:test";
import { renderPlatformBindingsChecklist } from "../../scripts/check-platform-bindings.ts";

test("operator checklist renders the exact current binding groups", () => {
  const output = renderPlatformBindingsChecklist();

  expect(output).toContain("D1 databases:\n    - TAKOSUMI_ACCOUNTS_DB");
  expect(output).toContain("R2 buckets:\n    - R2_ARTIFACTS");
  expect(output).toContain("Durable Objects:\n    - COORDINATION");
  expect(output).toContain("Static assets:\n    - ASSETS");
  expect(output).not.toContain("Queues:");
  expect(output).not.toContain("TAKOSUMI_CLOUD_");
  expect(output).not.toContain("R2_FORM_PACKAGES");
});
