import { expect, test } from "bun:test";
import { StaticSecretConnectionVault } from "../../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../../core/domains/deploy-control/store.ts";
import { referenceCredentialDriversFromEnv, REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../../providers/registry.ts";
import { createDefaultRunnerProfiles } from "../../../../core/domains/deploy-control/runner_profiles.ts";
import { cloudflareOAuthValues } from "../../../../providers/cloudflare/oauth.ts";

const provider = "registry.opentofu.org/cloudflare/cloudflare";
const account = "0123456789abcdef0123456789abcdef";
const start = Date.parse("2026-10-27T00:00:00Z");
const authority = { workspaceId: "ws_oauth", managementState: "active" as const, managementEpoch: 1 };

async function fixture() {
  const store = new InMemoryOpenTofuControlStore();
  await store.putWorkspace({ id: authority.workspaceId, handle: "oauth", displayName: "OAuth", type: "personal",
    ownerUserId: "owner", createdAt: new Date(start).toISOString(), updatedAt: new Date(start).toISOString() });
  let now = start;
  let refreshes = 0;
  let refreshFailure: "terminal" | "temporary" | undefined;
  let expectedRefreshToken = "refresh-fixture";
  let beforeRefresh: (() => Promise<void>) | undefined;
  const vault = new StaticSecretConnectionVault({ store,
    crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "fixture-oauth-vault-passphrase-0123456789" }),
    now: () => new Date(now), newId: () => "conn_oauth_fixture",
    credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((item) => item.id === id),
    credentialDrivers: REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
    fetch: async (url, init) => {
      if (url === "https://dash.cloudflare.com/oauth2/token") {
        refreshes++;
        expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe(expectedRefreshToken);
        expect(String(init?.body)).not.toContain("client_secret");
        await beforeRefresh?.();
        if (refreshFailure === "temporary") return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        if (refreshFailure === "terminal") return Response.json({ error: "invalid_grant" }, { status: 400 });
        expectedRefreshToken = `refresh-rotated-${refreshes}`;
        return Response.json({ access_token: `access-renewed-${refreshes}`, refresh_token: expectedRefreshToken, expires_in: 3600 });
      }
      if (url.endsWith("/user/tokens/verify")) return Response.json({ success: true, result: { status: "active" } });
      if (url.endsWith("?per_page=2")) return Response.json({ success: true, result: [{ id: account }] });
      if (url.endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "fixture" } });
      if (url.endsWith(account)) return Response.json({ success: true, result: { id: account } });
      throw new Error("Unexpected provider request");
    },
  });
  const connection = await vault.register({ workspaceId: authority.workspaceId, provider,
    credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" },
    materialization: "oauth", values: cloudflareOAuthValues({ clientId: "client-id-fixture",
      tokenResponse: { access_token: "access-original", refresh_token: "refresh-fixture", expires_in: 3600 }, now: start }) }, authority, null);
  return { store, vault, connection, advance: (elapsed = 3600_000) => { now += elapsed; },
    refreshes: () => refreshes, failRefresh: (kind: "terminal" | "temporary" = "terminal") => { refreshFailure = kind; }, recover: () => { refreshFailure = undefined; },
    beforeRefresh: (fn: () => Promise<void>) => { beforeRefresh = fn; } };
}

test("OAuth discovers one account, renews sealed tokens, and never mints refresh/client secrets to the runner", async () => {
  const f = await fixture();
  expect(await f.vault.test(f.connection.id, authority, null)).toEqual({ status: "verified" });
  const firstBlob = await f.store.getSecretBlob(f.connection.id);
  expect(JSON.stringify(firstBlob)).not.toContain("refresh-fixture");
  f.advance();
  const minted = await f.vault.mint(authority.workspaceId, [provider]);
  expect(minted.env).toEqual({ CLOUDFLARE_API_TOKEN: "access-renewed-1" });
  expect(f.refreshes()).toBe(1);
  const renewedBlob = await f.store.getSecretBlob(f.connection.id);
  expect(renewedBlob?.ciphertext).not.toBe(firstBlob?.ciphertext);
  expect(JSON.stringify(renewedBlob)).not.toContain("client-fixture");
  // A second request opens the persisted rotated refresh material, rather than
  // keeping refresh state in a process-local cache.
  f.advance();
  expect(await f.vault.test(f.connection.id, authority, null)).toEqual({ status: "verified" });
  expect(f.refreshes()).toBe(2);
});

