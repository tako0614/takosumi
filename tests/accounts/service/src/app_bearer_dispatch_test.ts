import { expect, test } from "bun:test";
import { InMemoryAccountsStore } from "../../../../accounts/service/src/store.ts";
import { handleControlRoute } from "../../../../accounts/service/src/control-routes.ts";

test("app PAT and installed-app OAuth cannot initialize account-wide Control resources", async () => {
  const store = new InMemoryAccountsStore();
  const now = Date.now();
  store.savePersonalAccessToken("fixture-app-pat", { tokenId: "pat_app", tokenPrefix: "fixture", subject: "tsub_owner", name: "App", scopes: ["read", "write"], appIds: ["cap1"], createdAt: now });
  store.saveAccessToken("fixture-app-oauth", { clientId: "client1", scope: "openid capsules:read capsules:write", subject: "pairwise", takosumiSubject: "tsub_owner", capsuleId: "cap1", expiresAt: now + 60_000 });
  for (const token of ["fixture-app-pat", "fixture-app-oauth"]) {
    for (const path of ["/api/v1/workspaces", "/api/v1/dashboard/bootstrap", "/api/v1/views/workspaces.v1", "/api/v1/connections", "/api/v1/usage"]) {
      let initializations = 0;
      const url = new URL(path, "https://accounts.example.test");
      const response = await handleControlRoute({ request: new Request(url, { headers: { authorization: `Bearer ${token}` } }), url, store, resolveOperations: async () => { initializations++; return undefined; } });
      expect(response?.status).toBe(403);
      expect(await response!.json()).toMatchObject({ error: { code: "app_access_denied" } });
      expect(initializations).toBe(0);
    }
  }
});
