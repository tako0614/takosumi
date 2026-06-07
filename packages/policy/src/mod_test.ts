/**
 * takosumi-policy unit tests (core-spec.md §25). Per-layer evaluators +
 * composition. Pure data in / verdict out; no service / store.
 */

import { expect, test } from "bun:test";
import {
  composePolicyVerdict,
  evaluateActionPolicy,
  evaluateProviderAllowlist,
  evaluateQuotaPolicy,
  evaluateResourceAllowlist,
  evaluateScopeBoundary,
  type PlanResourceChange,
  providerMatches,
  TAKOSUMI_POLICY_PACKAGE,
} from "./mod.ts";

test("package identity", () => {
  expect(TAKOSUMI_POLICY_PACKAGE).toBe("takosumi-policy");
});

// --- §25 layer 4: provider allowlist ---------------------------------------

test("provider allowlist admits a fully-qualified provider against a short rule", () => {
  const result = evaluateProviderAllowlist(
    ["registry.opentofu.org/cloudflare/cloudflare"],
    { allowed: ["cloudflare"] },
  );
  expect(result.notAllowed).toEqual([]);
  expect(result.denied).toEqual([]);
  expect(result.missingProviders).toBe(false);
  expect(result.reasons).toEqual([]);
});

test("provider allowlist rejects a provider not admitted by any rule", () => {
  const result = evaluateProviderAllowlist(
    ["registry.opentofu.org/hashicorp/aws"],
    { allowed: ["cloudflare"] },
  );
  expect(result.notAllowed).toEqual(["registry.opentofu.org/hashicorp/aws"]);
  expect(result.reasons.join("\n")).toMatch(/aws is not allowed/);
});

test("provider allowlist denial overrides an allow", () => {
  const result = evaluateProviderAllowlist(
    ["registry.opentofu.org/hashicorp/aws"],
    { allowed: ["*"], denied: ["aws"] },
  );
  expect(result.denied).toEqual(["registry.opentofu.org/hashicorp/aws"]);
  expect(result.notAllowed).toEqual([]);
  expect(result.reasons.join("\n")).toMatch(/aws is denied/);
});

test("provider allowlist wildcard admits any provider", () => {
  const result = evaluateProviderAllowlist(
    ["registry.opentofu.org/hashicorp/aws", "cloudflare"],
    { allowed: ["*"] },
  );
  expect(result.notAllowed).toEqual([]);
  expect(result.reasons).toEqual([]);
});

test("provider allowlist trips the providers-before-init gate on zero providers", () => {
  const result = evaluateProviderAllowlist([], { allowed: ["cloudflare"] });
  expect(result.missingProviders).toBe(true);
  expect(result.reasons.join("\n")).toMatch(/before OpenTofu init/);
});

test("provider allowlist allowNoProviders skips the gate for a provider-free install", () => {
  const result = evaluateProviderAllowlist([], {
    allowed: ["cloudflare"],
    allowNoProviders: true,
  });
  expect(result.missingProviders).toBe(false);
  expect(result.reasons).toEqual([]);
});

test("provider allowlist with no allowed rules does not trip the gate", () => {
  const result = evaluateProviderAllowlist([], { allowed: [] });
  expect(result.missingProviders).toBe(false);
});

test("providerMatches is one-directional", () => {
  expect(
    providerMatches("registry.opentofu.org/hashicorp/aws", "aws"),
  ).toBe(true);
  // A bare provider must NOT satisfy a fully-qualified rule.
  expect(
    providerMatches("aws", "registry.opentofu.org/hashicorp/aws"),
  ).toBe(false);
});

// --- §25 layer 5: resource-type allowlist ----------------------------------

const CHANGES: readonly PlanResourceChange[] = [
  { address: "a", type: "cloudflare_r2_bucket", actions: ["create"] },
  { address: "b", type: "cloudflare_workers_script", actions: ["update"] },
  { address: "c", type: "random_id", actions: ["no-op"] },
];

test("resource allowlist passes when every mutating type is allowed", () => {
  const result = evaluateResourceAllowlist(CHANGES, [
    "cloudflare_r2_bucket",
    "cloudflare_workers_script",
  ]);
  expect(result.disallowedResourceTypes).toEqual([]);
  expect(result.reasons).toEqual([]);
});

test("resource allowlist flags a mutating type outside the allowlist", () => {
  const result = evaluateResourceAllowlist(CHANGES, ["cloudflare_r2_bucket"]);
  expect(result.disallowedResourceTypes).toEqual(["cloudflare_workers_script"]);
  expect(result.reasons.join("\n")).toMatch(
    /cloudflare_workers_script is not allowed/,
  );
});

