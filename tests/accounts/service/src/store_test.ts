import { expect, test } from "bun:test";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";

test("InMemoryAccountsStore persists Accounts identity and session state", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveAccount({
    subject: "tsub_owner",
    email: "owner@example.test",
    createdAt: now,
    updatedAt: now,
  });
  store.saveAccountSession({
    sessionId: "sess_owner",
    subject: "tsub_owner",
    createdAt: now,
    expiresAt: now + 60_000,
  });

  expect(store.findAccount("tsub_owner")?.email).toBe("owner@example.test");
  expect(store.findAccountSession("sess_owner")?.subject).toBe("tsub_owner");
  store.deleteAccountSession("sess_owner");
  expect(store.findAccountSession("sess_owner")).toBeUndefined();
});

test("InMemoryAccountsStore indexes Capsule OIDC registrations without a Capsule mirror", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.saveOidcClient({
    clientId: "oidc_capsule",
    capsuleId: "cap_office",
    namespacePath: "identity.oidc",
    issuerUrl: "https://app.example.test",
    redirectUris: ["https://office.example.test/oauth/callback"],
    allowedScopes: ["openid", "profile"],
    subjectMode: "pairwise",
    tokenEndpointAuthMethod: "none",
    createdAt: now,
    updatedAt: now,
  });

  expect(store.findOidcClient("oidc_capsule")?.capsuleId).toBe("cap_office");
  expect(store.findOidcClientForCapsule("cap_office")?.namespacePath).toBe(
    "identity.oidc",
  );
});

test("InMemoryAccountsStore persists Workspace-scoped PAT metadata", async () => {
  const store = new InMemoryAccountsStore();
  store.savePersonalAccessToken("takpat_secret", {
    tokenId: "pat_1",
    tokenPrefix: "takpat_sec",
    subject: "tsub_owner",
    name: "automation",
    scopes: ["read", "write"],
    workspaceId: "ws_owner",
    createdAt: 1,
  });

  expect(store.findPersonalAccessToken("takpat_secret")?.workspaceId).toBe(
    "ws_owner",
  );
  expect(store.listPersonalAccessTokensForSubject("tsub_owner")).toHaveLength(1);
});
