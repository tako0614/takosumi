import { expect, test } from "bun:test";
import {
  normalizeVariablePathRecord,
  normalizeVariables,
} from "../../../../core/domains/deploy-control/validation.ts";

test("normalizes dotted OpenTofu variable paths into nested objects", () => {
  expect(
    normalizeVariablePathRecord({
      "cloudflare.workers_subdomain": "team",
      cloudflare: { account_id: "acct_123" },
    }),
  ).toEqual({
    cloudflare: {
      account_id: "acct_123",
      workers_subdomain: "team",
    },
  });
});

test("rejects prototype-reserved OpenTofu variable path segments", () => {
  for (const key of [
    "__proto__",
    "constructor",
    "prototype",
    "cloudflare.__proto__",
    "cloudflare.constructor",
    "cloudflare.prototype",
  ]) {
    expect(() => normalizeVariablePathRecord({ [key]: true })).toThrow(
      /dot-separated OpenTofu variable identifier segments/,
    );
  }

  expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
});

test("rejects prototype-reserved JSON object keys inside variable values", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    expect(() =>
      normalizeVariables({
        cloudflare: { [key]: { polluted: true } },
      }),
    ).toThrow(/must be a JSON value/);
  }

  expect(({} as { readonly polluted?: boolean }).polluted).toBeUndefined();
});
