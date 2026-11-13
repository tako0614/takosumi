import assert from "node:assert/strict";
import { createRetentionAdapter, type RetentionBackend } from "./refresh-retention-adapters.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { runRefreshChainRetention, type RefreshChainRetentionCursor } from "../../../../accounts/service/src/refresh-chain-retention.ts";
import type { TokenRecord } from "../../../../accounts/service/src/store.ts";

const backend = process.argv[2] as RetentionBackend;
const scenario = process.argv[3];
assert(["memory", "d1", "postgres"].includes(backend));
const fixture = await createRetentionAdapter(backend);
const { store } = fixture;
const originalNow = Date.now;
let clock = originalNow();
const issuedAt = clock;
const DAY = 24 * 60 * 60 * 1_000;
const token = (expiresAt: number): TokenRecord => ({ clientId: "fixture-client", subject: "fixture-subject", scope: "openid offline_access", expiresAt });
async function collect(cursor?: RefreshChainRetentionCursor, maxRows = 7) {
  let scanned = 0;
  for (let call = 0; call < 40; call += 1) {
    const result = await runRefreshChainRetention(store, { now: clock, refreshTokenTtlMs: DAY,
      authorizationCodeTtlMs: 1, maxRows, pageSize: Math.min(maxRows, 3), ...(cursor ? { cursor } : {}) });
    assert(result.scanned <= maxRows);
    scanned += result.scanned;
    if (result.done) return scanned;
    assert(result.cursor);
    cursor = result.cursor;
  }
  throw new Error("bounded retention did not complete its phase cycle");
}
Date.now = () => clock;
try {
  if (scenario === "exact-expiry") {
    await store.saveRefreshToken("parent", token(issuedAt + 60 * DAY));
    assert(await store.addRefreshChainLink("parent", "child"));
    clock = issuedAt + 60 * DAY - 1;
    await collect();
    assert(await store.getRefreshChainChild("parent"));
    clock += 1;
    await collect();
    assert.equal(await store.getRefreshChainChild("parent"), undefined);
  } else if (scenario === "prefix-root") {
    assert(await store.addRefreshChainLink("root", "child"));
    assert(await store.addRefreshChainLink("child", "grandchild"));
    await store.saveRefreshToken("grandchild", token(issuedAt + 60 * DAY));
    clock = issuedAt + 31 * DAY;
    await collect();
    assert.equal(await store.getRefreshChainChild("root"), undefined);
    assert(await store.getRefreshChainChild("child"));
    await store.saveAccessToken("suffix-access", token(issuedAt + 60 * DAY));
    await store.linkAccessTokenToRefreshChain("grandchild", "suffix-access");
    await store.revokeRefreshChain("child");
    assert.equal(await store.isRefreshRootRevoked("root"), true);
    assert.equal(await store.findRefreshToken("grandchild"), undefined);
    assert.equal(await store.findAccessToken("suffix-access"), undefined);
  } else if (scenario === "long-access") {
    await store.saveAccessToken("access", token(issuedAt + 60 * DAY));
    await store.linkAccessTokenToRefreshChain("root", "access");
    clock = issuedAt + 31 * DAY;
    await collect();
    await store.revokeRefreshChain("root");
    assert.equal(await store.findAccessToken("access"), undefined);
  } else if (scenario === "revoked-residue") {
    assert(await store.addRefreshChainLink("root", "child"));
    await store.saveRefreshToken("child", token(issuedAt + 60 * DAY));
    await store.revokeRefreshChain("root");
    // Controlled interruption residue in a disposable store, not a new issuer.
    await store.saveRefreshToken("child", token(issuedAt + 60 * DAY));
    clock = issuedAt + 31 * DAY;
    await collect();
    assert.equal(await store.isRefreshRootRevoked("root"), true);
    assert.equal(await store.isRefreshRootRevoked("child"), true);
    clock = issuedAt + 60 * DAY;
    await collect();
    assert.equal(await store.isRefreshRootRevoked("root"), false);
  } else if (scenario === "large-family") {
    let parent = "root";
    for (let index = 0; index < 51; index += 1) {
      const child = `child-${index}`;
      assert(await store.addRefreshChainLink(parent, child));
      parent = child;
    }
    await store.revokeRefreshChain("root");
    clock = issuedAt + 31 * DAY;
    const first = await runRefreshChainRetention(store, { now: clock, refreshTokenTtlMs: DAY,
      maxRows: 1, pageSize: 1, cursor: { phase: "revoked_roots" } });
    assert.equal(first.scanned, 1);
    assert.equal(first.revokedRoots, 0);
    assert.equal(await store.isRefreshRootRevoked("root"), true);
    await collect();
    assert.equal(await store.isRefreshRootRevoked("root"), false);
    assert.equal(await store.getRefreshChainChild("root"), undefined);
  } else if (scenario === "live-code-row") {
    await store.saveAuthorizationCode("code", { clientId: "fixture-client", redirectUri: "https://app.example.test/callback",
      scope: "openid", subject: "fixture-subject", expiresAt: issuedAt + 60 * DAY });
    await store.markAuthorizationCodeConsumed("code");
    clock = issuedAt + 31 * DAY;
    await collect();
    assert.equal(await store.isAuthorizationCodeConsumed("code"), true);
    assert(await store.consumeAuthorizationCode("code"));
    await collect();
    assert.equal(await store.isAuthorizationCodeConsumed("code"), false);
  } else if (scenario === "unknown-expiry") {
    await store.saveRefreshToken("parent", token(fixture.postgres ? issuedAt + 60 * DAY : Number.NaN));
    assert(await store.addRefreshChainLink("parent", "child"));
    if (fixture.postgres) await fixture.postgres.query("UPDATE accounts_v1.oauth_refresh_tokens SET expires_at = 'infinity' WHERE token_hash = $1", [await sha256Text("parent")]);
    clock = issuedAt + 31 * DAY;
    await collect();
    assert(await store.getRefreshChainChild("parent"));
  } else if (scenario === "incomplete-index") {
    assert(fixture.d1);
    assert(await store.addRefreshChainLink("root", "child"));
    await store.revokeRefreshChain("root");
    const key = await sha256Text("root");
    await fixture.d1.prepare("DELETE FROM takosumi_accounts_documents WHERE bucket = 'refresh_chain_links' AND key = ?").bind(key).run();
    clock = issuedAt + 31 * DAY;
    await collect({ phase: "revoked_roots" });
    assert.equal(await store.isRefreshRootRevoked("root"), true);
    await fixture.d1.prepare("DELETE FROM takosumi_accounts_indexes WHERE bucket = 'refresh_chain_links' AND document_key = ?").bind(key).run();
    await collect({ phase: "revoked_roots" });
    assert.equal(await store.isRefreshRootRevoked("root"), false);
  } else if (scenario === "invalid-link-root" || scenario === "invalid-link-time") {
    assert(fixture.d1);
    assert(await store.addRefreshChainLink("root", "child"));
    const key = await sha256Text("root");
    const path = scenario === "invalid-link-root" ? "$.rootHash" : "$.createdAt";
    const value = scenario === "invalid-link-root" ? null : "unknown";
    await fixture.d1.prepare(`UPDATE takosumi_accounts_documents SET document = json_set(document, ?, ?)
      WHERE bucket = 'refresh_chain_links' AND key = ?`).bind(path, value, key).run();
    clock = issuedAt + 31 * DAY;
    await collect();
    const row = await fixture.d1.prepare("SELECT key FROM takosumi_accounts_documents WHERE bucket = 'refresh_chain_links' AND key = ?").bind(key).first();
    assert(row, "unknown dependency identity/time must not authorize deletion");
  } else throw new Error("unknown property scenario");
  console.log(JSON.stringify({ backend, scenario, pass: true }));
} finally {
  Date.now = originalNow;
  await fixture.close();
}
