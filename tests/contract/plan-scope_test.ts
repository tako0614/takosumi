import { expect, test } from "bun:test";

import {
  normalizePlanResourceScope,
  normalizeScopeBoundaryPolicy,
  parseScopeBoundaryPolicy,
  planScopeSelectors,
  resourceTypeMatchesPattern,
} from "takosumi-contract";

test("scope policy is provider-neutral and runner selectors omit allowed values", () => {
  const policy = parseScopeBoundaryPolicy({
    mode: "strict",
    rules: [
      {
        resourceTypePattern: "vendor_*",
        dimensions: {
          account: {
            selector: "/owner/account_id",
            allowedValues: ["account-a", "account-b"],
          },
          region: {
            selector: "/region",
            allowedValues: ["eu-test-1"],
          },
        },
      },
    ],
  });

  expect(planScopeSelectors(policy)).toEqual([
    {
      resourceTypePattern: "vendor_*",
      dimensions: {
        account: "/owner/account_id",
        region: "/region",
      },
    },
  ]);
  expect(JSON.stringify(planScopeSelectors(policy))).not.toContain("account-a");
  expect(resourceTypeMatchesPattern("vendor_service", "vendor_*")).toBe(true);
  expect(resourceTypeMatchesPattern("other_service", "vendor_*")).toBe(false);
});

test("current scope policy rejects malformed selectors instead of weakening policy", () => {
  expect(() =>
    parseScopeBoundaryPolicy({
      rules: [
        {
          resourceTypePattern: "vendor_*",
          dimensions: {
            region: { selector: "region", allowedValues: ["eu-test-1"] },
          },
        },
      ],
    }),
  ).toThrow(/RFC 6901 selector/);
  expect(() =>
    normalizeScopeBoundaryPolicy({
      rules: [{ resourceTypePattern: "vendor_*", dimensions: "invalid" }],
    }),
  ).toThrow(/dimensions/);
});

test("provider-specific scope policy shapes fail closed", () => {
  expect(() =>
    normalizeScopeBoundaryPolicy({
      mode: "strict",
      cloudflare: { accountIds: ["cf-account"], zoneIds: ["cf-zone"] },
      aws: { accountIds: ["aws-account"], regions: ["us-test-1"] },
    }),
  ).toThrow(/rules/);
});

test("provider-specific plan projections are not inferred", () => {
  expect(
    normalizePlanResourceScope({
      cloudflareAccountId: "cf-account",
      cloudflareZoneId: "cf-zone",
    }),
  ).toBeUndefined();
});