test("resource allowlist ignores no-op/read changes", () => {
  const result = evaluateResourceAllowlist(
    [{ address: "c", type: "random_id", actions: ["no-op", "read"] }],
    [],
  );
  expect(result.disallowedResourceTypes).toEqual([]);
});

test("undefined allowlist skips the layer (not configured)", () => {
  const result = evaluateResourceAllowlist(CHANGES, undefined);
  expect(result.disallowedResourceTypes).toEqual([]);
  expect(result.reasons).toEqual([]);
});

test("empty allowlist forbids every mutating type", () => {
  const result = evaluateResourceAllowlist(CHANGES, []);
  expect(result.disallowedResourceTypes).toEqual([
    "cloudflare_r2_bucket",
    "cloudflare_workers_script",
  ]);
});

test("resource allowlist de-duplicates and sorts disallowed types", () => {
  const result = evaluateResourceAllowlist(
    [
      { address: "a", type: "z_type", actions: ["create"] },
      { address: "b", type: "a_type", actions: ["update"] },
      { address: "c", type: "z_type", actions: ["create"] },
    ],
    [],
  );
  expect(result.disallowedResourceTypes).toEqual(["a_type", "z_type"]);
});

// --- §25 layer 7: action policy --------------------------------------------

test("action policy allows create/update without approval", () => {
  const result = evaluateActionPolicy([
    { address: "a", type: "x", actions: ["create"] },
    { address: "b", type: "y", actions: ["update"] },
    { address: "c", type: "z", actions: ["no-op"] },
  ]);
  expect(result.requiresApproval).toBe(false);
  expect(result.reasons).toEqual([]);
});

test("action policy requires approval for a delete", () => {
  const result = evaluateActionPolicy([
    { address: "a", type: "cloudflare_r2_bucket", actions: ["delete"] },
  ]);
  expect(result.requiresApproval).toBe(true);
  expect(result.reasons.join("\n")).toMatch(/cloudflare_r2_bucket/);
});

test("action policy requires approval for a replace (delete+create)", () => {
  const result = evaluateActionPolicy([
    { address: "a", type: "x", actions: ["delete", "create"] },
  ]);
  expect(result.requiresApproval).toBe(true);
});

test("action policy requires approval for create-before-destroy replace", () => {
  const result = evaluateActionPolicy([
    { address: "a", type: "x", actions: ["create", "delete"] },
  ]);
  expect(result.requiresApproval).toBe(true);
});

test("action policy de-duplicates destructive reasons by type", () => {
  const result = evaluateActionPolicy([
    { address: "a", type: "x", actions: ["delete"] },
    { address: "b", type: "x", actions: ["delete", "create"] },
  ]);
  expect(result.requiresApproval).toBe(true);
  expect(result.reasons).toHaveLength(1);
});

// --- §25 layer 6: scope boundary -------------------------------------------

test("scope boundary admits resources with matching Cloudflare metadata", () => {
  const result = evaluateScopeBoundary([
    {
      address: "cloudflare_r2_bucket.files",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
      scope: { cloudflareAccountId: "acct_allowed" },
    },
  ], {
    mode: "strict",
    cloudflare: { accountIds: ["acct_allowed"] },
  });
  expect(result.outOfScope).toEqual([]);
  expect(result.reasons).toEqual([]);
});

test("strict scope boundary fails closed when configured metadata is missing", () => {
  const result = evaluateScopeBoundary([
    {
      address: "cloudflare_r2_bucket.files",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
    },
  ], {
    mode: "strict",
    cloudflare: { accountIds: ["acct_allowed"] },
  });
  expect(result.outOfScope).toEqual([
    "cloudflare_r2_bucket.files missing Cloudflare account metadata",
  ]);
  expect(result.reasons.join("\n")).toMatch(/out of scope/);
});

test("permissive scope boundary validates available metadata but skips missing metadata", () => {
  const missing = evaluateScopeBoundary([
    {
      address: "cloudflare_r2_bucket.files",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
    },
  ], {
    cloudflare: { accountIds: ["acct_allowed"] },
  });
  expect(missing.outOfScope).toEqual([]);

  const observed = evaluateScopeBoundary([
    {
      address: "cloudflare_r2_bucket.files",
      type: "cloudflare_r2_bucket",
      actions: ["create"],
      scope: { cloudflareAccountId: "acct_other" },
    },
  ], {
    cloudflare: { accountIds: ["acct_allowed"] },
  });
  expect(observed.outOfScope).toEqual([
    "cloudflare_r2_bucket.files Cloudflare account acct_other",
  ]);
});

test("scope boundary ignores read-only resources", () => {
  const result = evaluateScopeBoundary([
    {
      address: "aws_s3_bucket.files",
      type: "aws_s3_bucket",
      actions: ["read"],
      scope: { awsRegion: "us-east-1" },
    },
  ], {
    mode: "strict",
    aws: { regions: ["us-west-2"] },
  });
  expect(result.outOfScope).toEqual([]);
});

