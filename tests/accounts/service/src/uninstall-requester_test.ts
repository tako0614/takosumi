import { expect, test } from "bun:test";
import { requireAccountsBearer } from "../../../../accounts/service/src/account-session.ts";
import { sha256Text } from "../../../../accounts/service/src/encoding.ts";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { validateUninstallRequester } from "../../../../accounts/service/src/uninstall-requester.ts";

const subject = "tsub_uninstall_requester";
const workspaceId = "ws_uninstall_requester";
const now = Date.now();

function storeWithAccount(): InMemoryAccountsStore {
  const store = new InMemoryAccountsStore();
  store.saveAccount({ subject, createdAt: now, updatedAt: now });
  return store;
}

test("session captures only account identity and rechecks account existence", async () => {
  const store = storeWithAccount();
  const secret = "sess_uninstall_secret";
  store.saveAccountSession({
    sessionId: secret,
    subject,
    createdAt: now,
    expiresAt: now + 60_000,
  });
  const result = await requireAccountsBearer({
    request: new Request("https://example.test/api/v1/capsules/cap/uninstall", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
    store,
    scope: "write",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.auth.uninstallRequester).toEqual({ subject });
  expect(JSON.stringify(result.auth.uninstallRequester)).not.toContain(secret);
  expect(await validateUninstallRequester(store, result.auth.uninstallRequester, workspaceId, now)).toBe(true);
  const missingAccount = Object.create(store) as InMemoryAccountsStore;
  missingAccount.findAccount = () => undefined;
  expect(await validateUninstallRequester(missingAccount, result.auth.uninstallRequester, workspaceId, now)).toBe(false);
});

test("PAT grant is re-read by nonsecret ID and rejects revoke, expiry, scope and workspace changes", async () => {
  const store = storeWithAccount();
  const secret = "takpat_uninstall_secret";
  const base = {
    tokenId: "pat_uninstall_requester",
    tokenPrefix: "takpat_un",
    subject,
    name: "uninstall",
    scopes: ["write" as const],
    workspaceId,
    createdAt: now,
    expiresAt: now + 60_000,
  };
  store.savePersonalAccessToken(secret, base);
  const result = await requireAccountsBearer({
    request: new Request("https://example.test/api/v1/capsules/cap/uninstall", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
    store,
    scope: "write",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const requester = result.auth.uninstallRequester;
  expect(requester).toEqual({ subject, grant: { kind: "personal-access-token", tokenId: base.tokenId } });
  expect(JSON.stringify(requester)).not.toContain(secret);
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(true);
  expect(await validateUninstallRequester(store, requester, workspaceId, now + 60_000)).toBe(false);
  store.savePersonalAccessToken(secret, { ...base, revokedAt: now + 1 });
  expect(await validateUninstallRequester(store, requester, workspaceId, now + 2)).toBe(false);
  store.savePersonalAccessToken(secret, { ...base, scopes: ["read"] });
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(false);
  store.savePersonalAccessToken(secret, { ...base, workspaceId: "ws_elsewhere" });
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(false);
});

test("OAuth grant uses canonical token hash and rejects expiry, scope and workspace changes", async () => {
  const store = storeWithAccount();
  const secret = "oauth_uninstall_secret";
  const base = {
    clientId: "client_uninstall",
    subject: "pairwise_principal",
    takosumiSubject: subject,
    scope: "capsules:write",
    workspaceId,
    expiresAt: now + 60_000,
  };
  store.saveAccessToken(secret, base);
  const result = await requireAccountsBearer({
    request: new Request("https://example.test/api/v1/capsules/cap/uninstall", {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
    }),
    store,
    scope: "write",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const requester = result.auth.uninstallRequester;
  expect(requester).toEqual({
    subject,
    grant: { kind: "oauth-access-token", tokenHash: await sha256Text(secret) },
  });
  expect(JSON.stringify(requester)).not.toContain(secret);
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(true);
  expect(await validateUninstallRequester(store, requester, workspaceId, now + 60_000)).toBe(false);
  store.saveAccessToken(secret, { ...base, scope: "capsules:read" });
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(false);
  store.saveAccessToken(secret, { ...base, workspaceId: "ws_elsewhere" });
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(false);
  store.deleteToken(secret);
  expect(await validateUninstallRequester(store, requester, workspaceId, now)).toBe(false);
});
