import { expect, test } from "bun:test";
import type { TemplatePolicySpec } from "takosumi-contract/deploy-control-api";
import { evaluateTemplatePlanPolicy } from "./template_policy.ts";

const POLICY: TemplatePolicySpec = {
  allowedProviders: ["cloudflare/cloudflare"],
  allowedResourceTypes: ["cloudflare_r2_bucket"],
  destructiveChanges: { requireExplicitConfirmation: true },
};

test("a create-only plan of allowed types passes with no confirmation", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: POLICY,
    changes: [
      { address: "module.app.cloudflare_r2_bucket.this", type: "cloudflare_r2_bucket", actions: ["create"] },
    ],
  });
  expect(result.disallowedResourceTypes).toEqual([]);
  expect(result.hasDestructiveChange).toEqual(false);
  expect(result.requiresConfirmation).toEqual(false);
  expect(result.reasons).toEqual([]);
});

test("a disallowed resource type is flagged with a reason", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: POLICY,
    changes: [
      { address: "module.app.cloudflare_workers_script.x", type: "cloudflare_workers_script", actions: ["create"] },
    ],
  });
  expect(result.disallowedResourceTypes).toEqual(["cloudflare_workers_script"]);
  expect(result.reasons[0]).toMatch(/cloudflare_workers_script is not allowed/);
});

test("a delete change is destructive and requires confirmation", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: POLICY,
    changes: [
      { address: "module.app.cloudflare_r2_bucket.this", type: "cloudflare_r2_bucket", actions: ["delete"] },
    ],
  });
  expect(result.hasDestructiveChange).toEqual(true);
  expect(result.requiresConfirmation).toEqual(true);
});

test("a replace (delete+create) is destructive", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: POLICY,
    changes: [
      { address: "module.app.cloudflare_r2_bucket.this", type: "cloudflare_r2_bucket", actions: ["delete", "create"] },
    ],
  });
  expect(result.hasDestructiveChange).toEqual(true);
  expect(result.requiresConfirmation).toEqual(true);
});

test("destructive change does not require confirmation when the policy disables it", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: { ...POLICY, destructiveChanges: { requireExplicitConfirmation: false } },
    changes: [
      { address: "module.app.cloudflare_r2_bucket.this", type: "cloudflare_r2_bucket", actions: ["delete"] },
    ],
  });
  expect(result.hasDestructiveChange).toEqual(true);
  expect(result.requiresConfirmation).toEqual(false);
});

test("no-op and read changes neither require allowlisting nor count as destructive", () => {
  const result = evaluateTemplatePlanPolicy({
    policy: POLICY,
    changes: [
      { address: "data.x", type: "some_data_source", actions: ["read"] },
      { address: "module.app.cloudflare_r2_bucket.this", type: "cloudflare_r2_bucket", actions: ["no-op"] },
    ],
  });
  expect(result.disallowedResourceTypes).toEqual([]);
  expect(result.hasDestructiveChange).toEqual(false);
  expect(result.requiresConfirmation).toEqual(false);
});