// --- §25 layer 10: quota ----------------------------------------------------

test("quota policy enforces total and per-resource mutating counts", () => {
  const result = evaluateQuotaPolicy([
    { address: "a", type: "cloudflare_r2_bucket", actions: ["create"] },
    { address: "b", type: "cloudflare_r2_bucket", actions: ["update"] },
    { address: "c", type: "random_id", actions: ["no-op"] },
  ], {
    "resources.total": 1,
    cloudflare_r2_bucket: 1,
  });
  expect(result.exceeded).toEqual([
    "cloudflare_r2_bucket count 2 exceeds 1",
    "resources.total count 2 exceeds 1",
  ]);
  expect(result.reasons.join("\n")).toMatch(/quota/);
});

test("quota policy treats invalid limits as deny reasons", () => {
  const result = evaluateQuotaPolicy([], { resources: -1 });
  expect(result.exceeded).toEqual(["resources limit is invalid"]);
});

// --- composition -----------------------------------------------------------

test("composePolicyVerdict passes a clean create plan", () => {
  const verdict = composePolicyVerdict({
    provider: evaluateProviderAllowlist(["cloudflare"], { allowed: ["cloudflare"] }),
    resource: evaluateResourceAllowlist(
      [{ address: "a", type: "cloudflare_r2_bucket", actions: ["create"] }],
      ["cloudflare_r2_bucket"],
    ),
    action: evaluateActionPolicy([
      { address: "a", type: "cloudflare_r2_bucket", actions: ["create"] },
    ]),
  });
  expect(verdict.status).toBe("pass");
  expect(verdict.requiresApproval).toBe(false);
  expect(verdict.reasons).toEqual([]);
});

test("composePolicyVerdict denies on a disallowed resource type", () => {
  const verdict = composePolicyVerdict({
    resource: evaluateResourceAllowlist(
      [{ address: "a", type: "aws_s3_bucket", actions: ["create"] }],
      ["cloudflare_r2_bucket"],
    ),
  });
  expect(verdict.status).toBe("deny");
  expect(verdict.requiresApproval).toBe(false);
  expect(verdict.reasons.join("\n")).toMatch(/aws_s3_bucket is not allowed/);
});

test("composePolicyVerdict denies on a denied provider", () => {
  const verdict = composePolicyVerdict({
    provider: evaluateProviderAllowlist(["aws"], {
      allowed: ["*"],
      denied: ["aws"],
    }),
  });
  expect(verdict.status).toBe("deny");
});

test("composePolicyVerdict passes but requires approval on a delete/replace", () => {
  const verdict = composePolicyVerdict({
    resource: evaluateResourceAllowlist(
      [{ address: "a", type: "cloudflare_r2_bucket", actions: ["delete", "create"] }],
      ["cloudflare_r2_bucket"],
    ),
    action: evaluateActionPolicy([
      { address: "a", type: "cloudflare_r2_bucket", actions: ["delete", "create"] },
    ]),
  });
  expect(verdict.status).toBe("pass");
  expect(verdict.requiresApproval).toBe(true);
});

test("composePolicyVerdict requires approval for a destroy flow", () => {
  const verdict = composePolicyVerdict({ destroy: true });
  expect(verdict.status).toBe("pass");
  expect(verdict.requiresApproval).toBe(true);
});

test("composePolicyVerdict deny dominates requiresApproval", () => {
  const verdict = composePolicyVerdict({
    resource: evaluateResourceAllowlist(
      [{ address: "a", type: "aws_s3_bucket", actions: ["delete"] }],
      ["cloudflare_r2_bucket"],
    ),
    action: evaluateActionPolicy([
      { address: "a", type: "aws_s3_bucket", actions: ["delete"] },
    ]),
  });
  expect(verdict.status).toBe("deny");
  // The action layer still surfaces the approval requirement.
  expect(verdict.requiresApproval).toBe(true);
});

test("composePolicyVerdict folds the post-MVP scope/quota seams when populated", () => {
  const scope = composePolicyVerdict({ scope: { outOfScope: ["res.a"] } });
  expect(scope.status).toBe("deny");
  expect(scope.reasons.join("\n")).toMatch(/res.a is out of scope/);
  const quota = composePolicyVerdict({ quota: { exceeded: ["compute"] } });
  expect(quota.status).toBe("deny");
  expect(quota.reasons.join("\n")).toMatch(/quota compute is exceeded/);
  // Empty/absent post-MVP inputs do not deny.
  const clean = composePolicyVerdict({ scope: {}, quota: {} });
  expect(clean.status).toBe("pass");
});
