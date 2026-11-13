import assert from "node:assert/strict";
import { createRetentionAdapter, type RetentionBackend } from "./refresh-retention-adapters.ts";
import { base64UrlEncodeBytes } from "../../../../accounts/service/src/encoding.ts";
import { handleToken, handleUserInfo } from "../../../../accounts/service/src/oidc-routes.ts";
import type { OidcClientRegistration } from "../../../../accounts/service/src/mod.ts";
import { runRefreshChainRetention } from "../../../../accounts/service/src/refresh-chain-retention.ts";

const backend = process.argv[2] as RetentionBackend;
const scenario = process.argv[3];
assert(["memory", "d1", "postgres"].includes(backend));
assert(scenario === "access-only" || scenario === "rotated-family");
const DAY = 24 * 60 * 60 * 1_000;
const fixture = await createRetentionAdapter(backend);
const { store } = fixture;
const originalNow = Date.now;
let clock = originalNow();
const issuedAt = clock;
const issuer = "https://retention.example.test";
const client: OidcClientRegistration = {
  clientId: "retention-client", redirectUris: ["https://app.example.test/callback"],
  tokenEndpointAuthMethod: "none", allowedScopes: ["openid", "offline_access"],
};
const clients = new Map([[client.clientId, client]]);
// Identity/signing custody is synthetic; the actual token handler, PKCE,
// consume, opaque-token issuer, persistence and revocation effects are exercised.
const flow = { subject: "unused", pairwiseSubjectSecret: "retention-fixture-secret", issueIdToken: async () => "fixture-id-token" };
const code = "retention-fixture-code";
const verifier = "retention-fixture-verifier".repeat(3);
function request(values: Record<string, string>): Request {
  return new Request(`${issuer}/oauth/token`, { method: "POST", body: new URLSearchParams({ client_id: client.clientId, ...values }) });
}
const codeRequest = () => request({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: client.redirectUris[0]! });
async function exchange(req: Request): Promise<{ access_token: string; refresh_token?: string }> {
  const response = await handleToken({ issuer, request: req, store, flow, clients });
  assert.equal(response.status, 200, "ordinary token exchange failed");
  return await response.json();
}
async function userInfo(access: string): Promise<number> {
  return (await handleUserInfo({ issuer, request: new Request(`${issuer}/oauth/userinfo`, { headers: { authorization: `Bearer ${access}` } }), store, clients })).status;
}
Date.now = () => clock;
try {
  await store.saveAuthorizationCode(code, {
    clientId: client.clientId, redirectUri: client.redirectUris[0]!,
    scope: scenario === "access-only" ? "openid" : "openid offline_access",
    subject: "retention-fixture-subject", expiresAt: clock + 60_000,
    codeChallenge: base64UrlEncodeBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
    codeChallengeMethod: "S256",
  });
  const first = await exchange(codeRequest());
  assert.equal(await store.consumeAuthorizationCode(code), undefined, "the ordinary exchange must consume the original code row");
  const originalAccess = await store.findAccessToken(first.access_token);
  assert(originalAccess);
  const expectedAccessDays = scenario === "access-only" ? 60 : 1;
  assert(Math.abs(originalAccess.expiresAt - (issuedAt + expectedAccessDays * DAY)) < 1_000, "actual issuer did not use isolated TTL configuration");
  let currentRefresh = first.refresh_token;
  if (scenario === "rotated-family") {
    assert(currentRefresh);
    clock = issuedAt + 2 * DAY;
    const rotated = await exchange(request({ grant_type: "refresh_token", refresh_token: currentRefresh }));
    currentRefresh = rotated.refresh_token;
    assert(currentRefresh);
    assert.equal(await store.findRefreshToken(first.refresh_token!), undefined);
  }
  clock = issuedAt + 31 * DAY;
  const retention = await runRefreshChainRetention(store, {
    now: clock, refreshTokenTtlMs: DAY, authorizationCodeTtlMs: 1, maxRows: 20, pageSize: 5,
  });
  const markerRetained = await store.isAuthorizationCodeConsumed(code);
  let liveAccess = first.access_token;
  if (scenario === "rotated-family") {
    // Only a live refresh descendant protected the code marker during cleanup:
    // both earlier access tokens have the actual shorter, one-day lifetime.
    assert(originalAccess.expiresAt <= clock);
    const refreshed = await exchange(request({ grant_type: "refresh_token", refresh_token: currentRefresh! }));
    currentRefresh = refreshed.refresh_token;
    liveAccess = refreshed.access_token;
    assert(currentRefresh);
  }
  const beforeUserInfo = await userInfo(liveAccess);
  const replay = await handleToken({ issuer, request: codeRequest(), store, flow, clients });
  const originalAccessRevoked = await store.findAccessToken(first.access_token) === undefined;
  const currentAccessRevoked = await store.findAccessToken(liveAccess) === undefined;
  const currentRefreshRevoked = currentRefresh === undefined || await store.findRefreshToken(currentRefresh) === undefined;
  const afterUserInfo = await userInfo(liveAccess);
  const facts = { backend, scenario, markerRetained, replayStatus: replay.status, beforeUserInfo, afterUserInfo,
    originalAccessRevoked, currentAccessRevoked, currentRefreshRevoked,
    consumedMarkersDeleted: retention.consumedCodes, codeLinksDeleted: retention.authCodeTokenLinks, scanned: retention.scanned };
  console.log(JSON.stringify(facts));
  assert.equal(beforeUserInfo, 200);
  assert.equal(replay.status, 400);
  assert.equal(markerRetained, true);
  assert.equal(originalAccessRevoked, true);
  assert.equal(currentAccessRevoked, true);
  assert.equal(currentRefreshRevoked, true);
  assert.equal(afterUserInfo, 401);
  assert.equal(retention.consumedCodes, 0);
  assert.equal(retention.authCodeTokenLinks, 0);
  assert(retention.scanned <= 20);
} finally {
  Date.now = originalNow;
  await fixture.close();
}