test("revocation while refresh is in flight cannot resurrect credentials or mint the token", async () => {
  const f = await fixture();
  await f.vault.test(f.connection.id, authority, null);
  f.advance();
  f.beforeRefresh(async () => { await f.vault.revoke(f.connection.id, authority, null); });
  await expect(f.vault.mint(authority.workspaceId, [provider])).rejects.toThrow();
  expect(await f.store.getConnection(f.connection.id)).toBeUndefined();
  expect(await f.store.getSecretBlob(f.connection.id)).toBeUndefined();
});

test("failed refresh stops mint and preserves the last sealed material for reconnect", async () => {
  const f = await fixture();
  await f.vault.test(f.connection.id, authority, null);
  const blob = await f.store.getSecretBlob(f.connection.id);
  f.advance(); f.failRefresh();
  await expect(f.vault.mint(authority.workspaceId, [provider])).rejects.toMatchObject({ reason: "provider_connection_setup_required" });
  expect((await f.store.getConnection(f.connection.id))?.status).toBe("pending");
  expect((await f.store.getSecretBlob(f.connection.id))?.ciphertext).toBe(blob?.ciphertext);
  expect((await f.store.getSecretBlob(f.connection.id))?.renewalLease).toBeDefined();
});


test("concurrent phase mints use a single durable renewal and never replay a rotated refresh token", async () => {
  const f = await fixture();
  await f.vault.test(f.connection.id, authority, null);
  f.advance();
  f.beforeRefresh(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  const bundles = await Promise.all([f.vault.mint(authority.workspaceId, [provider]), f.vault.mint(authority.workspaceId, [provider])]);
  expect(f.refreshes()).toBe(1);
  expect(bundles.map((item) => item.env)).toEqual([{ CLOUDFLARE_API_TOKEN: "access-renewed-1" }, { CLOUDFLARE_API_TOKEN: "access-renewed-1" }]);
  expect((await f.store.getSecretBlob(f.connection.id))?.renewalLease).toBeUndefined();
});


test("renewal reads the current host client secret and trusted token endpoint, never tenant copies", async () => {
  const f = await fixture();
  const values = cloudflareOAuthValues({ clientId: "client-id-fixture", now: start,
    tokenResponse: { access_token: "access-fixture", refresh_token: "refresh-fixture", expires_in: 3600 } });
  let endpoint: string | undefined;
  let sent: URLSearchParams | undefined;
  const driver = referenceCredentialDriversFromEnv({ TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_ID: "client-id-fixture",
    TAKOSUMI_CLOUDFLARE_OAUTH_CLIENT_SECRET: "rotated-host-fixture", TAKOSUMI_CLOUDFLARE_OAUTH_TOKEN_URL: "https://oauth-staging.example.test/token" })["cloudflare/oauth"]!;
  const refreshed = await driver.refresh!({ connection: f.connection, values, files: [], now: () => new Date(start + 3600_000),
    staticEvidence: () => ({ connectionId: f.connection.id, provider, issuer: "fixture", issuedAt: new Date(start).toISOString() }),
    fetch: async (url, init) => { endpoint = url; sent = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: "next-access-fixture", refresh_token: "next-refresh-fixture", expires_in: 3600 }); } });
  expect(endpoint).toBe("https://oauth-staging.example.test/token");
  expect(sent?.get("client_secret")).toBe("rotated-host-fixture");
  expect(JSON.stringify(refreshed)).not.toContain("rotated-host-fixture");
});

