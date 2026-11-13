import { expect, test } from "bun:test";
import { runRefreshChainRetention } from "../../../../accounts/service/src/refresh-chain-retention.ts";
import { InMemoryAccountsStore, type TokenRecord } from "../../../../accounts/service/src/store.ts";

const DAY = 24 * 60 * 60 * 1_000;

function token(expiresAt: number): TokenRecord {
  return { clientId: "fixture-client", subject: "tsub_retention_fixture", scope: "openid offline_access", expiresAt };
}

test("retention keeps a reuse fence while its previously issued refresh token is unexpired", async () => {
  const store = new InMemoryAccountsStore();
  const issuedAt = Date.now();
  store.saveRefreshToken("fixture-parent", token(issuedAt + 60 * DAY));
  expect(store.addRefreshChainLink("fixture-parent", "fixture-child")).toBe(true);

  const result = await runRefreshChainRetention(store, { now: issuedAt + 31 * DAY, maxRows: 10, pageSize: 10 });

  expect(result.scanned).toBeLessThanOrEqual(10);
  expect(result.chainLinks).toBe(0);
  expect(store.getRefreshChainChild("fixture-parent")).toBe("fixture-child");
});

test("a longer access lifetime retains its chain link and subsequent revocation cascade", async () => {
  const store = new InMemoryAccountsStore();
  const issuedAt = Date.now();
  store.saveAccessToken("fixture-access", token(issuedAt + 60 * DAY));
  store.linkAccessTokenToRefreshChain("fixture-root", "fixture-access");
  const options = { now: issuedAt + 31 * DAY, refreshTokenTtlMs: DAY, maxRows: 10, pageSize: 10 };

  const result = await runRefreshChainRetention(store, options);

  expect(result.chainAccessTokens).toBe(0);
  store.revokeRefreshChain("fixture-root");
  expect(store.findAccessToken("fixture-access")).toBeUndefined();
});

test("expired prefixes may be reclaimed without splitting a live descendant from its original root", async () => {
  const store = new InMemoryAccountsStore();
  const issuedAt = Date.now();
  expect(store.addRefreshChainLink("fixture-root", "fixture-child")).toBe(true);
  expect(store.addRefreshChainLink("fixture-child", "fixture-grandchild")).toBe(true);
  store.saveRefreshToken("fixture-grandchild", token(issuedAt + 60 * DAY));

  const result = await runRefreshChainRetention(store, {
    now: issuedAt + 31 * DAY, refreshTokenTtlMs: DAY, maxRows: 10, pageSize: 10,
  });

  expect(result.chainLinks).toBe(1);
  expect(store.getRefreshChainChild("fixture-root")).toBeUndefined();
  expect(store.getRefreshChainChild("fixture-child")).toBe("fixture-grandchild");
  store.saveAccessToken("fixture-descendant-access", token(issuedAt + 60 * DAY));
  store.linkAccessTokenToRefreshChain("fixture-grandchild", "fixture-descendant-access");
  store.revokeRefreshChain("fixture-child");
  expect(store.isRefreshRootRevoked("fixture-root")).toBe(true);
  expect(store.findRefreshToken("fixture-grandchild")).toBeUndefined();
  expect(store.findAccessToken("fixture-descendant-access")).toBeUndefined();
});

test("retention still retires expired links within its existing row budget", async () => {
  const store = new InMemoryAccountsStore();
  const issuedAt = Date.now();
  store.saveRefreshToken("fixture-parent", token(issuedAt + 60 * DAY));
  expect(store.addRefreshChainLink("fixture-parent", "fixture-child")).toBe(true);

  const result = await runRefreshChainRetention(store, {
    now: issuedAt + 62 * DAY, refreshTokenTtlMs: DAY, maxRows: 1, pageSize: 1,
  });

  expect(result.scanned).toBe(1);
  expect(result.chainLinks).toBe(1);
  expect(store.getRefreshChainChild("fixture-parent")).toBeUndefined();
});
