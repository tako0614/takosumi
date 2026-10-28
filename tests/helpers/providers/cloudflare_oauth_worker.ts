import { StaticSecretConnectionVault } from "../../../core/adapters/vault/mod.ts";
import { PartitionedSecretBoundaryCrypto } from "../../../core/adapters/secret-store/memory.ts";
import { InMemoryOpenTofuControlStore } from "../../../core/domains/deploy-control/store.ts";
import { REFERENCE_CREDENTIAL_RECIPE_COMPOSITION } from "../../../providers/registry.ts";
import { cloudflareOAuthValues } from "../../../providers/cloudflare/oauth.ts";

const account = "0123456789abcdef0123456789abcdef";
const provider = "registry.opentofu.org/cloudflare/cloudflare";
const initialTime = Date.parse("2026-10-27T00:00:00Z");

export default {
  async fetch(request: Request): Promise<Response> {
    const scenario = new URL(request.url).pathname.slice(1);
    const store = new InMemoryOpenTofuControlStore();
    const authority = { workspaceId: "ws_native_oauth", managementState: "active" as const, managementEpoch: 1 };
    await store.putWorkspace({ id: authority.workspaceId, handle: "native-oauth", displayName: "Native OAuth",
      type: "personal", ownerUserId: "fixture-owner", createdAt: new Date(initialTime).toISOString(),
      updatedAt: new Date(initialTime).toISOString() });
    let now = initialTime;
    let refreshes = 0;
    const calls: { path: string; redirect: string }[] = [];
    const vault = new StaticSecretConnectionVault({ store,
      crypto: new PartitionedSecretBoundaryCrypto({ globalPassphrase: "synthetic-native-oauth-fixture-passphrase" }),
      now: () => new Date(now), newId: () => "conn_native_oauth",
      credentialRecipeResolver: (id) => REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipes.find((item) => item.id === id),
      credentialDrivers: REFERENCE_CREDENTIAL_RECIPE_COMPOSITION.credentialRecipeDrivers,
      fetch: async (url, init) => {
        // Use workerd's actual Request constructor, which rejects redirect:error
        // before any network operation. Every response below is synthetic.
        const outbound = new Request(url, init);
        const path = new URL(outbound.url).pathname;
        calls.push({ path, redirect: outbound.redirect });
        if (path === "/oauth2/token") {
          refreshes++;
          if (scenario === "refresh-redirect") return new Response(null, { status: 302,
            headers: { location: "https://untrusted.example.test/token" } });
          return Response.json({ access_token: "renewed-fixture", refresh_token: "rotated-fixture", expires_in: 3600 });
        }
        if (path === "/client/v4/accounts") {
          if (scenario === "account-redirect") return new Response(null, { status: 302,
            headers: { location: "https://untrusted.example.test/accounts" } });
          return Response.json({ success: true, result: [{ id: account }] });
        }
        if (path.endsWith("/user/tokens/verify")) return Response.json({ success: true, result: { status: "active" } });
        if (path.endsWith("/workers/subdomain")) return Response.json({ success: true, result: { subdomain: "fixture" } });
        if (path.endsWith(account)) return Response.json({ success: true, result: { id: account } });
        throw new Error("Unexpected synthetic provider request");
      },
    });
    const connection = await vault.register({ scope: "workspace", workspaceId: authority.workspaceId, provider,
      credentialRecipe: { id: "cloudflare", authMode: "oauth", secretPartition: "provider-credentials" },
      materialization: "oauth",
      values: cloudflareOAuthValues({ clientId: "native-fixture-client", now,
        tokenResponse: { access_token: "access-fixture", refresh_token: "refresh-fixture", expires_in: 3600 } }),
    }, authority, null);
    try {
      let result = await vault.test(connection.id, authority, null);
      if (scenario.startsWith("refresh")) {
        now += 31 * 60_000;
        result = await vault.test(connection.id, authority, null);
      }
      return Response.json({ result, calls, refreshes });
    } catch (error) {
      // Only these fixed public contract fields leave the fixture.
      const failure = error as { code?: string; reason?: string; message?: string };
      return Response.json({ error: { code: failure.code, reason: failure.reason, message: failure.message },
        calls, refreshes, status: (await store.getConnection(connection.id))?.status });
    }
  },
};