test("a token nearing the phase budget is renewed before it is minted", async () => {
  const f = await fixture(); await f.vault.test(f.connection.id, authority, null);
  f.advance(31 * 60_000);
  expect((await f.vault.mint(authority.workspaceId, [provider])).env).toEqual({ CLOUDFLARE_API_TOKEN: "access-renewed-1" });
  expect(f.refreshes()).toBe(1);
});

test("an interrupted durable renewal is never replayed and requires a new connection", async () => {
  const f = await fixture(); await f.vault.test(f.connection.id, authority, null); f.advance();
  const blob = (await f.store.getSecretBlob(f.connection.id))!;
  await f.store.putSecretBlob({ ...blob, renewalLease: { owner: "interrupted-fixture", expiresAt: new Date(start).toISOString() } });
  await expect(f.vault.mint(authority.workspaceId, [provider])).rejects.toMatchObject({ reason: "provider_connection_setup_required" });
  expect(f.refreshes()).toBe(0);
  expect((await f.store.getConnection(f.connection.id))?.status).toBe("pending");
});


test("a persistent authority mismatch cannot loop or call the provider refresh endpoint", async () => {
  const f = await fixture(); await f.vault.test(f.connection.id, authority, null); f.advance();
  const commit = f.store.commitConnectionTestResult.bind(f.store);
  let claims = 0;
  f.store.commitConnectionTestResult = async (input) => {
    if (input.replacementSecretBlob?.renewalLease) { claims++; return false; }
    return await commit(input);
  };
  await expect(f.vault.mint(authority.workspaceId, [provider])).rejects.toThrow();
  expect(claims).toBe(2); expect(f.refreshes()).toBe(0);
});


test("an explicit temporary no-token response releases the claim without disconnecting", async () => {
  const f = await fixture(); await f.vault.test(f.connection.id, authority, null); f.advance();
  const before = await f.store.getSecretBlob(f.connection.id); f.failRefresh("temporary");
  await expect(f.vault.mint(authority.workspaceId, [provider])).rejects.toMatchObject({ reason: "credential_service_unavailable" });
  expect(await f.store.getSecretBlob(f.connection.id)).toEqual(before);
  expect((await f.store.getConnection(f.connection.id))?.status).toBe("verified");
  f.recover();
  expect((await f.vault.mint(authority.workspaceId, [provider])).env).toEqual({ CLOUDFLARE_API_TOKEN: "access-renewed-2" });
});

for (const budget of [2800, 7200]) {
  test(`OAuth refresh and dispatch respect the canonical ${budget}s RunnerProfile budget`, async () => {
    const f = await fixture(); await f.vault.test(f.connection.id, authority, null); f.advance(20 * 60_000);
    const base = createDefaultRunnerProfiles(start)[0]!;
    await f.store.putRunnerProfile({ ...base, id: "runner_budget", resourceLimits: { ...base.resourceLimits, maxRunSeconds: budget } });
    await f.store.putPlanRun({ id: "run_budget", workspaceId: authority.workspaceId,
      source: { kind: "git", url: "https://example.test/app.git", ref: "main" }, sourceDigest: "sha256:source",
      operation: "create", runnerProfileId: "runner_budget", variablesDigest: "sha256:variables", requiredProviders: [provider],
      status: "running", policy: { status: "passed", reasons: [], checkedAt: start }, policyDecisionDigest: "sha256:policy",
      auditEvents: [], createdAt: start, updatedAt: start });
    const mint = f.vault.mintForCapsuleProviderBindings(authority.workspaceId,
      [{ provider, connectionId: f.connection.id }], { phase: "plan", runId: "run_budget" });
    if (budget === 2800) {
      expect((await mint).env.CLOUDFLARE_API_TOKEN).toBe("access-renewed-1"); expect(f.refreshes()).toBe(1);
    } else {
      await expect(mint).rejects.toMatchObject({ reason: "provider_credential_lifetime_insufficient" });
      expect(f.refreshes()).toBe(0);
    }
  });
}
