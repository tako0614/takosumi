import { expect, test } from "bun:test";

import type { ProviderConnection } from "takosumi-contract/connections";
import {
  verifyCloudflareToken,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
  type CloudflareFetch,
} from "../../providers/cloudflare/credentials.ts";
import {
  REFERENCE_CREDENTIAL_RECIPE_COMPOSITION,
  credentialRecipeDriverKey,
} from "../../providers/registry.ts";

const NOW = "2026-06-04T00:00:00.000Z";
const CLOUDFLARE = "registry.opentofu.org/cloudflare/cloudflare";
const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

function connection(
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    id: "conn_cloudflare_test",
    provider: CLOUDFLARE,
    providerSource: CLOUDFLARE,
    scope: "workspace",
    workspaceId: "workspace_1",
    status: "pending",
    materialization: "secret",
    envNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Cloudflare token verification requires an account id", async () => {
  let called = false;
  const fetch: CloudflareFetch = async () => {
    called = true;
    return jsonResponse({ success: true });
  };

  const result = await verifyCloudflareToken({ token: "cf-token", fetch });

  expect(result.ok).toBe(false);
  expect(result.detail).toContain("account id");
  expect(called).toBe(false);
});

for (const accountId of [
  "acct_short",
  "0123456789abcdef0123456789ABCDEf",
]) {
  test(`Cloudflare token verification rejects malformed account id ${accountId}`, async () => {
    let called = false;
    const fetch: CloudflareFetch = async () => {
      called = true;
      return jsonResponse({ success: true });
    };

    const result = await verifyCloudflareToken({
      token: "cf-token",
      accountId,
      fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("account id");
    expect(called).toBe(false);
  });
}

test("Cloudflare verification checks token, account access, and workers subdomain", async () => {
  const calls: string[] = [];
  const fetch: CloudflareFetch = async (input) => {
    calls.push(input);
    if (input.endsWith("/user/tokens/verify")) {
      return jsonResponse({ success: true, result: { status: "active" } });
    }
    if (input.endsWith(`/accounts/${ACCOUNT_ID}`)) {
      return jsonResponse({ success: true, result: { id: ACCOUNT_ID } });
    }
    if (input.endsWith(`/accounts/${ACCOUNT_ID}/workers/subdomain`)) {
      return jsonResponse({
        success: true,
        result: { subdomain: "team-workers" },
      });
    }
    return new Response("not found", { status: 404 });
  };

  const result = await verifyCloudflareToken({
    token: "cf-token",
    accountId: ACCOUNT_ID,
    fetch,
  });

  expect(result).toEqual({
    ok: true,
    verifiedScopeHints: {
      providerSettings: {
        accountId: ACCOUNT_ID,
        workersSubdomain: "team-workers",
      },
      moduleInputDefaults: {
        cloudflare_account_id: ACCOUNT_ID,
        cloudflare_workers_subdomain: "team-workers",
      },
    },
  });
  expect(calls).toEqual([
    "https://api.cloudflare.com/client/v4/user/tokens/verify",
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}`,
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers/subdomain`,
  ]);
});

test("Cloudflare verification rejects account probe id mismatch", async () => {
  const fetch: CloudflareFetch = async (input) => {
    if (input.endsWith("/user/tokens/verify")) {
      return jsonResponse({ success: true, result: { status: "active" } });
    }
    if (input.endsWith("/workers/subdomain")) {
      return jsonResponse({ success: true, result: { subdomain: "team-workers" } });
    }
    return jsonResponse({ success: true, result: { id: "fedcba9876543210fedcba9876543210" } });
  };

  const result = await verifyCloudflareToken({
    token: "cf-token",
    accountId: ACCOUNT_ID,
    fetch,
  });

  expect(result.ok).toBe(false);
  expect(result.detail).toContain("account probe");
});

for (const subdomain of ["team.workers", "team/workers", "Team-workers"]) {
  test(`Cloudflare verification rejects invalid Workers subdomain ${subdomain}`, async () => {
    const fetch: CloudflareFetch = async (input) => {
      if (input.endsWith("/user/tokens/verify")) {
        return jsonResponse({ success: true, result: { status: "active" } });
      }
      if (input.endsWith("/workers/subdomain")) {
        return jsonResponse({ success: true, result: { subdomain } });
      }
      return jsonResponse({ success: true, result: { id: ACCOUNT_ID } });
    };

    const result = await verifyCloudflareToken({
      token: "cf-token",
      accountId: ACCOUNT_ID,
      fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("invalid subdomain");
  });
}

test("reference Cloudflare api_token driver requires account access context", async () => {
  const driver =
    REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers[
      credentialRecipeDriverKey({ id: "cloudflare", authMode: "api_token" })
    ];
  expect(driver?.verify).toBeDefined();
  expect(driver?.verifierId).toBe(
    CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
  );
  expect(driver?.verificationCapabilities).toEqual([
    CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  ]);
  const result = await driver!.verify!({
    connection: connection(),
    values: { CLOUDFLARE_API_TOKEN: "cf-token" },
    files: [],
    fetch: async () => jsonResponse({ success: true }),
    now: () => new Date(NOW),
    staticEvidence: () => ({
      connectionId: "conn_cloudflare_test",
      provider: CLOUDFLARE,
      temporary: false,
      ttlEnforced: false,
      issuer: "static_secret",
    }),
  });

  expect(result.ok).toBe(false);
  expect(result.detail).toContain("account id");
});

test("reference Cloudflare OAuth driver declares the same verified capability", () => {
  const driver =
    REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers[
      credentialRecipeDriverKey({ id: "cloudflare", authMode: "oauth" })
    ];

  expect(driver?.verifierId).toBe(
    CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_VERIFIER_ID,
  );
  expect(driver?.verificationCapabilities).toEqual([
    CLOUDFLARE_ACCOUNT_WORKERS_SUBDOMAIN_CAPABILITY,
  ]);
});

test("Cloudflare api_token recipe requires account id in guided input hints", () => {
  const recipe = REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find(
    (candidate) => candidate.id === "cloudflare",
  );
  expect(recipe?.authModes.api_token.inputHints?.CLOUDFLARE_ACCOUNT_ID).toMatchObject({
    required: true,
  });
});
