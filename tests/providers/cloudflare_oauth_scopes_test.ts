import { expect, test } from "bun:test";
import { cloudflareOAuthValues, refreshCloudflareOAuthValues } from "../../providers/cloudflare/oauth.ts";
import { cloudflareOAuthDescriptorFromEnv } from "../../providers/cloudflare/setup.ts";
import { referenceCredentialDriversFromEnv } from "../../providers/registry.ts";
import type { CredentialRecipeDriverContext } from "../../providers/types.ts";

const clientId = "scope-fixture-client";
const scopes = "account-settings.read workers-scripts.admin d1.write workers-kv-storage.write workers-r2.write queues.write offline_access";
const limitedScopes = "account-settings.read workers-scripts.admin offline_access";
const now = Date.parse("2026-11-17T00:00:00Z");
const host = {
  TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: clientId,
  TAKOSUMI_CLOUDFLARE_OAUTH_REDIRECT_URI: "https://fixture.test/api/v1/connections/oauth/cloudflare/callback",
  TAKOSUMI_CLOUDFLARE_OAUTH_SCOPES: scopes,
};
const tokenResponse = (scope?: unknown) => ({ access_token: "access-fixture", refresh_token: "refresh-fixture", expires_in: 3600, ...(scope === undefined ? {} : { scope }) });
const material = (scope?: unknown) => cloudflareOAuthValues({ clientId, now, tokenResponse: tokenResponse(scope) });
const descriptor = () => cloudflareOAuthDescriptorFromEnv(host)!;

test("connection callback refuses a successful token response missing required storage grants", () => {
  expect(() => descriptor().mapTokenResponse({ helperId: "cloudflare", clientId, tokenResponse: tokenResponse(limitedScopes) }))
    .toThrow(/permissions|scopes/u);
});

test("connection callback retains the granted scopes inside sealed OAuth material", () => {
  const values = descriptor().mapTokenResponse({ helperId: "cloudflare", clientId, tokenResponse: tokenResponse(scopes) });
  expect(JSON.parse(values.CLOUDFLARE_OAUTH_SESSION!).scopes).toContain("d1.write");
  expect(JSON.parse(values.CLOUDFLARE_OAUTH_SESSION!).scopes).toContain("workers-r2.write");
});

test("an omitted initial response scope means the requested scope per OAuth, not an empty grant", () => {
  const values = descriptor().mapTokenResponse({ helperId: "cloudflare", clientId, tokenResponse: tokenResponse() });
  expect(JSON.parse(values.CLOUDFLARE_OAUTH_SESSION!).scopes).toContain("workers-kv-storage.write");
});

for (const [label, values] of [["narrow grant", material(limitedScopes)], ["old unknown grant", material()]] as const) {
  test(`host scope expansion refuses ${label} before provider verification or mint`, async () => {
    let requests = 0;
    const input = {
      connection: { id: "conn-scopes", provider: "registry.opentofu.org/cloudflare/cloudflare", credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" } },
      values, now: () => new Date(now),
      fetch: async () => { requests++; throw new Error("Provider request must not occur"); },
      staticEvidence: () => ({ connectionId: "conn-scopes", provider: "registry.opentofu.org/cloudflare/cloudflare", temporary: false, ttlEnforced: false }),
    } as CredentialRecipeDriverContext;
    const driver = referenceCredentialDriversFromEnv(host)["cloudflare/oauth"]!;
    expect((await driver.verify!(input)).ok).toBe(false);
    await expect(driver.mint!(input)).rejects.toThrow(/permissions|scopes/u);
    expect(requests).toBe(0);
  });
}

test("refresh refuses an explicit reduction from previously granted storage scopes", async () => {
  let calls = 0;
  const input = { values: material(scopes), now: () => new Date(now + 3600_000),
    fetch: async () => { calls++; return Response.json(tokenResponse(limitedScopes)); } } as CredentialRecipeDriverContext;
  await expect(refreshCloudflareOAuthValues(input)).rejects.toThrow(/permissions|scopes/u);
  expect(calls).toBe(1);
});

test("refresh without a scope field preserves the previous grant and keeps only the access token runner-bound", async () => {
  const input = { values: material(scopes), now: () => new Date(now + 3600_000),
    fetch: async () => Response.json(tokenResponse()) } as CredentialRecipeDriverContext;
  const refreshed = await refreshCloudflareOAuthValues(input);
  expect(JSON.parse(refreshed!.CLOUDFLARE_OAUTH_SESSION!).scopes).toContain("d1.write");
  const driver = referenceCredentialDriversFromEnv(host)["cloudflare/oauth"]!;
  const minted = await driver.mint!({ ...input, values: refreshed!,
    connection: { id: "conn-scopes" }, staticEvidence: () => ({}) } as CredentialRecipeDriverContext);
  expect(minted.env).toEqual({ CLOUDFLARE_API_TOKEN: "access-fixture" });
});

test("malformed granted scopes fail without exposing access or refresh credentials", () => {
  for (const scope of [123, ["d1.write"], "d1.write\n\"invalid", "x".repeat(9000)]) {
    expect(() => descriptor().mapTokenResponse({ helperId: "cloudflare", clientId, tokenResponse: tokenResponse(scope) }))
      .toThrow();
  }
});
